import type { RustLibCallContext, RustLibCallExpr } from "./lib-calls.js";
import type { RustDynamicHttpContext } from "./dynamic-http.js";
import type { IrType, SrcLoc } from "../../ir/ir.js";

function streamItem(type: IrType, value: string, context: RustLibCallContext, loc: SrcLoc): string {
  const dyn = context.dynTypeName();
  if (type.kind === "bytes" && type.elem === "u8") return `${dyn}::Bytes(${value})`;
  if (type.kind === "array" && (type.elem.kind === "dyn" || type.elem.kind === "jsval")) return `${dyn}::Array(${value})`;
  if (type.kind === "array") {
    const read = streamItem(type.elem, "sc_value", context, loc);
    const write = type.elem.kind === "bytes" && type.elem.elem === "u8"
      ? `match sc_value { ${dyn}::Bytes(value) | ${dyn}::Buffer(value) => value, value => sc_dyn_check_fail("bytes", &value) }`
      : context.emitDynCheckValue(type.elem, "sc_value", loc);
    return `${dyn}::Array(runtime::array_mapped(${value}, |sc_value| ${read}, |sc_value| ${write}))`;
  }
  if (type.kind === "promise") {
    const item = streamItem(type.inner, "sc_value", context, loc);
    return `${dyn}::Promise(runtime::promise_to_mapped_handle(&(${value}), |sc_value| ${item}))`;
  }
  if (type.kind === "union") {
    const union = context.union(type.unionId, loc);
    const arms = union.arms.map((arm, tag) => {
      const variant = `${context.unionName(union.id)}::${context.unionVariant(tag)}`;
      return context.isUnit(arm)
        ? `${variant} => ${streamItem(arm, "()", context, loc)}`
        : `${variant}(sc_value) => ${streamItem(arm, "sc_value", context, loc)}`;
    });
    return `match ${value} { ${arms.join(", ")}, }`;
  }
  return context.emitDynFromValue(type, value, loc);
}

export function emitRustWebStreamFrom(expr: RustLibCallExpr, context: RustLibCallContext): string | null {
  if (expr.fn !== "fetch.streamFrom" || expr.args.length !== 1 || expr.type.kind !== "dyn") return null;
  const source = expr.args[0];
  if (!source) return null;
  const dyn = context.dynTypeName();
  const value = context.emitExpr(source);
  if (source.type.kind === "array") {
    const item = streamItem(source.type.elem, "runtime::array_get(source, position)", context, expr.loc);
    return `${dyn}::WebStream(runtime::web_stream_from_indexed(${value}, |source, index| { let position = index.get() as f64; if position >= runtime::array_len(source) { None } else { index.set(index.get() + 1); Some(${item}) } }, sc_web_from_resolve, ${dyn}::Undefined))`;
  }
  if (source.type.kind === "string") return `sc_web_stream_from(${dyn}::String(${value}))`;
  if (source.type.kind === "bytes" && source.type.elem === "u8") return `sc_web_stream_from(${dyn}::Bytes(${value}))`;
  if (source.type.kind === "dyn") return `sc_web_stream_from(${value})`;
  return null;
}

export function emitRustWebStreamFromDefinitions(context: RustDynamicHttpContext): void {
  const dyn = context.dynTypeName();
  const source = `
fn sc_web_from_resolve(value: ${dyn}) -> runtime::JsPromise<${dyn}> {
    match value {
        ${dyn}::Promise(handle) => runtime::promise_view_from_handle(&handle),
        value => runtime::promise_resolved(value),
    }
}
fn sc_web_stream_from(value: ${dyn}) -> ${dyn} {
    let stream = match value {
        ${dyn}::Array(source) => runtime::web_stream_from_indexed(source, |source, index| {
            let position = index.get() as f64;
            if position >= runtime::array_len(source) { None } else {
                index.set(index.get() + 1); Some(runtime::array_get(source, position))
            }
        }, sc_web_from_resolve, ${dyn}::Undefined),
        ${dyn}::Bytes(source) | ${dyn}::Buffer(source) => runtime::web_stream_from_indexed(source, |source, index| {
            let position = index.get() as f64;
            if position >= runtime::bytes_len(source) { None } else {
                index.set(index.get() + 1); Some(${dyn}::Number(runtime::bytes_get(source, position)))
            }
        }, sc_web_from_resolve, ${dyn}::Undefined),
        ${dyn}::String(source) => runtime::web_stream_from_indexed(source, |source, index| {
            source.get(index.get()..).and_then(|rest| rest.chars().next()).map(|ch| {
                index.set(index.get() + ch.len_utf8()); ${dyn}::String(runtime::string(&ch.to_string()))
            })
        }, sc_web_from_resolve, ${dyn}::Undefined),
        ${dyn}::Undefined => runtime::throw_type_error("Cannot read properties of undefined (reading 'Symbol(Symbol.asyncIterator)')".to_owned()),
        ${dyn}::Null => runtime::throw_type_error("Cannot read properties of null (reading 'Symbol(Symbol.asyncIterator)')".to_owned()),
        _ => runtime::throw_type_error("object is not iterable (cannot read property Symbol(Symbol.iterator))".to_owned()),
    };
    ${dyn}::WebStream(stream)
}
`;
  for (const line of source.trim().split("\n")) context.line(line);
}
