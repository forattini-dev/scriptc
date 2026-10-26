use super::*;

pub(super) fn expression(value: &Expr, function: &Function, module: &Module) -> Option<String> {
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
            "{{ let subject = {}; let regex = {}; let callback = {}; let require_global = {}; runtime::regex_replace_captures(&subject, &regex, require_global, |matched| {{ let mut args = vec![NativeValue::String(matched.matched)]; args.extend(matched.captures.into_iter().map(|value| value.map(NativeValue::String).unwrap_or(NativeValue::Undefined))); args.push(NativeValue::Number(matched.offset as f64)); args.push(NativeValue::String(matched.input)); if let Some(groups) = matched.groups {{ args.push(NativeValue::Object(runtime::Gc::new(NativeMap {{ entries: groups.into_iter().map(|(key, value)| (key, value.map(NativeValue::String).unwrap_or(NativeValue::Undefined))).collect() }}))); }} native_value_string(native_value_call(callback.clone(), args, \"replacement\")) }}) }}",
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
                "test" => format!(
                    "{{ let regex = {receiver}; let text = {}; runtime::regex_test(&regex, &runtime::JsString::from(text)) }}",
                    arg.unwrap()
                ),
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
