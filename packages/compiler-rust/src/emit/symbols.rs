use super::*;
use crate::ir;
pub(super) fn expression(value: &Expr, function: &Function, module: &Module) -> Option<String> {
    let Expr::LibCall {
        r#fn, args, r#type, ..
    } = value
    else {
        return None;
    };
    let arg = || expr(&args[0], function, module);
    Some(match r#fn.as_str() {
        operation if ir::well_known_symbol(operation).is_some() => format!(
            "runtime::symbol_well_known(runtime::WellKnownSymbol::{})",
            ir::well_known_symbol(operation).unwrap()
        ),
        "sym.newAnon" => "runtime::symbol_new_anonymous()".into(),
        "sym.new" | "sym.for" => format!(
            "runtime::{}(&runtime::JsString::from({}))",
            if r#fn == "sym.new" {
                "symbol_new"
            } else {
                "symbol_for"
            },
            arg()
        ),
        "sym.toString" => format!("runtime::symbol_to_string(&({}))", arg()),
        "sym.desc" | "sym.keyFor" => {
            let Type::Union { union_id } = r#type else {
                unreachable!("validated optional string");
            };
            let arms = &module.unions[*union_id].arms;
            let string = arms.iter().position(|t| *t == Type::String).unwrap();
            let undefined = arms.iter().position(|t| *t == Type::Undefined).unwrap();
            format!(
                "match runtime::{}(&({})) {{ Some(value) => U{union_id}::V{string}(value), None => U{union_id}::V{undefined}(()), }}",
                if r#fn == "sym.desc" {
                    "symbol_description"
                } else {
                    "symbol_key_for"
                },
                arg()
            )
        }
        "dyn.typeof" => format!(
            "{{ let value = {}; runtime::JsString::from(if native_value_test(&value, \"undefined\") {{ \"undefined\" }} else if native_value_test(&value, \"boolean\") {{ \"boolean\" }} else if native_value_test(&value, \"number\") {{ \"number\" }} else if native_value_test(&value, \"string\") {{ \"string\" }} else if native_value_test(&value, \"symbol\") {{ \"symbol\" }} else if native_value_test(&value, \"function\") {{ \"function\" }} else {{ \"object\" }}) }}",
            arg()
        ),
        _ => return None,
    })
}
