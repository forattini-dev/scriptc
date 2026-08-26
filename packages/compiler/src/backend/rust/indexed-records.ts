import type { IrExpr } from "../../ir/nodes.js";
import { typeKey } from "../../ir/nodes.js";
import type { RustExpressionContext } from "./expressions.js";

type IndexedRecordContext = Pick<RustExpressionContext,
  "dynTypeName" | "nextName" | "records" | "union" |
  "unionName" | "unionVariant" | "unsupported"
>;

export function emitRustRecordKeyGet(
  expr: Extract<IrExpr, { kind: "recordKeyGet" }>,
  context: IndexedRecordContext,
  emitExpr: (expr: IrExpr) => string,
): string {
  return emitRustRecordKeyGetValues(expr, context, emitExpr(expr.obj), emitExpr(expr.key));
}

export function emitRustRecordKeyGetValues(
  expr: Extract<IrExpr, { kind: "recordKeyGet" }>,
  context: IndexedRecordContext,
  objectExpr: string,
  keyExpr: string,
): string {
  const shape = context.records.get(expr.shapeId);
  if (shape === undefined || shape.indexValue === undefined || shape.fields.length !== 0) {
    context.unsupported(`indexed record read '${expr.shapeId}'`, expr.loc);
  }
  const indexValue = shape.indexValue;
  if (expr.key.type.kind !== "string") context.unsupported("indexed record key type", expr.loc);
  const object = context.nextName("sc_rt");
  const key = context.nextName("sc_rt");
  const bindings = `let ${object} = ${objectExpr}; let ${key} = ${keyExpr};`;
  const lookup = `runtime::map_get_by(&${object}, &${key}, |left, right| left.as_ref() == right.as_ref())`;
  if (indexValue.kind === "dyn" && expr.type.kind === "dyn") {
    return `{ ${bindings} ${lookup}.unwrap_or(${context.dynTypeName()}::Undefined) }`;
  }
  if (expr.type.kind === "union") {
    const union = context.union(expr.type.unionId, expr.loc);
    const undefinedTag = union.arms.findIndex((arm) => arm.kind === "undefinedT");
    if (undefinedTag < 0) context.unsupported(`indexed record optional read result '${expr.shapeId}'`, expr.loc);
    const name = context.unionName(union.id);
    let present: string;
    if (indexValue.kind === "union") {
      if (indexValue.unionId === union.id) {
        present = "value";
      } else {
        const stored = context.union(indexValue.unionId, expr.loc);
        const arms = stored.arms.map((arm, tag) => {
          const resultTag = union.arms.findIndex((candidate) => typeKey(candidate) === typeKey(arm));
          if (resultTag < 0) context.unsupported("indexed record optional read retag", expr.loc);
          const from = `${context.unionName(stored.id)}::${context.unionVariant(tag)}`;
          const to = `${name}::${context.unionVariant(resultTag)}`;
          return arm.kind === "undefinedT" || arm.kind === "nullT"
            ? `${from} => ${to}`
            : `${from}(payload) => ${to}(payload)`;
        }).join(", ");
        present = `match value { ${arms} }`;
      }
    } else {
      const valueTag = union.arms.findIndex((arm) => typeKey(arm) === typeKey(indexValue));
      if (valueTag < 0) context.unsupported(`indexed record optional read result '${expr.shapeId}'`, expr.loc);
      present = `${name}::${context.unionVariant(valueTag)}(value)`;
    }
    return `{ ${bindings} match ${lookup} { Some(value) => ${present}, None => ${name}::${context.unionVariant(undefinedTag)}, } }`;
  }
  if (typeKey(indexValue) !== typeKey(expr.type)) {
    context.unsupported(`indexed record read result '${expr.shapeId}'`, expr.loc);
  }
  return `{ ${bindings} ${lookup}.expect("scriptc: missing statically-known indexed record key") }`;
}
