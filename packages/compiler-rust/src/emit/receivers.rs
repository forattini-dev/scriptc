//! Call references evaluate their receiver once and retain it through invocation.
use super::*;

fn receiver(value: &mut Expr) -> Option<&mut Box<Expr>> {
    match value {
        Expr::DynCheck { value, .. }
        | Expr::UnionNarrow { value, .. }
        | Expr::Upcast { value, .. }
        | Expr::Downcast { value, .. } => receiver(value),
        Expr::RecordGet { obj, field, .. } => {
            if field == "\0scriptc.call" {
                receiver(obj)
            } else {
                Some(obj)
            }
        }
        Expr::RecordKeyGet { obj, .. } | Expr::FieldGet { obj, .. } => Some(obj),
        Expr::DynKeyGet { value, .. } => Some(value),
        _ => None,
    }
}

pub(super) fn call(
    callee: &Expr,
    args: &[Expr],
    dynamic_name: Option<&str>,
    function: &Function,
    module: &Module,
) -> String {
    // Preserve the typed ABI when none of its targets observes a receiver.
    // In particular, data records containing typed Sets need no dynamic mirror.
    if dynamic_name.is_none() && !functions::reads_receiver(&callee.ty(), module) {
        let arguments = args
            .iter()
            .map(|arg| format!(", {}", expr(arg, function, module)))
            .collect::<String>();
        return format!(
            "call_{}({}{arguments})",
            functions::type_name(&callee.ty(), module),
            expr(callee, function, module)
        );
    }
    let mut rewritten = callee.clone();
    let mut prefix = String::new();
    let this = if let Some(source) = receiver(&mut rewritten) {
        let local = crate::ir::Local {
            id: "native_call_receiver".into(),
            name: "call receiver".into(),
            r#type: source.ty(),
            mutable: false,
            boxed: false,
        };
        prefix = format!("let {} = {}; ", local.id, expr(source, function, module));
        **source = Expr::VarRef {
            local_id: local.id.clone(),
            r#type: local.r#type.clone(),
            loc: function.loc.clone(),
        };
        values::box_value(&local.r#type, &format!("{}.clone()", local.id), module)
    } else {
        "NativeValue::Undefined".into()
    };
    let target = expr(&rewritten, function, module);
    let arguments = args
        .iter()
        .map(|arg| expr(arg, function, module))
        .collect::<Vec<_>>();
    let call = if let Some(name) = dynamic_name {
        format!(
            "native_value_call_with_this(native_call_target, {this}, vec![{}], {name:?})",
            arguments.join(", ")
        )
    } else {
        let args = arguments
            .iter()
            .map(|arg| format!(", {arg}"))
            .collect::<String>();
        format!(
            "call_{}_with_this(native_call_target, {this}{args})",
            functions::type_name(&callee.ty(), module)
        )
    };
    format!("{{ {prefix}let native_call_target = {target}; {call} }}")
}
