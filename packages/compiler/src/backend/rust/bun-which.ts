import type { IrExpr } from "../../ir/ir.js";
import type { RustLibCallContext, RustLibCallExpr } from "./lib-calls.js";

export function emitRustBunWhich(expr: RustLibCallExpr, context: RustLibCallContext): string | null {
  if (expr.fn !== "bun.which") return null;
  if (expr.args.length !== 3 || expr.args[0]?.type.kind !== "string" || expr.type.kind !== "union") context.unsupported("Bun.which signature", expr.loc);
  const optional = (arg: IrExpr | undefined): string => {
    if (!arg || arg.type.kind !== "union") context.unsupported("Bun.which optional string", expr.loc);
    const union = context.union(arg.type.unionId, expr.loc);
    const string = union.arms.findIndex(arm => arm.kind === "string"), absent = union.arms.findIndex(arm => arm.kind === "undefinedT");
    if (union.arms.length !== 2 || string < 0 || absent < 0) context.unsupported("Bun.which optional string", expr.loc);
    const name = context.unionName(union.id);
    return `match ${context.emitExpr(arg)} { ${name}::${context.unionVariant(string)}(value) => Some(value), ${name}::${context.unionVariant(absent)} => None, }`;
  };
  const union = context.union(expr.type.unionId, expr.loc);
  const string = union.arms.findIndex(arm => arm.kind === "string"), absent = union.arms.findIndex(arm => arm.kind === "nullT");
  if (union.arms.length !== 2 || string < 0 || absent < 0) context.unsupported("Bun.which nullable string", expr.loc);
  const command = context.nextTemporary(), path = context.nextTemporary(), cwd = context.nextTemporary(), name = context.unionName(union.id);
  return `{ let ${command} = ${context.emitExpr(expr.args[0])}; let ${path} = ${optional(expr.args[1])}; let ${cwd} = ${optional(expr.args[2])}; match runtime::bun_which(&${command}, ${path}.as_ref(), ${cwd}.as_ref()) { Some(value) => ${name}::${context.unionVariant(string)}(value), None => ${name}::${context.unionVariant(absent)}, } }`;
}
