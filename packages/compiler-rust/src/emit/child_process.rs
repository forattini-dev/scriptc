//! Builtin function bodies dispatch to asynchronous native process primitives.
use super::*;
use std::fmt::Write;

pub(super) fn definitions(module: &Module, out: &mut String) {
    let mut result = None;
    let mut used = false;
    module.visit_expressions(&mut |expr| {
        if let Expr::LibCall { r#fn, r#type, .. } = expr {
            used |= matches!(r#fn.as_str(), "cp.execFileNative" | "cp.execFilePromise");
            if r#fn == "cp.execFilePromise"
                && let Type::Promise { inner } = r#type
            {
                result = Some((**inner).clone());
            }
        }
    });
    if !used {
        return;
    }
    out.push_str("fn native_exec_is_array(value: &NativeValue) -> bool { matches!(value, NativeValue::Array(_) ");
    for (index, ty) in values::types(module).iter().enumerate() {
        if matches!(ty, Type::Array { elem } if **elem != Type::Dyn) {
            write!(out, "| NativeValue::V{index}(_) ").unwrap();
        }
    }
    out.push_str(") }\n");
    out.push_str(include_str!("../child_process_support.rs"));
    if let Some(result) = result {
        let value = "runtime::Gc::new(NativeRecordData { entries: vec![(\"stdout\".into(), NativeValue::String(output.stdout.clone())), (\"stderr\".into(), NativeValue::String(output.stderr.clone()))] })";
        let boxed = values::box_value(&result, value, module);
        writeln!(out, "fn native_exec_promise(args: runtime::JsArray<NativeValue>) -> runtime::JsPromise<NativeValue> {{ let request = native_exec_request(args, true); let promise = runtime::promise_new(); let target = promise.clone(); let traced = target.clone(); let child = runtime::child_exec_file_options(&request.command, &request.arguments, request.options, std::rc::Rc::new(move |output| {{ if output.error.is_some() {{ let _ = runtime::promise_reject(&target, runtime::caught_value(native_exec_error(&output, true))); }} else {{ let value = {boxed}; let _ = runtime::promise_fulfill(&target, value); }} }}), std::rc::Rc::new(move |tracer| tracer.edge(&traced))); runtime::promise_own_set(&promise, \"child\", child); promise }}").unwrap();
    }
}

pub(super) fn expression(value: &Expr, function: &Function, module: &Module) -> Option<String> {
    let Expr::LibCall {
        r#fn, args, r#type, ..
    } = value
    else {
        return None;
    };
    let name = match r#fn.as_str() {
        "cp.execFileNative" => {
            return Some(format!(
                "native_exec_callback({})",
                expr(&args[0], function, module)
            ));
        }
        "cp.execFilePromise" => {
            return Some(format!(
                "native_exec_promise({})",
                expr(&args[0], function, module)
            ));
        }
        "cp.promiseChild" => {
            return Some(format!(
                "runtime::promise_own_get::<_, runtime::JsChild>(&({}), \"child\").unwrap_or_else(|| runtime::throw_type_error(\"scriptc: required Promise child property is missing\".into()))",
                expr(&args[0], function, module)
            ));
        }
        "child.killed" => {
            return Some(format!(
                "runtime::child_killed(&({}))",
                expr(&args[0], function, module)
            ));
        }
        "child.pid" => "pid",
        "child.exitCode" => "exit_code",
        _ => return None,
    };
    let Type::Union { union_id } = r#type else {
        unreachable!("validated child lookup");
    };
    let number = module.unions[*union_id]
        .arms
        .iter()
        .position(|t| *t == Type::F64)
        .unwrap();
    let empty = 1 - number;
    Some(format!(
        "match runtime::child_{name}(&({})) {{ Some(value) => U{union_id}::V{number}(value), None => U{union_id}::V{empty}(()), }}",
        expr(&args[0], function, module)
    ))
}
