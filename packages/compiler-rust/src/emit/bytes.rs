//! Owned typed views reuse the shared portable bytes ABI.
use super::*;
pub(super) fn expression(
    value: &Expr,
    function: &Function,
    module: &Emission<'_>,
) -> Option<String> {
    let emit = |v: &Expr| expr(v, function, module);
    Some(match value {
        Expr::BytesNew { source, r#type, .. } => {
            let Type::Bytes { elem } = r#type else {
                unreachable!("validated bytes constructor")
            };
            match source.as_deref() {
                None => format!("runtime::bytes_empty::<{elem}>()"),
                Some(v) => format!(
                    "runtime::{}(&({}))",
                    if v.ty() == *r#type {
                        "bytes_copy".into()
                    } else if v.ty() == Type::F64 {
                        return Some(format!("runtime::bytes_alloc::<{elem}>({})", emit(v)));
                    } else {
                        format!("bytes_from_array::<{elem}>")
                    },
                    emit(v)
                ),
            }
        }
        Expr::BytesIntrinsic {
            method,
            receiver,
            args,
            ..
        } => {
            let evaluated = args
                .iter()
                .enumerate()
                .map(|(i, a)| format!("let arg{i} = {};", emit(a)))
                .collect::<String>();
            let operation = match method.as_str() {
                "length" => "runtime::bytes_len(&bytes)".into(),
                "byteLength" => "runtime::bytes_byte_len(&bytes)".into(),
                "buffer" => "NativeValue::ArrayBuffer(runtime::bytes_array_buffer(&bytes))".into(),
                "get" => "runtime::bytes_get(&bytes, arg0)".into(),
                "toArray" => "runtime::bytes_to_array(&bytes)".into(),
                "byteOffset" => "runtime::bytes_byte_offset(&bytes)".into(),
                "windowView" => "runtime::bytes_u8_window_view(&bytes)".into(),
                "dataViewNew" => format!(
                    "runtime::data_view_new(&bytes, {}, {}, {})",
                    if args.is_empty() { "0.0" } else { "arg0" },
                    args.len() == 2,
                    if args.len() < 2 { "0.0" } else { "arg1" }
                ),
                method if crate::ir::data_view_operation(method).is_some() => {
                    let (kind, is_set, _) = crate::ir::data_view_operation(method).unwrap();
                    if is_set {
                        format!(
                            "runtime::data_view_set(&bytes, \"{kind}\", arg0, arg1, {})",
                            if args.len() < 3 { "false" } else { "arg2" }
                        )
                    } else {
                        format!(
                            "runtime::data_view_get(&bytes, \"{kind}\", arg0, {})",
                            if args.len() < 2 { "false" } else { "arg1" }
                        )
                    }
                }
                "join" => "runtime::bytes_join(&bytes, &runtime::JsString::from(arg0))".into(),
                "equals" => "runtime::bytes_equals(&bytes, &arg0)".into(),
                "toStringVar" => {
                    "runtime::bytes_to_string_checked(&bytes, &runtime::JsString::from(arg0))"
                        .into()
                }
                "toStringRange" => "runtime::bytes_to_string_checked_range(&bytes, &runtime::JsString::from(arg0), arg1, arg2)".into(),
                "slice" | "subarray" => format!(
                    "runtime::bytes_slice(&bytes, {}, {}, {})",
                    if args.is_empty() { "0.0" } else { "arg0" },
                    if args.len() < 2 {
                        "f64::INFINITY"
                    } else {
                        "arg1"
                    },
                    method == "subarray"
                ),
                "setFrom" => format!(
                    "runtime::bytes_set_from(&bytes, &arg0, {})",
                    if args.len() < 2 { "0.0" } else { "arg1" }
                ),
                "setFromArray" => format!(
                    "runtime::bytes_set_from_array(&bytes, &arg0, {})",
                    if args.len() < 2 { "0.0" } else { "arg1" }
                ),
                "writeString" => format!("native_buffer_write(&bytes, vec![{}])", (0..args.len()).map(|i| format!("arg{i}")).collect::<Vec<_>>().join(", ")),
                "writeUIntBE" => "runtime::buffer_write_uint_be(&bytes, arg0, arg1, arg2)".into(),
                "readUIntBE" => "runtime::buffer_read_uint_be(&bytes, arg0, arg1)".into(),
                "copy" => format!(
                    "runtime::bytes_copy_into(&bytes, &arg0, {}, {}, {}, {})",
                    args.len() - 1,
                    if args.len() < 2 { "0.0" } else { "arg1" },
                    if args.len() < 3 { "0.0" } else { "arg2" },
                    if args.len() < 4 { "0.0" } else { "arg3" },
                ),
                _ => unreachable!("validated bytes operation"),
            };
            format!(
                "{{ let bytes = {}; {evaluated} {operation} }}",
                emit(receiver)
            )
        }
        Expr::LibCall { r#fn, args, .. } if r#fn == "buffer.isBuffer" => {
            format!("native_value_is_buffer(&({}))", emit(&args[0]))
        }
        Expr::LibCall { r#fn, args, .. } if r#fn == "buffer.byteLenStr" => format!(
            "{{ let value = {}; let encoding = {}; runtime::buffer_byte_length_string(&value, &encoding) }}",
            emit(&args[0]),
            emit(&args[1])
        ),
        Expr::LibCall { r#fn, args, .. } if r#fn == "buffer.fromDyn" => format!(
            "{{ let source = {}; let encoding = {}; native_buffer_from(source, encoding, 0) }}",
            emit(&args[0]),
            emit(&args[1])
        ),
        Expr::LibCall { r#fn, args, .. } if r#fn == "bytes.fromDyn" => {
            format!("native_u8_from_dynamic({})", emit(&args[0]))
        }
        Expr::LibCall { r#fn, args, .. } if r#fn == "buffer.fromU8Window" => {
            format!("runtime::buffer_from_u8_window_view(&({}))", emit(&args[0]))
        }
        Expr::LibCall { r#fn, args, .. } if r#fn == "buffer.fromStr" => format!(
            "{{ let value = {}; let encoding = {}; runtime::buffer_from_string(&runtime::JsString::from(value), &runtime::JsString::from(encoding)) }}",
            emit(&args[0]),
            emit(&args[1])
        ),
        Expr::LibCall { r#fn, args, .. } if r#fn == "text.decode" => {
            format!("runtime::text_decode(&({}))", emit(&args[0]))
        }
        Expr::LibCall { r#fn, args, .. } if r#fn == "text.decodeFatal" => format!(
            "runtime::text_decode_fatal(&({}), {})",
            emit(&args[0]),
            emit(&args[1])
        ),
        Expr::LibCall { r#fn, .. } if r#fn == "text.decoderNew" => {
            "runtime::text_decoder_new()".into()
        }
        Expr::LibCall { r#fn, args, .. } if r#fn == "text.decodeStream" => format!(
            "runtime::text_decode_stream({}, &({}), {}, {})",
            emit(&args[0]),
            emit(&args[1]),
            emit(&args[2]),
            emit(&args[3])
        ),
        Expr::LibCall { r#fn, args, .. } if r#fn == "text.decodeSelected" => format!(
            "runtime::text_decode_selected({}, &({}), {}, {}, {})",
            emit(&args[0]),
            emit(&args[1]),
            emit(&args[2]),
            emit(&args[3]),
            emit(&args[4])
        ),
        _ => return None,
    })
}
