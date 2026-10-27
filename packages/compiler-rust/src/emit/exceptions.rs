//! Completion records keep protected return values and exceptions pending.
use super::*;
use std::fmt::Write;

pub(super) fn definitions(module: &Emission<'_>, output: &mut String) {
    output.push_str("fn native_exception_string(caught: &runtime::Caught) -> runtime::JsString { if runtime::caught_is::<NativeValue>(caught) { return match runtime::caught_narrow::<NativeValue>(caught) {\n");
    if !module.classes.is_empty() {
        output.push_str("NativeValue::Instance(object) if object.with(|o| o.error.is_some()) => error_string(object),\n");
    }
    output.push_str("value @ (NativeValue::Undefined | NativeValue::Null | NativeValue::BigInt(_) | NativeValue::Number(_) | NativeValue::Boolean(_) | NativeValue::String(_)) => native_value_string(value), _ => runtime::JsString::from(\"[object Object]\"), }; } runtime::caught_to_string(caught) }\n");
    if module.classes.iter().any(|c| c.name == "%Error") {
        output.push_str("fn native_caught(caught: runtime::Caught) -> NativeValue { if runtime::caught_is::<NativeValue>(&caught) { return runtime::caught_narrow::<NativeValue>(&caught); } if runtime::caught_is::<f64>(&caught) { return NativeValue::Number(runtime::caught_narrow::<f64>(&caught)); } if runtime::caught_is::<bool>(&caught) { return NativeValue::Boolean(runtime::caught_narrow::<bool>(&caught)); } if runtime::caught_is::<runtime::JsString>(&caught) { return NativeValue::String(runtime::caught_narrow::<runtime::JsString>(&caught)); } if runtime::caught_is_error(&caught) { let error = runtime::caught_error_value(&caught); let name = runtime::error_name(&error); let message = runtime::error_message(&error); let code = runtime::error_code(&error); let object = match name.well_formed_utf8().unwrap_or(\"\") {\n");
        for (index, class) in module.classes.iter().enumerate().filter(|(_, c)| c.runtime) {
            writeln!(
                output,
                "{:?} => instance_allocate_{index}(),",
                class.js_name
            )
            .unwrap();
        }
        let root = module
            .classes
            .iter()
            .position(|c| c.name == "%Error")
            .unwrap();
        writeln!(output, "_ => instance_allocate_{root}(), }}; object.with_mut(|object| {{ let error = object.error.as_mut().expect(\"validated Error receiver\"); error.name = name; error.message = message; if let Some(code) = code {{ error.own.push((runtime::JsString::from(\"code\"), NativeValue::String(code))); }} }}); return NativeValue::Instance(object); }} runtime::throw_type_error(\"scriptc: unknown native exception payload\".into()) }}").unwrap();
    } else {
        output.push_str("fn native_caught(caught: runtime::Caught) -> NativeValue { if runtime::caught_is::<NativeValue>(&caught) { return runtime::caught_narrow::<NativeValue>(&caught); } runtime::throw_type_error(\"scriptc: native exception conversion requires Error classes\".into()) }\n");
    }
}
fn region(
    body: &[Stmt],
    function: &Function,
    module: &Emission<'_>,
    output: &mut String,
    flow: &FlowContext,
) {
    let mut inner = flow.clone();
    inner.region += 1;
    writeln!(
        output,
        "match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {{"
    )
    .unwrap();
    for stmt in body {
        statement_with_flow(stmt, function, module, output, &inner);
    }
    writeln!(output, "runtime::Completion::<{}>::Normal\n}})) {{ Ok(completion) => completion, Err(payload) => runtime::Completion::Throw(runtime::caught_from_panic(payload)), }}", rust_type(function.return_type.clone(), module)).unwrap();
}
pub(super) fn statement(
    stmt: &Stmt,
    function: &Function,
    module: &Emission<'_>,
    output: &mut String,
    flow: &FlowContext,
) {
    let Stmt::TryCatch {
        try_body,
        catch_body,
        catch_local_id,
        finally_body,
        ..
    } = stmt
    else {
        unreachable!()
    };
    output.push_str("{ let pending = ");
    region(try_body, function, module, output, flow);
    output.push_str(";\n");
    if let Some(body) = catch_body {
        output.push_str("let pending = match pending { runtime::Completion::Throw(caught) => { ");
        if let Some(id) = catch_local_id {
            let boxed = function
                .locals
                .iter()
                .any(|local| local.id == *id && local.boxed);
            let value = if boxed {
                "native_cell(native_caught(caught))"
            } else {
                "native_caught(caught)"
            };
            writeln!(output, "let {id} = {value};").unwrap();
        } else {
            output.push_str("drop(caught); ");
        }
        region(body, function, module, output, flow);
        output.push_str(" }, completion => completion };\n");
    }
    if let Some(body) = finally_body {
        output.push_str("let final_completion = ");
        region(body, function, module, output, flow);
        output.push_str("; let pending = match final_completion { runtime::Completion::Normal => pending, completion => completion };\n");
    }
    let normal = if crate::ir::always_returns(std::slice::from_ref(stmt)) {
        "unreachable!(\"abrupt protected region\")"
    } else {
        "()"
    };
    let returned = if flow.region != 0 {
        "return runtime::Completion::Return(value)"
    } else {
        "return value"
    };
    writeln!(output, "match pending {{ runtime::Completion::Normal => {normal}, runtime::Completion::Return(value) => {{ {returned} }}, runtime::Completion::Throw(caught) => runtime::rethrow_caught(caught),").unwrap();
    for (id, target) in flow.targets.iter().enumerate() {
        if target.region == flow.region {
            writeln!(
                output,
                "runtime::Completion::Break({id}) => break 'native_loop_{id},"
            )
            .unwrap();
            if target.allows_continue {
                writeln!(
                    output,
                    "runtime::Completion::Continue({id}) => continue 'native_loop_{id},"
                )
                .unwrap();
            }
        }
    }
    let jump = if flow.region != 0 {
        "completion => return completion"
    } else {
        "_ => unreachable!(\"validated completion target\")"
    };
    writeln!(output, "{jump}, }} }}").unwrap();
}

pub(super) fn expression(
    value: &Expr,
    function: &Function,
    module: &Emission<'_>,
) -> Option<String> {
    Some(match value {
        Expr::CaughtToDyn { value, .. } => expr(value, function, module),
        Expr::CaughtNarrow { value, r#type, .. } => {
            values::checked_value(r#type, &expr(value, function, module), module)
        }
        Expr::CaughtTest {
            value, class_name, ..
        } => {
            let index = module
                .classes
                .iter()
                .position(|c| c.name == *class_name)
                .unwrap();
            format!(
                "match {} {{ NativeValue::Instance(object) => instance_is_{index}(object), _ => false }}",
                expr(value, function, module)
            )
        }
        _ => return None,
    })
}
