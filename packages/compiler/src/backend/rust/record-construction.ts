import type { IrExpr } from "../../ir/ir.js";
import { mangleField } from "../mangle.js";
import type { RustExpressionContext } from "./expression-context.js";
import { isSharedRecord, sharedRecordName } from "./shared-records.js";
import { rustJsString } from "./string-literals.js";

/** Define data slots directly; CopyDataProperties never invokes a prototype setter. */
export function emitRecordOwnValues(expr: Extract<IrExpr, { kind: "libCall" }>, context: RustExpressionContext, emit: (expr: IrExpr) => string): string {
  const value = context.nextName("sc_own_values");
  const dyn = context.dynTypeName();
  if (expr.fn === "record.setOwn") {
    const key = context.nextName("sc_own_key");
    const field = context.nextName("sc_own_field");
    return `{ let ${value} = ${emit(expr.args[0]!)}; let ${key} = ${emit(expr.args[1]!)}; let ${field} = ${emit(expr.args[2]!)}; match ${value} { ${dyn}::Object(object) => runtime::map_set_by(&object, ${key}, ${field}, |a,b| a == b), _ => runtime::throw_type_error("scriptc: own-value plan must be a native object".to_owned()) }; () }`;
  }
  const shape = expr.type.kind === "record" ? context.records.get(expr.type.shapeId) : undefined;
  if (!shape || !isSharedRecord(shape) || shape.tuple || shape.indexValue) context.unsupported("record.fromOwn layout", expr.loc);
  const template = context.nextName("sc_template");
  const output = context.nextName("sc_own_record");
  const result = context.nextName("sc_complete_record");
  const required = shape.fields.filter(field => field.type.kind !== "undefinedT" && !(field.type.kind === "union" && context.union(field.type.unionId).arms.some(arm => arm.kind === "undefinedT")));
  const checks = required.map(field => `if !runtime::map_has_by(&${output}, &${rustJsString(field.name, value => context.rustString(value))}, |a,b| a == b) { runtime::throw_type_error("scriptc: missing required record own key".to_owned()); }`).join(" ");
  const types = shape.fields.map(field => `let _ = ${result}.get_${mangleField(field.name)}();`).join(" ");
  return `{ let ${template} = ${emit(expr.args[0]!)}; let ${value} = ${emit(expr.args[1]!)}; let _ = ${template}.own_object("record.fromOwn"); let ${dyn}::Object(object) = ${value} else { runtime::throw_type_error("scriptc: own-value plan must be a native object".to_owned()) }; let ${output} = runtime::map_new(); let mut index = 0.0; while index < runtime::map_iter_count(&object) { if runtime::map_iter_live(&object,index) { runtime::map_set_by(&${output}, runtime::map_iter_key(&object,index), runtime::map_iter_value(&object,index), |a,b| a == b); } index += 1.0; } ${checks} let ${result} = ${sharedRecordName(shape.id)} { object: ${dyn}::Object(${output}) }; ${types} ${result} }`;
}

/** Values are captured before this operation; publish only a complete record. */
export function emitRecordOwnConstruction(expr: Extract<IrExpr, { kind: "libCall" }>, context: RustExpressionContext, emit: (expr: IrExpr) => string): string {
  const shape = expr.type.kind === "record" ? context.records.get(expr.type.shapeId) : undefined;
  if (!shape || !isSharedRecord(shape) || shape.tuple || shape.indexValue) context.unsupported("record.cloneOwn layout", expr.loc);
  const source = context.nextName("sc_source");
  const keys = context.nextName("sc_keys");
  const output = context.nextName("sc_record");
  const index = context.nextName("sc_index");
  const key = context.nextName("sc_key");
  const js = (text: string) => rustJsString(text, value => context.rustString(value));
  const arms = shape.fields.map(field => `key if key == ${js(field.name)} => ${context.emitDynFromValue(field.type, `${source}.get_${mangleField(field.name)}()`, expr.loc)}`).join(", ");
  const required = shape.fields.filter(field => field.type.kind !== "undefinedT" && !(field.type.kind === "union" && context.union(field.type.unionId, expr.loc).arms.some(arm => arm.kind === "undefinedT")));
  const checks = required.map(field => `if !runtime::map_has_by(&${output}, &${js(field.name)}, |a, b| a == b) { runtime::throw_type_error("scriptc: missing required record own key".to_owned()); }`).join(" ");
  return `{ let ${source} = ${emit(expr.args[0]!)}; let ${keys} = ${emit(expr.args[1]!)}; let _ = ${source}.own_object("record.cloneOwn"); let ${output} = runtime::map_new(); let mut ${index} = 0.0; while ${index} < runtime::array_len(&${keys}) { let ${key} = runtime::array_get(&${keys}, ${index}); if runtime::map_has_by(&${output}, &${key}, |a, b| a == b) { runtime::throw_type_error("scriptc: invalid record own-key plan".to_owned()); } let value = match ${key}.clone() { ${arms}${arms ? "," : ""} _ => runtime::throw_type_error("scriptc: invalid record own-key plan".to_owned()) }; runtime::map_set_by(&${output}, ${key}, value, |a, b| a == b); ${index} += 1.0; } ${checks} ${sharedRecordName(shape.id)} { object: ${context.dynTypeName()}::Object(${output}) } }`;
}
