import type { IrExpr, IrType } from "../../ir/nodes.js";
import { typeKey } from "../../ir/nodes.js";
import { mangleField } from "../mangle.js";
import type { RustExpressionContext } from "./expressions.js";
import { RUST_RECORD_OVERFLOW } from "./record-layout.js";

type IndexedRecordContext = Pick<RustExpressionContext,
  "dynTypeName" | "emitDynFromValue" | "isEdgeValue" | "needsClone" |
  "nextName" | "records" | "rustString" | "union" | "unionName" |
  "unionVariant" | "unsupported"
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
  if (shape === undefined) {
    context.unsupported(`indexed record read '${expr.shapeId}'`, expr.loc);
  }
  const indexValue = shape.indexValue;
  if (expr.key.type.kind !== "string") context.unsupported("indexed record key type", expr.loc);
  const object = context.nextName("sc_rt");
  const key = context.nextName("sc_rt");
  const bindings = `let ${object} = ${objectExpr}; let ${key} = ${keyExpr};`;
  if (shape.fields.length !== 0) {
    const record = context.nextName("sc_rt");
    const ownField = (type: IrType, field: string): string => {
      if (context.isEdgeValue(type)) {
        return `${field}.as_ref().expect("scriptc: cleared live indexed record field").clone()`;
      }
      return context.needsClone(type) ? `${field}.clone()` : field;
    };
    const surface = (type: IrType, value: string): string => {
      if (typeKey(type) === typeKey(expr.type)) return value;
      if (expr.type.kind === "dyn") return context.emitDynFromValue(type, value, expr.loc);
      if (expr.type.kind === "union") {
        const result = context.union(expr.type.unionId, expr.loc);
        if (type.kind === "union") {
          const stored = context.union(type.unionId, expr.loc);
          const arms = stored.arms.map((arm, tag) => {
            const resultTag = result.arms.findIndex((candidate) => typeKey(candidate) === typeKey(arm));
            if (resultTag < 0) context.unsupported("indexed record declared-field union retag", expr.loc);
            const from = `${context.unionName(stored.id)}::${context.unionVariant(tag)}`;
            const to = `${context.unionName(result.id)}::${context.unionVariant(resultTag)}`;
            return arm.kind === "undefinedT" || arm.kind === "nullT"
              ? `${from} => ${to}`
              : `${from}(payload) => ${to}(payload)`;
          }).join(", ");
          return `match ${value} { ${arms} }`;
        }
        const resultTag = result.arms.findIndex((candidate) => typeKey(candidate) === typeKey(type));
        if (resultTag < 0) context.unsupported("indexed record declared-field union result", expr.loc);
        const variant = `${context.unionName(result.id)}::${context.unionVariant(resultTag)}`;
        return type.kind === "undefinedT" || type.kind === "nullT" ? variant : `${variant}(${value})`;
      }
      context.unsupported(`indexed record declared-field result '${expr.shapeId}'`, expr.loc);
    };
    const declared = shape.fields.map((field) => {
      const stored = `${record}.${mangleField(field.name)}`;
      const value = surface(field.type, ownField(field.type, stored));
      return `if ${key}.as_ref() == "${context.rustString(field.name)}" { return ${value}; }`;
    }).join(" ");
    const miss = missingRecordValue(expr, context);
    if (indexValue === undefined) {
      return `{ ${bindings} ${object}.with(|${record}| { ${declared} ${miss} }) }`;
    }
    const overflow = `${record}.${RUST_RECORD_OVERFLOW}.as_ref().expect("scriptc: cleared live record overflow")`;
    const lookup = `runtime::map_get_by(${overflow}, &${key}, |left, right| left.as_ref() == right.as_ref())`;
    const present = surface(indexValue, "value");
    return `{ ${bindings} ${object}.with(|${record}| { ${declared} match ${lookup} { Some(value) => ${present}, None => ${miss}, } }) }`;
  }
  if (indexValue === undefined) context.unsupported(`indexed record read '${expr.shapeId}'`, expr.loc);
  const lookup = `runtime::map_get_by(&${object}, &${key}, |left, right| left.as_ref() == right.as_ref())`;
  if (indexValue.kind === "dyn" && expr.type.kind === "dyn") {
    return `{ ${bindings} ${lookup}.unwrap_or(${context.dynTypeName()}::Undefined) }`;
  }
  if (expr.type.kind === "union") {
    const union = context.union(expr.type.unionId, expr.loc);
    const undefinedTag = union.arms.findIndex((arm) => arm.kind === "undefinedT");
    if (undefinedTag < 0 && typeKey(indexValue) === typeKey(expr.type)) {
      return `{ ${bindings} ${lookup}.expect("scriptc: missing statically-known indexed record key") }`;
    }
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

function missingRecordValue(
  expr: Extract<IrExpr, { kind: "recordKeyGet" }>,
  context: IndexedRecordContext,
): string {
  if (expr.type.kind === "dyn") return `${context.dynTypeName()}::Undefined`;
  if (expr.type.kind === "union") {
    const union = context.union(expr.type.unionId, expr.loc);
    const undefinedTag = union.arms.findIndex((arm) => arm.kind === "undefinedT");
    if (undefinedTag >= 0) return `${context.unionName(union.id)}::${context.unionVariant(undefinedTag)}`;
  }
  return `panic!("scriptc: missing statically-known indexed record key")`;
}
