//! Async `try { B } finally { F }` regions whose suspensions have no direct
//! continuation shape are rewritten into the equivalent protected form the
//! structured planner supports:
//!
//! ```text
//! kind = 0
//! try { loop { B' ; break } } catch (c) { kind = 2; error = c }
//! F
//! if kind == 1 { return value }
//! if kind == 2 { throw error }
//! ```
//!
//! where every `return v` in `B` records `kind = 1; value = v` and leaves the
//! wrapper loop. The finalizer therefore runs exactly once on normal
//! completion, on return and on throw, before the recorded completion is
//! resumed; a completion raised by `F` itself replaces it, as in JavaScript.
//! Regions whose `break`/`continue` cross the `try` keep their original form.
use super::*;
use crate::ir::Loc;

struct Rewriter<'a> {
    function: &'a mut Function,
    next: usize,
}

impl Rewriter<'_> {
    fn local(&mut self, name: &str, ty: Type) -> String {
        let id = format!("sc_finally_{}_{}", name, self.next);
        self.next += 1;
        self.function.locals.push(crate::ir::Local {
            id: id.clone(),
            name: format!("finally {name}"),
            r#type: ty,
            mutable: true,
            boxed: false,
        });
        id
    }
}

fn read(id: &str, ty: Type, loc: &Loc) -> Expr {
    Expr::VarRef {
        local_id: id.into(),
        r#type: ty,
        loc: loc.clone(),
    }
}

fn number(value: f64, loc: &Loc) -> Expr {
    Expr::NumLit {
        value,
        spelling: None,
        r#type: Type::F64,
        loc: loc.clone(),
    }
}

fn undefined_dyn(loc: &Loc) -> Expr {
    Expr::DynFrom {
        value: Box::new(Expr::UnitLit {
            unit: "undefined",
            r#type: Type::Undefined,
            loc: loc.clone(),
        }),
        r#type: Type::Dyn,
        loc: loc.clone(),
    }
}

/// Whether a `break`/`continue` in `body` leaves the region (targets a loop
/// or switch outside it). `breaks` counts loops and switches; `continues`
/// counts loops only.
fn crosses(body: &[Stmt], breaks: usize, continues: usize) -> bool {
    body.iter().any(|stmt| match stmt {
        Stmt::Break { target_depth, .. } => *target_depth >= breaks,
        Stmt::Continue { target_depth, .. } => *target_depth >= continues,
        Stmt::If { then, else_, .. } => {
            crosses(then, breaks, continues)
                || else_.as_ref().is_some_and(|body| crosses(body, breaks, continues))
        }
        Stmt::Block { body, .. } => crosses(body, breaks, continues),
        Stmt::TryCatch {
            try_body,
            catch_body,
            finally_body,
            ..
        } => {
            crosses(try_body, breaks, continues)
                || catch_body.as_ref().is_some_and(|body| crosses(body, breaks, continues))
                || finally_body.as_ref().is_some_and(|body| crosses(body, breaks, continues))
        }
        Stmt::While { body, .. } | Stmt::GeneratorForOf { body, .. } => {
            crosses(body, breaks + 1, continues + 1)
        }
        Stmt::Switch { cases, .. } => cases
            .iter()
            .any(|case| crosses(&case.body, breaks + 1, continues)),
        _ => false,
    })
}

impl Rewriter<'_> {
    /// Replace each `return` with a recorded completion and a break out of the
    /// wrapper loop, `depth` break targets above the statement.
    fn returns(&mut self, body: Vec<Stmt>, depth: usize, kind: &str, value: Option<&str>) -> Vec<Stmt> {
        let mut out = Vec::new();
        for stmt in body {
            match stmt {
                Stmt::Return { value: returned, loc } => {
                    if let (Some(slot), Some(returned)) = (value, returned) {
                        let returned = if let Expr::Await { .. } = &returned {
                            let ty = returned.ty();
                            let temp = self.local("awaited", ty.clone());
                            out.push(Stmt::VarDecl {
                                local_id: temp.clone(),
                                init: returned,
                                loc: loc.clone(),
                            });
                            read(&temp, ty, &loc)
                        } else {
                            returned
                        };
                        out.push(Stmt::Assign {
                            local_id: slot.into(),
                            value: Expr::DynFrom {
                                value: Box::new(returned),
                                r#type: Type::Dyn,
                                loc: loc.clone(),
                            },
                            initializes_global: false,
                            loc: loc.clone(),
                        });
                    }
                    out.push(Stmt::Assign {
                        local_id: kind.into(),
                        value: number(1.0, &loc),
                        initializes_global: false,
                        loc: loc.clone(),
                    });
                    out.push(Stmt::Break { target_depth: depth, loc });
                }
                Stmt::If { cond, then, else_, loc } => out.push(Stmt::If {
                    cond,
                    then: self.returns(then, depth, kind, value),
                    else_: else_.map(|body| self.returns(body, depth, kind, value)),
                    loc,
                }),
                Stmt::Block { body, loc } => out.push(Stmt::Block {
                    body: self.returns(body, depth, kind, value),
                    loc,
                }),
                Stmt::TryCatch {
                    try_body,
                    catch_body,
                    catch_local_id,
                    finally_body,
                    loc,
                } => out.push(Stmt::TryCatch {
                    try_body: self.returns(try_body, depth, kind, value),
                    catch_body: catch_body.map(|body| self.returns(body, depth, kind, value)),
                    catch_local_id,
                    finally_body: finally_body.map(|body| self.returns(body, depth, kind, value)),
                    loc,
                }),
                Stmt::While { cond, body, loc } => out.push(Stmt::While {
                    cond,
                    body: self.returns(body, depth + 1, kind, value),
                    loc,
                }),
                Stmt::GeneratorForOf {
                    generator,
                    local_id,
                    body,
                    loc,
                } => out.push(Stmt::GeneratorForOf {
                    generator,
                    local_id,
                    body: self.returns(body, depth + 1, kind, value),
                    loc,
                }),
                Stmt::Switch { disc, cases, loc } => out.push(Stmt::Switch {
                    disc,
                    cases: cases
                        .into_iter()
                        .map(|mut case| {
                            case.body = self.returns(std::mem::take(&mut case.body), depth + 1, kind, value);
                            case
                        })
                        .collect(),
                    loc,
                }),
                other => out.push(other),
            }
        }
        out
    }

    fn body(&mut self, body: Vec<Stmt>) -> Vec<Stmt> {
        let mut out = Vec::new();
        for stmt in body {
            match stmt {
                Stmt::TryCatch {
                    try_body,
                    catch_body: None,
                    catch_local_id: None,
                    finally_body: Some(finally),
                    loc,
                } if !crosses(&try_body, 0, 0) => {
                    let try_body = self.body(try_body);
                    let finally = self.body(finally);
                    let return_type = self.function.return_type.clone();
                    let kind = self.local("kind", Type::F64);
                    let value = (return_type != Type::Void).then(|| self.local("value", Type::Dyn));
                    let error = self.local("error", Type::Dyn);
                    let caught = self.local("caught", Type::Caught);
                    out.push(Stmt::VarDecl {
                        local_id: kind.clone(),
                        init: number(0.0, &loc),
                        loc: loc.clone(),
                    });
                    if let Some(value) = &value {
                        out.push(Stmt::VarDecl {
                            local_id: value.clone(),
                            init: undefined_dyn(&loc),
                            loc: loc.clone(),
                        });
                    }
                    out.push(Stmt::VarDecl {
                        local_id: error.clone(),
                        init: undefined_dyn(&loc),
                        loc: loc.clone(),
                    });
                    let mut wrapped = self.returns(try_body, 0, &kind, value.as_deref());
                    wrapped.push(Stmt::Break { target_depth: 0, loc: loc.clone() });
                    out.push(Stmt::TryCatch {
                        try_body: vec![Stmt::While {
                            cond: Expr::BoolLit {
                                value: true,
                                r#type: Type::Bool,
                                loc: loc.clone(),
                            },
                            body: wrapped,
                            loc: loc.clone(),
                        }],
                        catch_body: Some(vec![
                            Stmt::Assign {
                                local_id: kind.clone(),
                                value: number(2.0, &loc),
                                initializes_global: false,
                                loc: loc.clone(),
                            },
                            Stmt::Assign {
                                local_id: error.clone(),
                                value: Expr::CaughtToDyn {
                                    value: Box::new(read(&caught, Type::Caught, &loc)),
                                    r#type: Type::Dyn,
                                    loc: loc.clone(),
                                },
                                initializes_global: false,
                                loc: loc.clone(),
                            },
                        ]),
                        catch_local_id: Some(caught),
                        finally_body: None,
                        loc: loc.clone(),
                    });
                    out.extend(finally);
                    let is = |code: f64| Expr::Bin {
                        op: "==".into(),
                        left: Box::new(read(&kind, Type::F64, &loc)),
                        right: Box::new(number(code, &loc)),
                        r#type: Type::Bool,
                        loc: loc.clone(),
                    };
                    let resumed = value.map(|value| {
                        let stored = read(&value, Type::Dyn, &loc);
                        if return_type == Type::Dyn {
                            stored
                        } else {
                            Expr::DynCheck {
                                value: Box::new(stored),
                                r#type: return_type.clone(),
                                loc: loc.clone(),
                            }
                        }
                    });
                    out.push(Stmt::If {
                        cond: is(1.0),
                        then: vec![Stmt::Return { value: resumed, loc: loc.clone() }],
                        else_: None,
                        loc: loc.clone(),
                    });
                    out.push(Stmt::If {
                        cond: is(2.0),
                        then: vec![Stmt::Throw {
                            value: read(&error, Type::Dyn, &loc),
                            loc: loc.clone(),
                        }],
                        else_: None,
                        loc: loc.clone(),
                    });
                }
                Stmt::If { cond, then, else_, loc } => out.push(Stmt::If {
                    cond,
                    then: self.body(then),
                    else_: else_.map(|body| self.body(body)),
                    loc,
                }),
                Stmt::Block { body, loc } => out.push(Stmt::Block {
                    body: self.body(body),
                    loc,
                }),
                Stmt::While { cond, body, loc } => out.push(Stmt::While {
                    cond,
                    body: self.body(body),
                    loc,
                }),
                other => out.push(other),
            }
        }
        out
    }
}

fn contains_finally(body: &[Stmt]) -> bool {
    body.iter().any(|stmt| match stmt {
        Stmt::TryCatch {
            catch_body: None,
            finally_body: Some(_),
            ..
        } => true,
        Stmt::If { then, else_, .. } => {
            contains_finally(then) || else_.as_deref().is_some_and(contains_finally)
        }
        Stmt::Block { body, .. } | Stmt::While { body, .. } => contains_finally(body),
        _ => false,
    })
}

/// Rewrite async functions the planner cannot schedule, keeping a rewrite
/// only when the whole module still validates and the function now plans.
pub(super) fn rewrite_unplannable(module: &mut Module, plannable: impl Fn(&Function) -> bool) {
    for index in 0..module.functions.len() {
        let function = &module.functions[index];
        if !function.is_async
            || function.generator.is_some()
            || plannable(function)
            || !contains_finally(&function.body)
        {
            continue;
        }
        let mut candidate = function.clone();
        let body = std::mem::take(&mut candidate.body);
        let mut rewriter = Rewriter {
            function: &mut candidate,
            next: 0,
        };
        let body = rewriter.body(body);
        candidate.body = body;
        if !plannable(&candidate) {
            continue;
        }
        let original = std::mem::replace(&mut module.functions[index], candidate);
        if crate::ir::validate(module).is_err() {
            module.functions[index] = original;
        }
    }
}
