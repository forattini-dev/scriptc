import type { IrExpr, IrType } from "../../ir/nodes.js";
import { typeKey } from "../../ir/nodes.js";
import { mangleField } from "../mangle.js";
import type { RustExpressionContext } from "./expressions.js";
import { emitRustRecordKeyGetValues } from "./indexed-records.js";

type UnionKeyGetContext = Pick<RustExpressionContext,
  "dynTypeName" | "isEdgeValue" | "isUnit" | "needsClone" | "nextName" |
  "records" | "union" | "unionName" | "unionVariant" | "unsupported"
>;

export function emitRustUnionKeyGet(
  expr: Extract<IrExpr, { kind: "unionKeyGet" }>,
  context: UnionKeyGetContext,
  emitExpr: (expr: IrExpr) => string,
): string {
  const source = context.union(expr.unionId, expr.loc);
  const sourceName = context.unionName(source.id);
  const value = context.nextName("sc_rt");
  const key = context.nextName("sc_rt");
  const literal = expr.key.kind === "strLit" ? expr.key.value : null;

  const surface = (answer: string, answerType: IrType): string => {
    if (typeKey(answerType) === typeKey(expr.type)) return answer;
    if (expr.type.kind !== "union") {
      context.unsupported(`union keyed read result '${answerType.kind}'`, expr.loc);
    }
    const result = context.union(expr.type.unionId, expr.loc);
    const tag = result.arms.findIndex((arm) => typeKey(arm) === typeKey(answerType));
    if (tag < 0) context.unsupported(`union keyed read result arm '${answerType.kind}'`, expr.loc);
    const variant = `${context.unionName(result.id)}::${context.unionVariant(tag)}`;
    return context.isUnit(answerType) ? variant : `${variant}(${answer})`;
  };

  const arms = source.arms.map((arm, tag) => {
    const variant = `${sourceName}::${context.unionVariant(tag)}`;
    if (context.isUnit(arm)) {
      return `${variant} => ${surface("()", { kind: "undefinedT" })}`;
    }
    if (arm.kind === "array") {
      if (expr.key.type.kind !== "f64") context.unsupported("string-keyed union array read", expr.loc);
      return `${variant}(payload) => ${surface(`runtime::array_get(&payload, ${key})`, arm.elem)}`;
    }
    if (arm.kind !== "record") context.unsupported(`union keyed read arm '${arm.kind}'`, expr.loc);
    if (expr.key.type.kind !== "string") context.unsupported("number-keyed union record read", expr.loc);
    const shape = context.records.get(arm.shapeId);
    if (shape === undefined) context.unsupported(`unknown union keyed record '${arm.shapeId}'`, expr.loc);
    const field = literal === null ? undefined : shape.fields.find((candidate) => candidate.name === literal);
    if (field !== undefined) {
      const access = `record.${mangleField(field.name)}`;
      const answer = context.isEdgeValue(field.type)
        ? `${access}.as_ref().expect("scriptc: cleared live union field").clone()`
        : context.needsClone(field.type) ? `${access}.clone()` : access;
      return `${variant}(payload) => payload.with(|record| ${surface(answer, field.type)})`;
    }
    if (shape.indexValue === undefined) {
      context.unsupported(`union keyed record without an index signature '${arm.shapeId}'`, expr.loc);
    }
    const keyedExpr: Extract<IrExpr, { kind: "recordKeyGet" }> = {
      kind: "recordKeyGet",
      obj: expr.value,
      shapeId: arm.shapeId,
      key: expr.key,
      type: expr.type,
      loc: expr.loc,
    };
    const answer = emitRustRecordKeyGetValues(keyedExpr, context, "payload", `${key}.clone()`);
    return `${variant}(payload) => ${answer}`;
  }).join(", ");

  return `{ let ${value} = ${emitExpr(expr.value)}; let ${key} = ${emitExpr(expr.key)}; match ${value} { ${arms} } }`;
}
