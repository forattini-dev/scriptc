import type * as ts from "../ts7/adapter.js";
import { DYN, STRING, type IrExpr } from "../../ir/ir.js";
import { locOf } from "../program.js";
import type { Lowerer } from "./lowerer.js";

/** Dynamic element reads use JS property keys and retain the stored value. */
export function lowerDynamicKeyRead(L: Lowerer, expr: ts.ElementAccessExpression, value: IrExpr, optional: boolean): IrExpr | null {
  const rawKey = L.lowerExpr(expr.argumentExpression);
  const key: IrExpr | null = ["string", "symbol", "dyn"].includes(rawKey.type.kind)
    ? rawKey
    : rawKey.type.kind === "f64" || rawKey.type.kind === "bool"
      ? { kind: "toString", operand: rawKey, type: STRING, loc: rawKey.loc }
      : rawKey.type.kind === "union" && L.unions.get(rawKey.type.unionId)?.arms.every(arm => arm.kind === "string" || arm.kind === "symbol")
        ? { kind: "dynFrom", value: rawKey, type: DYN, loc: rawKey.loc }
      : null;
  return key ? L.maybeNarrow({
    kind: "dynKeyGet", key, ...(optional ? { optional: true as const } : {}),
    value, type: DYN, loc: locOf(expr),
  }, expr) : null;
}

/** Native Proxy reads must retain symbol identity; class hidden slots are
 * handled before this path. Ordinary symbol storage remains a runtime fence. */
export function lowerNativeSymbolKeyRead(L: Lowerer, expr: ts.ElementAccessExpression, optional: boolean): IrExpr | null {
  const object = L.lowerExpr(expr.expression);
  const value: IrExpr | null = object.type.kind === "dyn" ? object
    : object.type.kind === "record" && L.dynConvertible(object.type)
      ? { kind: "dynFrom", value: object, type: DYN, loc: object.loc } : null;
  return value ? lowerDynamicKeyRead(L, expr, value, optional) : null;
}
