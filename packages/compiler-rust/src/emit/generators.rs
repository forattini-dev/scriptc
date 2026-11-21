//! Safe generator continuations over the runtime's typed resume protocol.
use super::*;

pub(super) fn expression(
    value: &Expr,
    function: &Function,
    module: &Emission<'_>,
) -> Option<String> {
    let (generator, argument, returning) = match value {
        Expr::GeneratorNext {
            generator, value, ..
        } => (generator.as_ref(), Some(value.as_ref()), false),
        Expr::GeneratorReturn {
            generator, value, ..
        } => (generator.as_ref(), value.as_deref(), true),
        _ => return None,
    };
    let Type::Generator {
        r#async,
        yield_type,
        return_type,
        ..
    } = generator.ty()
    else {
        unreachable!("validated generator resume")
    };
    let yielded = values::box_value(&yield_type, "value", module);
    let returned = if matches!(*return_type, Type::Void | Type::Undefined) {
        "NativeValue::Undefined".into()
    } else {
        let boxed = values::box_value(&return_type, "value", module);
        format!("match value {{ Some(value) => {boxed}, None => NativeValue::Undefined }}")
    };
    let generator = expr(generator, function, module);
    let input = argument.map(|value| expr(value, function, module));
    let call = if returning {
        let input = input.map_or_else(
            || "None".into(),
            |value| {
                if matches!(*return_type, Type::Void | Type::Undefined) {
                    format!("Some({{ let _ = {value}; () }})")
                } else {
                    format!("Some({value})")
                }
            },
        );
        if r#async {
            format!("runtime::async_generator_return(&generator, {input})")
        } else {
            format!("runtime::generator_return(&generator, {input})")
        }
    } else {
        let input = input.expect("generator next input");
        if r#async {
            format!("runtime::async_generator_next(&generator, {input})")
        } else {
            format!("runtime::generator_next(&generator, {input})")
        }
    };
    let iterator_result = "|value: NativeValue, done: bool| NativeValue::Object(runtime::Gc::new(NativeMap { null_prototype: false, symbol_properties: None, entries: vec![(runtime::string(\"value\"), value), (runtime::string(\"done\"), NativeValue::Boolean(done))], hash_index: NativeHashIndex::default() }))";
    if r#async {
        Some(format!(
            "{{ let generator = {generator}; let source = {call}; let result = runtime::promise_new(); let continuation = result.clone(); runtime::promise_then(&source, Box::new(move |outcome| {{ match outcome {{ Ok(step) => {{ let iterator_result = {iterator_result}; let value = match step {{ runtime::AsyncGeneratorStep::Yielded(value) => iterator_result({yielded}, false), runtime::AsyncGeneratorStep::Returned(value) => iterator_result({returned}, true) }}; let _ = runtime::promise_fulfill(&continuation, value); }}, Err(reason) => {{ let _ = runtime::promise_reject(&continuation, reason); }} }} }})); result }}"
        ))
    } else {
        Some(format!(
            "{{ let generator = {generator}; let iterator_result = {iterator_result}; match {call} {{ runtime::GeneratorStep::Yielded(value) => iterator_result({yielded}, false), runtime::GeneratorStep::Returned(value) => iterator_result({returned}, true) }} }}"
        ))
    }
}

fn contains_yield_expr(value: &Expr) -> bool {
    let mut found = false;
    crate::ir::walk_expression(value, &mut |expr| {
        found |= matches!(expr, Expr::Yield { .. } | Expr::YieldStar { .. });
    });
    found
}

fn contains_await_expr(value: &Expr) -> bool {
    let mut found = false;
    crate::ir::walk_expression(value, &mut |expr| {
        found |= matches!(expr, Expr::Await { .. });
    });
    found
}

fn statement_has_yield(stmt: &Stmt) -> bool {
    let mut found = false;
    match stmt {
        Stmt::GeneratorForOf {
            generator, body, ..
        } => {
            found |= contains_yield_expr(generator);
            found |= body.iter().any(statement_has_yield);
        }
        Stmt::Switch { disc, cases, .. } => {
            found |= contains_yield_expr(disc);
            found |= cases.iter().any(|case| {
                case.test.as_ref().is_some_and(contains_yield_expr)
                    || case.body.iter().any(statement_has_yield)
            });
        }
        Stmt::ArraySet {
            arr, index, value, ..
        }
        | Stmt::BytesSet {
            arr, index, value, ..
        } => {
            found |= contains_yield_expr(arr)
                || contains_yield_expr(index)
                || contains_yield_expr(value);
        }
        Stmt::ArraySetLength { arr, length, .. } => {
            found |= contains_yield_expr(arr) || contains_yield_expr(length);
        }
        Stmt::Throw { value, .. }
        | Stmt::Assign { value, .. }
        | Stmt::RecordSet {
            obj: value,
            value: _,
            ..
        } => found |= contains_yield_expr(value),
        Stmt::TryCatch {
            try_body,
            catch_body,
            finally_body,
            ..
        } => {
            found |= try_body.iter().any(statement_has_yield)
                || catch_body
                    .as_ref()
                    .is_some_and(|body| body.iter().any(statement_has_yield))
                || finally_body
                    .as_ref()
                    .is_some_and(|body| body.iter().any(statement_has_yield));
        }
        Stmt::FieldSet { obj, value, .. } => {
            found |= contains_yield_expr(obj) || contains_yield_expr(value);
        }
        Stmt::While { cond, body, .. } => {
            found |= contains_yield_expr(cond) || body.iter().any(statement_has_yield);
        }
        Stmt::RecordKeySet {
            obj, key, value, ..
        } => {
            found |=
                contains_yield_expr(obj) || contains_yield_expr(key) || contains_yield_expr(value);
        }
        Stmt::Return { value, .. } => found |= value.as_ref().is_some_and(contains_yield_expr),
        Stmt::VarDecl { init, .. } => found |= contains_yield_expr(init),
        Stmt::Expression { expr, .. } => found |= contains_yield_expr(expr),
        Stmt::If {
            cond, then, else_, ..
        } => {
            found |= contains_yield_expr(cond)
                || then.iter().any(statement_has_yield)
                || else_
                    .as_ref()
                    .is_some_and(|body| body.iter().any(statement_has_yield));
        }
        Stmt::Block { body, .. } => found |= body.iter().any(statement_has_yield),
        Stmt::Break { .. } | Stmt::Continue { .. } => {}
    }
    found
}

pub(super) fn statement_has_await(stmt: &Stmt) -> bool {
    let mut found = false;
    match stmt {
        Stmt::GeneratorForOf {
            generator, body, ..
        } => {
            found |= contains_await_expr(generator);
            found |= body.iter().any(statement_has_await);
        }
        Stmt::Switch { disc, cases, .. } => {
            found |= contains_await_expr(disc);
            found |= cases.iter().any(|case| {
                case.test.as_ref().is_some_and(contains_await_expr)
                    || case.body.iter().any(statement_has_await)
            });
        }
        Stmt::ArraySet {
            arr, index, value, ..
        }
        | Stmt::BytesSet {
            arr, index, value, ..
        } => {
            found |= contains_await_expr(arr)
                || contains_await_expr(index)
                || contains_await_expr(value);
        }
        Stmt::ArraySetLength { arr, length, .. } => {
            found |= contains_await_expr(arr) || contains_await_expr(length);
        }
        Stmt::Throw { value, .. }
        | Stmt::Assign { value, .. }
        | Stmt::RecordSet {
            obj: value,
            value: _,
            ..
        } => found |= contains_await_expr(value),
        Stmt::TryCatch {
            try_body,
            catch_body,
            finally_body,
            ..
        } => {
            found |= try_body.iter().any(statement_has_await)
                || catch_body
                    .as_ref()
                    .is_some_and(|body| body.iter().any(statement_has_await))
                || finally_body
                    .as_ref()
                    .is_some_and(|body| body.iter().any(statement_has_await));
        }
        Stmt::FieldSet { obj, value, .. } => {
            found |= contains_await_expr(obj) || contains_await_expr(value);
        }
        Stmt::While { cond, body, .. } => {
            found |= contains_await_expr(cond) || body.iter().any(statement_has_await);
        }
        Stmt::RecordKeySet {
            obj, key, value, ..
        } => {
            found |=
                contains_await_expr(obj) || contains_await_expr(key) || contains_await_expr(value);
        }
        Stmt::Return { value, .. } => found |= value.as_ref().is_some_and(contains_await_expr),
        Stmt::VarDecl { init, .. } => found |= contains_await_expr(init),
        Stmt::Expression { expr, .. } => found |= contains_await_expr(expr),
        Stmt::If {
            cond, then, else_, ..
        } => {
            found |= contains_await_expr(cond)
                || then.iter().any(statement_has_await)
                || else_
                    .as_ref()
                    .is_some_and(|body| body.iter().any(statement_has_await));
        }
        Stmt::Block { body, .. } => found |= body.iter().any(statement_has_await),
        Stmt::Break { .. } | Stmt::Continue { .. } => {}
    }
    found
}

fn supported_yield_star_condition(condition: &Expr) -> bool {
    matches!(
        condition,
        Expr::Logical { op, right, .. }
            if op == "&&"
                && matches!(right.as_ref(), Expr::DynScalarEq { left, right, .. }
                    if matches!(left.as_ref(), Expr::YieldStar { generator, .. }
                        if matches!(generator.ty(), Type::Generator { r#async: false, .. }))
                        && !contains_yield_expr(right)
                        && !contains_await_expr(right))
    )
}

fn assigned_yield_star(value: &Expr) -> Option<&Expr> {
    match value {
        Expr::YieldStar { generator, .. } => Some(generator),
        Expr::DynFrom { value, .. } => match value.as_ref() {
            Expr::YieldStar { generator, .. } => Some(generator),
            _ => None,
        },
        _ => None,
    }
}

fn projected_yield_star(value: &Expr) -> Option<&Expr> {
    match value {
        Expr::YieldStar { generator, .. } => Some(generator),
        Expr::DynFrom { value, .. }
        | Expr::DynCheck { value, .. }
        | Expr::UnionWrap { value, .. } => projected_yield_star(value),
        _ => None,
    }
}

fn extract_suspension(
    value: &mut Expr,
    loc: &crate::ir::Loc,
    locals: &mut Vec<crate::ir::Local>,
    next_local: &mut usize,
) -> Option<Stmt> {
    projected_yield_star(value)?;
    let init = value.clone();
    let r#type = init.ty();
    let id = loop {
        let id = format!("sc_suspend_{}", *next_local);
        *next_local += 1;
        if !locals.iter().any(|local| local.id == id) {
            break id;
        }
    };
    locals.push(crate::ir::Local {
        id: id.clone(),
        name: "generator suspension".into(),
        r#type: r#type.clone(),
        mutable: false,
        boxed: true,
    });
    *value = Expr::VarRef {
        local_id: id.clone(),
        r#type,
        loc: loc.clone(),
    };
    Some(Stmt::VarDecl {
        local_id: id,
        init,
        loc: loc.clone(),
    })
}

fn normalize_body(
    body: &mut Vec<Stmt>,
    locals: &mut Vec<crate::ir::Local>,
    next_local: &mut usize,
) {
    let original = std::mem::take(body);
    for mut stmt in original {
        match &mut stmt {
            Stmt::GeneratorForOf { body, .. }
            | Stmt::While { body, .. }
            | Stmt::Block { body, .. } => normalize_body(body, locals, next_local),
            Stmt::Switch { cases, .. } => {
                for case in cases {
                    normalize_body(&mut case.body, locals, next_local);
                }
            }
            Stmt::TryCatch {
                try_body,
                catch_body,
                catch_local_id,
                finally_body,
                loc,
            } => {
                normalize_body(try_body, locals, next_local);
                if let Some(body) = catch_body {
                    normalize_body(body, locals, next_local);
                }
                if let Some(body) = finally_body {
                    normalize_body(body, locals, next_local);
                }
                let suspends =
                    try_body
                        .iter()
                        .chain(finally_body.iter().flatten())
                        .any(|statement| {
                            statement_has_yield(statement) || statement_has_await(statement)
                        });
                if suspends && catch_body.is_none() && finally_body.is_some() {
                    let id = loop {
                        let id = format!("sc_generator_caught_{}", *next_local);
                        *next_local += 1;
                        if !locals.iter().any(|local| local.id == id) {
                            break id;
                        }
                    };
                    locals.push(crate::ir::Local {
                        id: id.clone(),
                        name: "generator finally error".into(),
                        r#type: Type::Caught,
                        mutable: false,
                        boxed: false,
                    });
                    *catch_local_id = Some(id.clone());
                    *catch_body = Some(vec![Stmt::Throw {
                        value: Expr::CaughtToDyn {
                            value: Box::new(Expr::VarRef {
                                local_id: id,
                                r#type: Type::Caught,
                                loc: loc.clone(),
                            }),
                            r#type: Type::Dyn,
                            loc: loc.clone(),
                        },
                        loc: loc.clone(),
                    }]);
                }
            }
            Stmt::If { then, else_, .. } => {
                normalize_body(then, locals, next_local);
                if let Some(body) = else_ {
                    normalize_body(body, locals, next_local);
                }
            }
            _ => {}
        }

        let mut prefix = Vec::new();
        if let Stmt::VarDecl { init, .. } = &mut stmt {
            match init {
                Expr::Call { args, loc, .. }
                | Expr::Intrinsic { args, loc, .. }
                | Expr::LibCall { args, loc, .. } => {
                    let loc = loc.clone();
                    for arg in args.iter_mut() {
                        prefix.extend(extract_suspension(arg, &loc, locals, next_local));
                    }
                }
                Expr::Bin {
                    left, right, loc, ..
                } => {
                    let loc = loc.clone();
                    prefix.extend(extract_suspension(left.as_mut(), &loc, locals, next_local));
                    prefix.extend(extract_suspension(right.as_mut(), &loc, locals, next_local));
                }
                _ => {}
            }
        }
        match &mut stmt {
            Stmt::FieldSet { value, loc, .. }
            | Stmt::RecordSet { value, loc, .. }
            | Stmt::Throw { value, loc }
            | Stmt::Assign { value, loc, .. } => {
                prefix.extend(extract_suspension(value, loc, locals, next_local));
            }
            Stmt::ArraySet {
                arr,
                index,
                value,
                loc,
            }
            | Stmt::BytesSet {
                arr,
                index,
                value,
                loc,
            } => {
                prefix.extend(extract_suspension(arr, loc, locals, next_local));
                prefix.extend(extract_suspension(index, loc, locals, next_local));
                prefix.extend(extract_suspension(value, loc, locals, next_local));
            }
            Stmt::RecordKeySet {
                obj,
                key,
                value,
                loc,
                ..
            } => {
                prefix.extend(extract_suspension(obj, loc, locals, next_local));
                prefix.extend(extract_suspension(key, loc, locals, next_local));
                prefix.extend(extract_suspension(value, loc, locals, next_local));
            }
            Stmt::ArraySetLength { arr, length, loc } => {
                prefix.extend(extract_suspension(arr, loc, locals, next_local));
                prefix.extend(extract_suspension(length, loc, locals, next_local));
            }
            _ => {}
        }
        body.extend(prefix);
        body.push(stmt);
    }
}

pub(super) fn normalize(module: &mut Module) {
    for function in &mut module.functions {
        if function.generator.is_none() {
            continue;
        }
        let mut next_local = function.locals.len();
        normalize_body(&mut function.body, &mut function.locals, &mut next_local);
    }
}

fn supported_statements(body: &[Stmt], is_async: bool) -> bool {
    body.iter().all(|stmt| match stmt {
        Stmt::GeneratorForOf {
            generator, body, ..
        } => {
            !contains_yield_expr(generator)
                && !contains_await_expr(generator)
                && supported_statements(body, is_async)
        }
        Stmt::Switch { disc, cases, .. } => {
            !contains_yield_expr(disc)
                && !contains_await_expr(disc)
                && cases.iter().all(|case| {
                    case.test
                        .as_ref()
                        .is_none_or(|test| !contains_yield_expr(test) && !contains_await_expr(test))
                        && supported_statements(&case.body, is_async)
                })
        }
        Stmt::Expression {
            expr: Expr::Yield { .. } | Expr::YieldStar { .. },
            ..
        } => true,
        Stmt::Expression {
            expr: Expr::Sequence { stmts, result, .. },
            ..
        } => {
            supported_statements(stmts, is_async)
                && !contains_yield_expr(result)
                && !contains_await_expr(result)
        }
        Stmt::Expression {
            expr:
                Expr::ArrayIntrinsic {
                    method,
                    args,
                    receiver,
                    ..
                },
            ..
        } if method == "push"
            && matches!(receiver.ty(), Type::Array { .. })
            && matches!(args.as_slice(), [Expr::YieldStar { .. }]) =>
        {
            true
        }
        Stmt::VarDecl {
            init: Expr::Yield { .. } | Expr::YieldStar { .. },
            ..
        } => true,
        Stmt::VarDecl { init, .. } if projected_yield_star(init).is_some() => true,
        Stmt::Assign { value, .. } if assigned_yield_star(value).is_some() => true,
        Stmt::Return {
            value: Some(value), ..
        } if projected_yield_star(value).is_some() => true,
        Stmt::Return {
            value:
                Some(Expr::Await {
                    r#type: Type::Void | Type::Null | Type::Undefined,
                    ..
                }),
            ..
        } => is_async,
        Stmt::Return {
            value: Some(Expr::Sequence { stmts, result, .. }),
            ..
        } => {
            supported_statements(stmts, is_async)
                && !contains_yield_expr(result)
                && !contains_await_expr(result)
        }
        Stmt::If {
            cond, then, else_, ..
        } => {
            (!contains_yield_expr(cond) || supported_yield_star_condition(cond))
                && !contains_await_expr(cond)
                && supported_statements(then, is_async)
                && else_
                    .as_ref()
                    .is_none_or(|body| supported_statements(body, is_async))
        }
        Stmt::While { cond, body, .. } => {
            !contains_yield_expr(cond)
                && !contains_await_expr(cond)
                && supported_statements(body, is_async)
        }
        Stmt::Block { body, .. } => supported_statements(body, is_async),
        Stmt::VarDecl {
            init: Expr::Await { .. },
            ..
        } => is_async,
        Stmt::Expression {
            expr: Expr::Await { .. },
            ..
        } => is_async,
        Stmt::TryCatch {
            try_body,
            catch_body: Some(catch_body),
            catch_local_id: Some(_),
            finally_body: Some(finally_body),
            ..
        } => {
            matches!(catch_body.last(), Some(Stmt::Throw { .. }))
                && !catch_body.iter().any(statement_has_yield)
                && !catch_body.iter().any(statement_has_await)
                && supported_statements(try_body, is_async)
                && supported_statements(finally_body, is_async)
        }
        Stmt::TryCatch {
            try_body,
            catch_body: Some(catch_body),
            catch_local_id: Some(_),
            finally_body: None,
            ..
        } => supported_statements(try_body, is_async) && supported_statements(catch_body, is_async),
        Stmt::Break { .. } | Stmt::Continue { .. } => true,
        _ => !statement_has_yield(stmt) && !statement_has_await(stmt),
    })
}

pub(super) fn supported(function: &Function) -> bool {
    function.generator.is_some() && supported_statements(&function.body, function.is_async)
}

pub(super) fn unsupported_reason(function: &Function) -> String {
    fn walk(body: &[Stmt], is_async: bool, path: &str) -> Option<String> {
        for (index, stmt) in body.iter().enumerate() {
            if supported_statements(std::slice::from_ref(stmt), is_async) {
                continue;
            }
            let here = format!("{path}[{index}]");
            match stmt {
                Stmt::If {
                    cond, then, else_, ..
                } => {
                    if contains_await_expr(cond) {
                        return Some(format!("{here}: await in if condition"));
                    }
                    if let Some(reason) = walk(then, is_async, &format!("{here}.then")) {
                        return Some(reason);
                    }
                    if let Some(other) = else_
                        && let Some(reason) = walk(other, is_async, &format!("{here}.else"))
                    {
                        return Some(reason);
                    }
                    return Some(format!("{here}: unsupported if continuation"));
                }
                Stmt::Block { body, .. } | Stmt::While { body, .. } => {
                    if let Some(reason) = walk(body, is_async, &format!("{here}.body")) {
                        return Some(reason);
                    }
                    return Some(format!("{here}: await in loop condition"));
                }
                Stmt::GeneratorForOf {
                    generator, body, ..
                } => {
                    if contains_await_expr(generator) {
                        return Some(format!("{here}: await in for-of source"));
                    }
                    if let Some(reason) = walk(body, is_async, &format!("{here}.body")) {
                        return Some(reason);
                    }
                    return Some(format!("{here}: unsupported for-of continuation"));
                }
                Stmt::Switch { disc, cases, .. } => {
                    if contains_await_expr(disc)
                        || cases
                            .iter()
                            .any(|case| case.test.as_ref().is_some_and(contains_await_expr))
                    {
                        return Some(format!("{here}: await in switch selector"));
                    }
                    for (case_index, case) in cases.iter().enumerate() {
                        if let Some(reason) =
                            walk(&case.body, is_async, &format!("{here}.case[{case_index}]"))
                        {
                            return Some(reason);
                        }
                    }
                    return Some(format!("{here}: unsupported switch continuation"));
                }
                Stmt::TryCatch {
                    try_body,
                    catch_body,
                    finally_body,
                    ..
                } => {
                    if let Some(reason) = walk(try_body, is_async, &format!("{here}.try")) {
                        return Some(reason);
                    }
                    if let Some(catch) = catch_body
                        && let Some(reason) = walk(catch, is_async, &format!("{here}.catch"))
                    {
                        return Some(reason);
                    }
                    if let Some(finally) = finally_body
                        && let Some(reason) = walk(finally, is_async, &format!("{here}.finally"))
                    {
                        return Some(reason);
                    }
                    return Some(format!(
                        "{here}: unsupported try shape (catch={}, finally={})",
                        catch_body.is_some(),
                        finally_body.is_some()
                    ));
                }
                Stmt::Return { .. } => return Some(format!("{here}: await in return value")),
                Stmt::Assign { .. } => return Some(format!("{here}: await in assignment")),
                Stmt::Throw { .. } => return Some(format!("{here}: await in throw value")),
                Stmt::VarDecl { .. } => {
                    return Some(format!("{here}: nested await in declaration"));
                }
                Stmt::Expression { .. } => {
                    return Some(format!("{here}: nested await in expression"));
                }
                Stmt::RecordSet { .. } | Stmt::FieldSet { .. } => {
                    return Some(format!("{here}: await in property write"));
                }
                Stmt::RecordKeySet { .. } => {
                    return Some(format!("{here}: await in computed property write"));
                }
                Stmt::ArraySet { .. } | Stmt::BytesSet { .. } => {
                    return Some(format!("{here}: await in indexed write"));
                }
                Stmt::ArraySetLength { .. } => {
                    return Some(format!("{here}: await in array length write"));
                }
                Stmt::Break { .. } | Stmt::Continue { .. } => {
                    return Some(format!("{here}: unsupported abrupt completion"));
                }
            }
        }
        None
    }

    walk(&function.body, function.is_async, "body")
        .unwrap_or_else(|| "unknown continuation shape".into())
}

fn command_match_open(output: &mut String) {
    output.push_str("match sc_command {\nruntime::GeneratorCommand::Next(_) => {\n");
}
fn command_match_close(output: &mut String, completion: &Completion) {
    output.push_str("}\nruntime::GeneratorCommand::Return(value) => ");
    if let Some(code) = completion.on_return() {
        output.push_str("{\n");
        output.push_str(code);
        output.push_str("\n}\n");
    } else {
        output.push_str("runtime::GeneratorStep::Returned(value),\n");
    }
    output.push_str(
        "runtime::GeneratorCommand::Throw(reason) => runtime::rethrow_caught(reason),\n}\n",
    );
}

#[derive(Clone)]
enum Completion {
    ReturnNone,
    Code(String),
    Protected {
        finish: Box<Completion>,
        on_return: String,
    },
    Loop {
        finish: Box<Completion>,
        on_break: String,
        on_continue: String,
    },
    Switch {
        finish: Box<Completion>,
        on_break: String,
    },
}

fn finish(completion: &Completion, output: &mut String) {
    match completion {
        Completion::ReturnNone => output.push_str("runtime::GeneratorStep::Returned(None)\n"),
        Completion::Code(code) => output.push_str(code),
        Completion::Protected { finish: inner, .. }
        | Completion::Loop { finish: inner, .. }
        | Completion::Switch { finish: inner, .. } => finish(inner, output),
    }
}

impl Completion {
    fn on_return(&self) -> Option<&str> {
        match self {
            Self::Protected { on_return, .. } => Some(on_return),
            Self::Loop { finish, .. } => finish.on_return(),
            Self::Switch { finish, .. } => finish.on_return(),
            _ => None,
        }
    }

    fn on_break(&self, depth: usize) -> Option<&str> {
        match self {
            Self::Loop {
                finish, on_break, ..
            } => {
                if depth == 0 {
                    Some(on_break)
                } else {
                    finish.on_break(depth - 1)
                }
            }
            Self::Protected { finish, .. } => finish.on_break(depth),
            Self::Switch { finish, on_break } => {
                if depth == 0 {
                    Some(on_break)
                } else {
                    finish.on_break(depth - 1)
                }
            }
            _ => None,
        }
    }

    fn on_continue(&self, depth: usize) -> Option<&str> {
        match self {
            Self::Loop {
                finish,
                on_continue,
                ..
            } => {
                if depth == 0 {
                    Some(on_continue)
                } else {
                    finish.on_continue(depth - 1)
                }
            }
            Self::Protected { finish, .. } => finish.on_continue(depth),
            Self::Switch { finish, .. } => finish.on_continue(depth),
            _ => None,
        }
    }

    fn with_finish(&self, finish: Completion) -> Completion {
        match self {
            Self::Protected { on_return, .. } => Self::Protected {
                finish: Box::new(match self {
                    Self::Protected { finish: inner, .. } => inner.with_finish(finish),
                    _ => unreachable!(),
                }),
                on_return: on_return.clone(),
            },
            Self::Loop {
                finish: inner,
                on_break,
                on_continue,
            } => Self::Loop {
                finish: Box::new(inner.with_finish(finish)),
                on_break: on_break.clone(),
                on_continue: on_continue.clone(),
            },
            Self::Switch {
                finish: inner,
                on_break,
            } => Self::Switch {
                finish: Box::new(inner.with_finish(finish)),
                on_break: on_break.clone(),
            },
            _ => finish,
        }
    }
}

fn step_type(function: &Function, module: &Emission<'_>) -> String {
    let channels = function.generator.as_ref().expect("generator channels");
    let channel = |ty: Type| {
        if matches!(ty, Type::Void | Type::Null | Type::Undefined) {
            "()".into()
        } else {
            rust_type(ty, module)
        }
    };
    let yielded = channel(channels.yield_type.clone());
    let yielded = if function.is_async {
        format!("runtime::AsyncGeneratorYield<{yielded}>")
    } else {
        yielded
    };
    format!(
        "runtime::GeneratorStep<{yielded}, {}>",
        channel(function.return_type.clone())
    )
}

fn body_generator_type(function: &Function, module: &Emission<'_>) -> String {
    if !function.is_async {
        return rust_type(function.call_result(), module);
    }
    let channels = function.generator.as_ref().expect("generator channels");
    let channel = |ty: Type| {
        if matches!(ty, Type::Void | Type::Null | Type::Undefined) {
            "()".into()
        } else {
            rust_type(ty, module)
        }
    };
    format!(
        "runtime::AsyncGeneratorBody<{}, {}>",
        channel(channels.yield_type.clone()),
        channel(function.return_type.clone())
    )
}

fn helper_parameters(active: &[String], function: &Function, module: &Emission<'_>) -> String {
    let receiver = function
        .reads_receiver()
        .then_some(", native_this: NativeValue")
        .unwrap_or_default();
    format!(
        "{receiver}{}",
        active
            .iter()
            .map(|id| {
                if id.starts_with("sc_generator_for_capture_") {
                    return format!(", {id}: runtime::Gc<NativeCell<NativeValue>>");
                }
                let local = function
                    .locals
                    .iter()
                    .find(|local| local.id == *id)
                    .expect("active generator local");
                format!(
                    ", {id}: runtime::Gc<NativeCell<{}>>",
                    rust_type(local.r#type.clone(), module)
                )
            })
            .collect::<String>()
    )
}
fn helper_arguments(active: &[String], function: &Function) -> String {
    let receiver = function
        .reads_receiver()
        .then_some(", native_this.clone()")
        .unwrap_or_default();
    format!(
        "{receiver}{}",
        active
            .iter()
            .map(|id| format!(", {id}.clone()"))
            .collect::<String>()
    )
}

#[derive(Clone, Copy)]
enum YieldStarBinding<'a> {
    Declare(&'a str),
    Assign(&'a str),
    Return(&'a Type),
}

fn yield_star_resume_input(function: &Function, next_type: &Type) -> &'static str {
    if matches!(next_type, Type::Void | Type::Undefined) {
        if function.is_async {
            "{ let _: runtime::AsyncGeneratorInput = sc_input; () }"
        } else {
            "{ let _ = sc_input; () }"
        }
    } else if !function.is_async {
        "sc_input"
    } else {
        // The async-generator driver type-erases every public `.next(value)`
        // argument while the suspended body is parked. Recover the delegate's
        // represented next channel before resuming a synchronous `yield*`.
        "runtime::async_generator_input(sc_input)"
    }
}

fn yield_star_sequence(
    generator: &Expr,
    binding: Option<YieldStarBinding<'_>>,
    remaining: &[Stmt],
    function: &Function,
    module: &Emission<'_>,
    output: &mut String,
    active: &mut Vec<String>,
    completion: Completion,
    next_helper: &mut usize,
) {
    let Type::Generator {
        r#async: false,
        yield_type,
        return_type,
        next_type,
    } = generator.ty()
    else {
        unreachable!("validated synchronous yield* delegate")
    };
    let helper = format!("sc_yield_star_{}", *next_helper);
    *next_helper += 1;
    let params = helper_parameters(active, function, module);
    let args = helper_arguments(active, function);
    let channel = |ty: &Type| {
        if matches!(ty, Type::Void | Type::Null | Type::Undefined) {
            "()".into()
        } else {
            rust_type(ty.clone(), module)
        }
    };
    let delegate_type = rust_type(generator.ty(), module);
    let outer_yield_type = &function
        .generator
        .as_ref()
        .expect("generator channels")
        .yield_type;
    let outer_yielded = if *outer_yield_type == *yield_type
        || (matches!(outer_yield_type, Type::Void | Type::Undefined)
            && matches!(*yield_type, Type::Void | Type::Undefined))
    {
        "sc_yielded".into()
    } else if *outer_yield_type == Type::Dyn {
        values::box_value(&yield_type, "sc_yielded", module)
    } else if *yield_type == Type::Dyn {
        // An erased delegate is adapted item-by-item to the enclosing typed
        // generator. This preserves `yield*` control flow while retaining the
        // same runtime checks as an explicit `for (...) yield value` bridge.
        values::checked_value(outer_yield_type, "sc_yielded", module)
    } else {
        unreachable!("validated yield* covariance")
    };
    let delegate_step = format!(
        "runtime::GeneratorStep<{}, {}>",
        channel(&yield_type),
        channel(&return_type)
    );
    output.push_str(&format!(
        "fn {helper}(sc_generator: {}, sc_delegate: {delegate_type}, sc_step: {delegate_step}{params}) -> {} {{\nmatch sc_step {{\nruntime::GeneratorStep::Yielded(sc_yielded) => {{\n",
        body_generator_type(function, module),
        step_type(function, module)
    ));
    output.push_str(
        "runtime::generator_suspend(&sc_generator, move |sc_generator, sc_command| {\nmatch sc_command {\nruntime::GeneratorCommand::Next(sc_input) => {\n",
    );
    let resume_input = yield_star_resume_input(function, &next_type);
    output.push_str(&format!(
        "let sc_step = runtime::generator_next(&sc_delegate, {resume_input});\nreturn {helper}(sc_generator, sc_delegate, sc_step{args});\n"
    ));
    output.push_str("}\nruntime::GeneratorCommand::Return(value) => { let _ = runtime::generator_return(&sc_delegate, None); runtime::GeneratorStep::Returned(value) },\nruntime::GeneratorCommand::Throw(reason) => { let _ = runtime::generator_return(&sc_delegate, None); runtime::rethrow_caught(reason) },\n}\n});\n");
    if function.is_async {
        output.push_str(&format!(
            "runtime::GeneratorStep::Yielded(runtime::AsyncGeneratorYield::Value({outer_yielded}))\n"
        ));
    } else {
        output.push_str(&format!(
            "runtime::GeneratorStep::Yielded({outer_yielded})\n"
        ));
    }
    output.push_str("}\nruntime::GeneratorStep::Returned(sc_value) => {\n");
    let mut continue_sequence = true;
    if let Some(YieldStarBinding::Return(result_type)) = binding {
        let boxed = if matches!(*return_type, Type::Void | Type::Undefined) {
            "NativeValue::Undefined".into()
        } else {
            values::box_value(&return_type, "value", module)
        };
        let converted = values::checked_value(result_type, "sc_value", module);
        output.push_str(&format!(
            "let sc_value = match sc_value {{ Some(value) => {boxed}, None => NativeValue::Undefined }};\nruntime::GeneratorStep::Returned(Some({converted}))\n"
        ));
        continue_sequence = false;
    } else if let Some(binding) = binding {
        let local_id = match binding {
            YieldStarBinding::Declare(local_id) | YieldStarBinding::Assign(local_id) => local_id,
            YieldStarBinding::Return(_) => unreachable!(),
        };
        let local = function
            .locals
            .iter()
            .find(|local| local.id == local_id)
            .expect("validated yield* result local");
        let boxed = if matches!(*return_type, Type::Void | Type::Undefined) {
            "NativeValue::Undefined".into()
        } else {
            values::box_value(&return_type, "value", module)
        };
        let converted = values::checked_value(&local.r#type, "sc_value", module);
        output.push_str(&format!(
            "let sc_value = match sc_value {{ Some(value) => {boxed}, None => NativeValue::Undefined }};\n"
        ));
        match binding {
            YieldStarBinding::Declare(_) => {
                output.push_str(&format!(
                    "let {local_id}: runtime::Gc<NativeCell<{}>> = native_cell({converted});\n",
                    rust_type(local.r#type.clone(), module),
                ));
                active.push(local_id.into());
            }
            YieldStarBinding::Assign(_) => {
                output.push_str(&format!("native_cell_write(&{local_id}, {converted});\n"))
            }
            YieldStarBinding::Return(_) => unreachable!(),
        }
    } else {
        output.push_str("let _ = sc_value;\n");
    }
    if continue_sequence {
        sequence(
            remaining,
            function,
            module,
            output,
            active,
            completion,
            next_helper,
        );
    }
    output.push_str("}\n}\n}\n");
    let initial = if matches!(*next_type, Type::Void | Type::Undefined) {
        "()"
    } else if *next_type == Type::Dyn {
        "NativeValue::Undefined"
    } else {
        unreachable!("frontend restricts initial yield* next channel")
    };
    output.push_str(&format!(
        "let sc_delegate = {};\nlet sc_step = runtime::generator_next(&sc_delegate, {initial});\nreturn {helper}(sc_generator, sc_delegate, sc_step{args});\n",
        expr(generator, function, module)
    ));
}

#[allow(clippy::too_many_arguments)]
fn yield_star_push_sequence(
    expression: &Expr,
    remaining: &[Stmt],
    function: &Function,
    module: &Emission<'_>,
    output: &mut String,
    active: &mut Vec<String>,
    completion: Completion,
    next_helper: &mut usize,
) -> bool {
    let Expr::ArrayIntrinsic {
        receiver,
        method,
        args: push_args,
        ..
    } = expression
    else {
        return false;
    };
    let [Expr::YieldStar { generator, .. }] = push_args.as_slice() else {
        return false;
    };
    if method != "push" {
        return false;
    }
    let Type::Array { elem } = receiver.ty() else {
        return false;
    };
    let Type::Generator {
        r#async: false,
        yield_type,
        return_type,
        next_type,
    } = generator.ty()
    else {
        return false;
    };
    if *elem != Type::Dyn || *return_type != Type::Dyn {
        return false;
    }

    let helper = format!("sc_yield_star_push_{}", *next_helper);
    *next_helper += 1;
    let params = helper_parameters(active, function, module);
    let args = helper_arguments(active, function);
    let channel = |ty: &Type| {
        if matches!(ty, Type::Void | Type::Null | Type::Undefined) {
            "()".into()
        } else {
            rust_type(ty.clone(), module)
        }
    };
    let delegate_type = rust_type(generator.ty(), module);
    let delegate_step = format!(
        "runtime::GeneratorStep<{}, {}>",
        channel(&yield_type),
        channel(&return_type)
    );
    let outer_yield_type = &function
        .generator
        .as_ref()
        .expect("generator channels")
        .yield_type;
    let outer_yielded = if *outer_yield_type == *yield_type
        || (matches!(outer_yield_type, Type::Void | Type::Undefined)
            && matches!(*yield_type, Type::Void | Type::Undefined))
    {
        "sc_yielded".into()
    } else if *outer_yield_type == Type::Dyn {
        values::box_value(&yield_type, "sc_yielded", module)
    } else if *yield_type == Type::Dyn {
        values::checked_value(outer_yield_type, "sc_yielded", module)
    } else {
        return false;
    };
    output.push_str(&format!(
        "fn {helper}(sc_generator: {}, sc_delegate: {delegate_type}, sc_step: {delegate_step}{params}) -> {} {{\nmatch sc_step {{\nruntime::GeneratorStep::Yielded(sc_yielded) => {{\n",
        body_generator_type(function, module),
        step_type(function, module)
    ));
    output.push_str("runtime::generator_suspend(&sc_generator, move |sc_generator, sc_command| {\nmatch sc_command {\nruntime::GeneratorCommand::Next(sc_input) => {\n");
    let resume_input = yield_star_resume_input(function, &next_type);
    output.push_str(&format!(
        "let sc_step = runtime::generator_next(&sc_delegate, {resume_input});\nreturn {helper}(sc_generator, sc_delegate, sc_step{args});\n"
    ));
    output.push_str("}\nruntime::GeneratorCommand::Return(value) => { let _ = runtime::generator_return(&sc_delegate, None); ");
    if let Some(code) = completion.on_return() {
        output.push_str(code);
    } else {
        output.push_str("return runtime::GeneratorStep::Returned(value);");
    }
    output.push_str("}\nruntime::GeneratorCommand::Throw(reason) => { let _ = runtime::generator_return(&sc_delegate, None); runtime::rethrow_caught(reason) },\n}\n});\n");
    if function.is_async {
        output.push_str(&format!("runtime::GeneratorStep::Yielded(runtime::AsyncGeneratorYield::Value({outer_yielded}))\n"));
    } else {
        output.push_str(&format!(
            "runtime::GeneratorStep::Yielded({outer_yielded})\n"
        ));
    }
    output.push_str("}\nruntime::GeneratorStep::Returned(sc_value) => {\n");
    let boxed = if matches!(*return_type, Type::Void | Type::Undefined) {
        "NativeValue::Undefined".into()
    } else {
        values::box_value(&return_type, "value", module)
    };
    output.push_str(&format!(
        "let sc_value = match sc_value {{ Some(value) => {boxed}, None => NativeValue::Undefined }};\nlet sc_array = {};\nruntime::array_push(&sc_array, sc_value);\n",
        expr(receiver, function, module)
    ));
    sequence(
        remaining,
        function,
        module,
        output,
        &mut active.clone(),
        completion.clone(),
        next_helper,
    );
    output.push_str("}\n}\n}\n");
    let initial = if matches!(*next_type, Type::Void | Type::Undefined) {
        "()"
    } else if *next_type == Type::Dyn {
        "NativeValue::Undefined"
    } else {
        return false;
    };
    output.push_str(&format!(
        "let sc_delegate = {};\nlet sc_step = runtime::generator_next(&sc_delegate, {initial});\nreturn {helper}(sc_generator, sc_delegate, sc_step{args});\n",
        expr(generator, function, module)
    ));
    true
}

#[allow(clippy::too_many_arguments)]
fn yield_star_if_sequence(
    condition: &Expr,
    then: &[Stmt],
    else_: Option<&[Stmt]>,
    remaining: &[Stmt],
    function: &Function,
    module: &Emission<'_>,
    output: &mut String,
    active: &mut Vec<String>,
    completion: Completion,
    next_helper: &mut usize,
) -> bool {
    let Expr::Logical {
        op,
        left: prefix,
        right,
        ..
    } = condition
    else {
        return false;
    };
    if op != "&&" {
        return false;
    }
    let Expr::DynScalarEq {
        left,
        right: compared,
        negated,
        ..
    } = right.as_ref()
    else {
        return false;
    };
    let Expr::YieldStar { generator, .. } = left.as_ref() else {
        return false;
    };
    if contains_yield_expr(compared) || contains_await_expr(compared) {
        return false;
    }
    let Type::Generator {
        r#async: false,
        yield_type,
        return_type,
        next_type,
    } = generator.ty()
    else {
        return false;
    };

    let helper = format!("sc_yield_star_condition_{}", *next_helper);
    *next_helper += 1;
    let params = helper_parameters(active, function, module);
    let args = helper_arguments(active, function);
    let channel = |ty: &Type| {
        if matches!(ty, Type::Void | Type::Null | Type::Undefined) {
            "()".into()
        } else {
            rust_type(ty.clone(), module)
        }
    };
    let delegate_type = rust_type(generator.ty(), module);
    let delegate_step = format!(
        "runtime::GeneratorStep<{}, {}>",
        channel(&yield_type),
        channel(&return_type)
    );
    let outer_yield_type = &function
        .generator
        .as_ref()
        .expect("generator channels")
        .yield_type;
    let outer_yielded = if *outer_yield_type == *yield_type
        || (matches!(outer_yield_type, Type::Void | Type::Undefined)
            && matches!(*yield_type, Type::Void | Type::Undefined))
    {
        "sc_yielded".into()
    } else if *outer_yield_type == Type::Dyn {
        values::box_value(&yield_type, "sc_yielded", module)
    } else if *yield_type == Type::Dyn {
        values::checked_value(outer_yield_type, "sc_yielded", module)
    } else {
        return false;
    };

    output.push_str(&format!(
        "fn {helper}(sc_generator: {}, sc_delegate: {delegate_type}, sc_step: {delegate_step}{params}) -> {} {{\nmatch sc_step {{\nruntime::GeneratorStep::Yielded(sc_yielded) => {{\n",
        body_generator_type(function, module),
        step_type(function, module)
    ));
    output.push_str("runtime::generator_suspend(&sc_generator, move |sc_generator, sc_command| {\nmatch sc_command {\nruntime::GeneratorCommand::Next(sc_input) => {\n");
    let resume_input = yield_star_resume_input(function, &next_type);
    output.push_str(&format!(
        "let sc_step = runtime::generator_next(&sc_delegate, {resume_input});\nreturn {helper}(sc_generator, sc_delegate, sc_step{args});\n"
    ));
    output.push_str("}\nruntime::GeneratorCommand::Return(value) => { let _ = runtime::generator_return(&sc_delegate, None); ");
    if let Some(code) = completion.on_return() {
        output.push_str(code);
    } else {
        output.push_str("return runtime::GeneratorStep::Returned(value);");
    }
    output.push_str("}\nruntime::GeneratorCommand::Throw(reason) => { let _ = runtime::generator_return(&sc_delegate, None); runtime::rethrow_caught(reason) },\n}\n});\n");
    if function.is_async {
        output.push_str(&format!("runtime::GeneratorStep::Yielded(runtime::AsyncGeneratorYield::Value({outer_yielded}))\n"));
    } else {
        output.push_str(&format!(
            "runtime::GeneratorStep::Yielded({outer_yielded})\n"
        ));
    }
    output.push_str("}\nruntime::GeneratorStep::Returned(sc_value) => {\n");
    let boxed = if matches!(*return_type, Type::Void | Type::Undefined) {
        "NativeValue::Undefined".into()
    } else {
        values::box_value(&return_type, "value", module)
    };
    output.push_str(&format!(
        "let sc_value = match sc_value {{ Some(value) => {boxed}, None => NativeValue::Undefined }};\nif {}native_value_eq(&sc_value, &({})) {{\n",
        if *negated { "!" } else { "" },
        expr(compared, function, module)
    ));
    let mut branch = then.to_vec();
    branch.extend_from_slice(remaining);
    sequence(
        &branch,
        function,
        module,
        output,
        &mut active.clone(),
        completion.clone(),
        next_helper,
    );
    output.push_str("} else {\n");
    let mut branch = else_.unwrap_or_default().to_vec();
    branch.extend_from_slice(remaining);
    sequence(
        &branch,
        function,
        module,
        output,
        &mut active.clone(),
        completion.clone(),
        next_helper,
    );
    output.push_str("}\n}\n}\n}\n");

    output.push_str(&format!("if {} {{\n", expr(prefix, function, module)));
    let initial = if matches!(*next_type, Type::Void | Type::Undefined) {
        "()"
    } else if *next_type == Type::Dyn {
        "NativeValue::Undefined"
    } else {
        return false;
    };
    output.push_str(&format!(
        "let sc_delegate = {};\nlet sc_step = runtime::generator_next(&sc_delegate, {initial});\nreturn {helper}(sc_generator, sc_delegate, sc_step{args});\n}} else {{\n",
        expr(generator, function, module)
    ));
    let mut branch = else_.unwrap_or_default().to_vec();
    branch.extend_from_slice(remaining);
    sequence(
        &branch,
        function,
        module,
        output,
        active,
        completion,
        next_helper,
    );
    output.push_str("}\n");
    true
}

fn protected_sequence(
    stmt: &Stmt,
    remaining: &[Stmt],
    function: &Function,
    module: &Emission<'_>,
    output: &mut String,
    active: &mut Vec<String>,
    completion: Completion,
    next_helper: &mut usize,
) {
    let Stmt::TryCatch {
        try_body,
        catch_body: Some(catch_body),
        catch_local_id: Some(catch_local),
        finally_body: Some(finally_body),
        ..
    } = stmt
    else {
        unreachable!("validated protected generator region")
    };
    let Some((Stmt::Throw { value: thrown, .. }, catch_prefix)) = catch_body.split_last() else {
        unreachable!("validated protected generator catch completion")
    };

    let normal = format!("sc_generator_finally_normal_{}", *next_helper);
    *next_helper += 1;
    let returning = format!("sc_generator_finally_return_{}", *next_helper);
    *next_helper += 1;
    let throwing = format!("sc_generator_finally_throw_{}", *next_helper);
    *next_helper += 1;
    let params = helper_parameters(active, function, module);
    let args = helper_arguments(active, function);
    let body_type = body_generator_type(function, module);
    let step = step_type(function, module);

    output.push_str(&format!(
        "fn {normal}(sc_generator: {body_type}{params}) -> {step} {{\n"
    ));
    let mut normal_body = finally_body.clone();
    normal_body.extend_from_slice(remaining);
    sequence(
        &normal_body,
        function,
        module,
        output,
        &mut active.clone(),
        completion.clone(),
        next_helper,
    );
    output.push_str("}\n");

    let return_type = rust_type(function.return_type.clone(), module);
    output.push_str(&format!(
        "fn {returning}(sc_generator: {body_type}, sc_return: Option<{return_type}>{params}) -> {step} {{\n"
    ));
    sequence(
        finally_body,
        function,
        module,
        output,
        &mut active.clone(),
        Completion::Code("runtime::GeneratorStep::Returned(sc_return)\n".into()),
        next_helper,
    );
    output.push_str("}\n");

    output.push_str(&format!(
        "fn {throwing}(sc_generator: {body_type}, sc_reason: runtime::Caught{params}) -> {step} {{\n"
    ));
    sequence(
        finally_body,
        function,
        module,
        output,
        &mut active.clone(),
        Completion::Code("runtime::rethrow_caught(sc_reason)\n".into()),
        next_helper,
    );
    output.push_str("}\n");

    for (index, id) in active.iter().enumerate() {
        output.push_str(&format!(
            "let sc_protected_capture_{index} = {id}.clone();\n"
        ));
    }
    output.push_str(
        "runtime::generator_push_panic_handler(&sc_generator, move |sc_generator, sc_caught| {\n",
    );
    for (index, id) in active.iter().enumerate() {
        output.push_str(&format!("let {id} = sc_protected_capture_{index};\n"));
    }
    output
        .push_str("let sc_pending = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {\n");
    let catch_boxed = function
        .locals
        .iter()
        .any(|local| local.id == *catch_local && local.boxed);
    output.push_str(&format!(
        "let {catch_local} = {}native_caught(sc_caught){};\n",
        if catch_boxed { "native_cell(" } else { "" },
        if catch_boxed { ")" } else { "" }
    ));
    for statement_value in catch_prefix {
        statement(statement_value, function, module, output);
    }
    output.push_str(&format!(
        "runtime::caught_value({})\n",
        values::box_value(&thrown.ty(), &expr(thrown, function, module), module)
    ));
    output.push_str("}));\nlet sc_reason = match sc_pending { Ok(reason) => reason, Err(payload) => runtime::caught_from_panic(payload), };\n");
    output.push_str(&format!(
        "return {throwing}(sc_generator, sc_reason{args});\n}});\n"
    ));

    let protected = Completion::Protected {
        finish: Box::new(Completion::Code(format!(
            "runtime::generator_pop_panic_handler(&sc_generator);\nreturn {normal}(sc_generator{args});\n"
        ))),
        on_return: format!(
            "runtime::generator_pop_panic_handler(&sc_generator);\nreturn {returning}(sc_generator, value{args});"
        ),
    };
    sequence(
        try_body,
        function,
        module,
        output,
        active,
        protected,
        next_helper,
    );
}

fn catch_sequence(
    stmt: &Stmt,
    remaining: &[Stmt],
    function: &Function,
    module: &Emission<'_>,
    output: &mut String,
    active: &mut Vec<String>,
    completion: Completion,
    next_helper: &mut usize,
) {
    let Stmt::TryCatch {
        try_body,
        catch_body: Some(catch_body),
        catch_local_id: Some(catch_local),
        finally_body: None,
        ..
    } = stmt
    else {
        unreachable!("validated generator catch region")
    };

    let normal = format!("sc_generator_catch_normal_{}", *next_helper);
    *next_helper += 1;
    let caught = format!("sc_generator_catch_body_{}", *next_helper);
    *next_helper += 1;
    let params = helper_parameters(active, function, module);
    let args = helper_arguments(active, function);
    let body_type = body_generator_type(function, module);
    let step = step_type(function, module);

    output.push_str(&format!(
        "fn {normal}(sc_generator: {body_type}{params}) -> {step} {{\n"
    ));
    sequence(
        remaining,
        function,
        module,
        output,
        &mut active.clone(),
        completion.clone(),
        next_helper,
    );
    output.push_str("}\n");

    output.push_str(&format!(
        "fn {caught}(sc_generator: {body_type}, sc_caught: runtime::Caught{params}) -> {step} {{\n"
    ));
    let catch_boxed = function
        .locals
        .iter()
        .any(|local| local.id == *catch_local && local.boxed);
    output.push_str(&format!(
        "let {catch_local} = {}native_caught(sc_caught){};\n",
        if catch_boxed { "native_cell(" } else { "" },
        if catch_boxed { ")" } else { "" }
    ));
    let mut catch_active = active.clone();
    catch_active.push(catch_local.clone());
    let mut caught_body = catch_body.clone();
    caught_body.extend_from_slice(remaining);
    sequence(
        &caught_body,
        function,
        module,
        output,
        &mut catch_active,
        completion.clone(),
        next_helper,
    );
    output.push_str("}\n");

    for (index, id) in active.iter().enumerate() {
        output.push_str(&format!("let sc_catch_capture_{index} = {id}.clone();\n"));
    }
    output.push_str(
        "runtime::generator_push_panic_handler(&sc_generator, move |sc_generator, sc_caught| {\n",
    );
    for (index, id) in active.iter().enumerate() {
        output.push_str(&format!("let {id} = sc_catch_capture_{index};\n"));
    }
    output.push_str(&format!(
        "return {caught}(sc_generator, sc_caught{args});\n}});\n"
    ));

    let on_return = completion.on_return().map_or_else(
        || {
            "runtime::generator_pop_panic_handler(&sc_generator);\nreturn runtime::GeneratorStep::Returned(value);"
                .into()
        },
        |parent| {
            format!("runtime::generator_pop_panic_handler(&sc_generator);\n{parent}")
        },
    );
    let protected = Completion::Protected {
        finish: Box::new(Completion::Code(format!(
            "runtime::generator_pop_panic_handler(&sc_generator);\nreturn {normal}(sc_generator{args});\n"
        ))),
        on_return,
    };
    sequence(
        try_body,
        function,
        module,
        output,
        active,
        protected,
        next_helper,
    );
}

fn sequence(
    statements: &[Stmt],
    function: &Function,
    module: &Emission<'_>,
    output: &mut String,
    active: &mut Vec<String>,
    completion: Completion,
    next_helper: &mut usize,
) {
    let Some((first, remaining)) = statements.split_first() else {
        finish(&completion, output);
        return;
    };
    match first {
        Stmt::Return {
            value: Some(Expr::Sequence { stmts, result, .. }),
            loc,
        } => {
            let mut flattened = stmts.clone();
            flattened.push(Stmt::Return {
                value: Some(*result.clone()),
                loc: loc.clone(),
            });
            sequence(
                &flattened,
                function,
                module,
                output,
                active,
                completion,
                next_helper,
            );
        }
        Stmt::Expression {
            expr: Expr::Sequence {
                stmts, result, loc, ..
            },
            ..
        } if stmts.iter().any(statement_has_yield) || stmts.iter().any(statement_has_await) => {
            let mut flattened = stmts.clone();
            flattened.push(Stmt::Expression {
                expr: *result.clone(),
                loc: loc.clone(),
            });
            flattened.extend_from_slice(remaining);
            sequence(
                &flattened,
                function,
                module,
                output,
                active,
                completion,
                next_helper,
            );
        }
        Stmt::VarDecl {
            local_id,
            init: Expr::Yield { value, .. },
            ..
        } => {
            let local = function
                .locals
                .iter()
                .find(|local| local.id == *local_id)
                .expect("validated generator resume local");
            output.push_str(&format!(
                "let sc_yielded = {};\n",
                expr(value, function, module)
            ));
            output.push_str(
                "runtime::generator_suspend(&sc_generator, move |sc_generator, sc_command| {\nmatch sc_command {\nruntime::GeneratorCommand::Next(sc_input) => {\n",
            );
            output.push_str(&format!(
                "let {local_id}: runtime::Gc<NativeCell<{}>> = native_cell(sc_input);\n",
                rust_type(local.r#type.clone(), module)
            ));
            active.push(local_id.clone());
            sequence(
                remaining,
                function,
                module,
                output,
                active,
                completion.clone(),
                next_helper,
            );
            command_match_close(output, &completion);
            output.push_str("});\nruntime::GeneratorStep::Yielded(sc_yielded)\n");
        }
        Stmt::VarDecl {
            local_id,
            init: Expr::YieldStar { generator, .. },
            ..
        } => yield_star_sequence(
            generator,
            Some(YieldStarBinding::Declare(local_id)),
            remaining,
            function,
            module,
            output,
            active,
            completion,
            next_helper,
        ),
        Stmt::VarDecl { local_id, init, .. } if projected_yield_star(init).is_some() => {
            yield_star_sequence(
                projected_yield_star(init).expect("matched projected yield*"),
                Some(YieldStarBinding::Declare(local_id)),
                remaining,
                function,
                module,
                output,
                active,
                completion,
                next_helper,
            )
        }
        Stmt::Assign {
            local_id, value, ..
        } if assigned_yield_star(value).is_some() => yield_star_sequence(
            assigned_yield_star(value).expect("matched assigned yield*"),
            Some(YieldStarBinding::Assign(local_id)),
            remaining,
            function,
            module,
            output,
            active,
            completion,
            next_helper,
        ),
        Stmt::Return {
            value: Some(value), ..
        } if projected_yield_star(value).is_some() => yield_star_sequence(
            projected_yield_star(value).expect("matched projected yield*"),
            Some(YieldStarBinding::Return(&value.ty())),
            remaining,
            function,
            module,
            output,
            active,
            completion,
            next_helper,
        ),
        Stmt::Expression {
            expr: Expr::YieldStar { generator, .. },
            ..
        } => yield_star_sequence(
            generator,
            None,
            remaining,
            function,
            module,
            output,
            active,
            completion,
            next_helper,
        ),
        Stmt::Expression {
            expr: expression @ Expr::ArrayIntrinsic { .. },
            ..
        } if contains_yield_expr(expression) => {
            assert!(yield_star_push_sequence(
                expression,
                remaining,
                function,
                module,
                output,
                active,
                completion,
                next_helper,
            ));
        }
        Stmt::Expression {
            expr: Expr::Yield { value, .. },
            ..
        } => {
            output.push_str(&format!(
                "let sc_yielded = {};\n",
                expr(value, function, module)
            ));
            output.push_str(
                "runtime::generator_suspend(&sc_generator, move |sc_generator, sc_command| {\n",
            );
            command_match_open(output);
            sequence(
                remaining,
                function,
                module,
                output,
                active,
                completion.clone(),
                next_helper,
            );
            command_match_close(output, &completion);
            output.push_str("});\n");
            if function.is_async {
                output.push_str("runtime::GeneratorStep::Yielded(runtime::AsyncGeneratorYield::Value(sc_yielded))\n");
            } else {
                output.push_str("runtime::GeneratorStep::Yielded(sc_yielded)\n");
            }
        }
        Stmt::Break { target_depth, .. } => {
            let code = completion
                .on_break(*target_depth)
                .expect("validated generator break target");
            output.push_str(code);
            output.push('\n');
        }
        Stmt::Continue { target_depth, .. } => {
            let code = completion
                .on_continue(*target_depth)
                .expect("validated generator continue target");
            output.push_str(code);
            output.push('\n');
        }
        Stmt::Return {
            value:
                Some(Expr::Await {
                    value: awaited,
                    r#type: Type::Void | Type::Null | Type::Undefined,
                    ..
                }),
            ..
        } => {
            debug_assert!(function.is_async);
            output.push_str(&format!(
                "let sc_awaited = {};\n",
                expr(awaited, function, module)
            ));
            output.push_str(
                "runtime::generator_suspend(&sc_generator, move |sc_generator, sc_command| {\nmatch sc_command {\nruntime::GeneratorCommand::Next(sc_input) => {\nlet _: NativeValue = runtime::async_generator_input(sc_input);\n",
            );
            if let Some(on_return) = completion.on_return() {
                output.push_str("let value: Option<()> = None;\n");
                output.push_str(on_return);
                output.push('\n');
            } else {
                output.push_str("runtime::GeneratorStep::Returned(None)\n");
            }
            command_match_close(output, &completion);
            output.push_str(
                "});\nruntime::GeneratorStep::Yielded(runtime::async_generator_await(sc_awaited))\n",
            );
        }
        Stmt::Return { value, .. } => {
            if let Some(on_return) = completion.on_return() {
                let return_type = rust_type(function.return_type.clone(), module);
                let value = value.as_ref().map_or_else(
                    || "None".into(),
                    |value| format!("Some({})", expr(value, function, module)),
                );
                output.push_str(&format!(
                    "let value: Option<{return_type}> = {value};\n{on_return}\n"
                ));
            } else if let Some(value) = value {
                output.push_str(&format!(
                    "runtime::GeneratorStep::Returned(Some({}))\n",
                    expr(value, function, module)
                ));
            } else {
                output.push_str("runtime::GeneratorStep::Returned(None)\n");
            }
        }
        Stmt::If {
            cond, then, else_, ..
        } => {
            if yield_star_if_sequence(
                cond,
                then,
                else_.as_deref(),
                remaining,
                function,
                module,
                output,
                active,
                completion.clone(),
                next_helper,
            ) {
                return;
            }
            output.push_str(&format!("if {} {{\n", expr(cond, function, module)));
            let mut branch = then.clone();
            branch.extend_from_slice(remaining);
            sequence(
                &branch,
                function,
                module,
                output,
                &mut active.clone(),
                completion.clone(),
                next_helper,
            );
            output.push_str("} else {\n");
            let mut branch = else_.clone().unwrap_or_default();
            branch.extend_from_slice(remaining);
            sequence(
                &branch,
                function,
                module,
                output,
                &mut active.clone(),
                completion,
                next_helper,
            );
            output.push_str("}\n");
        }
        Stmt::Block { body, .. } => {
            let mut flattened = body.clone();
            flattened.extend_from_slice(remaining);
            sequence(
                &flattened,
                function,
                module,
                output,
                active,
                completion,
                next_helper,
            );
        }
        Stmt::Switch { disc, cases, .. } => {
            let id = *next_helper;
            *next_helper += 1;
            let after = format!("sc_generator_switch_after_{id}");
            let body_type = body_generator_type(function, module);
            let step = step_type(function, module);
            let params = helper_parameters(active, function, module);
            let args = helper_arguments(active, function);
            output.push_str(&format!(
                "fn {after}(sc_generator: {body_type}{params}) -> {step} {{\n"
            ));
            sequence(
                remaining,
                function,
                module,
                output,
                &mut active.clone(),
                completion.clone(),
                next_helper,
            );
            output.push_str("}\n");
            output.push_str(&format!(
                "let sc_switch_disc = {};\n",
                expr(disc, function, module)
            ));

            let switch_completion = Completion::Switch {
                finish: Box::new(completion.clone().with_finish(Completion::Code(format!(
                    "return {after}(sc_generator{args});\n"
                )))),
                on_break: format!("return {after}(sc_generator{args});"),
            };
            let mut emitted_test = false;
            for (index, case) in cases.iter().enumerate() {
                let Some(test) = &case.test else {
                    continue;
                };
                output.push_str(if emitted_test { " else if " } else { "if " });
                output.push_str(&format!(
                    "sc_switch_disc == ({}) {{\n",
                    expr(test, function, module)
                ));
                let branch = cases[index..]
                    .iter()
                    .flat_map(|case| case.body.iter().cloned())
                    .collect::<Vec<_>>();
                sequence(
                    &branch,
                    function,
                    module,
                    output,
                    &mut active.clone(),
                    switch_completion.clone(),
                    next_helper,
                );
                output.push('}');
                emitted_test = true;
            }
            output.push_str(if emitted_test { " else {\n" } else { "{\n" });
            if let Some(default) = cases.iter().position(|case| case.test.is_none()) {
                let branch = cases[default..]
                    .iter()
                    .flat_map(|case| case.body.iter().cloned())
                    .collect::<Vec<_>>();
                sequence(
                    &branch,
                    function,
                    module,
                    output,
                    &mut active.clone(),
                    switch_completion,
                    next_helper,
                );
            } else {
                output.push_str(&format!("return {after}(sc_generator{args});\n"));
            }
            output.push_str("}\n");
        }
        Stmt::GeneratorForOf {
            generator,
            local_id,
            body,
            ..
        } => {
            let Type::Generator {
                r#async: false,
                yield_type,
                next_type,
                ..
            } = generator.ty()
            else {
                unreachable!("validated synchronous generator for-of")
            };
            let local = function
                .locals
                .iter()
                .find(|local| local.id == *local_id)
                .expect("validated generator for-of local");
            debug_assert_eq!(*yield_type, local.r#type);

            let id = *next_helper;
            *next_helper += 1;
            let capture = format!("sc_generator_for_capture_{id}");
            let next = format!("sc_generator_for_next_{id}");
            let after = format!("sc_generator_for_after_{id}");
            let body_type = body_generator_type(function, module);
            let step = step_type(function, module);
            let outer_params = helper_parameters(active, function, module);
            let outer_args = helper_arguments(active, function);
            let mut loop_active = active.clone();
            loop_active.push(capture.clone());
            let loop_params = helper_parameters(&loop_active, function, module);
            let loop_args = helper_arguments(&loop_active, function);
            let delegate = values::checked_value(
                &generator.ty(),
                &format!("native_cell_read(&{capture})"),
                module,
            );
            let initial = if *next_type == Type::Dyn {
                "NativeValue::Undefined"
            } else {
                "()"
            };

            output.push_str(&format!(
                "fn {after}(sc_generator: {body_type}{outer_params}) -> {step} {{\n"
            ));
            sequence(
                remaining,
                function,
                module,
                output,
                &mut active.clone(),
                completion.clone(),
                next_helper,
            );
            output.push_str("}\n");

            output.push_str(&format!(
                "fn {next}(sc_generator: {body_type}{loop_params}) -> {step} {{\nlet sc_delegate = {delegate};\nmatch runtime::generator_next_without_arg(&sc_delegate, {initial}) {{\nruntime::GeneratorStep::Yielded(sc_value) => {{\nlet {local_id}: runtime::Gc<NativeCell<{}>> = native_cell(sc_value);\n",
                rust_type(local.r#type.clone(), module)
            ));
            let mut body_active = loop_active.clone();
            body_active.push(local_id.clone());
            let loop_completion = Completion::Loop {
                finish: Box::new(completion.clone().with_finish(Completion::Code(format!(
                    "return {next}(sc_generator{loop_args});\n"
                )))),
                on_break: format!(
                    "let sc_delegate = {delegate}; let _ = runtime::generator_return(&sc_delegate, None); return {after}(sc_generator{outer_args});"
                ),
                on_continue: format!("return {next}(sc_generator{loop_args});"),
            };
            let return_completion = if let Some(on_return) = completion.on_return() {
                format!(
                    "let sc_delegate = {delegate}; let _ = runtime::generator_return(&sc_delegate, None); {on_return}"
                )
            } else {
                format!(
                    "let sc_delegate = {delegate}; let _ = runtime::generator_return(&sc_delegate, None); return runtime::GeneratorStep::Returned(value);"
                )
            };
            sequence(
                body,
                function,
                module,
                output,
                &mut body_active,
                Completion::Protected {
                    finish: Box::new(loop_completion),
                    on_return: return_completion,
                },
                next_helper,
            );
            output.push_str(&format!(
                "}}\nruntime::GeneratorStep::Returned(_) => {after}(sc_generator{outer_args}),\n}}\n}}\n"
            ));

            let boxed =
                values::box_value(&generator.ty(), &expr(generator, function, module), module);
            output.push_str(&format!(
                "let {capture}: runtime::Gc<NativeCell<NativeValue>> = native_cell({boxed});\nreturn {next}(sc_generator{loop_args});\n"
            ));
        }
        Stmt::While { cond, body, .. } => {
            let helper = format!("sc_generator_while_{}", *next_helper);
            *next_helper += 1;
            let after = format!("sc_generator_after_while_{}", *next_helper);
            *next_helper += 1;
            let params = helper_parameters(active, function, module);
            let args = helper_arguments(active, function);
            let body_type = body_generator_type(function, module);
            let step = step_type(function, module);
            output.push_str(&format!(
                "fn {after}(sc_generator: {body_type}{params}) -> {step} {{\n"
            ));
            sequence(
                remaining,
                function,
                module,
                output,
                &mut active.clone(),
                completion.clone(),
                next_helper,
            );
            output.push_str("}\n");
            output.push_str(&format!(
                "fn {helper}(sc_generator: {body_type}{params}) -> {step} {{\nif {} {{\n",
                expr(cond, function, module)
            ));
            let loop_completion = Completion::Loop {
                finish: Box::new(completion.with_finish(Completion::Code(format!(
                    "return {helper}(sc_generator{args});\n"
                )))),
                on_break: format!("return {after}(sc_generator{args});"),
                on_continue: format!("return {helper}(sc_generator{args});"),
            };
            sequence(
                body,
                function,
                module,
                output,
                &mut active.clone(),
                loop_completion,
                next_helper,
            );
            output.push_str("} else {\n");
            output.push_str(&format!("return {after}(sc_generator{args});\n"));
            output.push_str("}\n}\n");
            output.push_str(&format!("return {helper}(sc_generator{args});\n"));
        }
        protected @ Stmt::TryCatch {
            catch_body: Some(_),
            catch_local_id: Some(_),
            finally_body: Some(_),
            ..
        } => protected_sequence(
            protected,
            remaining,
            function,
            module,
            output,
            active,
            completion,
            next_helper,
        ),
        caught @ Stmt::TryCatch {
            catch_body: Some(_),
            catch_local_id: Some(_),
            finally_body: None,
            ..
        } => catch_sequence(
            caught,
            remaining,
            function,
            module,
            output,
            active,
            completion,
            next_helper,
        ),
        statement_value @ Stmt::TryCatch { .. } => {
            exceptions::generator_statement(statement_value, function, module, output);
            sequence(
                remaining,
                function,
                module,
                output,
                active,
                completion,
                next_helper,
            );
        }
        Stmt::VarDecl {
            local_id,
            init: Expr::Await { value, r#type, .. },
            ..
        } => {
            debug_assert!(function.is_async);
            let local = function
                .locals
                .iter()
                .find(|local| local.id == *local_id)
                .expect("validated async generator local");
            debug_assert!(local.boxed);
            output.push_str(&format!(
                "let sc_awaited = {};\n",
                expr(value, function, module)
            ));
            output.push_str(
                "runtime::generator_suspend(&sc_generator, move |sc_generator, sc_command| {\nmatch sc_command {\nruntime::GeneratorCommand::Next(sc_input) => {\nlet sc_resumed: NativeValue = runtime::async_generator_input(sc_input);\n",
            );
            output.push_str(&format!(
                "let {local_id}: runtime::Gc<NativeCell<{}>> = native_cell({});\n",
                rust_type(local.r#type.clone(), module),
                values::checked_value(r#type, "sc_resumed", module)
            ));
            active.push(local_id.clone());
            sequence(
                remaining,
                function,
                module,
                output,
                active,
                completion.clone(),
                next_helper,
            );
            command_match_close(output, &completion);
            output.push_str("});\nruntime::GeneratorStep::Yielded(runtime::async_generator_await(sc_awaited))\n");
        }
        Stmt::Expression {
            expr: Expr::Await { value, .. },
            ..
        } => {
            debug_assert!(function.is_async);
            output.push_str(&format!(
                "let sc_awaited = {};\n",
                expr(value, function, module)
            ));
            output.push_str(
                "runtime::generator_suspend(&sc_generator, move |sc_generator, sc_command| {\nmatch sc_command {\nruntime::GeneratorCommand::Next(sc_input) => {\nlet _: NativeValue = runtime::async_generator_input(sc_input);\n",
            );
            sequence(
                remaining,
                function,
                module,
                output,
                active,
                completion.clone(),
                next_helper,
            );
            command_match_close(output, &completion);
            output.push_str("});\nruntime::GeneratorStep::Yielded(runtime::async_generator_await(sc_awaited))\n");
        }
        Stmt::VarDecl { local_id, .. } => {
            statement(first, function, module, output);
            active.push(local_id.clone());
            sequence(
                remaining,
                function,
                module,
                output,
                active,
                completion,
                next_helper,
            );
        }
        statement_value => {
            statement(statement_value, function, module, output);
            sequence(
                remaining,
                function,
                module,
                output,
                active,
                completion,
                next_helper,
            );
        }
    }
}

pub(super) fn body(function: &Function, module: &Emission<'_>, output: &mut String) {
    output.push_str(if function.is_async {
        "runtime::async_generator_new(move |sc_generator, sc_command| {\n"
    } else {
        "runtime::generator_new(move |sc_generator, sc_command| {\n"
    });
    command_match_open(output);
    let mut active = Vec::new();
    for param in &function.params {
        if function
            .locals
            .iter()
            .any(|local| local.id == param.local_id && local.boxed)
        {
            output.push_str(&format!(
                "let {} = native_cell({});\n",
                param.local_id, param.local_id
            ));
        }
        active.push(param.local_id.clone());
    }
    let mut next_helper = 0;
    sequence(
        &function.body,
        function,
        module,
        output,
        &mut active,
        Completion::ReturnNone,
        &mut next_helper,
    );
    command_match_close(output, &Completion::ReturnNone);
    output.push_str("})\n");
}
