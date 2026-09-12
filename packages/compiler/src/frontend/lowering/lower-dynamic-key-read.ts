import type * as ts from "../ts7/adapter.js";
import { DYN, STRING, type IrExpr } from "../../ir/ir.js";
import { locOf } from "../program.js";
import type { Lowerer } from "./lowerer.js";

/** Dynamic element reads use JS property keys and retain the stored value. */
export function lowerDynamicKeyRead(L: Lowerer, expr: ts.ElementAccessExpression, value: IrExpr, optional: boolean): IrExpr | null {
  const rawKey = L.lowerExpr(expr.argumentExpression);
  const key: IrExpr | null = rawKey.type.kind === "string"
    ? rawKey
    : rawKey.type.kind === "f64" || rawKey.type.kind === "bool" || rawKey.type.kind === "dyn"
      ? { kind: "toString", operand: rawKey, type: STRING, loc: rawKey.loc }
      : null;
  return key ? L.maybeNarrow({
    kind: "dynKeyGet", key, ...(optional ? { optional: true as const } : {}),
    value, type: DYN, loc: locOf(expr),
  }, expr) : null;
}
