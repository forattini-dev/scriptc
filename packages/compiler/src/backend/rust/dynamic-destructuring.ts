import type { IrExpr, SrcLoc } from "../../ir/nodes.js";

type DynamicDestructureExpr = Extract<IrExpr, { kind: "dynDestrCheck" }>;

interface DynamicDestructuringContext {
  dynTypeName(): string;
  nextName(prefix: string): string;
  rustString(value: string): string;
  unsupported(kind: string, loc?: SrcLoc): never;
}

/** Emit RequireObjectCoercible for object destructuring over dyn/island values. */
export function emitRustDynamicDestructureCheck(
  expr: DynamicDestructureExpr,
  context: DynamicDestructuringContext,
  emitExpr: (expr: IrExpr) => string,
): string {
  if ((expr.value.type.kind !== "dyn" && expr.value.type.kind !== "jsval") ||
      expr.type.kind !== expr.value.type.kind) {
    context.unsupported("dynamic destructuring check shape", expr.loc);
  }
  const value = context.nextName("sc_rt");
  const dyn = context.dynTypeName();
  const prefix = expr.firstProp === undefined
    ? `Cannot destructure '${expr.spelling}' as it is `
    : `Cannot destructure property '${expr.firstProp}' of '${expr.spelling}' as it is `;
  const escaped = context.rustString(prefix);
  return `{ let ${value} = ${emitExpr(expr.value)}; match &${value} { ${dyn}::Undefined => runtime::throw_type_error("${escaped}undefined.".to_owned()), ${dyn}::Null => runtime::throw_type_error("${escaped}null.".to_owned()), _ => {}, } ${value} }`;
}
