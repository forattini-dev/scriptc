/* The C emission of node:readline's ASYNC-ITERATOR slice —
 * `for await (const line of rl)`, which the frontend lowers to a
 * `rl.nextLine` libCall answering `Promise<string | undefined>`.
 *
 * Everything else in node:readline emits inline in emit-exprs.ts, because
 * every other call is one runtime call with no shape to build.
 * `rl.nextLine` is not: the runtime answers ONE line (+1) or NULL for
 * "nothing more can arrive", and the promise it settles is a union whose
 * two arm TAGS are program data. That needs an interned adapter per union
 * shape — the raceAdapterFor stance — so it lives in its own file rather
 * than growing emit-async.ts.
 */
import { InternalCompilerError } from "../../errors.js";
import type { IrExpr, IrType } from "../../ir/nodes.js";
import { typeKey } from "../../ir/nodes.js";
import { mangleReadlineNextThunk } from "../mangle.js";
import type { CEmitter } from "./emitter.js";
import { vAdapters } from "./emit-types.js";

/* The interned adapters, per emitter. They hang here rather than on
 * CEmitter because this is the only file that reads them, and the
 * emitter's own thunk registry is a frozen-size file; a WeakMap keyed by
 * the emitter gives the same per-compilation lifetime with no shared
 * state between compilations. */
const readlineNextThunks = new WeakMap<CEmitter, Map<string, string>>();

function thunkRegistry(E: CEmitter): Map<string, string> {
  let registry = readlineNextThunks.get(E);
  if (!registry) {
    registry = new Map<string, string>();
    readlineNextThunks.set(E, registry);
  }
  return registry;
}

/** Interned `rl.nextLine` answer adapter, one per result-union typeKey.
 *
 * The runtime hands back a line (+1) or NULL, and this fulfills the
 * `string | undefined` promise the call site created. The closure is an
 * ordinary RESOLVE closure (scr_make_resolve_fn): caps[0] holds that
 * promise +1 and scr_resolve_ref_impl releases it — the `new Promise`
 * machinery, with a readline answer where the executor's `resolve` would
 * be. The undefined arm is the interned immortal unit instance (free, and
 * releases skip it). */
export function readlineNextThunkFor(E: CEmitter, inner: IrType): string {
  if (inner.kind !== "union") {
    throw new InternalCompilerError("emitter bug: rl.nextLine result is not a union (frontend must fence)");
  }
  const def = E.unionsById.get(inner.unionId);
  const stringTag = def ? def.arms.findIndex((arm) => arm.kind === "string") : -1;
  const undefinedTag = def ? def.arms.findIndex((arm) => arm.kind === "undefinedT") : -1;
  if (!def || def.arms.length !== 2 || stringTag < 0 || undefinedTag < 0) {
    throw new InternalCompilerError("emitter bug: rl.nextLine result union is not `string | undefined`");
  }
  const registry = thunkRegistry(E);
  const key = typeKey(inner);
  const existing = registry.get(key);
  if (existing) return existing;
  const sym = mangleReadlineNextThunk(registry.size);
  registry.set(key, sym);
  const v = vAdapters(inner);
  E.walkerProtos.push(`static void ${sym}(ScrClosure *sc_self, ScrStr *sc_line);`);
  E.walkerDefs.push(
    `static void ${sym}(ScrClosure *sc_self, ScrStr *sc_line) {`,
    `  ScrUnion *sc_u = sc_line`,
    `      ? scr_union_new_ref(${stringTag}, sc_line, scr_str_retain_v, scr_str_release_v, NULL)`,
    `      : ${E.unitInstanceRef(inner.unionId, undefinedTag)};`,
    `  scr_resolve_ref_impl(sc_self, sc_u, ${v.retain}, ${v.release}, ${E.traceArgC(inner)});`,
    `}`,
  );
  return sym;
}

/** `rl.nextLine` itself: a fresh promise, handed to the runtime through
 * the resolve closure the adapter above expects. Never throws — a closed
 * interface answers undefined, which is how the `for await` loop ends —
 * so no pending check follows. Answers the promise temporary's name. */
export function emitReadlineNextLine(
  E: CEmitter,
  expr: IrExpr & { kind: "libCall" },
  handle: string,
): { name: string; type: IrType } {
  if (expr.type.kind !== "promise") {
    throw new InternalCompilerError("emitter bug: rl.nextLine result is not a promise");
  }
  // An open interface is a stdin consumer, so the loop must run.
  E.usesTimers = true;
  const adapter = readlineNextThunkFor(E, expr.type.inner);
  const promise = E.newTemp(expr.type, `scr_promise_new()`);
  E.line(
    `scr_rl_next_line(${handle}, scr_make_resolve_fn(${promise.name}, (void *)&${adapter}), &${adapter});` +
      E.srcComment(expr.loc),
  );
  return promise;
}
