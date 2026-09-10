import type { IrType } from "../../ir/nodes.js";

type Convert = (type: IrType, value: string, path?: string) => string;

export function emitNativeMapFrom(element: IrType, value: string, dyn: string, box: Convert, check: Convert): string {
  if (element.kind === "dyn") return `${dyn}::Object(${value})`;
  return `{ let sc_source = ${value}; match runtime::map_mapped_source::<_, ${dyn}, _>(&sc_source) { ` +
    `Some(sc_original) => ${dyn}::Object(sc_original), ` +
    `None => ${dyn}::Object(runtime::map_mapped(sc_source, |sc_item| ${box(element, "sc_item")}, |sc_item| ${check(element, "sc_item")})), } }`;
}

export function emitNativeMapCheck(element: IrType, value: string, dyn: string, box: Convert, check: Convert, path = '"$"'): string {
  const read = check(element, "sc_item");
  const validate = check(element, "sc_item", "&runtime::json_property_path(sc_path, runtime::map_iter_key(&sc_map, sc_index).as_ref())");
  const project = `{ let mut sc_index = 0.0; while sc_index < runtime::map_iter_count(&sc_map) { ` +
    `if runtime::map_iter_live(&sc_map, sc_index) { let sc_item = runtime::map_iter_value(&sc_map, sc_index); let _ = ${validate}; } sc_index += 1.0; } ` +
    `runtime::map_mapped(sc_map, |sc_item| ${read}, |sc_item| ${box(element, "sc_item")}) }`;
  // Null and undefined share Rust's unit layout. Recovering solely by Rust
  // type would bypass their distinct checked-boundary contracts.
  const checked = element.kind === "nullT" || element.kind === "undefinedT" ? project
    : `runtime::map_mapped_source(&sc_map).unwrap_or_else(|| ${project})`;
  return `{ let sc_value = ${value}; let sc_path = ${path}; match sc_value { ${dyn}::Object(sc_map) => ${checked}, ` +
    `sc_other => sc_dyn_check_fail_at("object", &sc_other, sc_path), } }`;
}
