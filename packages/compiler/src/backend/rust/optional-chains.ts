import type { IrExpr } from "../../ir/nodes.js";
import type { RustExpressionContext } from "./expressions.js";

type OptionalChainContext = Pick<RustExpressionContext,
  "chainValues" | "dynTypeName" | "isUnit" | "nextName" |
  "union" | "unionName" | "unionVariant" | "unsupported"
>;

export function emitRustOptionalChain(
  expr: Extract<IrExpr, { kind: "optChain" }>,
  context: OptionalChainContext,
  emitExpr: (expr: IrExpr) => string,
): string {
  if (context.chainValues.has(expr.id)) context.unsupported(`nested optional chain '${expr.id}'`, expr.loc);
  const receiver = context.nextName("sc_chain");
  context.chainValues.set(expr.id, receiver);
  let body: string;
  try {
    body = emitExpr(expr.body);
  } finally {
    context.chainValues.delete(expr.id);
  }

  if (expr.receiver.type.kind === "dyn" || expr.receiver.type.kind === "jsval") {
    if (expr.type.kind !== expr.receiver.type.kind && expr.type.kind !== "void") {
      context.unsupported("dynamic optional chain result", expr.loc);
    }
    const dyn = context.dynTypeName();
    const binding = `let ${receiver} = ${emitExpr(expr.receiver)};`;
    const nullish = `matches!(&${receiver}, ${dyn}::Undefined | ${dyn}::Null)`;
    return expr.type.kind === "void"
      ? `{ ${binding} if !${nullish} { let _ = ${body}; } }`
      : `{ ${binding} if ${nullish} { ${dyn}::Undefined } else { ${body} } }`;
  }

  if (expr.receiver.type.kind !== "union") context.unsupported("optional chain over a non-union", expr.loc);
  const source = context.union(expr.receiver.type.unionId, expr.loc);
  const narrowedTags = source.arms.flatMap((arm, tag) => context.isUnit(arm) ? [] : [tag]);
  const unitTags = source.arms.flatMap((arm, tag) => context.isUnit(arm) ? [tag] : []);
  if (narrowedTags.length !== 1 || unitTags.length === 0) context.unsupported("optional chain union shape", expr.loc);
  let absent: string;
  if (expr.type.kind === "void") {
    absent = "()";
  } else if (expr.type.kind === "dyn" || expr.type.kind === "jsval") {
    absent = `${context.dynTypeName()}::Undefined`;
  } else {
    if (expr.type.kind !== "union") context.unsupported("optional chain result without undefined union", expr.loc);
    const result = context.union(expr.type.unionId, expr.loc);
    const undefinedTag = result.arms.findIndex((arm) => arm.kind === "undefinedT");
    if (undefinedTag < 0) context.unsupported("optional chain result without undefined arm", expr.loc);
    absent = `${context.unionName(result.id)}::${context.unionVariant(undefinedTag)}`;
  }
  const sourceName = context.unionName(source.id);
  const arms = source.arms.map((arm, tag) => {
    const variant = `${sourceName}::${context.unionVariant(tag)}`;
    return context.isUnit(arm) ? `${variant} => ${absent}` : `${variant}(${receiver}) => ${body}`;
  }).join(", ");
  return `match ${emitExpr(expr.receiver)} { ${arms} }`;
}
