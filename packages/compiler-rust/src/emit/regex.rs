use super::*;
use std::fmt::Write;

pub(super) fn metadata_definitions(types: &[Type], out: &mut String) {
    out.push_str(include_str!("regex_metadata_support.rs"));
    out.push_str(
        r#"
fn native_regex_construct(args: Vec<NativeValue>, construct: bool) -> NativeValue {
    let pattern = args.first().cloned().unwrap_or(NativeValue::Undefined);
    let flags = args.get(1).cloned().unwrap_or(NativeValue::Undefined);
    if !construct && matches!(flags, NativeValue::Undefined)
        && let NativeValue::Regex(_) = &pattern
    {
        return pattern;
    }
    let (pattern, original_flags) = match pattern {
        NativeValue::Undefined => (runtime::string(""), runtime::string("")),
        NativeValue::Regex(regex) => (runtime::regex_source(&regex), runtime::regex_flags(&regex)),
        other => (native_value_string(other), runtime::string("")),
    };
    let flags = match flags {
        NativeValue::Undefined => original_flags,
        other => native_value_string(other),
    };
    NativeValue::Regex(runtime::regex_new(&pattern, flags.to_utf8_lossy()))
}
fn native_global_regex_value() -> NativeValue {
    let global = native_global_object();
    let key = runtime::string("RegExp");
    if !native_value_has_own(global.clone(), key.clone()) {
        runtime::throw_reference_error("RegExp is not defined".into());
    }
    native_value_get(global, key)
}
"#,
    );
    out.push_str("fn native_regex_property(value: &NativeValue, key: &runtime::JsString) -> Option<NativeValue> { match value { NativeValue::Regex(regex) => match key.well_formed_utf8().unwrap_or(\"\") { \"constructor\" => Some(NativeValue::RegexConstructor), \"source\" => Some(NativeValue::String(runtime::regex_source(regex))), \"flags\" => Some(NativeValue::String(runtime::regex_flags(regex))), \"lastIndex\" => Some(NativeValue::Number(runtime::regex_last_index(regex))), _ => None }, NativeValue::Array(row) => native_regex_metadata(row, key),\n");
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
            "{{ let subject = {}; let regex = {}; let callback = {}; let require_global = {}; runtime::regex_replace_captures(&subject, &regex, require_global, |matched| {{ let mut args = vec![NativeValue::String(matched.matched)]; args.extend(matched.captures.into_iter().map(|value| value.map(NativeValue::String).unwrap_or(NativeValue::Undefined))); args.push(NativeValue::Number(matched.offset as f64)); args.push(NativeValue::String(matched.input)); if let Some(groups) = matched.groups {{ args.push(NativeValue::Object(runtime::Gc::new(NativeMap {{ null_prototype: true, symbol_properties: None, entries: groups.into_iter().map(|(key, value)| (key, value.map(NativeValue::String).unwrap_or(NativeValue::Undefined))).collect(), hash_index: NativeHashIndex::default() }}))); }} native_value_string(native_value_call(callback.clone(), args, \"replacement\")) }}) }}",
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
                "matchAll" => {
                    let layout = crate::ir::regex_captures::match_all_layout(module, &value.ty())
                        .expect("validated matchAll captures");
                    let crate::ir::regex_captures::MatchAllLayout {
                        capture,
                        string_tag,
                        undefined_tag,
                    } = layout;
                    format!(
                        "{{ let text = {receiver}; let regex = {}; runtime::regex_match_all(&text, &regex, |value| match value {{ Some(text) => U{capture}::V{string_tag}(text), None => U{capture}::V{undefined_tag}(()), }}) }}",
                        arg.unwrap()
                    )
                }
                "exec" | "match" => {
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
                    let argument = arg.unwrap();
                    let (bindings, call) = if method == "exec" {
                        (
                            format!("let regex = {receiver}; let text = {argument};"),
                            "runtime::regex_exec(&regex, &text,",
                        )
                    } else {
                        (
                            format!("let text = {receiver}; let regex = {argument};"),
                            "runtime::regex_match(&text, &regex,",
                        )
                    };
                    format!(
                        "{{ {bindings} match {call} |value| match value {{ Some(text) => U{capture}::V{string_tag}(text), None => U{capture}::V{undefined_tag}(()), }}) {{ Some(row) => U{result}::V{array_tag}(row), None => U{result}::V{null_tag}(()), }} }}"
                    )
                }
                "test" => format!(
                    "{{ let regex = {receiver}; let text = {}; runtime::regex_test(&regex, &runtime::JsString::from(text)) }}",
                    arg.unwrap()
                ),
                "split" => {
                    let limit = expr(&args[1], function, module);
                    format!(
                        "{{ let subject = {receiver}; let regex = {}; let limit = {limit}; runtime::regex_split(&subject, &regex, limit) }}",
                        arg.unwrap()
                    )
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
