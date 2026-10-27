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
                "get" => "runtime::bytes_get(&bytes, arg0)".into(),
                "toArray" => "runtime::bytes_to_array(&bytes)".into(),
                "byteOffset" => "runtime::bytes_byte_offset(&bytes)".into(),
                "join" => "runtime::bytes_join(&bytes, &runtime::JsString::from(arg0))".into(),
                "toStringVar" => {
                    "runtime::bytes_to_string_checked(&bytes, &runtime::JsString::from(arg0))"
                        .into()
                }
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
        Expr::LibCall { r#fn, args, .. } if r#fn == "buffer.fromDyn" => format!(
            "{{ let source = {}; let encoding = {}; native_buffer_from(source, encoding, 0) }}",
            emit(&args[0]),
            emit(&args[1])
        ),
        Expr::LibCall { r#fn, args, .. } if r#fn == "buffer.fromStr" => format!(
            "{{ let value = {}; let encoding = {}; runtime::buffer_from_string(&runtime::JsString::from(value), &runtime::JsString::from(encoding)) }}",
            emit(&args[0]),
            emit(&args[1])
        ),
        Expr::LibCall { r#fn, args, .. } if r#fn == "text.decode" => {
            format!("runtime::text_decode(&({}))", emit(&args[0]))
        }
        _ => return None,
    })
}
