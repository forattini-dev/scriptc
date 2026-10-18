import type { IrExpr } from "../../ir/ir.js";
import { mangleField } from "../mangle.js";
import type { RustExpressionContext } from "./expression-context.js";
import { isSharedRecord, sharedRecordName } from "./shared-records.js";
import { rustJsString } from "./string-literals.js";

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
