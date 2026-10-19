import type { IrExpr } from "../../ir/ir.js";
import { recordViewPairs } from "../../ir/record-views.js";
import type { RustExpressionContext } from "./expression-context.js";
import { isSharedRecord, sharedRecordName } from "./shared-records.js";

export function emitRecordView(expr: Extract<IrExpr, { kind: "libCall" }>, context: RustExpressionContext, emit: (expr: IrExpr) => string): string {
  const source = expr.args[0]!;
  const unions = { get: (id: string) => context.union(id, expr.loc) };
  const pairs = recordViewPairs(source.type, expr.type, context.records, unions);
  if (!pairs) context.unsupported("record.view projection", expr.loc);
  const targets = expr.type.kind === "union" ? context.union(expr.type.unionId).arms : [expr.type];
  const value = context.nextName("sc_record_view");
  const project = (tag: number): string => {
    const target = targets[tag]!;
    if (target.kind !== "record" || !isSharedRecord(context.records.get(target.shapeId))) context.unsupported("record.view storage", expr.loc);
    const result = `{ let _ = ${value}.own_object("record.view"); ${sharedRecordName(target.shapeId)} { object: ${value}.object.clone() } }`;
    return expr.type.kind === "union" ? `${context.unionName(expr.type.unionId)}::${context.unionVariant(tag)}(${result})` : result;
  };
  if (source.type.kind !== "union") return `{ let ${value} = ${emit(source)}; ${project(pairs[0]![1])} }`;
  const name = context.unionName(source.type.unionId);
  return `match ${emit(source)} { ${pairs.map(([from, to]) => `${name}::${context.unionVariant(from)}(${value}) => ${project(to)}`).join(",")} }`;
}
