import type { RustLibCallContext, RustLibCallExpr } from "./lib-calls.js";

export function emitRustInspectCall(
  expr: RustLibCallExpr,
  context: RustLibCallContext,
): string | null {
  const [errorExpr, recurseExpr, depthExpr] = expr.args;
  if (expr.fn !== "insp.error" || expr.args.length !== 3 ||
      errorExpr?.type.kind !== "object" || recurseExpr?.type.kind !== "f64" ||
      depthExpr?.type.kind !== "f64") return null;
  const error = context.nextTemporary();
  const recurse = context.nextTemporary();
  const depth = context.nextTemporary();
  const bindings = `let ${error} = ${context.emitExpr(errorExpr)}; let ${recurse} = ${context.emitExpr(recurseExpr)}; let ${depth} = ${context.emitExpr(depthExpr)};`;
  if (context.hasErrorClassRoots()) {
    // The frontend's dispatch helper already answered every user Error
    // subclass in this value's tree, so the builtin arm is the only one
    // a well-typed value can reach here (the DOMException precedent).
    return `{ ${bindings} match &${error} { ${context.errorValueName()}::Builtin(error) => runtime::inspect_error(error, ${recurse}, ${depth}), _ => unreachable!("scriptc invariant: inspect dispatch covered all user Error subclasses"), } }`;
  }
  return `{ ${bindings} runtime::inspect_error(&${error}, ${recurse}, ${depth}) }`;
}
