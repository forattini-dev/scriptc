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
    context.unsupported("Error inspection beside user Error subclasses", expr.loc);
  }
  return `{ ${bindings} runtime::inspect_error(&${error}, ${recurse}, ${depth}) }`;
}
