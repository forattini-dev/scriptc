import type { IrExpr, IrType, IrUnionDef, SrcLoc } from "../../ir/nodes.js";

type NullishExpr = Extract<IrExpr, { kind: "nullish" }>;

export interface RustNullishContext {
  dynTypeName(): string;
  isUnit(type: IrType): boolean;
  nextName(prefix: string): string;
  union(id: string, loc?: SrcLoc): IrUnionDef;
  unionName(id: string): string;
  unionVariant(tag: number): string;
  unsupported(kind: string, loc?: SrcLoc): never;
}

/** Emit lazy nullish coalescing for checked-dynamic and tagged-union values. */
export function emitRustNullish(
  expr: NullishExpr,
  context: RustNullishContext,
  emitExpr: (expr: IrExpr) => string,
): string {
  const left = context.nextName("sc_rt");
  if (expr.left.type.kind === "dyn") {
    if (expr.type.kind !== "dyn") context.unsupported("dynamic nullish with non-dynamic result", expr.loc);
    const dyn = context.dynTypeName();
    return `{ let ${left} = ${emitExpr(expr.left)}; if matches!(&${left}, ${dyn}::Undefined | ${dyn}::Null) { ${emitExpr(expr.right)} } else { ${left} } }`;
  }
  if (expr.left.type.kind !== "union") context.unsupported("nullish over a non-union", expr.loc);
  const union = context.union(expr.left.type.unionId, expr.loc);
  const unitPatterns = union.arms.flatMap((arm, tag) =>
    context.isUnit(arm) ? [`${context.unionName(union.id)}::${context.unionVariant(tag)}`] : []
  );
  if (unitPatterns.length === 0) context.unsupported("nullish union without a unit arm", expr.loc);
  if (expr.type.kind === "union" && expr.type.unionId === union.id) {
    return `{ let ${left} = ${emitExpr(expr.left)}; if matches!(&${left}, ${unitPatterns.join(" | ")}) { ${emitExpr(expr.right)} } else { ${left} } }`;
  }
  const arms = union.arms.map((arm, tag) => {
    const variant = `${context.unionName(union.id)}::${context.unionVariant(tag)}`;
    return context.isUnit(arm)
      ? `${variant} => ${emitExpr(expr.right)}`
      : `${variant}(payload) => payload`;
  }).join(", ");
  return `{ let ${left} = ${emitExpr(expr.left)}; match ${left} { ${arms} } }`;
}
