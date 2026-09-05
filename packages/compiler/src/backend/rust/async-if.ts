import type { IrStmt } from "../../ir/nodes.js";
import type { RustAsyncControlEmitter } from "./async-control.js";

/** `if` with a suspension in a branch (or loop control under a suspended
 * loop) in an ordinary async sequence: the remainder becomes a resume
 * helper both branches continue into. Split from async-control.ts (the
 * 1200-line ceiling). */
export function emitAsyncIf(
  emitter: RustAsyncControlEmitter,
  stmt: Extract<IrStmt, { kind: "if" }>,
  remaining: readonly IrStmt[],
  onComplete: (() => void) | null,
): void {
  const outerLocals = new Set(emitter.context.currentAsyncLocals() ?? []);
  const resume = emitter.emitAsyncResumeHelper(remaining, onComplete, outerLocals, stmt.loc, "if_continue");
  const emitBranches = (condition: string): void => {
    emitter.context.line(`if ${condition} {`);
    emitter.context.pushIndent();
    emitter.withAsyncLocals(new Set(outerLocals), () => emitter.emitAsyncStatements(stmt.then, resume));
    emitter.context.popIndent();
    emitter.context.line("} else {");
    emitter.context.pushIndent();
    const elseBody = stmt.else_;
    if (elseBody === null) {
      resume();
    } else {
      emitter.withAsyncLocals(new Set(outerLocals), () => emitter.emitAsyncStatements(elseBody, resume));
    }
    emitter.context.popIndent();
    emitter.context.line("}");
  };
  if (emitter.containsAsyncSuspension(stmt.cond)) {
    emitter.context.emitAsyncValue(stmt.cond, emitBranches);
    return;
  }
  emitBranches(emitter.context.emitExpr(stmt.cond));
}
