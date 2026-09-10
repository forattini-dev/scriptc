import type { IrLibFn } from "../../ir/nodes.js";
import type { IrNumericCoercionFn } from "../../ir/numeric-coercion.js";

export function isNumericCoercionFn(fn: IrLibFn): fn is IrNumericCoercionFn {
  return ["num.parseInt", "num.parseFloat", "num.fromString", "num.isNaN", "dyn.toStringCoerce", "dyn.toNumberCoerce", "dyn.compare"].includes(fn);
}

/** Arguments already evaluated left to right. The caller owns pending-error
 * checks and releases; dynamic coercion hooks borrow their receiver. */
export function emitNumericCoercion(fn: IrNumericCoercionFn, args: readonly string[]): string {
  switch (fn) {
    case "num.parseInt": return `scr_parse_int(${args[0]}, ${args[1]})`;
    case "num.parseFloat": return `scr_parse_float(${args[0]})`;
    case "num.fromString": return `scr_string_to_number(${args[0]})`;
    case "dyn.toStringCoerce": return `scr_dyn_string_coerce_js(${args[0]})`;
    case "dyn.toNumberCoerce": return `scr_dyn_number_coerce_value(${args[0]})`;
    case "dyn.compare": return `scr_dyn_compare(${args[0]}, ${args[1]})`;
    case "num.isNaN": return `(bool)isnan(${args[0]})`;
  }
}
