import type * as ts from "../ts7/adapter.js";
import { DYN, STRING, type IrExpr } from "../../ir/ir.js";
import type { Lowerer } from "./lowerer.js";

/** String(symbol) alone uses SymbolDescriptiveString. Template interpolation,
 * concatenation and an object's primitive Symbol result still use ToString. */
export function lowerStringConstructor(L: Lowerer, value: IrExpr, node: ts.Node): IrExpr {
  if (value.type.kind === "symbol") return { kind: "libCall", fn: "sym.toString", args: [value], type: STRING, loc: value.loc };
  if (value.type.kind === "union" && L.unions.get(value.type.unionId)?.arms.some(arm => arm.kind === "symbol") && L.dynConvertible(value.type)) {
    value = { kind: "dynFrom", value, type: DYN, loc: value.loc };
  }
  return value.type.kind === "dyn"
    ? { kind: "libCall", fn: "dyn.stringConstructor", args: [value], type: STRING, loc: value.loc }
    : L.ensureString(value, node);
}
