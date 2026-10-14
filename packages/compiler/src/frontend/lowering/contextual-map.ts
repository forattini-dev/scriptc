import * as ts from "../ts7/adapter.js";
import type { Lowerer } from "./lowerer.js";

/** An empty implicit Map<any, any> can already map to Rust's dynamic map,
 * even when a JSDoc/contextual slot supplies useful K/V. Adopt only an
 * assignable supported context; explicit generics and entries keep their type. */
export function contextualMapConstruction(lowerer: Lowerer, expr: ts.NewExpression) {
  let tsType = lowerer.typeOf(expr);
  let mapped = lowerer.mapTypeOf(tsType);
  const implicitEmpty = (expr.arguments?.length ?? 0) === 0 &&
    (expr.typeArguments?.length ?? 0) === 0 && tsType.isTypeReference() &&
    lowerer.checker.getTypeArguments(tsType).length === 2 &&
    lowerer.checker.getTypeArguments(tsType).every(type => (type.flags & ts.TypeFlags.Any) !== 0);
  if (mapped?.kind !== "map" || implicitEmpty) {
    const context = lowerer.checker.getContextualType(expr);
    const contextual = context ? lowerer.mapTypeOf(context) : null;
    if (context && contextual?.kind === "map" && lowerer.checker.isTypeAssignableTo(tsType, context)) {
      tsType = context;
      mapped = contextual;
    }
  }
  return { tsType, mapped };
}
