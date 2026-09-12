import { rustJsString } from "./string-literals.js";
import type { IrRecordShape, IrUnionDef } from "../../ir/ir.js";
import { validRecordDiscriminant } from "../../ir/record-discriminant.js";
import { isSharedRecord, recordCheckName } from "./shared-records.js";

interface Context {
  readonly records: ReadonlyMap<string, IrRecordShape>;
  dynTypeName(): string;
  unionName(id: string): string;
  unionVariant(tag: number): string;
  rustString(value: string): string;
}

export function sharedDiscriminatedUnion(context: Context, union: IrUnionDef): boolean {
  return validRecordDiscriminant(union, id => context.records.get(id)) &&
    union.arms.every(arm => arm.kind !== "record" || isSharedRecord(context.records.get(arm.shapeId)));
}

/** The old enum variant records the original view; the map owns current kind. */
export function discriminatedUnionBox(context: Context, union: IrUnionDef, value: string): string {
  const dyn = context.dynTypeName();
  const name = context.unionName(union.id);
  const arms = union.arms.map((arm, tag) => {
    const variant = `${name}::${context.unionVariant(tag)}`;
    return arm.kind === "record" ? `${variant}(payload) => ${dyn}::Object(payload.object.clone())`
      : `${variant} => ${dyn}::${arm.kind === "nullT" ? "Null" : "Undefined"}`;
  });
  return `match &(${value}) { ${arms.join(", ")} }`;
}

export function discriminatedUnionCheck(context: Context, union: IrUnionDef, value: string, path = '"$"'): string {
  const discriminator = union.discriminant;
  if (!discriminator) throw new Error("missing record discriminant");
  const dyn = context.dynTypeName();
  const name = context.unionName(union.id);
  const units = union.arms.flatMap((arm, tag) => arm.kind === "record" ? [] : [
    `${dyn}::${arm.kind === "nullT" ? "Null" : "Undefined"} => ${name}::${context.unionVariant(tag)}`,
  ]);
  const branches = discriminator.cases.map(entry => {
    const tag = union.arms.findIndex(arm => arm.kind === "record" && arm.shapeId === entry.shapeId);
    const condition = entry.values.map(item => `kind.as_ref() == "${context.rustString(item)}"`).join(" || ");
    return `if ${condition} { ${name}::${context.unionVariant(tag)}(${recordCheckName(entry.shapeId)}_at(value, ${path})) }`;
  });
  const record = `value => { let object = match &value { ${dyn}::Object(object) => object, _ => sc_dyn_check_fail_at("object", &value, ${path}) }; let discriminator = runtime::map_get_by(object, &${rustJsString(discriminator.field, text => context.rustString(text))}, |a, b| a == b).unwrap_or(${dyn}::Undefined); let kind = match discriminator { ${dyn}::String(kind) => kind, value => sc_dyn_check_fail_at("string discriminant", &value, ${path}) }; ${branches.join(" else ")} else { sc_dyn_check_fail_at("known record discriminant", &value, ${path}) } }`;
  return `{ let value = ${value}; match value { ${[...units, record].join(", ")} } }`;
}

export function discriminatedUnionTag(context: Context, union: IrUnionDef, tag: number, value: string): string {
  const dyn = context.dynTypeName();
  const arm = union.arms[tag];
  if (arm?.kind !== "record") return `matches!(${discriminatedUnionBox(context, union, value)}, ${dyn}::${arm?.kind === "nullT" ? "Null" : "Undefined"})`;
  const discriminator = union.discriminant;
  const entry = discriminator?.cases.find(entry => entry.shapeId === arm.shapeId);
  if (!discriminator || !entry) throw new Error("missing record discriminator case");
  const condition = entry.values.map(item => `kind.as_ref() == "${context.rustString(item)}"`).join(" || ");
  return `{ let value = ${discriminatedUnionBox(context, union, value)}; match value { ${dyn}::Object(object) => match runtime::map_get_by(&object, &${rustJsString(discriminator.field, text => context.rustString(text))}, |a, b| a == b) { Some(${dyn}::String(kind)) => ${condition}, _ => false }, _ => false } }`;
}

/** JSON decoding must use literal domains before structural field checks. */
export function discriminatedJsonGuard(context: Pick<Context, "rustString">, union: IrUnionDef, shapeId: string): string | undefined {
  const discriminator = union.discriminant;
  const entry = discriminator?.cases.find(entry => entry.shapeId === shapeId);
  if (!discriminator || !entry) return undefined;
  const condition = entry.values.map(value => `kind.as_ref() == "${context.rustString(value)}"`).join(" || ");
  return `matches!(node, runtime::JsonNode::Object(fields) if matches!(runtime::json_object_field(fields, "${context.rustString(discriminator.field)}"), Some(runtime::JsonNode::String(kind)) if ${condition}))`;
}
