import type { IrExpr } from "../../ir/ir.js";
import type { RustCheckedBufferContext } from "./buffer-checked.js";

/** Buffer.from's native checked-value dispatch; never enters a JavaScript engine.
 * Bound recursive valueOf conversion with a named refusal instead of allowing
 * a cyclic/deep object protocol to abort the native process on stack overflow. */
export function emitRustDynamicBufferFrom(
  source: IrExpr,
  encoding: IrExpr,
  context: RustCheckedBufferContext,
): string {
  const dyn = context.dynTypeName();
  const value = context.nextTemporary();
  const encodingValue = context.nextTemporary();
  return `{
    fn sc_buffer_array_like(sc_value: &${dyn}, sc_length: f64) -> runtime::JsBytes<u8> {
      if sc_length <= 0.0 { return runtime::bytes_empty(); }
      if sc_length == f64::INFINITY { runtime::throw_range_error("Array buffer allocation failed".to_owned()); }
      let sc_bytes = runtime::bytes_alloc(sc_length);
      for sc_index in 0..runtime::bytes_len(&sc_bytes) as usize {
        let sc_element = sc_dyn_key_get(sc_value, &runtime::string(&sc_index.to_string()), false);
        runtime::bytes_set(&sc_bytes, sc_index as f64, sc_dyn_to_number(&sc_dyn_number_primitive(&sc_element)));
      }
      sc_bytes
    }
    fn sc_buffer_from(sc_value: &${dyn}, sc_encoding: &runtime::JsString, sc_depth: usize) -> runtime::JsBytes<u8> {
      if sc_depth > 128 { runtime::throw_error("scriptc: Buffer.from valueOf conversion beyond 128 levels is not supported yet".to_owned()); }
      let sc_key = runtime::string("valueOf");
      let sc_has_value_of = match sc_value {
        ${dyn}::Object(..) => sc_dyn_has_key(sc_value, &sc_key),
        ${dyn}::Array(sc_array) => runtime::array_property_has(sc_array, &sc_key),
        _ => false,
      };
      if sc_has_value_of && sc_dyn_is_truthy(&sc_dyn_key_get(sc_value, &sc_key, false)) {
        let sc_method = sc_dyn_key_get(sc_value, &sc_key, false);
        let sc_result = { let _sc_this = sc_dyn_this_push(sc_value.clone()); sc_dyn_call(&sc_method, &[], "value.valueOf") };
        if !matches!(&sc_result, ${dyn}::Null) && !sc_dyn_strict_equal(&sc_result, sc_value) &&
            matches!(sc_dyn_typeof(&sc_result).to_utf8_lossy(), "string" | "object") {
          return sc_buffer_from(&sc_result, sc_encoding, sc_depth + 1);
        }
      }
      match sc_value {
        ${dyn}::String(sc_text) => return runtime::buffer_from_string(sc_text, sc_encoding),
        ${dyn}::Bytes(sc_bytes) | ${dyn}::Buffer(sc_bytes) => return runtime::bytes_copy(sc_bytes),
        ${dyn}::Array(sc_array) => return sc_buffer_array_like(sc_value, runtime::array_len(sc_array)),
        ${dyn}::Proxy(..) => return sc_dyn_proxy_unsupported("Buffer.from"),
        ${dyn}::Object(..) => {
          let sc_length = sc_dyn_key_get(sc_value, &runtime::string("length"), false);
          if !matches!(sc_length, ${dyn}::Undefined) {
            return match sc_dyn_key_get(sc_value, &runtime::string("length"), false) {
              ${dyn}::Number(..) => match sc_dyn_key_get(sc_value, &runtime::string("length"), false) {
                ${dyn}::Number(sc_length) => sc_buffer_array_like(sc_value, sc_length),
                sc_length => sc_buffer_array_like(sc_value, sc_dyn_to_number(&sc_dyn_number_primitive(&sc_length))),
              },
              _ => runtime::bytes_empty(),
            };
          }
          let _ = sc_dyn_key_get(sc_value, &runtime::string("buffer"), false);
          let sc_type = sc_dyn_key_get(sc_value, &runtime::string("type"), false);
          if matches!(&sc_type, ${dyn}::String(sc_name) if sc_name.as_ref() == "Buffer") {
            if matches!(sc_dyn_key_get(sc_value, &runtime::string("data"), false), ${dyn}::Array(..)) {
              let sc_data = sc_dyn_key_get(sc_value, &runtime::string("data"), false);
              let sc_length = sc_dyn_key_get(&sc_data, &runtime::string("length"), false);
              return sc_buffer_array_like(&sc_data, sc_dyn_to_number(&sc_dyn_number_primitive(&sc_length)));
            }
          }
        },
        _ => {},
      }
      runtime::throw_type_error_code(format!("The first argument must be of type string or an instance of Buffer, ArrayBuffer, or Array or an Array-like Object. Received {}", sc_dyn_specific_type(sc_value)), "ERR_INVALID_ARG_TYPE")
    }
    let ${value} = ${context.emitExpr(source)};
    let ${encodingValue} = ${context.emitExpr(encoding)};
    sc_buffer_from(&${value}, &${encodingValue}, 0)
  }`;
}
