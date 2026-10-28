use super::*;
use std::fmt::Write;

pub(super) fn metadata_definitions(types: &[Type], out: &mut String) {
    out.push_str(include_str!("regex_metadata_support.rs"));
    out.push_str("fn native_regex_property(value: &NativeValue, key: &runtime::JsString) -> Option<NativeValue> { match value { NativeValue::Array(row) => native_regex_metadata(row, key),\n");
    for (index, ty) in types.iter().enumerate() {
        if matches!(ty, Type::Array { elem } if **elem != Type::Dyn) {
            writeln!(
                out,
                "NativeValue::V{index}(row) => native_regex_metadata(row, key),"
            )
            .unwrap();
        }
    }
    out.push_str("_ => None, } }\n");
}

pub(super) fn expression(
    value: &Expr,
    function: &Function,
    module: &Emission<'_>,
) -> Option<String> {
    Some(match value {
        Expr::RegexLit { pattern, flags, .. } => {
            format!("runtime::regex_new({pattern:?}, {flags:?})")
        }
        Expr::LibCall { r#fn, args, .. } if r#fn == "regex.new" => format!(
            "{{ let pattern = {}; let flags = {}; runtime::regex_new(&runtime::JsString::from(pattern), &flags) }}",
            expr(&args[0], function, module),
            expr(&args[1], function, module)
        ),
        Expr::LibCall { r#fn, args, .. } if r#fn == "regex.replaceCaptures" => format!(
            "{{ let subject = {}; let regex = {}; let callback = {}; let require_global = {}; runtime::regex_replace_captures(&subject, &regex, require_global, |matched| {{ let mut args = vec![NativeValue::String(matched.matched)]; args.extend(matched.captures.into_iter().map(|value| value.map(NativeValue::String).unwrap_or(NativeValue::Undefined))); args.push(NativeValue::Number(matched.offset as f64)); args.push(NativeValue::String(matched.input)); if let Some(groups) = matched.groups {{ args.push(NativeValue::Object(runtime::Gc::new(NativeMap {{ null_prototype: true, entries: groups.into_iter().map(|(key, value)| (key, value.map(NativeValue::String).unwrap_or(NativeValue::Undefined))).collect() }}))); }} native_value_string(native_value_call(callback.clone(), args, \"replacement\")) }}) }}",
            expr(&args[0], function, module),
            expr(&args[1], function, module),
            expr(&args[2], function, module),
            expr(&args[3], function, module)
        ),
        Expr::RegexIntrinsic {
            method,
            receiver,
            args,
            ..
        } => {
            let receiver = expr(receiver, function, module);
            let arg = args.first().map(|arg| expr(arg, function, module));
            match method.as_str() {
                "exec" => {
                    let layout = crate::ir::regex_captures::exec_layout(module, &value.ty())
                        .expect("validated captures");
                    let crate::ir::regex_captures::ExecLayout {
                        result,
                        array_tag,
                        null_tag,
                        capture,
                        string_tag,
                        undefined_tag,
                    } = layout;
                    format!(
                        "{{ let regex = {receiver}; let text = {}; match runtime::regex_exec(&regex, &text, |value| match value {{ Some(text) => U{capture}::V{string_tag}(text), None => U{capture}::V{undefined_tag}(()), }}) {{ Some(row) => U{result}::V{array_tag}(row), None => U{result}::V{null_tag}(()), }} }}",
                        arg.unwrap()
                    )
                }
                "test" => format!(
                    "{{ let regex = {receiver}; let text = {}; runtime::regex_test(&regex, &runtime::JsString::from(text)) }}",
                    arg.unwrap()
                ),
                "split" => {
                    let limit = expr(&args[1], function, module);
                    format!("{{ let subject = {receiver}; let regex = {}; let limit = {limit}; runtime::regex_split(&subject, &regex, limit) }}", arg.unwrap())
                }
                "replace" | "replaceAll" => {
                    let replacement = expr(&args[1], function, module);
                    let operation = if method == "replace" {
                        "regex_replace"
                    } else {
                        "regex_replace_all"
                    };
                    format!(
                        "{{ let subject = {receiver}; let regex = {}; let replacement = {replacement}; runtime::{operation}(&subject, &regex, &replacement) }}",
                        arg.unwrap()
                    )
                }
                "source" | "flags" => format!("runtime::regex_{method}(&({receiver}))"),
                "lastIndex" => format!("runtime::regex_last_index(&({receiver}))"),
                "setLastIndex" => format!(
                    "{{ let regex = {receiver}; let index = {}; runtime::regex_set_last_index(&regex, index); index }}",
                    arg.unwrap()
                ),
                _ => unreachable!("IR validated"),
            }
        }
        _ => return None,
    })
}
