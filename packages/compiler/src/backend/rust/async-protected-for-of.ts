import type { IrStmt, SrcLoc } from "../../ir/ir.js";
import { mangleLocal } from "../mangle.js";
import type { RustAsyncControlEmitter, RustAsyncFrameExtra, RustAsyncHandlers } from "./async-control.js";

/** A suspending for-of inside try/catch/finally: the iteration helper
 * takes the array and index as parameters (frame extras for every helper
 * nested in its body), each iteration runs the body as a protected
 * segment, and fallthrough continues with the next index. Split from
 * async-control.ts (the 1200-line ceiling). */
export function emitAsyncProtectedForOf(
  emitter: RustAsyncControlEmitter,
  stmt: Extract<IrStmt, { kind: "forOf" }>,
  remaining: readonly IrStmt[],
  exitLocals: ReadonlySet<string>,
  handlers: RustAsyncHandlers,
  loc: SrcLoc,
  arrayValue?: string,
): void {
  const result = emitter.context.currentAsyncResult();
  const fn = emitter.context.currentFunction();
  if (result === null || fn?.async !== true) {
    emitter.context.unsupported("protected async for-of outside an async function", stmt.loc);
  }
  if ((stmt.labels?.length ?? 0) > 0) emitter.context.unsupported("labeled protected async for-of", stmt.loc);
  if (stmt.iterable.type.kind !== "array") emitter.context.unsupported("protected async for-of over a non-array", stmt.loc);
  if (arrayValue === undefined && emitter.containsAsyncSuspension(stmt.iterable)) {
    emitter.emitAsyncProtectedValue(stmt.iterable, exitLocals, handlers, (value) =>
      emitter.emitAsyncProtectedForOf(stmt, remaining, exitLocals, handlers, loc, value));
    return;
  }
  if (emitter.containsLoopControl(stmt.body)) {
    emitter.context.unsupported("break or continue in a protected suspended async for-of", stmt.loc);
  }

  const loopLocals = new Set(emitter.context.currentAsyncLocals() ?? []);
  const locals = [...loopLocals].map((localId) => emitter.context.local(localId, stmt.loc));
  const local = emitter.context.local(stmt.localId, stmt.loc);
  const helper = emitter.context.nextName("sc_async_protected_for_of");
  const array = emitter.context.nextName("sc_async_for_of_array");
  const index = emitter.context.nextName("sc_async_for_of_index");
  const arrayType = emitter.context.rustType(stmt.iterable.type, stmt.loc);
  const frameExtras = [...emitter.context.asyncFrameExtras()];
  const params = [
    `${result}: runtime::JsPromise<${emitter.context.rustType(fn.returnType, stmt.loc)}>`,
    ...frameExtras.map((extra) => `${extra.name}: ${extra.rustType}`),
    `${array}: ${arrayType}`,
    `${index}: f64`,
    ...locals.map((candidate) =>
      `${mangleLocal(candidate.id)}: runtime::JsCell<${emitter.context.rustType(candidate.type, stmt.loc)}>`
    ),
  ];
  const call = (nextIndex: string) => `${helper}(${[
    `${result}.clone()`,
    ...frameExtras.map((extra) => `${extra.name}.clone()`),
    `${array}.clone()`,
    nextIndex,
    ...locals.map((candidate) => `${mangleLocal(candidate.id)}.clone()`),
  ].join(", ")});`;

  emitter.context.line(`let ${array} = ${arrayValue ?? emitter.context.emitExpr(stmt.iterable)};`);
  emitter.context.line(`fn ${helper}(${params.join(", ")}) {`);
  emitter.context.pushIndent();
  const loopFrameExtras: RustAsyncFrameExtra[] = [
    { name: array, rustType: emitter.context.rustType(stmt.iterable.type, stmt.loc) },
    { name: index, rustType: "f64" },
  ];
  emitter.context.withAsyncFrameExtras(loopFrameExtras, () => emitter.withAsyncLocals(new Set(loopLocals), () => {
    emitter.context.line(`if ${index} < runtime::array_len(&${array}) {`);
    emitter.context.pushIndent();
    emitter.context.line(`let ${mangleLocal(local.id)}: runtime::JsCell<${emitter.context.rustType(local.type, stmt.loc)}> = runtime::cell_new(runtime::array_get(&${array}, ${index}));`);
    const iterationLocals = new Set(loopLocals);
    iterationLocals.add(local.id);
    emitter.withAsyncLocals(iterationLocals, () => {
      emitter.emitAsyncProtectedSequence(stmt.body, exitLocals, {
        fallthrough: () => emitter.withAsyncLocals(new Set(loopLocals), () => {
          emitter.context.line(call(`${index} + 1.0_f64`));
          emitter.context.line("return;");
        }),
        returned: handlers.returned,
        thrown: handlers.thrown,
      }, loc);
    });
    emitter.context.popIndent();
    emitter.context.line("} else {");
    emitter.context.pushIndent();
    emitter.withAsyncLocals(new Set(loopLocals), () => {
      emitter.emitAsyncProtectedSequence(remaining, exitLocals, handlers, loc);
    });
    emitter.context.popIndent();
    emitter.context.line("}");
  }));
  emitter.context.popIndent();
  emitter.context.line("}");
  emitter.context.line(call("0.0_f64"));
}
