import type { IrExpr } from "../../ir/ir.js";
import type { RustExpressionContext } from "./expression-context.js";

/** Evaluate the receiver once and preserve symbol keys through [[Get]].
 * Optional reads skip key evaluation when their receiver is nullish. */
export function emitRustDynamicKeyRead(
  context: RustExpressionContext, expr: Extract<IrExpr, { kind: "dynKeyGet" }>,
  emit: (value: IrExpr) => string,
): string {
  if (!["string", "symbol", "dyn"].includes(expr.key.type.kind)) context.unsupported("dynamic keyed read with an unsupported key", expr.loc);
  const value = context.nextName("sc_rt");
  const key = context.nextName("sc_rt");
  const dyn = context.dynTypeName();
  const property = expr.key.type.kind === "symbol" ? `${dyn}::Symbol(${key})` : key;
  const get = expr.key.type.kind === "string"
    ? `sc_dyn_key_get(&${value}, &${key}, false)`
    : `sc_dyn_get_key(&${value}, &${property}, &${value})`;
  const read = `{ let ${key} = ${emit(expr.key)}; ${get} }`;
  return `{ let ${value} = ${emit(expr.value)}; ${expr.optional === true
    ? `if matches!(&${value}, ${dyn}::Undefined | ${dyn}::Null) { ${dyn}::Undefined } else ${read}` : read} }`;
}
