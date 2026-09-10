import type { RustExpressionContext } from "./expression-context.js";
import type { IrExpr, IrType } from "../../ir/nodes.js";

type ArrayType = Extract<IrType, { kind: "array" }>;
type Convert = (type: IrType, value: string, path?: string) => string;

/** Recover the original dynamic storage on a return crossing; otherwise
 * project the typed storage. Both callbacks are capture-free Rust functions. */
export function emitNativeArrayFrom(type: ArrayType, value: string, dyn: string, box: Convert, check: Convert): string {
  if (type.elem.kind === "dyn") return `${dyn}::Array(${value})`;
  const read = box(type.elem, "sc_item");
  const write = check(type.elem, "sc_item");
  return `{ let sc_source = ${value}; match runtime::array_mapped_source::<${dyn}, _>(&sc_source) { ` +
    `Some(sc_original) => ${dyn}::Array(sc_original), ` +
    `None => ${dyn}::Array(runtime::array_mapped(sc_source, |sc_item| ${read}, |sc_item| ${write})), } }`;
}

/** Validate existing elements at the boundary, then retain the source array.
 * Later reads validate the current element, and writes update the source. */
export function emitNativeArrayCheck(type: ArrayType, value: string, dyn: string, box: Convert, check: Convert, path = '"$"'): string {
  if (type.elem.kind === "dyn") return `match ${value} { ${dyn}::Array(sc_array) => sc_array, sc_other => sc_dyn_check_fail_at("array", &sc_other, ${path}), }`;
  const read = check(type.elem, "sc_item");
  const validate = check(type.elem, "sc_item", "&runtime::json_index_path(sc_path, sc_index as usize)");
  const write = box(type.elem, "sc_item");
  return `{ let sc_value = ${value}; let sc_path = ${path}; match sc_value { ${dyn}::Array(sc_array) => ` +
    `runtime::array_mapped_source(&sc_array).unwrap_or_else(|| { ` +
    `let mut sc_index = 0.0; while sc_index < runtime::array_len(&sc_array) { ` +
    `let sc_item = runtime::array_get(&sc_array, sc_index); let _ = ${validate}; sc_index += 1.0; } ` +
    `runtime::array_mapped(sc_array, |sc_item| ${read}, |sc_item| ${write}) }), ` +
    `sc_other => sc_dyn_check_fail_at("array", &sc_other, sc_path), } }`;
}

/** Union wrapping is representation-only; an inline literal still needs the
 * dynamic slot's storage rather than an inferred typed backing array. */
export function nativeDynamicArrayLiteral(expr: IrExpr): Extract<IrExpr, { kind: "arrayLit" }> | undefined {
  if (expr.kind === "arrayLit") return expr;
  return expr.kind === "unionWrap" ? nativeDynamicArrayLiteral(expr.value) : undefined;
}

/** A literal created directly in a dynamic slot needs dynamic element
 * storage, including when its inferred type is the empty numeric fallback.
 * Typed variables passed to that slot still keep their existing storage. */
export function emitNativeDynamicArrayLiteral(
  expr: Extract<IrExpr, { kind: "arrayLit" }>, context: RustExpressionContext, emit: (expr: IrExpr) => string,
): string {
  const dyn = context.dynTypeName();
  const output = context.nextName("sc_literal");
  const spreads = new Set(expr.spreads);
  const elements = expr.elems.map((element, index) => {
    const literal = nativeDynamicArrayLiteral(element);
    const value = literal !== undefined
      ? emitNativeDynamicArrayLiteral(literal, context, emit)
      : context.emitDynFromValue(element.type, emit(element), element.loc);
    if (!spreads.has(index)) return `runtime::array_push(&${output}, ${value});`;
    return `{ let sc_spread = ${value}; let ${dyn}::Array(sc_array) = sc_spread else { unreachable!("scriptc: typed array spread") }; runtime::array_extend(&${output}, &sc_array); }`;
  });
  return `{ let ${output}: runtime::JsArray<${dyn}> = runtime::array_new(Vec::new()); ${elements.join(" ")} ${dyn}::Array(${output}) }`;
}
