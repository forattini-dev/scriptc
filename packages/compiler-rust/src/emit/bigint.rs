use super::*;

pub(super) fn expression(value: &Expr, function: &Function, module: &Module) -> Option<String> {
    let Expr::LibCall { r#fn, args, .. } = value else {
        return None;
    };
    let (_, _, runtime) = crate::ir::bigint::signature(r#fn)?;
    // Capture all values before invoking conversions/operations, retaining JS
    // evaluation order and owning aliases. BigInt parameters borrow immutable limbs.
    let mut code = String::from("{ ");
    let mut names = Vec::new();
    for (index, value) in args.iter().enumerate() {
        code.push_str(&format!(
            "let a{index} = {}; ",
            expr(value, function, module)
        ));
        names.push(format!(
            "{}a{index}",
            if matches!(value.ty(), Type::Bigint | Type::String) {
                "&"
            } else {
                ""
            }
        ));
    }
    code.push_str(&format!("runtime::{runtime}({}) }}", names.join(", ")));
    Some(code)
}
