//! Option-valued runtime reads keep the shared string/undefined union ABI.
use super::*;

pub(super) fn expression(
    value: &Expr,
    function: &Function,
    module: &Emission<'_>,
) -> Option<String> {
    let Expr::LibCall {
        r#fn,
        args,
        r#type: Type::Union { union_id },
        ..
    } = value
    else {
        return None;
    };
    if r#fn != "process.envGet" {
        return None;
    }
    let arms = &module.unions[*union_id].arms;
    let string = arms.iter().position(|t| *t == Type::String).unwrap();
    let undefined = arms.iter().position(|t| *t == Type::Undefined).unwrap();
    Some(format!(
        "match runtime::process_env_get(&runtime::JsString::from({})) {{ Some(value) => U{union_id}::V{string}(value), None => U{union_id}::V{undefined}(()) }}",
        expr(&args[0], function, module)
    ))
}
