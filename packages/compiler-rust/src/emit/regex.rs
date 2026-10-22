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
