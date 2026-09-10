import { DYN, F64, STRING, BOOL, type IrType } from "./nodes.js";

/** The parsers consume strings after source argument evaluation and ToString.
 * parseInt uses the longest digit prefix and ToInt32(radix); parseFloat uses
 * the longest decimal prefix. fromString accepts the entire StringNumericLiteral,
 * including JS whitespace, empty strings, Infinity and unsigned base prefixes.
 * These string operations borrow their input and never throw.
 * Dynamic conversions run OrdinaryToPrimitive with the corresponding hint,
 * bind the source receiver as this, and propagate hook failures. */
export type IrNumericCoercionFn =
  | "num.parseInt" | "num.parseFloat" | "num.fromString" | "num.isNaN"
  | "dyn.toStringCoerce" | "dyn.toNumberCoerce" | "dyn.compare";

export const NUMERIC_COERCION_SIGS: Record<IrNumericCoercionFn, { argTypes: IrType[]; result: IrType }> = {
  "num.parseInt": { argTypes: [STRING, F64], result: F64 },
  "num.parseFloat": { argTypes: [STRING], result: F64 },
  "num.fromString": { argTypes: [STRING], result: F64 },
  "num.isNaN": { argTypes: [F64], result: BOOL },
  "dyn.toStringCoerce": { argTypes: [DYN], result: STRING },
  "dyn.toNumberCoerce": { argTypes: [DYN], result: F64 },
  // ToPrimitive(number) left then right; UTF-16 string order or numeric order.
  // -1/0/+1, with NaN for unordered values. Arguments evaluate before hooks.
  "dyn.compare": { argTypes: [DYN, DYN], result: F64 },
};
