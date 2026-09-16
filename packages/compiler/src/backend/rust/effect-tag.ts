import type { IrType, SrcLoc } from "../../ir/ir.js";
import { mangleField } from "../mangle.js";
import type { RustLibCallContext } from "./lib-calls.js";
import { isSharedRecord } from "./shared-records.js";

/** Type compatibility alone cannot distinguish structural errors: literal
 * tags erase to the same string field. Check the live tag after downcasting. */
export function effectTagPredicate(
  context: RustLibCallContext, type: IrType, value: string, tag: string, loc: SrcLoc,
): string {
  if (type.kind === "union") {
    return context.union(type.unionId, loc).arms.map(arm =>
      `(${effectTagPredicate(context, arm, value, tag, loc)})`).join(" || ");
  }
  const expected = `"${context.rustString(tag)}"`;
  let matches: string;
  if (type.kind === "record") {
    const shape = context.record(type.shapeId, loc);
    const field = shape.fields.find(field => field.name === "_tag");
    if (field?.type.kind !== "string") return context.unsupported("Effect.catchTag over a record without a string _tag", loc);
    matches = isSharedRecord(shape)
      ? `sc_error.get_${mangleField(field.name)}().as_ref() == ${expected}`
      : `sc_error.with(|record| record.${mangleField(field.name)}.as_ref() == ${expected})`;
  } else if (type.kind === "object" && context.hasClassMeta(type.className)) {
    const field = context.classFieldName(type.className, "_tag", loc);
    matches = `sc_error.with(|object| object.${field}.as_ref() == ${expected})`;
  } else if (type.kind === "effect") {
    // A kernel DATA handle (a SqlError, a SchemaError, an Exit): its tag is the node's, which the runtime answers —
    // the same value `_tag` reads through effect.dataTag.
    return `${value}.downcast_ref::<runtime::JsEffect>().is_some_and(|sc_error| runtime::effect_data_tag(sc_error).as_ref() == ${expected})`;
  } else {
    return context.unsupported("Effect.catchTag over an error without a native tag representation", loc);
  }
  return `${value}.downcast_ref::<${context.rustType(type, loc)}>().is_some_and(|sc_error| ${matches})`;
}
