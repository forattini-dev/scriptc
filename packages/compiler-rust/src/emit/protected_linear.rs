use super::*;

pub(super) struct Plan<'a> {
    body: &'a [Stmt],
    end: usize,
    result: Option<&'a Expr>,
    fallback: Option<&'a Expr>,
    points: Vec<usize>,
    live: Vec<Vec<&'a crate::ir::Local>>,
}

fn suspension(stmt: &Stmt) -> Option<(&Expr, Option<&str>)> {
    match stmt {
        Stmt::VarDecl {
            local_id,
            init: Expr::Await { value, .. },
            ..
        } => Some((value, Some(local_id))),
        Stmt::Expression {
            expr: Expr::Await { value, .. },
            ..
        } => Some((value, None)),
        _ => None,
    }
}

pub(super) fn plan(function: &Function) -> Option<Plan<'_>> {
    if !function.is_async
        || function.reads_receiver()
        || function
            .captures
            .as_ref()
            .is_some_and(|captures| !captures.is_empty())
    {
        return None;
    }
    let (body, fallback) = if let [
        Stmt::TryCatch {
            try_body,
            catch_body: Some(catch),
            catch_local_id: None,
            finally_body: None,
            ..
        },
    ] = function.body.as_slice()
    {
        let [
            Stmt::Return {
                value: Some(fallback),
                ..
            },
        ] = catch.as_slice()
        else {
            return None;
        };
        if !matches!(
            fallback,
            Expr::NumLit { .. } | Expr::StrLit { .. } | Expr::BoolLit { .. }
        ) {
            return None;
        }
        (try_body.as_slice(), Some(fallback))
    } else {
        (function.body.as_slice(), None)
    };
    let (end, result) = match body.last() {
        Some(Stmt::Return { value, .. }) => (body.len() - 1, value.as_ref()),
        _ if matches!(function.return_type, Type::Void | Type::Undefined) => (body.len(), None),
        _ => return None,
    };
    if result.is_some_and(|result| matches!(result, Expr::Await { .. }))
        || result.is_none() && !matches!(function.return_type, Type::Void | Type::Undefined)
    {
        return None;
    }
    let mut initialized = function
        .params
        .iter()
        .map(|param| param.local_id.as_str())
        .collect::<Vec<_>>();
    let mut points = Vec::new();
    let mut live = Vec::new();
    for (index, stmt) in body.iter().enumerate().take(end) {
        if suspension(stmt).is_some() {
            points.push(index);
            live.push(
                initialized
                    .iter()
                    .map(|id| function.locals.iter().find(|local| &local.id == id))
                    .collect::<Option<Vec<_>>>()?,
            );
        } else if !matches!(stmt, Stmt::VarDecl { .. } | Stmt::Expression { .. }) {
            return None;
        }
        if let Stmt::VarDecl { local_id, .. } = stmt {
            initialized.push(local_id);
        }
    }
    if points.is_empty() {
        return None;
    }
    Some(Plan {
        body,
        end,
        result,
        fallback,
        points,
        live,
    })
}

pub(super) fn count(plan: &Plan<'_>) -> usize {
    plan.points.len()
}

fn schedule(
    index: usize,
    stage: usize,
    plan: &Plan<'_>,
    function: &Function,
    module: &Emission<'_>,
    output: &mut String,
) {
    let (awaited, _) = suspension(&plan.body[plan.points[stage]]).expect("validated suspension");
    let promise = expr(awaited, function, module);
    let captures = plan.live[stage]
        .iter()
        .enumerate()
        .map(|(i, local)| format!("c{i}: Some({}.clone()),", local.id))
        .collect::<String>();
    output.push_str(&format!("let source = {promise}; let frame = runtime::Gc::new(NativeLinear{index}_{stage} {{ target: Some(target.clone()), {captures} }}); runtime::promise_then_traced(&source, frame, native_linear_resume_{index}_{stage});"));
}

fn segment(
    index: usize,
    stage: usize,
    plan: &Plan<'_>,
    function: &Function,
    module: &Emission<'_>,
    output: &mut String,
) {
    let start = if stage == 0 {
        0
    } else {
        plan.points[stage - 1] + 1
    };
    let end = if stage == plan.points.len() {
        plan.end
    } else {
        plan.points[stage]
    };
    for stmt in &plan.body[start..end] {
        statement(stmt, function, module, output);
    }
    if stage < plan.points.len() {
        schedule(index, stage, plan, function, module, output);
    } else {
        if let Some(result) = plan.result {
            let result = expr(result, function, module);
            let boxed = values::box_value(&function.return_type, "returned", module);
            output.push_str(&format!("let returned = {result}; let returned = {boxed}; native_promise_plain(&returned); let _ = runtime::promise_fulfill(&target, returned);"));
        } else {
            output.push_str("let returned = NativeValue::Undefined; native_promise_plain(&returned); let _ = runtime::promise_fulfill(&target, returned);");
        }
    }
}

pub(super) fn start(
    index: usize,
    plan: &Plan<'_>,
    function: &Function,
    module: &Emission<'_>,
    output: &mut String,
) {
    output.push_str("let target = result.clone(); let run = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {");
    segment(index, 0, plan, function, module, output);
    output.push_str(&format!("}})); if let Err(payload) = run {{ let reason = runtime::caught_from_panic(payload); native_linear_catch_{index}(&target, reason); }} }}); result\n"));
}

pub(super) fn definitions(
    index: usize,
    plan: &Plan<'_>,
    function: &Function,
    module: &Emission<'_>,
    output: &mut String,
) {
    let handle_error = if let Some(fallback) = plan.fallback {
        let fallback = expr(fallback, function, module);
        let boxed = values::box_value(&function.return_type, "value", module);
        format!(
            "let _ = reason; let value = {fallback}; let value = {boxed}; native_promise_plain(&value); let _ = runtime::promise_fulfill(target, value);"
        )
    } else {
        "let _ = runtime::promise_reject(target, reason);".into()
    };
    output.push_str(&format!("fn native_linear_catch_{index}(target: &runtime::JsPromise<NativeValue>, reason: runtime::Caught) {{ {handle_error} }}\n"));
    for (stage, point) in plan.points.iter().enumerate() {
        let name = format!("NativeLinear{index}_{stage}");
        output.push_str(&format!(
            "struct {name} {{ target: Option<runtime::JsPromise<NativeValue>>,"
        ));
        for (i, local) in plan.live[stage].iter().enumerate() {
            let ty = rust_type(local.r#type.clone(), module);
            let ty = if local.boxed {
                format!("runtime::Gc<NativeCell<{ty}>>")
            } else {
                ty
            };
            output.push_str(&format!("c{i}: Option<{ty}>,"));
        }
        output.push_str(&format!("}} impl runtime::Trace for {name} {{ fn trace(&self, tracer: &mut runtime::Tracer<'_>) {{ if let Some(value) = &self.target {{ value.trace_native(tracer); }}"));
        for i in 0..plan.live[stage].len() {
            output.push_str(&format!(
                "if let Some(value) = &self.c{i} {{ value.trace_native(tracer); }}"
            ));
        }
        output.push_str(&format!("}} }} impl runtime::ClearEdges for {name} {{ fn clear_edges(&mut self) {{ self.target = None;"));
        for i in 0..plan.live[stage].len() {
            output.push_str(&format!("self.c{i} = None;"));
        }
        output.push_str("} }\n");
        output.push_str(&format!("fn native_linear_resume_{index}_{stage}(frame: runtime::Gc<{name}>, outcome: Result<NativeValue, runtime::Caught>) {{ let target = frame.with(|frame| frame.target.as_ref().expect(\"scriptc: cleared target\").clone());"));
        for (i, local) in plan.live[stage].iter().enumerate() {
            let mutable = if local.mutable && !local.boxed {
                "mut "
            } else {
                ""
            };
            output.push_str(&format!("let {mutable}{} = frame.with(|frame| frame.c{i}.as_ref().expect(\"scriptc: cleared capture\").clone());", local.id));
        }
        output.push_str(&format!("let guard = target.clone(); runtime::promise_run_segment(&guard, move || match outcome {{ Err(reason) => native_linear_catch_{index}(&target, reason), Ok(value) => {{ let run = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {{"));
        if let Some((_, Some(id))) = suspension(&plan.body[*point]) {
            let local = function
                .locals
                .iter()
                .find(|local| local.id == id)
                .expect("validated await local");
            let value = values::checked_value(&local.r#type, "value", module);
            let value = if local.boxed {
                format!("native_cell({value})")
            } else {
                value
            };
            let mutable = if local.mutable && !local.boxed {
                "mut "
            } else {
                ""
            };
            output.push_str(&format!("let {mutable}{id} = {value};"));
        }
        segment(index, stage + 1, plan, function, module, output);
        output.push_str(&format!("}})); if let Err(payload) = run {{ let reason = runtime::caught_from_panic(payload); native_linear_catch_{index}(&target, reason); }} }} }}); }}\n"));
    }
}
