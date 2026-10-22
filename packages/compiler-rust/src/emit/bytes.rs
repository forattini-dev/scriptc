//! Owned u8 views reuse the shared portable bytes ABI.
use super::*;
pub(super) fn expression(value: &Expr, function: &Function, module: &Module) -> Option<String> {
    let emit = |v: &Expr| expr(v, function, module);
    Some(match value {
        Expr::BytesNew { source, .. } => match source.as_deref() {
            None => "runtime::bytes_empty::<u8>()".into(),
            Some(v) => format!(
                "runtime::{}(&({}))",
                if v.ty() == Type::bytes() {
                    "bytes_copy"
                } else if v.ty() == Type::F64 {
                    return Some(format!("runtime::bytes_alloc::<u8>({})", emit(v)));
                } else {
                    "bytes_from_array::<u8>"
                },
                emit(v)
            ),
        },
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
                "length" | "byteLength" => "runtime::bytes_len(&bytes)".into(),
                "byteOffset" => "runtime::bytes_byte_offset(&bytes)".into(),
                "join" => "runtime::bytes_join(&bytes, &runtime::JsString::from(arg0))".into(),
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
