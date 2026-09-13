import { type IrExpr, type SrcLoc, typeEquals } from "./ir.js";

export function validatePromiseView(expr: Extract<IrExpr, { kind: "libCall" }>, error: (message: string, loc: SrcLoc) => void): void {
  const source = expr.args[0]?.type;
  const map = expr.args[1];
  if (source?.kind !== "promise" || expr.type.kind !== "promise" || map?.kind !== "closure" ||
      map.captures.length !== 0 || map.type.kind !== "func" || map.type.rest || map.type.params.length !== 1 ||
      map.type.params[0] === undefined || !typeEquals(map.type.params[0], source.inner) || !typeEquals(map.type.ret, expr.type.inner)) {
    error("promise.view requires a Promise and a capture-free payload conversion matching its result", expr.loc);
  }
}
