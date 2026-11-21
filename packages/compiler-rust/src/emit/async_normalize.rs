//! Extract suspension from evaluation positions with no preceding effects.
use crate::ir::{Expr, Loc, Local, Module, Stmt, Type};

fn extract(value: &mut Expr, loc: &Loc, locals: &mut Vec<Local>, next: &mut usize) -> Stmt {
    let ty = value.ty();
    if matches!(ty, Type::Void | Type::Null | Type::Undefined) {
        // Unit channels have no native local storage. Suspend for the source
        // effect, then leave the exact unit literal in the consumer position
        // instead of manufacturing an invalid continuation-frame cell.
        let unit = match &ty {
            Type::Void => "void",
            Type::Null => "null",
            Type::Undefined => "undefined",
            _ => unreachable!(),
        };
        let init = std::mem::replace(
            value,
            Expr::UnitLit {
                unit,
                r#type: ty,
                loc: loc.clone(),
            },
        );
        return Stmt::Expression {
            expr: init,
            loc: loc.clone(),
        };
    }
    let id = loop {
        let candidate = format!("sc_async_arg_{}", *next);
        *next += 1;
        if !locals.iter().any(|local| local.id == candidate) {
            break candidate;
        }
    };
    let init = std::mem::replace(
        value,
        Expr::VarRef {
            local_id: id.clone(),
            r#type: ty.clone(),
            loc: loc.clone(),
        },
    );
    locals.push(Local {
        id: id.clone(),
        name: "async temporary".into(),
        r#type: ty,
        mutable: false,
        // A temporary extracted around suspension is read by the resumed
        // continuation, so it belongs to the continuation frame even when
        // its source expression was not a user-declared captured binding.
        boxed: true,
    });
    Stmt::VarDecl {
        local_id: id,
        init,
        loc: loc.clone(),
    }
}

fn returned_record(value: &mut Expr) -> Option<&mut Vec<crate::ir::FieldInit>> {
    match value {
        Expr::RecordLit { fields, .. } => Some(fields),
        Expr::UnionWrap { value, .. } | Expr::DynFrom { value, .. } => returned_record(value),
        _ => None,
    }
}

fn await_value(value: &mut Expr) -> Option<&mut Expr> {
    match value {
        Expr::Await { .. } => Some(value),
        Expr::DynFrom { value, .. } | Expr::UnionWrap { value, .. } => await_value(value),
        _ => None,
    }
}

pub(super) fn normalize(module: &mut Module) {
    for function in &mut module.functions {
        if function.is_async && function.generator.is_none() {
            let mut next = function.locals.len();
            lower_finally(
                &mut function.body,
                &function.return_type,
                &mut function.locals,
                &mut next,
            );
            body(&mut function.body, &mut function.locals, &mut next);
        }
    }
}

fn fresh_local(
    locals: &mut Vec<Local>,
    next: &mut usize,
    stem: &str,
    r#type: Type,
    mutable: bool,
) -> String {
    let id = loop {
        let candidate = format!("sc_{stem}_{}", *next);
        *next += 1;
        if !locals.iter().any(|local| local.id == candidate) {
            break candidate;
        }
    };
    locals.push(Local {
        id: id.clone(),
        name: format!("async {stem}"),
        r#type,
        mutable,
        boxed: false,
    });
    id
}

fn undefined(loc: &Loc) -> Expr {
    Expr::UnitLit {
        unit: "undefined",
        r#type: Type::Undefined,
        loc: loc.clone(),
    }
}

fn dynamic(value: Expr, loc: &Loc) -> Expr {
    if value.ty() == Type::Dyn {
        value
    } else {
        Expr::DynFrom {
            value: Box::new(value),
            r#type: Type::Dyn,
            loc: loc.clone(),
        }
    }
}

fn rewrite_returns(
    input: Vec<Stmt>,
    result: &str,
    returned: &str,
    loop_depth: usize,
) -> Option<Vec<Stmt>> {
    let mut output = Vec::new();
    for mut stmt in input {
        match &mut stmt {
            Stmt::Return { value, loc } => {
                if let Some(value) = value.take() {
                    output.push(Stmt::Assign {
                        local_id: result.into(),
                        value: dynamic(value, loc),
                        initializes_global: false,
                        loc: loc.clone(),
                    });
                }
                output.push(Stmt::Assign {
                    local_id: returned.into(),
                    value: Expr::BoolLit {
                        value: true,
                        r#type: Type::Bool,
                        loc: loc.clone(),
                    },
                    initializes_global: false,
                    loc: loc.clone(),
                });
                output.push(Stmt::Break {
                    target_depth: loop_depth,
                    loc: loc.clone(),
                });
                continue;
            }
            Stmt::If { then, else_, .. } => {
                *then = rewrite_returns(std::mem::take(then), result, returned, loop_depth)?;
                if let Some(other) = else_ {
                    *other = rewrite_returns(std::mem::take(other), result, returned, loop_depth)?;
                }
            }
            Stmt::Block { body, .. } => {
                *body = rewrite_returns(std::mem::take(body), result, returned, loop_depth)?;
            }
            Stmt::Switch { cases, .. } => {
                for case in cases {
                    case.body = rewrite_returns(
                        std::mem::take(&mut case.body),
                        result,
                        returned,
                        loop_depth,
                    )?;
                }
            }
            Stmt::TryCatch {
                try_body,
                catch_body,
                finally_body,
                ..
            } => {
                // Inner finalizers have already been lowered before the outer
                // protected region is converted.
                if finally_body.is_some() {
                    return None;
                }
                *try_body =
                    rewrite_returns(std::mem::take(try_body), result, returned, loop_depth)?;
                if let Some(catch) = catch_body {
                    *catch = rewrite_returns(std::mem::take(catch), result, returned, loop_depth)?;
                }
            }
            Stmt::While { body, .. } => {
                // A return from an existing loop would need a labelled jump
                // to the synthetic finally join. Leave that rare shape for a
                // dedicated CFG lowering instead of changing its meaning.
                let rewritten =
                    rewrite_returns(std::mem::take(body), result, returned, loop_depth + 1)?;
                if rewritten.iter().any(
                    |stmt| matches!(stmt, Stmt::Break { target_depth, .. } if *target_depth > 0),
                ) {
                    return None;
                }
                *body = rewritten;
            }
            _ => {}
        }
        output.push(stmt);
    }
    Some(output)
}

fn lower_finally(
    stmts: &mut Vec<Stmt>,
    return_type: &Type,
    locals: &mut Vec<Local>,
    next: &mut usize,
) {
    for stmt in stmts.iter_mut() {
        match stmt {
            Stmt::If { then, else_, .. } => {
                lower_finally(then, return_type, locals, next);
                if let Some(other) = else_ {
                    lower_finally(other, return_type, locals, next);
                }
            }
            Stmt::Block { body, .. } | Stmt::While { body, .. } => {
                lower_finally(body, return_type, locals, next)
            }
            Stmt::Switch { cases, .. } => {
                for case in cases {
                    lower_finally(&mut case.body, return_type, locals, next);
                }
            }
            Stmt::TryCatch {
                try_body,
                catch_body,
                finally_body,
                ..
            } => {
                lower_finally(try_body, return_type, locals, next);
                if let Some(catch) = catch_body {
                    lower_finally(catch, return_type, locals, next);
                }
                if let Some(finally) = finally_body {
                    lower_finally(finally, return_type, locals, next);
                }
            }
            _ => {}
        }
    }

    let original = std::mem::take(stmts);
    let original_len = original.len();
    let mut output = Vec::new();
    for (stmt_index, stmt) in original.into_iter().enumerate() {
        let fallback = stmt.clone();
        let Stmt::TryCatch {
            try_body,
            catch_body,
            catch_local_id,
            finally_body: Some(finally),
            loc,
        } = stmt
        else {
            output.push(fallback);
            continue;
        };

        let result = fresh_local(locals, next, "finally_result", Type::Dyn, true);
        let returned = fresh_local(locals, next, "finally_returned", Type::Bool, true);
        let failed = fresh_local(locals, next, "finally_failed", Type::Bool, true);
        let error = fresh_local(locals, next, "finally_error", Type::Dyn, true);
        let caught = fresh_local(locals, next, "finally_caught", Type::Caught, false);

        let protected = if let Some(catch) = catch_body {
            vec![Stmt::TryCatch {
                try_body,
                catch_body: Some(catch),
                catch_local_id,
                finally_body: None,
                loc: loc.clone(),
            }]
        } else {
            try_body
        };
        let Some(mut protected) = rewrite_returns(protected, &result, &returned, 0) else {
            output.push(fallback);
            continue;
        };
        protected.push(Stmt::Break {
            target_depth: 0,
            loc: loc.clone(),
        });

        output.push(Stmt::VarDecl {
            local_id: result.clone(),
            init: dynamic(undefined(&loc), &loc),
            loc: loc.clone(),
        });
        output.push(Stmt::VarDecl {
            local_id: returned.clone(),
            init: Expr::BoolLit {
                value: false,
                r#type: Type::Bool,
                loc: loc.clone(),
            },
            loc: loc.clone(),
        });
        output.push(Stmt::VarDecl {
            local_id: failed.clone(),
            init: Expr::BoolLit {
                value: false,
                r#type: Type::Bool,
                loc: loc.clone(),
            },
            loc: loc.clone(),
        });
        output.push(Stmt::VarDecl {
            local_id: error.clone(),
            init: dynamic(undefined(&loc), &loc),
            loc: loc.clone(),
        });
        output.push(Stmt::While {
            cond: Expr::BoolLit {
                value: true,
                r#type: Type::Bool,
                loc: loc.clone(),
            },
            body: vec![Stmt::TryCatch {
                try_body: protected,
                catch_body: Some(vec![
                    Stmt::Assign {
                        local_id: error.clone(),
                        value: Expr::CaughtToDyn {
                            value: Box::new(Expr::VarRef {
                                local_id: caught.clone(),
                                r#type: Type::Caught,
                                loc: loc.clone(),
                            }),
                            r#type: Type::Dyn,
                            loc: loc.clone(),
                        },
                        initializes_global: false,
                        loc: loc.clone(),
                    },
                    Stmt::Assign {
                        local_id: failed.clone(),
                        value: Expr::BoolLit {
                            value: true,
                            r#type: Type::Bool,
                            loc: loc.clone(),
                        },
                        initializes_global: false,
                        loc: loc.clone(),
                    },
                    Stmt::Break {
                        target_depth: 0,
                        loc: loc.clone(),
                    },
                ]),
                catch_local_id: Some(caught),
                finally_body: None,
                loc: loc.clone(),
            }],
            loc: loc.clone(),
        });
        output.extend(finally);
        output.push(Stmt::If {
            cond: Expr::VarRef {
                local_id: failed,
                r#type: Type::Bool,
                loc: loc.clone(),
            },
            then: vec![Stmt::Throw {
                value: Expr::VarRef {
                    local_id: error,
                    r#type: Type::Dyn,
                    loc: loc.clone(),
                },
                loc: loc.clone(),
            }],
            else_: None,
            loc: loc.clone(),
        });
        output.push(Stmt::If {
            cond: Expr::VarRef {
                local_id: returned,
                r#type: Type::Bool,
                loc: loc.clone(),
            },
            then: vec![Stmt::Return {
                value: if matches!(return_type, Type::Void | Type::Undefined) {
                    None
                } else if *return_type == Type::Dyn {
                    Some(Expr::VarRef {
                        local_id: result,
                        r#type: Type::Dyn,
                        loc: loc.clone(),
                    })
                } else {
                    Some(Expr::DynCheck {
                        value: Box::new(Expr::VarRef {
                            local_id: result,
                            r#type: Type::Dyn,
                            loc: loc.clone(),
                        }),
                        r#type: return_type.clone(),
                        loc: loc.clone(),
                    })
                },
                loc: loc.clone(),
            }],
            else_: None,
            loc: loc.clone(),
        });
        if stmt_index + 1 == original_len && !matches!(return_type, Type::Void | Type::Undefined) {
            // The frontend has already proved that a non-void function does
            // not fall through. This arm is unreachable, but spelling it out
            // keeps that fact visible after the finally join is expanded.
            output.push(Stmt::Throw {
                value: Expr::StrLit {
                    value: "scriptc: unreachable async finally fallthrough".into(),
                    r#type: Type::String,
                    loc: loc.clone(),
                },
                loc,
            });
        }
    }
    *stmts = output;
}

fn suspends(value: &Expr) -> bool {
    // `walk_expression` visits descendants, not the supplied root. A direct
    // `await` in a ternary arm therefore used to escape normalization and the
    // continuation planner only saw the later suspensions in the function.
    let mut found = matches!(value, Expr::Await { .. });
    crate::ir::walk_expression(value, &mut |value| {
        found |= matches!(value, Expr::Await { .. })
    });
    found
}

fn conditional_child(value: &Expr) -> Option<&Expr> {
    match value {
        Expr::DynFrom { value, .. }
        | Expr::DynCheck { value, .. }
        | Expr::UnionWrap { value, .. }
        | Expr::UnionNarrow { value, .. }
        | Expr::RecordGet { obj: value, .. }
        | Expr::FieldGet { obj: value, .. }
        | Expr::ToString { operand: value, .. }
        | Expr::Unary { operand: value, .. }
        | Expr::DynTest { value, .. }
        | Expr::UnionProject { value, .. }
        | Expr::UnionIsTag { value, .. }
        | Expr::Upcast { value, .. }
        | Expr::Downcast { value, .. }
        | Expr::InstanceOf { value, .. }
        | Expr::CaughtToDyn { value, .. }
        | Expr::CaughtNarrow { value, .. }
        | Expr::CaughtTest { value, .. }
        | Expr::DynIterN { value, .. } => Some(value),
        _ => None,
    }
}

fn conditional_child_mut(value: &mut Expr) -> Option<&mut Expr> {
    match value {
        Expr::DynFrom { value, .. }
        | Expr::DynCheck { value, .. }
        | Expr::UnionWrap { value, .. }
        | Expr::UnionNarrow { value, .. }
        | Expr::RecordGet { obj: value, .. }
        | Expr::FieldGet { obj: value, .. }
        | Expr::ToString { operand: value, .. }
        | Expr::Unary { operand: value, .. }
        | Expr::DynTest { value, .. }
        | Expr::UnionProject { value, .. }
        | Expr::UnionIsTag { value, .. }
        | Expr::Upcast { value, .. }
        | Expr::Downcast { value, .. }
        | Expr::InstanceOf { value, .. }
        | Expr::CaughtToDyn { value, .. }
        | Expr::CaughtNarrow { value, .. }
        | Expr::CaughtTest { value, .. }
        | Expr::DynIterN { value, .. } => Some(value),
        _ => None,
    }
}

/// Peels value-preserving projections around a conditional suspension. The
/// projections are cloned onto both results, but the branch values themselves
/// remain lazy: callers turn the returned condition into structured control
/// flow before either arm is normalized.
fn split_suspending_ternary(value: &Expr) -> Option<(Expr, Expr, Expr)> {
    if let Expr::Ternary {
        cond, then, else_, ..
    } = value
        && (suspends(then) || suspends(else_))
    {
        return Some((*cond.clone(), *then.clone(), *else_.clone()));
    }
    // Boolean `left && await right` is `left ? await right : false`, and
    // `left || await right` is `left ? true : await right`: the right operand
    // runs (and suspends) only on its selected branch.
    if let Expr::Logical {
        op,
        left,
        right,
        r#type: Type::Bool,
        loc,
    } = value
        && suspends(right)
        && matches!(op.as_str(), "&&" | "||")
    {
        let constant = |value: bool| Expr::BoolLit {
            value,
            r#type: Type::Bool,
            loc: loc.clone(),
        };
        return Some(if op == "&&" {
            (*left.clone(), *right.clone(), constant(false))
        } else {
            (*left.clone(), constant(true), *right.clone())
        });
    }
    let child = conditional_child(value)?;
    let (cond, then_child, else_child) = split_suspending_ternary(child)?;
    let mut then = value.clone();
    *conditional_child_mut(&mut then)? = then_child;
    let mut else_ = value.clone();
    *conditional_child_mut(&mut else_)? = else_child;
    Some((cond, then, else_))
}

fn conditional_join(
    value: &mut Expr,
    prefix: &mut Vec<Stmt>,
    locals: &mut Vec<Local>,
    next: &mut usize,
    loc: &Loc,
) -> bool {
    let Some((mut cond, then, else_)) = split_suspending_ternary(value) else {
        return false;
    };
    let result_type = value.ty();
    let result = fresh_local(locals, next, "async_choice", Type::Dyn, true);
    locals
        .iter_mut()
        .find(|local| local.id == result)
        .expect("fresh async choice local")
        .boxed = true;
    prefix.push(Stmt::VarDecl {
        local_id: result.clone(),
        init: dynamic(undefined(loc), loc),
        loc: loc.clone(),
    });

    expression(&mut cond, prefix, locals, next, loc);
    if matches!(cond, Expr::Await { .. }) {
        prefix.push(extract(&mut cond, loc, locals, next));
    }
    let mut left = vec![Stmt::Assign {
        local_id: result.clone(),
        value: dynamic(then, loc),
        initializes_global: false,
        loc: loc.clone(),
    }];
    let mut right = vec![Stmt::Assign {
        local_id: result.clone(),
        value: dynamic(else_, loc),
        initializes_global: false,
        loc: loc.clone(),
    }];
    body(&mut left, locals, next);
    body(&mut right, locals, next);
    prefix.push(Stmt::If {
        cond,
        then: left,
        else_: Some(right),
        loc: loc.clone(),
    });

    *value = match result_type {
        Type::Dyn => Expr::VarRef {
            local_id: result,
            r#type: Type::Dyn,
            loc: loc.clone(),
        },
        Type::Void | Type::Null | Type::Undefined => Expr::UnitLit {
            unit: match result_type {
                Type::Void => "void",
                Type::Null => "null",
                Type::Undefined => "undefined",
                _ => unreachable!(),
            },
            r#type: result_type,
            loc: loc.clone(),
        },
        other => Expr::DynCheck {
            value: Box::new(Expr::VarRef {
                local_id: result,
                r#type: Type::Dyn,
                loc: loc.clone(),
            }),
            r#type: other,
            loc: loc.clone(),
        },
    };
    true
}

fn ordered_values(
    values: &mut [Expr],
    prefix: &mut Vec<Stmt>,
    locals: &mut Vec<Local>,
    next: &mut usize,
    loc: &Loc,
) {
    if !values.iter().any(suspends) {
        return;
    }
    // JavaScript evaluates every item from left to right. Materializing the
    // complete list is intentional: values before a suspension stay before
    // it, while the declarations after it become part of the continuation.
    for value in values {
        expression(value, prefix, locals, next, loc);
        prefix.push(extract(value, loc, locals, next));
    }
}

fn ordered_pair(
    left: &mut Expr,
    right: &mut Expr,
    prefix: &mut Vec<Stmt>,
    locals: &mut Vec<Local>,
    next: &mut usize,
    loc: &Loc,
) {
    if !suspends(left) && !suspends(right) {
        return;
    }
    expression(left, prefix, locals, next, loc);
    prefix.push(extract(left, loc, locals, next));
    expression(right, prefix, locals, next, loc);
    prefix.push(extract(right, loc, locals, next));
}

fn expression(
    value: &mut Expr,
    prefix: &mut Vec<Stmt>,
    locals: &mut Vec<Local>,
    next: &mut usize,
    loc: &Loc,
) {
    if !suspends(value) {
        return;
    }
    if let Expr::Sequence { stmts, result, .. } = value {
        body(stmts, locals, next);
        prefix.append(stmts);
        *value = *result.clone();
        expression(value, prefix, locals, next, loc);
        return;
    }
    if conditional_join(value, prefix, locals, next, loc) {
        return;
    }
    match value {
        Expr::Await { value, .. } => {
            expression(value, prefix, locals, next, loc);
        }
        Expr::DynFrom { value, .. }
        | Expr::DynCheck { value, .. }
        | Expr::UnionWrap { value, .. }
        | Expr::UnionNarrow { value, .. }
        | Expr::RecordGet { obj: value, .. }
        | Expr::FieldGet { obj: value, .. }
        | Expr::ToString { operand: value, .. } => {
            expression(value, prefix, locals, next, loc);
            if matches!(value.as_ref(), Expr::Await { .. }) {
                prefix.push(extract(value, loc, locals, next));
            }
        }
        Expr::Call { args, .. } | Expr::LibCall { args, .. } | Expr::Intrinsic { args, .. } => {
            for arg in args {
                expression(arg, prefix, locals, next, loc);
                prefix.push(extract(arg, loc, locals, next));
            }
        }
        Expr::CallValue { callee, args, .. } => {
            expression(callee, prefix, locals, next, loc);
            prefix.push(extract(callee, loc, locals, next));
            ordered_values(args, prefix, locals, next, loc);
        }
        Expr::ArrayLit { elems, .. } | Expr::DynArrLit { elems, .. } => {
            ordered_values(elems, prefix, locals, next, loc);
        }
        Expr::RecordLit { fields, .. } => {
            if fields.iter().any(|field| suspends(&field.value)) {
                for field in fields {
                    if field.absent {
                        // Missing properties carry a typed undefined only as
                        // a layout placeholder. It is not a JavaScript value
                        // evaluation and must remain visibly undefined for
                        // RecordLit validation/emission rather than becoming
                        // an async temporary VarRef.
                        continue;
                    }
                    expression(&mut field.value, prefix, locals, next, loc);
                    prefix.push(extract(&mut field.value, loc, locals, next));
                }
            }
        }
        Expr::DynObjLit { fields, .. } => {
            if fields
                .iter()
                .any(|field| suspends(&field.key) || suspends(&field.value))
            {
                for field in fields {
                    expression(&mut field.key, prefix, locals, next, loc);
                    prefix.push(extract(&mut field.key, loc, locals, next));
                    expression(&mut field.value, prefix, locals, next, loc);
                    prefix.push(extract(&mut field.value, loc, locals, next));
                }
            }
        }
        Expr::MapNew { seed, .. } => {
            if seed
                .iter()
                .any(|entry| suspends(&entry.key) || suspends(&entry.value))
            {
                for entry in seed {
                    expression(&mut entry.key, prefix, locals, next, loc);
                    prefix.push(extract(&mut entry.key, loc, locals, next));
                    expression(&mut entry.value, prefix, locals, next, loc);
                    prefix.push(extract(&mut entry.value, loc, locals, next));
                }
            }
        }
        Expr::DynKeyGet {
            value: left,
            key: right,
            ..
        }
        | Expr::DynScalarEq { left, right, .. }
        | Expr::DynLooseEq { left, right, .. }
        | Expr::ArrayGet {
            arr: left,
            index: right,
            ..
        }
        | Expr::RecordKeyGet {
            obj: left,
            key: right,
            ..
        }
        | Expr::StrEq { left, right, .. }
        | Expr::StrConcat { left, right, .. }
        | Expr::UnionEq { left, right, .. }
        | Expr::Bin { left, right, .. } => {
            ordered_pair(left, right, prefix, locals, next, loc);
        }
        Expr::Unary { operand, .. }
        | Expr::DynTest { value: operand, .. }
        | Expr::UnionProject { value: operand, .. }
        | Expr::UnionIsTag { value: operand, .. }
        | Expr::Upcast { value: operand, .. }
        | Expr::Downcast { value: operand, .. }
        | Expr::InstanceOf { value: operand, .. }
        | Expr::CaughtToDyn { value: operand, .. }
        | Expr::CaughtNarrow { value: operand, .. }
        | Expr::CaughtTest { value: operand, .. }
        | Expr::DynIterN { value: operand, .. } => {
            expression(operand, prefix, locals, next, loc);
            if matches!(operand.as_ref(), Expr::Await { .. }) {
                prefix.push(extract(operand, loc, locals, next));
            }
        }
        Expr::DynInvoke { recv, args, .. }
        | Expr::BytesIntrinsic {
            receiver: recv,
            args,
            ..
        }
        | Expr::RegexIntrinsic {
            receiver: recv,
            args,
            ..
        }
        | Expr::SetIntrinsic {
            receiver: recv,
            args,
            ..
        }
        | Expr::MapIntrinsic {
            receiver: recv,
            args,
            ..
        }
        | Expr::ArrayIntrinsic {
            receiver: recv,
            args,
            ..
        }
        | Expr::StringIntrinsic {
            receiver: recv,
            args,
            ..
        } => {
            expression(recv, prefix, locals, next, loc);
            prefix.push(extract(recv, loc, locals, next));
            ordered_values(args, prefix, locals, next, loc);
        }
        Expr::DynCall { callee, args, .. } | Expr::NewValue { callee, args, .. } => {
            expression(callee, prefix, locals, next, loc);
            prefix.push(extract(callee, loc, locals, next));
            ordered_values(args, prefix, locals, next, loc);
        }
        Expr::BytesNew {
            source: Some(source),
            ..
        }
        | Expr::SetNew {
            seed: Some(source), ..
        } => {
            expression(source, prefix, locals, next, loc);
            if matches!(source.as_ref(), Expr::Await { .. }) {
                prefix.push(extract(source, loc, locals, next));
            }
        }
        Expr::Logical { left, right, .. } if !suspends(right) => {
            expression(left, prefix, locals, next, loc);
            if matches!(left.as_ref(), Expr::Await { .. }) {
                prefix.push(extract(left, loc, locals, next));
            }
        }
        Expr::Ternary {
            cond, then, else_, ..
        } if !suspends(then) && !suspends(else_) => {
            // Suspended arms are split into structured branches by `body`.
            // A suspended condition is different: it is always evaluated
            // before branch selection, so it can be resumed into a temporary
            // without evaluating either arm eagerly.
            expression(cond, prefix, locals, next, loc);
            if matches!(cond.as_ref(), Expr::Await { .. }) {
                prefix.push(extract(cond, loc, locals, next));
            }
        }
        _ => {}
    }
}

fn body(stmts: &mut Vec<Stmt>, locals: &mut Vec<Local>, next: &mut usize) {
    let original = std::mem::take(stmts);
    let mut remaining = original.into_iter();
    while let Some(mut stmt) = remaining.next() {
        // Logical and comma expressions are represented as a Sequence. Expose
        // its result before checking for a conditional suspension so forms
        // such as `value ?? await fallback()` become an explicit branch. If
        // this stays nested, the CFG planner cannot attach a continuation to
        // the awaited arm.
        if let Stmt::VarDecl { init, .. } = &mut stmt
            && let Expr::Sequence {
                stmts: sequence,
                result,
                ..
            } = init
        {
            let replacement = result.as_ref().clone();
            body(sequence, locals, next);
            stmts.append(sequence);
            *init = replacement;
        }
        if let Stmt::If {
            cond: Expr::Logical {
                op, left, right, ..
            },
            then,
            else_,
            loc,
        } = &stmt
            && suspends(right)
            && matches!(op.as_str(), "&&" | "||")
        {
            let nested = Stmt::If {
                cond: *right.clone(),
                then: then.clone(),
                else_: else_.clone(),
                loc: loc.clone(),
            };
            stmt = if op == "&&" {
                Stmt::If {
                    cond: *left.clone(),
                    then: vec![nested],
                    else_: else_.clone(),
                    loc: loc.clone(),
                }
            } else {
                Stmt::If {
                    cond: *left.clone(),
                    then: then.clone(),
                    else_: Some(vec![nested]),
                    loc: loc.clone(),
                }
            };
        }
        match &mut stmt {
            Stmt::If { then, else_, .. } => {
                body(then, locals, next);
                if let Some(other) = else_ {
                    body(other, locals, next);
                }
            }
            Stmt::Block { body: nested, .. } => body(nested, locals, next),
            Stmt::While { body: nested, .. } => body(nested, locals, next),
            Stmt::GeneratorForOf { body: nested, .. } => body(nested, locals, next),
            Stmt::Switch { cases, loc, .. } => {
                for case in cases {
                    body(&mut case.body, locals, next);
                    if case
                        .body
                        .iter()
                        .any(|stmt| matches!(stmt, Stmt::VarDecl { .. }))
                    {
                        // Source lexical declarations in a shared switch
                        // scope are refused by the frontend. Declarations
                        // introduced here are continuation temporaries, so
                        // give the case an explicit IR block rather than
                        // making them look like shared case bindings.
                        case.body = vec![Stmt::Block {
                            body: std::mem::take(&mut case.body),
                            loc: loc.clone(),
                        }];
                    }
                }
            }
            Stmt::TryCatch {
                try_body,
                catch_body,
                finally_body,
                ..
            } => {
                body(try_body, locals, next);
                if let Some(catch) = catch_body {
                    body(catch, locals, next);
                }
                if let Some(finally) = finally_body {
                    body(finally, locals, next);
                }
            }
            _ => {}
        }
        let generated_start = stmts.len();
        match &mut stmt {
            Stmt::VarDecl {
                init: value, loc, ..
            }
            | Stmt::Expression { expr: value, loc } => {
                // These are the two suspension forms consumed directly by
                // the continuation emitter. Keep the Await at the root.
                expression(value, stmts, locals, next, loc)
            }
            Stmt::Assign { value, loc, .. } | Stmt::Throw { value, loc } => {
                expression(value, stmts, locals, next, loc);
                if matches!(value, Expr::Await { .. }) {
                    stmts.push(extract(value, loc, locals, next));
                }
            }
            Stmt::Return {
                value: Some(value),
                loc,
            } => {
                expression(value, stmts, locals, next, loc);
                let terminal_unit_await = matches!(
                    value,
                    Expr::Await {
                        r#type: Type::Void | Type::Null | Type::Undefined,
                        ..
                    }
                );
                if matches!(value, Expr::Await { .. }) && !terminal_unit_await {
                    stmts.push(extract(value, loc, locals, next));
                }
            }
            Stmt::If { cond, loc, .. }
            | Stmt::Switch {
                disc: cond, loc, ..
            } => {
                expression(cond, stmts, locals, next, loc);
                if matches!(cond, Expr::Await { .. }) {
                    stmts.push(extract(cond, loc, locals, next));
                }
            }
            Stmt::GeneratorForOf {
                generator: value,
                loc,
                ..
            } => {
                expression(value, stmts, locals, next, loc);
                if matches!(value, Expr::Await { .. }) {
                    stmts.push(extract(value, loc, locals, next));
                }
            }
            Stmt::RecordSet {
                obj, value, loc, ..
            }
            | Stmt::FieldSet {
                obj, value, loc, ..
            } => ordered_pair(obj, value, stmts, locals, next, loc),
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
                if suspends(arr) || suspends(index) || suspends(value) {
                    expression(arr, stmts, locals, next, loc);
                    stmts.push(extract(arr, loc, locals, next));
                    expression(index, stmts, locals, next, loc);
                    stmts.push(extract(index, loc, locals, next));
                    expression(value, stmts, locals, next, loc);
                    stmts.push(extract(value, loc, locals, next));
                }
            }
            Stmt::RecordKeySet {
                obj,
                key,
                value,
                loc,
                ..
            } => {
                if suspends(obj) || suspends(key) || suspends(value) {
                    expression(obj, stmts, locals, next, loc);
                    stmts.push(extract(obj, loc, locals, next));
                    expression(key, stmts, locals, next, loc);
                    stmts.push(extract(key, loc, locals, next));
                    expression(value, stmts, locals, next, loc);
                    stmts.push(extract(value, loc, locals, next));
                }
            }
            Stmt::ArraySetLength { arr, length, loc } => {
                ordered_pair(arr, length, stmts, locals, next, loc)
            }
            _ => {}
        }
        if let Stmt::Return {
            value: Some(value),
            loc,
            ..
        } = &mut stmt
        {
            if let Some(fields) = returned_record(value) {
                let last = fields
                    .iter_mut()
                    .rposition(|field| await_value(&mut field.value).is_some());
                if let Some(last) = last {
                    for field in &mut fields[..=last] {
                        if field.absent {
                            // See the RecordLit normalization above. Absent
                            // layout slots do not participate in evaluation
                            // order around suspension points.
                            continue;
                        }
                        if let Some(awaited) = await_value(&mut field.value) {
                            stmts.push(extract(awaited, loc, locals, next));
                        }
                        // Materialize each earlier field before the next suspension.
                        stmts.push(extract(&mut field.value, loc, locals, next));
                    }
                }
            }
        }
        if let Stmt::VarDecl {
            init: Expr::Call { args, .. },
            loc,
            ..
        } = &mut stmt
        {
            if let Some(first @ Expr::Await { .. }) = args.first_mut() {
                stmts.push(extract(first, loc, locals, next));
            }
        }
        if stmts.len() != generated_start {
            // Expression normalization can expose a suspension by generating
            // a new statement. Feed that prefix back through statement
            // normalization before appending its consumer. This matters for
            // forms such as a typed record write whose value is
            // `condition ? await left : right`: ordered evaluation first
            // materializes the record receiver, then extracts the conditional
            // value into a declaration. The generated declaration must still
            // be split into branch continuations rather than leave an await
            // nested inside a ternary.
            let mut pending = stmts.split_off(generated_start);
            pending.push(stmt);
            pending.extend(remaining);
            body(&mut pending, locals, next);
            stmts.append(&mut pending);
            return;
        }
        stmts.push(stmt);
    }
}
