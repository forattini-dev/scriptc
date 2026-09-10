import type * as ts from "../ts7/adapter.js";
import { DYN, type IrExpr, type IrType } from "../../ir/nodes.js";
import { nativeIndexedRecordValue } from "../../ir/native-record.js";
import { locOf } from "../program.js";
import type { Lowerer } from "./lowerer.js";

/** Checked dictionary refinements retain storage instead of width-copying it. */
export function lowerNativeRecordCast(L: Lowerer, expr: ts.Expression, value: IrExpr, target: IrType): IrExpr {
  const supported = (type: IrType) => nativeIndexedRecordValue(type, id => L.shapes.get(id), id => L.unions.get(id)) !== undefined;
  if (!supported(value.type) || !supported(target)) return L.coerceInto(expr, value, target);
  const loc = locOf(expr);
  return { kind: "dynCheck", value: { kind: "dynFrom", value, type: DYN, loc }, type: target, loc };
}
