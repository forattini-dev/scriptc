import type { IrStmt } from "../../ir/ir.js";
import { mangleLocal } from "../mangle.js";
import type { RustAsyncControlEmitter } from "./async-control.js";

/** Every rejected await and every throwing segment enters the same catch body.
 * Emit it once instead of duplicating its continuations at each failure edge. */
export function emitAsyncTryCatch(
  emitter: RustAsyncControlEmitter,
  stmt: Extract<IrStmt, { kind: "tryCatch" }>,
  remaining: readonly IrStmt[],
  onComplete: (() => void) | null,
): void {
  const context = emitter.context;
  const outerLocals = new Set(context.currentAsyncLocals() ?? []);
  const resume = emitter.emitAsyncResumeHelper(remaining, onComplete, outerLocals, stmt.loc, "try_continue");
  let thrown = (reason: string): void => emitter.emitAsyncCatch(stmt, [], outerLocals, reason, resume);
  if (stmt.catchBody !== null) {
    const result = context.currentAsyncResult();
    const fn = context.currentFunction();
    if (result === null || fn?.async !== true) {
      return context.unsupported("async catch outside an async function", stmt.loc);
    }
    const helper = context.nextName("sc_async_catch");
    const reason = context.nextName("sc_async_reason");
    const locals = [...outerLocals].map(id => context.local(id, stmt.loc));
    const extras = [...context.asyncFrameExtras()];
    const params = [
      `${result}: runtime::JsPromise<${context.rustType(fn.returnType, stmt.loc)}>`,
      ...extras.map(extra => `${extra.name}: ${extra.rustType}`),
      ...locals.map(local => `${mangleLocal(local.id)}: runtime::JsCell<${context.rustType(local.type, stmt.loc)}>`),
      `${reason}: runtime::Caught`,
    ];
    context.line(`fn ${helper}(${params.join(", ")}) {`);
    context.pushIndent();
    emitter.withAsyncLocals(new Set(outerLocals), () => emitter.emitAsyncCatch(stmt, [], outerLocals, reason, resume));
    context.popIndent();
    context.line("}");
    thrown = value => context.line(`${helper}(${[
      `${result}.clone()`,
      ...extras.map(extra => `${extra.name}.clone()`),
      ...locals.map(local => `${mangleLocal(local.id)}.clone()`),
      value,
    ].join(", ")});`);
  }
  emitter.emitAsyncProtectedSequence(stmt.tryBody, outerLocals, {
    fallthrough: () => emitter.emitAsyncFinally(stmt, [], outerLocals, { kind: "fallthrough" }, resume),
    returned: (value, adopt = false) => emitter.emitAsyncFinally(stmt, [], outerLocals, { kind: "return", value, adopt }, resume),
    thrown,
  }, stmt.loc);
}
