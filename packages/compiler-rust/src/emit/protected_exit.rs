use super::*;

pub(super) struct Plan<'a> {
    prefix: &'a [Stmt],
    body: &'a [Stmt],
    tail: &'a [Stmt],
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
        || function.return_type != Type::Void
        || function.reads_receiver()
        || function
            .captures
            .as_ref()
            .is_some_and(|captures| !captures.is_empty())
    {
        return None;
    }
    let region = function.body.iter().position(|stmt| {
        matches!(
            stmt,
            Stmt::TryCatch {
                catch_body: Some(catch),
                catch_local_id: None,
                finally_body: None,
                ..
            } if catch.is_empty()
        )
    })?;
    let Stmt::TryCatch { try_body, .. } = &function.body[region] else {
        return None;
    };
    let prefix = &function.body[..region];
    let tail = &function.body[region + 1..];
    if !prefix
        .iter()
        .all(|stmt| matches!(stmt, Stmt::VarDecl { .. } | Stmt::Expression { .. }))
        || !matches!(
            tail,
            [Stmt::Expression {
                expr: Expr::LibCall { r#fn, .. },
                ..
            }] if r#fn == "process.exit"
        )
    {
        return None;
    }
    let mut initialized = function
        .params
        .iter()
        .map(|param| param.local_id.as_str())
        .collect::<Vec<_>>();
    for stmt in prefix {
        if let Stmt::VarDecl { local_id, .. } = stmt {
            initialized.push(local_id);
        }
    }
    let mut points = Vec::new();
    let mut live = Vec::new();
    for (index, stmt) in try_body.iter().enumerate() {
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
    (!points.is_empty()).then_some(Plan {
        prefix,
        body: try_body,
        tail,
        points,
        live,
    })
}

pub(super) fn count(plan: &Plan<'_>) -> usize {
    plan.points.len()
}

fn completion(plan: &Plan<'_>, function: &Function, module: &Emission<'_>) -> String {
    let mut output = String::new();
    for stmt in plan.tail {
        statement(stmt, function, module, &mut output);
    }
    output.push_str("let _ = runtime::promise_fulfill(&target, NativeValue::Undefined);");
    output
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
    output.push_str(&format!("let source = {promise}; let frame = runtime::Gc::new(NativeProtectedExit{index}_{stage} {{ target: Some(target.clone()), {captures} }}); runtime::promise_then_traced(&source, frame, native_protected_exit_resume_{index}_{stage});"));
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
        plan.body.len()
    } else {
        plan.points[stage]
    };
    for stmt in &plan.body[start..end] {
        statement(stmt, function, module, output);
    }
    if stage < plan.points.len() {
        schedule(index, stage, plan, function, module, output);
    } else {
        output.push_str(&completion(plan, function, module));
    }
}

pub(super) fn start(
    index: usize,
    plan: &Plan<'_>,
    function: &Function,
    module: &Emission<'_>,
    output: &mut String,
) {
    for stmt in plan.prefix {
        statement(stmt, function, module, output);
    }
    output.push_str("let target = result.clone(); let run = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {");
    segment(index, 0, plan, function, module, output);
    output.push_str(&format!("}})); if let Err(payload) = run {{ let _ = runtime::caught_from_panic(payload); native_protected_exit_catch_{index}(&target); }} }}); result\n"));
}

pub(super) fn definitions(
    index: usize,
    plan: &Plan<'_>,
    function: &Function,
    module: &Emission<'_>,
    output: &mut String,
) {
    let complete = completion(plan, function, module);
    output.push_str(&format!("fn native_protected_exit_catch_{index}(target: &runtime::JsPromise<NativeValue>) {{ let target = target.clone(); {complete} }}\n"));
    for (stage, point) in plan.points.iter().enumerate() {
        let name = format!("NativeProtectedExit{index}_{stage}");
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
        output.push_str(&format!("fn native_protected_exit_resume_{index}_{stage}(frame: runtime::Gc<{name}>, outcome: Result<NativeValue, runtime::Caught>) {{ let target = frame.with(|frame| frame.target.as_ref().expect(\"scriptc: cleared protected-exit target\").clone());"));
        for (i, local) in plan.live[stage].iter().enumerate() {
            let mutable = if local.mutable && !local.boxed {
                "mut "
            } else {
                ""
            };
            output.push_str(&format!("let {mutable}{} = frame.with(|frame| frame.c{i}.as_ref().expect(\"scriptc: cleared protected-exit capture\").clone());", local.id));
        }
        output.push_str(&format!("let guard = target.clone(); runtime::promise_run_segment(&guard, move || match outcome {{ Err(_) => native_protected_exit_catch_{index}(&target), Ok(value) => {{ let run = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {{"));
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
        output.push_str(&format!("}})); if let Err(payload) = run {{ let _ = runtime::caught_from_panic(payload); native_protected_exit_catch_{index}(&target); }} }} }}); }}\n"));
    }
}
