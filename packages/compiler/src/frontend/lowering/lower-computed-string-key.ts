import type * as ts from "../ts7/adapter.js";
import type { IrExpr } from "../../ir/ir.js";
import type { Lowerer } from "./lowerer.js";

/** The string-keyed object representations share one conversion boundary.
 * JS-residue keys use the existing jsval conversion, just like templates;
 * this does not admit symbol storage into a string-keyed record. */
export function lowerComputedStringKey(lowerer: Lowerer, name: ts.ComputedPropertyName): IrExpr {
  const key = lowerer.lowerExpr(name.expression);
  if (["f64", "bool", "dyn", "jsval"].includes(key.type.kind)) {
    return lowerer.ensureString(key, name);
  }
  if (key.type.kind !== "string") {
    lowerer.unsupported(
      "SC1090", name,
      `'${lowerer.fmt(key.type)}'-typed computed property keys (string, number, boolean, and unknown keys stringify)`,
    );
  }
  return key;
}
