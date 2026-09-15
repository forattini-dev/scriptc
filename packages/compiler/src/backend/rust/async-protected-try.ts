import type { IrStmt, SrcLoc } from "../../ir/ir.js";
import { mangleLocal } from "../mangle.js";
import type { RustAsyncControlContext, RustAsyncHandlers } from "./async-control.js";

type ProtectedSequenceEmitter = (
  statements: readonly IrStmt[],
  exitLocals: ReadonlySet<string>,
  handlers: RustAsyncHandlers,
  loc: SrcLoc,
) => void;

type AsyncLocalsEmitter = <T>(locals: Set<string>, emit: () => T) => T;

type PendingCompletion =
  | { readonly kind: "fallthrough" }
  | { readonly kind: "return"; readonly value: string }
  | { readonly kind: "throw"; readonly reason: string };

/** A suspending try/catch/finally nested inside an async protected segment (`await using` chains, a try inside a
 * try): each body is its own protected sequence, the finally runs on every completion, and a completion raised in
 * the finally replaces the pending one — resource cleanup throwing over a thrown body completes with a
 * SuppressedError, the sync lane's rule. */
export function emitAsyncProtectedTry(
  context: RustAsyncControlContext,
  emitSequence: ProtectedSequenceEmitter,
  withAsyncLocals: AsyncLocalsEmitter,
  stmt: Extract<IrStmt, { kind: "tryCatch" }>,
  remaining: readonly IrStmt[],
  exitLocals: ReadonlySet<string>,
  handlers: RustAsyncHandlers,
  loc: SrcLoc,
): void {
  const outerLocals = new Set(context.currentAsyncLocals() ?? []);
  const resume = (pending: PendingCompletion): void => withAsyncLocals(new Set(outerLocals), () => {
    if (pending.kind === "fallthrough") emitSequence(remaining, exitLocals, handlers, loc);
    else if (pending.kind === "return") handlers.returned(pending.value);
    else handlers.thrown(pending.reason);
  });
  const runFinally = (pending: PendingCompletion): void => {
    const finallyBody = stmt.finallyBody;
    if (finallyBody === null) {
      resume(pending);
      return;
    }
    withAsyncLocals(new Set(outerLocals), () => emitSequence(finallyBody, exitLocals, {
      fallthrough: () => resume(pending),
      returned: (value) => resume({ kind: "return", value }),
      thrown: (reason) => resume({
        kind: "throw",
        reason: stmt.suppressFinallyErrors && pending.kind === "throw" ? "runtime::suppressed_error_caught()" : reason,
      }),
    }, stmt.loc));
  };
  const runCatch = (reason: string): void => {
    const catchBody = stmt.catchBody;
    if (catchBody === null) {
      runFinally({ kind: "throw", reason });
      return;
    }
    withAsyncLocals(new Set(outerLocals), () => {
      if (stmt.catchLocalId === null) {
        context.line(`let _ = ${reason};`);
      } else {
        const local = context.local(stmt.catchLocalId, stmt.loc);
        context.line(`let ${mangleLocal(local.id)}: runtime::JsCell<runtime::Caught> = runtime::cell_new(${reason});`);
        context.currentAsyncLocals()?.add(local.id);
      }
      emitSequence(catchBody, exitLocals, {
        fallthrough: () => runFinally({ kind: "fallthrough" }),
        returned: (value) => runFinally({ kind: "return", value }),
        thrown: (catchReason) => runFinally({ kind: "throw", reason: catchReason }),
      }, stmt.loc);
    });
  };
  // Like the protected if: the nested sequence runs from a unit closure, so its completion handlers never emit a
  // bare `return;` into the enclosing segment (which answers an AsyncCompletion).
  const helper = context.nextName("sc_async_protected_try");
  context.line(`let ${helper} = || {`);
  context.pushIndent();
  withAsyncLocals(new Set(outerLocals), () => emitSequence(stmt.tryBody, exitLocals, {
    fallthrough: () => runFinally({ kind: "fallthrough" }),
    returned: (value) => runFinally({ kind: "return", value }),
    thrown: (reason) => runCatch(reason),
  }, stmt.loc));
  context.popIndent();
  context.line("};");
  context.line(`${helper}();`);
}
