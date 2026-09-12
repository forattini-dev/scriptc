import { InternalCompilerError } from "../../errors.js";
import { type IrType, isRefCounted, typeKey } from "../../ir/ir.js";
import type { CEmitter } from "./c-emitter.js";
import { cDecl, vAdapters } from "./types.js";

export function dynPromiseAdapter(
  E: CEmitter,
  inner: IrType,
): string {
  if (!isRefCounted(inner) || inner.kind === "dyn") {
    throw new InternalCompilerError(
      `dynamic promise adapter requires a concrete reference type, got ${typeKey(inner)}`,
    );
  }
  const key = typeKey(inner);
  const existing = E.dynPromiseAdapters.get(key);
  if (existing) return existing;
  const sym = `sc_dpa_${E.dynPromiseAdapters.size}`;
  E.dynPromiseAdapters.set(key, sym);
  const sig = `static void ${sym}(ScrPromise *sc_dst, ScrPromise *sc_src)`;
  E.walkerProtos.push(`${sig}; /* checked-dynamic promise exit ${key} */`);
  let fulfill: string;
  if (inner.kind === "string") {
    fulfill = `scr_promise_fulfill_str(sc_dst, sc_v);`;
  } else {
    const rc = vAdapters(inner);
    fulfill = `scr_promise_fulfill_ref(sc_dst, sc_v, &${rc.retain}, &${rc.release}, ${E.traceArgC(inner)});`;
  }
  E.walkerDefs.push(
    `${sig} { /* checked-dynamic promise exit ${key} */`,
    `  ScrDyn *sc_d = (ScrDyn *)scr_promise_payload_ref(sc_src);`,
    `  ${cDecl(inner, "sc_v")} = ${E.dynCheckHelper(inner)}(sc_d, NULL);`,
    `  scr_dyn_release(sc_d);`,
    `  if (scr_exc_pending()) {`,
    `    scr_promise_reject_pending(sc_dst);`,
    `    return;`,
    `  }`,
    `  ${fulfill}`,
    `}`,
    ``,
  );
  return sym;
}
