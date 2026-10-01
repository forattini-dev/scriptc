import { BOOL, type IrStmt, type SrcLoc } from "../../ir/ir.js";
import type { RustAsyncControlEmitter, RustAsyncHandlers } from "./async-control.js";

/** Preserve lexical block boundaries and reuse the protected canonical while
 * continuation for indexed array iteration with a synchronous loop header. */
export function emitAsyncProtectedBlockOrFor(
  emitter: RustAsyncControlEmitter,
  statement: IrStmt,
  remaining: readonly IrStmt[],
  exitLocals: ReadonlySet<string>,
  handlers: RustAsyncHandlers,
  loc: SrcLoc,
): boolean {
  if ((statement.kind !== "block" && statement.kind !== "for") ||
    !emitter.containsAsyncSuspension(statement)) return false;
  // Nested sequences emit unit returns in their completion handlers, never
  // directly into the enclosing closure returning AsyncCompletion.
  const context = emitter.context;
  const outerLocals = new Set(context.currentAsyncLocals() ?? []);
  const helper = context.nextName("sc_async_protected_block_for");
  context.line(`let ${helper} = || {`);
  context.pushIndent();
  emitter.withAsyncLocals(new Set(outerLocals), () =>
    emitBody(emitter, statement, remaining, exitLocals, handlers, loc));
  context.popIndent();
  context.line("};");
  context.line(`${helper}();`);
  return true;
}

function emitBody(
  emitter: RustAsyncControlEmitter,
  statement: Extract<IrStmt, { kind: "block" | "for" }>,
  remaining: readonly IrStmt[],
  exitLocals: ReadonlySet<string>,
  handlers: RustAsyncHandlers,
  loc: SrcLoc,
): void {
  if (statement.kind === "block") {
    const outerLocals = new Set(emitter.context.currentAsyncLocals() ?? []);
    emitter.emitAsyncProtectedSequence(statement.body, outerLocals, {
      fallthrough: () => emitter.withAsyncLocals(new Set(outerLocals), () =>
        emitter.emitAsyncProtectedSequence(remaining, exitLocals, handlers, loc)),
      returned: handlers.returned,
      thrown: handlers.thrown,
    }, loc);
    return;
  }
  if ((statement.labels?.length ?? 0) > 0 || emitter.containsLoopControl(statement.body)) {
    emitter.context.unsupported("loop control in a protected suspended async for", statement.loc);
  }
  if (emitter.containsAsyncSuspension(statement.init) || emitter.containsAsyncSuspension(statement.cond) ||
    emitter.containsAsyncSuspension(statement.update)) {
    emitter.context.unsupported("async suspension in protected for init, condition, or update", statement.loc);
  }
  const body: IrStmt[] = [];
  if (statement.cond !== null) body.push({
    kind: "if",
    cond: { kind: "unary", op: "!", operand: statement.cond, type: BOOL, loc: statement.loc },
    then: [{ kind: "break", loc: statement.loc }],
    else_: null,
    loc: statement.loc,
  });
  else body.push({
    kind: "if", cond: { kind: "boolLit", value: false, type: BOOL, loc: statement.loc },
    then: [{ kind: "break", loc: statement.loc }], else_: null, loc: statement.loc,
  });
  body.push(...statement.body);
  if (statement.update !== null) body.push(statement.update);
  emitter.emitAsyncProtectedSequence([
    ...(statement.init === null ? [] : [statement.init]),
    { kind: "while", cond: { kind: "boolLit", value: true, type: BOOL, loc: statement.loc }, body, loc: statement.loc },
    ...remaining,
  ], exitLocals, handlers, loc);
}
