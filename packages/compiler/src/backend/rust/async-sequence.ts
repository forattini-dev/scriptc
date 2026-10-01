import type { IrExpr } from "../../ir/ir.js";
import { mangleLocal } from "../mangle.js";
import type { RustAsyncControlEmitter, RustAsyncHandlers } from "./async-control.js";

/** Keep sequence temporaries in the value's continuation scope. A statement
 * segment would discard them before evaluating the sequence's result. */
export function emitAsyncProtectedSequenceValue(
  emitter: RustAsyncControlEmitter,
  expr: Extract<IrExpr, { kind: "seqExpr" }>,
  exitLocals: ReadonlySet<string>,
  handlers: RustAsyncHandlers,
  consume: (value: string) => void,
  index = 0,
): void {
  const context = emitter.context;
  const statement = expr.stmts[index];
  const next = (): void => emitAsyncProtectedSequenceValue(emitter, expr, exitLocals, handlers, consume, index + 1);
  if (statement === undefined) {
    emitter.emitAsyncProtectedValue(expr.result, exitLocals, handlers, consume);
    return;
  }
  if (statement.kind === "exprStmt") {
    emitter.emitAsyncProtectedValue(statement.expr, exitLocals, handlers, value => {
      context.line(`let _ = ${value};`);
      next();
    });
    return;
  }
  if (statement.kind === "varDecl" && statement.init !== null) {
    emitter.emitAsyncProtectedValue(statement.init, exitLocals, handlers, value => {
      const local = context.local(statement.localId, statement.loc);
      context.line(`let ${mangleLocal(local.id)}: runtime::JsCell<${context.rustType(local.type, statement.loc)}> = runtime::cell_new(${value});`);
      context.currentAsyncLocals()?.add(local.id);
      next();
    });
    return;
  }
  context.unsupported(`statement '${statement.kind}' in a protected async sequence expression`, statement.loc);
}
