import type { IrExpr, IrFunction, IrType } from "../../ir/nodes.js";
import { mangleFunction } from "../mangle.js";
import type { RustDefinitionContext } from "./definitions.js";
import { isSharedRecord } from "./shared-records.js";

/** Static helper bodies enumerate declared fields. Shared views must enumerate
 * the current own keys, including keys added through a wider dictionary alias. */
export function emitSharedIteration(context: RustDefinitionContext, fn: IrFunction): boolean {
  const member = /^%obj\.(keys|values|entries)\.\d+$/.exec(fn.name)?.[1];
  const source = fn.params[0]?.type;
  if (!member || fn.params.length !== 1 || source?.kind !== "record" ||
    !isSharedRecord(context.records.get(source.shapeId)) || fn.captures !== undefined || fn.async || fn.generator) return false;
  const result = fn.returnType;
  if (result.kind !== "array" && result.kind !== "dyn") return false;
  const dyn = context.dynTypeName();
  const raw = `runtime::map_get_by(&sc_input.object, &sc_key, |a, b| a == b).unwrap_or(${dyn}::Undefined)`;
  let item: string;
  if (member === "keys") item = "sc_key";
  else if (member === "values") item = result.kind === "dyn" ? raw : context.emitDynCheckValue(result.elem, raw, fn.loc);
  else {
    if (result.kind !== "array" || result.elem.kind !== "record") return false;
    const tuple = context.records.get(result.elem.shapeId);
    const valueType = tuple?.fields.find(field => field.name === "1")?.type;
    if (!tuple?.tuple || !valueType) return false;
    const ref = (localId: string, type: IrType): IrExpr => ({ kind: "varRef", localId, type, loc: fn.loc });
    const key = ref("sc_key", { kind: "string" });
    const value = ref("sc_item", valueType);
    const entry: IrExpr = { kind: "recordLit", type: result.elem, loc: fn.loc,
      fields: [{ name: "0", value: key }, { name: "1", value }] };
    item = context.emitExprWithValues(entry, [[key, "sc_key.clone()"], [value, context.emitDynCheckValue(valueType, raw, fn.loc)]]);
  }
  context.line(`fn ${mangleFunction(fn.name)}(sc_input: ${context.rustType(source)}) -> ${context.rustType(result)} {`);
  context.line("let sc_keys = runtime::map_string_keys_js_order(&sc_input.object);");
  if (member === "keys") context.line("sc_keys }");
  else {
    context.line("let sc_output = runtime::array_new(Vec::new()); let mut sc_index = 0.0;");
    context.line(`while sc_index < runtime::array_len(&sc_keys) { let sc_key = runtime::array_get(&sc_keys, sc_index); runtime::array_push(&sc_output, ${item}); sc_index += 1.0; }`);
    context.line(`${result.kind === "dyn" ? `${dyn}::Array(sc_output)` : "sc_output"} }`);
  }
  return true;
}
