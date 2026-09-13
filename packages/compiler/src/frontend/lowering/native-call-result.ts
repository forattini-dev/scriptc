import * as ts from "../ts7/adapter.js";
import type { IrExpr } from "../../ir/ir.js";
import { isJsSourceFile } from "../program.js";
import type { Lowerer } from "./lowerer.js";

/** Native dynamic dispatch erases the ABI result, not a checked TS scalar
 * return type. Restore it at the call boundary so enclosing operators see
 * the declared type. Composite extraction needs a separate aliasing contract. */
export function checkNativeCallResult(lowerer: Lowerer, expr: ts.CallExpression, value: IrExpr): IrExpr {
  if (value.type.kind !== "dyn" || isJsSourceFile(expr.getSourceFile())) return value;
  // The enclosing Number(...) or assignment may supply a contextual type;
  // only the resolved callee signature describes this call's actual result.
  const signature = lowerer.checker.getResolvedSignature(expr);
  if (!signature) return value;
  const source = lowerer.checker.getReturnTypeOfSignature(signature);
  if (source.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return value;
  const type = lowerer.mapTypeOf(source);
  if (type && ["string", "f64", "bool", "bigint", "date"].includes(type.kind)) {
    return { kind: "dynCheck", value, type, loc: value.loc };
  }
  return value;
}
