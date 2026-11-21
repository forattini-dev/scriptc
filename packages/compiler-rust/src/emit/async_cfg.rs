//! Structured async control flow lowers conditional suspension into callbacks.
use super::*;

pub(super) struct Plan<'a> {
    entry: Segment<'a>,
    stages: Vec<Stage<'a>>,
    handlers: Vec<Handler<'a>>,
    loops: Vec<LoopPlan<'a>>,
    awaits: usize,
}

#[derive(Clone)]
struct Segment<'a> {
    prefix: Vec<&'a Stmt>,
    handler: Option<usize>,
    terminal: Terminal<'a>,
}

#[derive(Clone)]
enum Terminal<'a> {
    Loop(usize),
    LoopExit(usize),
    Return(Option<&'a Expr>),
    Throw(&'a Expr),
    Complete,
    Branch {
        cond: &'a Expr,
        then: Box<Segment<'a>>,
        else_: Box<Segment<'a>>,
    },
    Switch {
        disc: &'a Expr,
        cases: Vec<(Option<&'a Expr>, Segment<'a>)>,
    },
    Enter(Box<Segment<'a>>),
    ExitHandler(Box<Segment<'a>>),
    RecordSetAwaitChoice {
        cond: &'a Expr,
        stage: usize,
        obj: &'a Expr,
        field: &'a str,
        else_value: &'a Expr,
        else_next: Box<Segment<'a>>,
    },
    AwaitChoice {
        cond: &'a Expr,
        then_stage: usize,
        else_stage: usize,
    },
    ProtectedFinally {
        before: Vec<&'a Stmt>,
        stage: usize,
        finally: &'a [Stmt],
    },
    Suspend(usize),
}

#[derive(Clone)]
enum Resume<'a> {
    Declare(&'a str),
    Assign(&'a str),
    AssignUnion {
        local_id: &'a str,
        union_id: usize,
        tag: usize,
        value_type: Type,
    },
    RecordSet {
        obj: &'a Expr,
        field: &'a str,
        value_type: Type,
    },
    CallArg {
        callee: &'a str,
        args: &'a [Expr],
        index: usize,
        value_type: Type,
        box_to_dyn: bool,
    },
    Return,
    ReturnFinally(&'a [Stmt]),
    ReturnValueFinally {
        local_id: &'a str,
        result: &'a Expr,
        finally: &'a [Stmt],
    },
    Ignore,
}

struct Stage<'a> {
    awaited: &'a Expr,
    resume: Resume<'a>,
    live: Vec<&'a crate::ir::Local>,
    next: Segment<'a>,
}

struct Handler<'a> {
    catch_local: Option<&'a str>,
    live: Vec<&'a crate::ir::Local>,
    body: Segment<'a>,
}

struct LoopPlan<'a> {
    cond: &'a Expr,
    live: Vec<&'a crate::ir::Local>,
    body: Segment<'a>,
    after: Segment<'a>,
    may_exit: bool,
}

fn breaks_target(body: &[Stmt], nested_break_targets: usize) -> bool {
    body.iter().any(|stmt| match stmt {
        Stmt::Break { target_depth, .. } => *target_depth == nested_break_targets,
        Stmt::If { then, else_, .. } => {
            breaks_target(then, nested_break_targets)
                || else_
                    .as_ref()
                    .is_some_and(|body| breaks_target(body, nested_break_targets))
        }
        Stmt::Block { body, .. } => breaks_target(body, nested_break_targets),
        Stmt::TryCatch {
            try_body,
            catch_body,
            finally_body,
            ..
        } => {
            breaks_target(try_body, nested_break_targets)
                || catch_body
                    .as_ref()
                    .is_some_and(|body| breaks_target(body, nested_break_targets))
                || finally_body
                    .as_ref()
                    .is_some_and(|body| breaks_target(body, nested_break_targets))
        }
        Stmt::While { body, .. } | Stmt::GeneratorForOf { body, .. } => {
            breaks_target(body, nested_break_targets + 1)
        }
        Stmt::Switch { cases, .. } => cases
            .iter()
            .any(|case| breaks_target(&case.body, nested_break_targets + 1)),
        _ => false,
    })
}

struct Builder<'a> {
    function: &'a Function,
    stages: Vec<Stage<'a>>,
    handlers: Vec<Handler<'a>>,
    recognized: std::collections::HashSet<usize>,
    branched_await: bool,
    loops: Vec<Option<LoopPlan<'a>>>,
    current_loop: Option<usize>,
    break_targets: Vec<Segment<'a>>,
    fallthrough: Vec<Option<Box<Segment<'a>>>>,
}

impl<'a> Builder<'a> {
    fn local(&self, id: &str) -> Option<&'a crate::ir::Local> {
        self.function.locals.iter().find(|local| local.id == id)
    }

    fn build(
        &mut self,
        mut input: Vec<&'a Stmt>,
        mut initialized: Vec<&'a crate::ir::Local>,
        branch_depth: usize,
        handler: Option<usize>,
    ) -> Option<Segment<'a>> {
        let mut prefix = Vec::new();
        while let Some(stmt) = input.first().copied() {
            input.remove(0);
            if let Stmt::Expression {
                expr: Expr::Sequence { stmts, result, .. },
                ..
            } = stmt
            {
                if discardable_sequence_result(result) {
                    let mut expanded = stmts.iter().collect::<Vec<_>>();
                    expanded.extend(input);
                    let mut nested = self.build(expanded, initialized, branch_depth, handler)?;
                    prefix.append(&mut nested.prefix);
                    return Some(Segment {
                        prefix,
                        handler,
                        terminal: nested.terminal,
                    });
                }
            }
            if let Stmt::RecordSet {
                obj,
                field,
                value: Expr::Ternary {
                    cond, then, else_, ..
                },
                ..
            } = stmt
            {
                if let Expr::Await {
                    value: awaited,
                    r#type: value_type,
                    ..
                } = then.as_ref()
                {
                    self.recognized
                        .insert(awaited.as_ref() as *const Expr as usize);
                    self.branched_await = true;
                    let next = self.build(
                        input.clone(),
                        initialized.clone(),
                        branch_depth + 1,
                        handler,
                    )?;
                    let else_next =
                        self.build(input, initialized.clone(), branch_depth + 1, handler)?;
                    let stage = self.stages.len();
                    self.stages.push(Stage {
                        awaited,
                        resume: Resume::RecordSet {
                            obj,
                            field,
                            value_type: value_type.clone(),
                        },
                        live: initialized,
                        next,
                    });
                    return Some(Segment {
                        prefix,
                        handler,
                        terminal: Terminal::RecordSetAwaitChoice {
                            cond,
                            stage,
                            obj,
                            field,
                            else_value: else_,
                            else_next: Box::new(else_next),
                        },
                    });
                }
            }
            if let Stmt::Expression {
                expr: Expr::Call { callee, args, .. },
                ..
            } = stmt
            {
                if let Some((index, cond, then_await, else_await)) = call_ternary_awaits(args) {
                    let (then_source, then_type, then_box_to_dyn) = then_await;
                    let (else_source, else_type, else_box_to_dyn) = else_await;
                    self.recognized.insert(then_source as *const Expr as usize);
                    self.recognized.insert(else_source as *const Expr as usize);
                    self.branched_await = true;
                    let then_next = self.build(
                        input.clone(),
                        initialized.clone(),
                        branch_depth + 1,
                        handler,
                    )?;
                    let else_next =
                        self.build(input, initialized.clone(), branch_depth + 1, handler)?;
                    let then_stage = self.stages.len();
                    self.stages.push(Stage {
                        awaited: then_source,
                        resume: Resume::CallArg {
                            callee,
                            args,
                            index,
                            value_type: then_type,
                            box_to_dyn: then_box_to_dyn,
                        },
                        live: initialized.clone(),
                        next: then_next,
                    });
                    let else_stage = self.stages.len();
                    self.stages.push(Stage {
                        awaited: else_source,
                        resume: Resume::CallArg {
                            callee,
                            args,
                            index,
                            value_type: else_type,
                            box_to_dyn: else_box_to_dyn,
                        },
                        live: initialized,
                        next: else_next,
                    });
                    return Some(Segment {
                        prefix,
                        handler,
                        terminal: Terminal::AwaitChoice {
                            cond,
                            then_stage,
                            else_stage,
                        },
                    });
                }
            }
            if let Stmt::VarDecl {
                local_id,
                init: Expr::Ternary {
                    cond, then, else_, ..
                },
                ..
            } = stmt
            {
                if let (Some((then_source, _, _)), Some((else_source, _, _))) =
                    (projected_await(then), projected_await(else_))
                {
                    self.recognized.insert(then_source as *const Expr as usize);
                    self.recognized.insert(else_source as *const Expr as usize);
                    self.branched_await = true;
                    let local = self.local(local_id)?;
                    let mut after = initialized.clone();
                    after.push(local);
                    let then_next =
                        self.build(input.clone(), after.clone(), branch_depth + 1, handler)?;
                    let else_next = self.build(input, after, branch_depth + 1, handler)?;
                    let then_stage = self.stages.len();
                    self.stages.push(Stage {
                        awaited: then_source,
                        resume: Resume::Declare(local_id),
                        live: initialized.clone(),
                        next: then_next,
                    });
                    let else_stage = self.stages.len();
                    self.stages.push(Stage {
                        awaited: else_source,
                        resume: Resume::Declare(local_id),
                        live: initialized,
                        next: else_next,
                    });
                    return Some(Segment {
                        prefix,
                        handler,
                        terminal: Terminal::AwaitChoice {
                            cond,
                            then_stage,
                            else_stage,
                        },
                    });
                }
            }
            if let Stmt::TryCatch {
                try_body,
                catch_body: None,
                finally_body: Some(finally),
                ..
            } = stmt
            {
                if let [
                    Stmt::Return {
                        value: Some(Expr::Await { value, .. }),
                        ..
                    },
                ] = try_body.as_slice()
                {
                    if handler.is_none() && synchronous_finally(finally) {
                        self.recognized
                            .insert(value.as_ref() as *const Expr as usize);
                        let stage = self.stages.len();
                        self.stages.push(Stage {
                            awaited: value,
                            resume: Resume::ReturnFinally(finally),
                            live: initialized,
                            next: Segment {
                                prefix: Vec::new(),
                                handler,
                                terminal: Terminal::Complete,
                            },
                        });
                        return Some(Segment {
                            prefix,
                            handler,
                            terminal: Terminal::Suspend(stage),
                        });
                    }
                }
                if handler.is_none() && synchronous_finally(finally) && try_body.len() >= 2 {
                    let (before, suffix) = try_body.split_at(try_body.len() - 2);
                    if let [
                        Stmt::VarDecl {
                            local_id,
                            init: Expr::Await { value, .. },
                            ..
                        },
                        Stmt::Return {
                            value: Some(result),
                            ..
                        },
                    ] = suffix
                    {
                        let mut live = initialized.clone();
                        let mut supported = true;
                        for stmt in before {
                            match stmt {
                                Stmt::VarDecl { local_id, .. } => {
                                    if let Some(local) = self.local(local_id) {
                                        live.push(local);
                                    } else {
                                        supported = false;
                                    }
                                }
                                Stmt::Expression { .. } | Stmt::Assign { .. } => {}
                                _ => supported = false,
                            }
                        }
                        if supported {
                            self.recognized
                                .insert(value.as_ref() as *const Expr as usize);
                            let stage = self.stages.len();
                            self.stages.push(Stage {
                                awaited: value,
                                resume: Resume::ReturnValueFinally {
                                    local_id,
                                    result,
                                    finally,
                                },
                                live,
                                next: Segment {
                                    prefix: Vec::new(),
                                    handler,
                                    terminal: Terminal::Complete,
                                },
                            });
                            return Some(Segment {
                                prefix,
                                handler,
                                terminal: Terminal::ProtectedFinally {
                                    before: before.iter().collect(),
                                    stage,
                                    finally,
                                },
                            });
                        }
                    }
                }
            }
            let suspension = match stmt {
                Stmt::Return {
                    value: Some(Expr::Await { value, .. }),
                    ..
                } => Some((value.as_ref(), Resume::Return)),
                Stmt::VarDecl {
                    local_id,
                    init: Expr::Await { value, .. },
                    ..
                } => Some((value.as_ref(), Resume::Declare(local_id.as_str()))),
                Stmt::Assign {
                    local_id,
                    value: Expr::Await { value, .. },
                    initializes_global: false,
                    ..
                } if initialized.iter().any(|local| local.id == *local_id) => {
                    Some((value.as_ref(), Resume::Assign(local_id.as_str())))
                }
                Stmt::Assign {
                    local_id,
                    value:
                        Expr::UnionWrap {
                            tag,
                            value,
                            r#type: Type::Union { union_id },
                            ..
                        },
                    initializes_global: false,
                    ..
                } if initialized.iter().any(|local| local.id == *local_id)
                    && matches!(value.as_ref(), Expr::Await { .. }) =>
                {
                    let Expr::Await {
                        value: awaited,
                        r#type: value_type,
                        ..
                    } = value.as_ref()
                    else {
                        return None;
                    };
                    Some((
                        awaited.as_ref(),
                        Resume::AssignUnion {
                            local_id,
                            union_id: *union_id,
                            tag: *tag,
                            value_type: value_type.clone(),
                        },
                    ))
                }
                Stmt::Expression {
                    expr: Expr::Await { value, .. },
                    ..
                } => Some((value.as_ref(), Resume::Ignore)),
                Stmt::RecordSet {
                    obj,
                    field,
                    value: Expr::Await { value, r#type, .. },
                    ..
                } => Some((
                    value.as_ref(),
                    Resume::RecordSet {
                        obj,
                        field,
                        value_type: r#type.clone(),
                    },
                )),
                _ => None,
            };
            if let Some((awaited, resume)) = suspension {
                self.recognized.insert(awaited as *const Expr as usize);
                self.branched_await |= branch_depth != 0;
                let mut after = initialized.clone();
                if let Resume::Declare(id) = &resume {
                    let local = self.local(id)?;
                    after.push(local);
                }
                let next = if matches!(resume, Resume::Return) {
                    Segment {
                        prefix: Vec::new(),
                        handler,
                        terminal: Terminal::Complete,
                    }
                } else {
                    self.build(input, after, branch_depth, handler)?
                };
                let stage = self.stages.len();
                self.stages.push(Stage {
                    awaited,
                    resume,
                    live: initialized,
                    next,
                });
                return Some(Segment {
                    prefix,
                    handler,
                    terminal: Terminal::Suspend(stage),
                });
            }
            match stmt {
                Stmt::VarDecl { local_id, .. } => {
                    initialized.push(self.local(local_id)?);
                    prefix.push(stmt);
                }
                Stmt::Assign {
                    initializes_global: false,
                    ..
                }
                | Stmt::Expression { .. }
                | Stmt::ArraySet { .. }
                | Stmt::BytesSet { .. }
                | Stmt::ArraySetLength { .. }
                | Stmt::FieldSet { .. }
                | Stmt::RecordKeySet { .. }
                | Stmt::RecordSet { .. }
                | Stmt::GeneratorForOf { .. } => prefix.push(stmt),
                Stmt::While { cond, body, .. } => {
                    let may_exit = breaks_target(body, 0);
                    let after = self.build(input, initialized.clone(), branch_depth, handler)?;
                    let index = self.loops.len();
                    self.loops.push(None);
                    let outer = self.current_loop.replace(index);
                    self.break_targets.push(Segment {
                        prefix: Vec::new(),
                        handler,
                        terminal: Terminal::LoopExit(index),
                    });
                    self.fallthrough.push(None);
                    let loop_body = self.build(
                        body.iter().collect(),
                        initialized.clone(),
                        branch_depth + 1,
                        handler,
                    )?;
                    self.fallthrough.pop();
                    self.break_targets.pop();
                    self.current_loop = outer;
                    self.loops[index] = Some(LoopPlan {
                        cond,
                        live: initialized,
                        body: loop_body,
                        after,
                        may_exit,
                    });
                    return Some(Segment {
                        prefix,
                        handler,
                        terminal: Terminal::Loop(index),
                    });
                }
                Stmt::Continue {
                    target_depth: 0, ..
                } => {
                    return Some(Segment {
                        prefix,
                        handler,
                        terminal: Terminal::Loop(self.current_loop?),
                    });
                }
                Stmt::Break { target_depth, .. } => {
                    let target = self
                        .break_targets
                        .get(self.break_targets.len().checked_sub(target_depth + 1)?)?
                        .clone();
                    return Some(Segment {
                        prefix,
                        handler,
                        terminal: Terminal::Enter(Box::new(target)),
                    });
                }
                Stmt::Switch { disc, cases, .. }
                    if cases.iter().any(|case| case.test.is_none())
                        && cases.iter().all(|case| {
                            matches!(
                                case.body.last(),
                                Some(Stmt::Return { .. } | Stmt::Throw { .. })
                            )
                        }) =>
                {
                    let mut branches = Vec::new();
                    for case in cases {
                        let body = self.build(
                            case.body.iter().collect(),
                            initialized.clone(),
                            branch_depth + 1,
                            handler,
                        )?;
                        branches.push((case.test.as_ref(), body));
                    }
                    return Some(Segment {
                        prefix,
                        handler,
                        terminal: Terminal::Switch {
                            disc,
                            cases: branches,
                        },
                    });
                }
                Stmt::Switch { disc, cases, .. }
                    if cases.iter().any(|case| case.test.is_none())
                        && cases
                            .iter()
                            .any(|case| case.body.iter().any(generators::statement_has_await)) =>
                {
                    // A switch is both a branch and a break target. Build the
                    // cases backwards so normal completion of one case enters
                    // the next case (JavaScript fallthrough), while an
                    // explicit break enters the single post-switch segment.
                    let after = self.build(input, initialized.clone(), branch_depth, handler)?;
                    self.break_targets.push(after.clone());
                    let mut next_case = after;
                    let mut branches = Vec::with_capacity(cases.len());
                    for case in cases.iter().rev() {
                        self.fallthrough.push(Some(Box::new(next_case.clone())));
                        let branch = self.build(
                            case.body.iter().collect(),
                            initialized.clone(),
                            branch_depth + 1,
                            handler,
                        )?;
                        self.fallthrough.pop();
                        next_case = branch.clone();
                        branches.push((case.test.as_ref(), branch));
                    }
                    self.break_targets.pop();
                    branches.reverse();
                    return Some(Segment {
                        prefix,
                        handler,
                        terminal: Terminal::Switch {
                            disc,
                            cases: branches,
                        },
                    });
                }
                Stmt::Switch { .. } => prefix.push(stmt),
                Stmt::Block { body, .. } => {
                    let mut expanded = body.iter().collect::<Vec<_>>();
                    expanded.extend(input);
                    let mut nested = self.build(expanded, initialized, branch_depth, handler)?;
                    prefix.append(&mut nested.prefix);
                    return Some(Segment {
                        prefix,
                        handler,
                        terminal: nested.terminal,
                    });
                }
                Stmt::If {
                    cond, then, else_, ..
                } => {
                    // Plan the post-branch continuation once. Rebuilding it
                    // for both arms duplicates every later await stage and
                    // grows exponentially for nested conditions in large
                    // modules. Branch-local declarations cannot escape their
                    // lexical arm, so the shared continuation starts with the
                    // incoming initialization set.
                    let after = self.build(input, initialized.clone(), branch_depth, handler)?;
                    self.fallthrough.push(Some(Box::new(after)));
                    let then = self.build(
                        then.iter().collect(),
                        initialized.clone(),
                        branch_depth + 1,
                        handler,
                    )?;
                    let else_ = self.build(
                        else_
                            .as_ref()
                            .map(|body| body.iter().collect())
                            .unwrap_or_default(),
                        initialized,
                        branch_depth + 1,
                        handler,
                    )?;
                    self.fallthrough.pop();
                    return Some(Segment {
                        prefix,
                        handler,
                        terminal: Terminal::Branch {
                            cond,
                            then: Box::new(then),
                            else_: Box::new(else_),
                        },
                    });
                }
                Stmt::TryCatch {
                    try_body,
                    catch_body: Some(catch_body),
                    catch_local_id,
                    finally_body: None,
                    ..
                } => {
                    // A catch only protects the lexical try body. Build the
                    // following statements once with the outer handler, then
                    // make normal completion of either arm cross that handler
                    // boundary explicitly. Appending `input` to `try_body`
                    // would incorrectly let this catch observe throws from
                    // every later continuation in the function.
                    let after = self.build(input, initialized.clone(), branch_depth, handler)?;
                    let mut catch_initialized = initialized.clone();
                    if let Some(catch_local_id) = catch_local_id {
                        catch_initialized.push(self.local(catch_local_id)?);
                    }
                    self.fallthrough.push(Some(Box::new(after.clone())));
                    let catch = self.build(
                        catch_body.iter().collect(),
                        catch_initialized,
                        branch_depth + 1,
                        handler,
                    )?;
                    let catch_index = self.handlers.len();
                    self.handlers.push(Handler {
                        catch_local: catch_local_id.as_deref(),
                        live: initialized.clone(),
                        body: catch,
                    });

                    let protected = self.build(
                        try_body.iter().collect(),
                        initialized,
                        branch_depth + 1,
                        Some(catch_index),
                    )?;
                    self.fallthrough.pop();
                    return Some(Segment {
                        prefix,
                        handler,
                        terminal: Terminal::Enter(Box::new(protected)),
                    });
                }
                Stmt::Return { value, .. } => {
                    return Some(Segment {
                        prefix,
                        handler,
                        terminal: Terminal::Return(value.as_ref()),
                    });
                }
                Stmt::Throw { value, .. } => {
                    return Some(Segment {
                        prefix,
                        handler,
                        terminal: Terminal::Throw(value),
                    });
                }
                _ => return None,
            }
        }
        let terminal = if let Some(Some(next)) = self.fallthrough.last() {
            Terminal::ExitHandler(next.clone())
        } else {
            self.current_loop.map_or(Terminal::Complete, Terminal::Loop)
        };
        Some(Segment {
            prefix,
            handler,
            terminal,
        })
    }
}

fn discardable_sequence_result(expr: &Expr) -> bool {
    matches!(
        expr,
        Expr::VarRef { .. }
            | Expr::NumLit { .. }
            | Expr::StrLit { .. }
            | Expr::BoolLit { .. }
            | Expr::UnitLit { .. }
    )
}

fn synchronous_finally(body: &[Stmt]) -> bool {
    body.iter().all(|stmt| match stmt {
        Stmt::Expression { .. }
        | Stmt::Assign { .. }
        | Stmt::FieldSet { .. }
        | Stmt::RecordSet { .. }
        | Stmt::RecordKeySet { .. } => true,
        Stmt::Block { body, .. } => synchronous_finally(body),
        Stmt::If { then, else_, .. } => {
            synchronous_finally(then) && else_.as_ref().is_none_or(|body| synchronous_finally(body))
        }
        _ => false,
    })
}

fn call_ternary_awaits<'a>(
    args: &'a [Expr],
) -> Option<(
    usize,
    &'a Expr,
    (&'a Expr, Type, bool),
    (&'a Expr, Type, bool),
)> {
    args.iter().enumerate().find_map(|(index, arg)| {
        let Expr::Ternary {
            cond, then, else_, ..
        } = arg
        else {
            return None;
        };
        let (then_source, then_type, then_box_to_dyn) = projected_await(then)?;
        let (else_source, else_type, else_box_to_dyn) = projected_await(else_)?;
        Some((
            index,
            cond.as_ref(),
            (then_source, then_type, then_box_to_dyn),
            (else_source, else_type, else_box_to_dyn),
        ))
    })
}

fn projected_await(expr: &Expr) -> Option<(&Expr, Type, bool)> {
    match expr {
        Expr::Await { value, r#type, .. } => Some((value.as_ref(), r#type.clone(), false)),
        Expr::DynFrom { value, .. } => {
            let Expr::Await {
                value: source,
                r#type,
                ..
            } = value.as_ref()
            else {
                return None;
            };
            Some((source.as_ref(), r#type.clone(), true))
        }
        _ => None,
    }
}

fn valid_completion(segment: &Segment<'_>, returns_void: bool) -> bool {
    match &segment.terminal {
        Terminal::Loop(_) | Terminal::LoopExit(_) => true,
        Terminal::Return(value) => returns_void == value.is_none(),
        Terminal::Throw(_) => true,
        Terminal::Complete => returns_void,
        Terminal::Branch { then, else_, .. } => {
            valid_completion(then, returns_void) && valid_completion(else_, returns_void)
        }
        Terminal::Switch { cases, .. } => cases
            .iter()
            .all(|(_, body)| valid_completion(body, returns_void)),
        Terminal::Enter(body) => valid_completion(body, returns_void),
        Terminal::ExitHandler(body) => valid_completion(body, returns_void),
        Terminal::RecordSetAwaitChoice { else_next, .. } => {
            valid_completion(else_next, returns_void)
        }
        Terminal::AwaitChoice { .. } => true,
        Terminal::ProtectedFinally { .. } => true,
        Terminal::Suspend(_) => true,
    }
}

pub(super) fn plan(function: &Function) -> Option<Plan<'_>> {
    if !function.is_async || function.generator.is_some() {
        return None;
    }
    let mut initialized = Vec::new();
    for id in function
        .params
        .iter()
        .map(|param| param.local_id.as_str())
        .chain(
            function
                .captures
                .iter()
                .flatten()
                .map(|capture| capture.local_id.as_str()),
        )
    {
        let local = function.locals.iter().find(|local| local.id == id)?;
        if !initialized
            .iter()
            .any(|existing: &&crate::ir::Local| existing.id == local.id)
        {
            initialized.push(local);
        }
    }
    let mut builder = Builder {
        function,
        stages: Vec::new(),
        handlers: Vec::new(),
        recognized: std::collections::HashSet::new(),
        branched_await: false,
        loops: Vec::new(),
        current_loop: None,
        break_targets: Vec::new(),
        fallthrough: Vec::new(),
    };
    let entry = builder.build(function.body.iter().collect(), initialized, 0, None)?;
    let mut actual = 0;
    function
        .visit_expressions(&mut |expr| actual += usize::from(matches!(expr, Expr::Await { .. })));
    let returns_void = matches!(function.return_type, Type::Void | Type::Undefined);
    let recognized = builder.recognized.len();
    let handlers_complete = builder
        .handlers
        .iter()
        .all(|handler| valid_completion(&handler.body, returns_void));
    let loops_complete = builder.loops.iter().all(|entry| {
        entry.as_ref().is_some_and(|entry| {
            valid_completion(&entry.body, returns_void)
                && (matches!(entry.cond, Expr::BoolLit { value: true, .. }) && !entry.may_exit
                    || valid_completion(&entry.after, returns_void))
        })
    });
    (recognized == actual
        && actual != 0
        && valid_completion(&entry, returns_void)
        && handlers_complete
        && loops_complete)
        .then_some(Plan {
            entry,
            stages: builder.stages,
            handlers: builder.handlers,
            loops: builder.loops.into_iter().collect::<Option<Vec<_>>>()?,
            awaits: recognized,
        })
}

pub(super) fn count(plan: &Plan<'_>) -> usize {
    plan.awaits
}

fn complete(value: Option<&Expr>, function: &Function, module: &Emission<'_>, output: &mut String) {
    if let Some(value) = value {
        let value = expr(value, function, module);
        let boxed = values::box_value(&function.return_type, "returned", module);
        output.push_str(&format!("let returned = {value}; let returned = {boxed}; native_promise_plain(&returned); let _ = runtime::promise_fulfill(&target, returned);"));
    } else {
        output.push_str("let returned = NativeValue::Undefined; native_promise_plain(&returned); let _ = runtime::promise_fulfill(&target, returned);");
    }
}

fn record_set(
    obj: &Expr,
    field: &str,
    value_type: &Type,
    value: &str,
    function: &Function,
    module: &Emission<'_>,
    output: &mut String,
) {
    let Type::Record { shape_id } = obj.ty() else {
        unreachable!("validated async record assignment")
    };
    let object = expr(obj, function, module);
    if record_storage::shared(&module.records[shape_id], module) {
        let boxed = values::box_value(value_type, "value", module);
        output.push_str(&format!(
            "{{ let object = {object}; let value = {value}; native_record_set(&object, {:?}.into(), {boxed}); }}",
            field
        ));
    } else if module.records[shape_id].tuple {
        let index = module.records[shape_id]
            .fields
            .iter()
            .position(|candidate| candidate.name == field)
            .expect("validated tuple field");
        let boxed = values::box_value(value_type, "value.clone()", module);
        output.push_str(&format!(
            "{{ let object = {object}; let value = {value}; if let Some(source) = object.with(|object| object.source.clone()) {{ runtime::array_set(&source, {index}.0, {boxed}); }} else {{ object.with_mut(|object| {{ object.{} = Some(value); if !object.own_keys.iter().any(|key| key == {:?}) {{ object.own_keys.push({:?}.into()); }} }}); }} }}",
            field_name(field), field, field
        ));
    } else {
        output.push_str(&format!(
            "{{ let object = {object}; let value = {value}; object.with_mut(|object| {{ object.{} = Some(value); if !object.own_keys.iter().any(|key| key == {:?}) {{ object.own_keys.push({:?}.into()); }} }}); }}",
            field_name(field), field, field
        ));
    }
}

fn schedule(
    function_index: usize,
    stage_index: usize,
    plan: &Plan<'_>,
    function: &Function,
    module: &Emission<'_>,
    output: &mut String,
) {
    let stage = &plan.stages[stage_index];
    let source = expr(stage.awaited, function, module);
    let captures = stage
        .live
        .iter()
        .enumerate()
        .map(|(index, local)| format!("c{index}: Some({}.clone()),", local.id))
        .collect::<String>();
    let captures = format!("driver: driver.clone(), {captures}");
    if let Resume::ReturnFinally(finally) = &stage.resume {
        output.push_str(&format!("match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {source})) {{ Ok(source) => {{ let frame = runtime::Gc::new(NativeAsyncCfg{function_index}_{stage_index} {{ target: Some(target.clone()), {captures} }}); runtime::promise_then_traced(&source, frame, native_async_cfg_resume_{function_index}_{stage_index}); }}, Err(payload) => {{ let reason = runtime::caught_from_panic(payload);"));
        for stmt in *finally {
            statement(stmt, function, module, output);
        }
        output.push_str("let _ = runtime::promise_reject(&target, reason); } }");
    } else {
        output.push_str(&format!("let source = {source}; let frame = runtime::Gc::new(NativeAsyncCfg{function_index}_{stage_index} {{ target: Some(target.clone()), {captures} }}); runtime::promise_then_traced(&source, frame, native_async_cfg_resume_{function_index}_{stage_index});"));
    }
}

fn handler(
    function_index: usize,
    handler_index: usize,
    reason: &str,
    plan: &Plan<'_>,
    output: &mut String,
) {
    let handler = &plan.handlers[handler_index];
    let args = handler
        .live
        .iter()
        .map(|local| format!(", {}.clone()", local.id))
        .collect::<String>();
    let region = ((function_index as u64) << 16) | handler_index as u64;
    output.push_str(&format!(
        "native_async_bypass({region}, || native_async_handler_{function_index}_{handler_index}(target.clone(), driver.clone(), {reason}{args}));"
    ));
}

fn schedule_loop(function_index: usize, loop_index: usize, plan: &Plan<'_>, output: &mut String) {
    output.push_str("{ let loop_target = target.clone(); let loop_driver = driver.clone();");
    for local in &plan.loops[loop_index].live {
        output.push_str(&format!("let {} = {}.clone();", local.id, local.id));
    }
    let args = plan.loops[loop_index]
        .live
        .iter()
        .map(|local| format!(", {}", local.id))
        .collect::<String>();
    output.push_str(&format!("native_async_dispatch_{function_index}(driver.clone(), Box::new(move || native_async_loop_{function_index}_{loop_index}(loop_target, loop_driver{args}))); }}"));
}

fn segment_raw(
    function_index: usize,
    current: &Segment<'_>,
    plan: &Plan<'_>,
    function: &Function,
    module: &Emission<'_>,
    output: &mut String,
) {
    for stmt in &current.prefix {
        statement(stmt, function, module, output);
    }
    match &current.terminal {
        Terminal::Loop(index) => schedule_loop(function_index, *index, plan, output),
        Terminal::LoopExit(index) => segment(
            function_index,
            &plan.loops[*index].after,
            plan,
            function,
            module,
            output,
        ),
        Terminal::Return(value) => complete(*value, function, module, output),
        Terminal::Throw(value_expr) => {
            let value_type = value_expr.ty();
            let value = expr(value_expr, function, module);
            let boxed = values::box_value(&value_type, &value, module);
            output.push_str(&format!("runtime::throw_value({boxed});"));
        }
        Terminal::Complete => complete(None, function, module, output),
        Terminal::Suspend(stage) => {
            schedule(function_index, *stage, plan, function, module, output)
        }
        Terminal::Enter(body) => segment(function_index, body, plan, function, module, output),
        Terminal::ExitHandler(body) => {
            segment(function_index, body, plan, function, module, output)
        }
        Terminal::ProtectedFinally {
            before,
            stage,
            finally,
        } => {
            output.push_str("match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {");
            for stmt in before {
                statement(stmt, function, module, output);
            }
            schedule(function_index, *stage, plan, function, module, output);
            output.push_str("})) { Ok(()) => {}, Err(payload) => { let reason = runtime::caught_from_panic(payload);");
            for stmt in *finally {
                statement(stmt, function, module, output);
            }
            output.push_str("let _ = runtime::promise_reject(&target, reason); } }");
        }
        Terminal::RecordSetAwaitChoice {
            cond,
            stage,
            obj,
            field,
            else_value,
            else_next,
        } => {
            output.push_str(&format!("if {} {{", expr(cond, function, module)));
            schedule(function_index, *stage, plan, function, module, output);
            output.push_str("} else {");
            let value_type = else_value.ty();
            let value = expr(else_value, function, module);
            record_set(obj, field, &value_type, &value, function, module, output);
            segment(function_index, else_next, plan, function, module, output);
            output.push('}');
        }
        Terminal::AwaitChoice {
            cond,
            then_stage,
            else_stage,
        } => {
            output.push_str(&format!("if {} {{", expr(cond, function, module)));
            schedule(function_index, *then_stage, plan, function, module, output);
            output.push_str("} else {");
            schedule(function_index, *else_stage, plan, function, module, output);
            output.push('}');
        }
        Terminal::Branch { cond, then, else_ } => {
            output.push_str(&format!("if {} {{", expr(cond, function, module)));
            segment(function_index, then, plan, function, module, output);
            output.push_str("} else {");
            segment(function_index, else_, plan, function, module, output);
            output.push('}');
        }
        Terminal::Switch { disc, cases } => {
            output.push_str(&format!(
                "{{ let native_async_disc = {};",
                expr(disc, function, module)
            ));
            let mut first = true;
            for (test, branch) in cases.iter().filter(|(test, _)| test.is_some()) {
                let test = test.expect("filtered switch test");
                output.push_str(if first { "if " } else { " else if " });
                first = false;
                output.push_str(&format!(
                    "native_async_disc == {} {{",
                    expr(test, function, module)
                ));
                segment(function_index, branch, plan, function, module, output);
                output.push('}');
            }
            if let Some((_, default)) = cases.iter().find(|(test, _)| test.is_none()) {
                if !first {
                    output.push_str(" else ");
                }
                output.push('{');
                segment(function_index, default, plan, function, module, output);
                output.push('}');
            }
            output.push('}');
        }
    }
}

fn segment(
    function_index: usize,
    current: &Segment<'_>,
    plan: &Plan<'_>,
    function: &Function,
    module: &Emission<'_>,
    output: &mut String,
) {
    if let Terminal::ExitHandler(next) = &current.terminal {
        let Some(handler_index) = current.handler else {
            for stmt in &current.prefix {
                statement(stmt, function, module, output);
            }
            segment(function_index, next, plan, function, module, output);
            return;
        };
        output.push_str(
            "{ let native_async_run = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {",
        );
        for stmt in &current.prefix {
            statement(stmt, function, module, output);
        }
        let region = ((function_index as u64) << 16) | handler_index as u64;
        output.push_str(&format!("}})); match native_async_run {{ Ok(()) => {{ native_async_bypass({region}, || {{"));
        segment(function_index, next, plan, function, module, output);
        output.push_str(&format!("}}); }}, Err(payload) => {{ let payload = native_async_bypass_check(payload, {region}); let reason = runtime::caught_from_panic(payload);"));
        handler(function_index, handler_index, "reason", plan, output);
        output.push_str("} } }");
        return;
    }
    let Some(handler_index) = current.handler else {
        segment_raw(function_index, current, plan, function, module, output);
        return;
    };
    output.push_str(
        "{ let native_async_run = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {",
    );
    segment_raw(function_index, current, plan, function, module, output);
    let region = ((function_index as u64) << 16) | handler_index as u64;
    output.push_str(&format!("}})); if let Err(payload) = native_async_run {{ let payload = native_async_bypass_check(payload, {region}); let reason = runtime::caught_from_panic(payload);"));
    handler(function_index, handler_index, "reason", plan, output);
    output.push_str("} }");
}

pub(super) fn start(
    function_index: usize,
    plan: &Plan<'_>,
    function: &Function,
    module: &Emission<'_>,
    output: &mut String,
) {
    output.push_str(&format!("let driver = std::rc::Rc::new(std::cell::RefCell::new(NativeAsyncDriver{function_index} {{ running: false, queue: std::collections::VecDeque::new() }}));"));
    segment(function_index, &plan.entry, plan, function, module, output);
    output.push_str("}); result\n");
}

fn restore(stage: &Stage<'_>, output: &mut String) {
    for (index, local) in stage.live.iter().enumerate() {
        let mutable = if local.mutable && !local.boxed {
            "mut "
        } else {
            ""
        };
        output.push_str(&format!("let {mutable}{} = frame.with(|frame| frame.c{index}.as_ref().expect(\"scriptc: cleared async capture\").clone());", local.id));
    }
}

fn resume_value(
    stage: &Stage<'_>,
    function: &Function,
    module: &Emission<'_>,
    output: &mut String,
) {
    if let Resume::CallArg {
        callee,
        args,
        index,
        value_type,
        box_to_dyn,
    } = &stage.resume
    {
        let mut checked = values::checked_value(value_type, "value", module);
        if *box_to_dyn {
            checked = values::box_value(value_type, &checked, module);
        }
        let arguments = args
            .iter()
            .enumerate()
            .map(|(argument_index, argument)| {
                if argument_index == *index {
                    checked.clone()
                } else {
                    expr(argument, function, module)
                }
            })
            .collect::<Vec<_>>()
            .join(", ");
        output.push_str(&format!("let _ = {callee}({arguments});"));
        return;
    }
    if let Resume::RecordSet {
        obj,
        field,
        value_type,
    } = &stage.resume
    {
        let checked = values::checked_value(value_type, "value", module);
        record_set(obj, field, value_type, &checked, function, module, output);
        return;
    }
    let id = match &stage.resume {
        Resume::Declare(id) | Resume::Assign(id) => *id,
        Resume::AssignUnion { local_id, .. } => *local_id,
        Resume::ReturnValueFinally { local_id, .. } => *local_id,
        Resume::RecordSet { .. }
        | Resume::CallArg { .. }
        | Resume::Return
        | Resume::ReturnFinally(_)
        | Resume::Ignore => return,
    };
    let local = function
        .locals
        .iter()
        .find(|local| local.id == id)
        .expect("validated async resume local");
    let checked = match &stage.resume {
        Resume::AssignUnion {
            union_id,
            tag,
            value_type,
            ..
        } => {
            let value = values::checked_value(value_type, "value", module);
            format!("U{union_id}::V{tag}({value})")
        }
        _ => values::checked_value(&local.r#type, "value", module),
    };
    match &stage.resume {
        Resume::Declare(_) if local.boxed => {
            output.push_str(&format!("let {id} = native_cell({checked});"));
        }
        Resume::Declare(_) => {
            let mutable = if local.mutable { "mut " } else { "" };
            output.push_str(&format!("let {mutable}{id} = {checked};"));
        }
        Resume::ReturnValueFinally { .. } => {
            let mutable = if local.mutable { "mut " } else { "" };
            if local.boxed {
                output.push_str(&format!("let {id} = native_cell({checked});"));
            } else {
                output.push_str(&format!("let {mutable}{id} = {checked};"));
            }
        }
        Resume::Assign(_) | Resume::AssignUnion { .. } if local.boxed => {
            output.push_str(&format!("native_cell_write(&{id}, {checked});"));
        }
        Resume::Assign(_) | Resume::AssignUnion { .. } => {
            output.push_str(&format!("{id} = {checked};"));
        }
        Resume::RecordSet { .. }
        | Resume::CallArg { .. }
        | Resume::Return
        | Resume::ReturnFinally(_)
        | Resume::Ignore => {}
    }
}

pub(super) fn definitions(
    function_index: usize,
    plan: &Plan<'_>,
    function: &Function,
    module: &Emission<'_>,
    output: &mut String,
) {
    output.push_str(&format!("struct NativeAsyncDriver{function_index} {{ running: bool, queue: std::collections::VecDeque<Box<dyn FnOnce()>> }}\nfn native_async_dispatch_{function_index}(driver: std::rc::Rc<std::cell::RefCell<NativeAsyncDriver{function_index}>>, job: Box<dyn FnOnce()>) {{ {{ let mut state = driver.borrow_mut(); state.queue.push_back(job); if state.running {{ return; }} state.running = true; }} loop {{ let job = driver.borrow_mut().queue.pop_front(); match job {{ Some(job) => job(), None => break }} }} driver.borrow_mut().running = false; }}\n"));
    // Catch continuations are shared control-flow nodes. Emitting their body at
    // every protected segment duplicates the complete post-catch continuation
    // (and, for loops, can grow generated Rust exponentially). Give each catch
    // one native function and pass the live lexical environment explicitly.
    for (handler_index, handler_plan) in plan.handlers.iter().enumerate() {
        let params = handler_plan
            .live
            .iter()
            .map(|local| {
                let ty = rust_type(local.r#type.clone(), module);
                let ty = if local.boxed {
                    format!("runtime::Gc<NativeCell<{ty}>>")
                } else {
                    ty
                };
                let mutable = if local.mutable && !local.boxed {
                    "mut "
                } else {
                    ""
                };
                format!(", {mutable}{}: {ty}", local.id)
            })
            .collect::<String>();
        output.push_str(&format!("fn native_async_handler_{function_index}_{handler_index}(target: runtime::JsPromise<NativeValue>, driver: std::rc::Rc<std::cell::RefCell<NativeAsyncDriver{function_index}>>, reason: runtime::Caught{params}) {{"));
        let boxed = function
            .locals
            .iter()
            .any(|local| Some(local.id.as_str()) == handler_plan.catch_local && local.boxed);
        let value = if boxed {
            "native_cell(native_caught(reason))"
        } else {
            "native_caught(reason)"
        };
        if let Some(local) = handler_plan.catch_local {
            output.push_str(&format!("let {local} = {value};"));
        } else {
            output.push_str("drop(reason);");
        }
        segment(
            function_index,
            &handler_plan.body,
            plan,
            function,
            module,
            output,
        );
        output.push_str("}\n");
    }
    for (loop_index, loop_plan) in plan.loops.iter().enumerate() {
        let params = loop_plan
            .live
            .iter()
            .map(|local| {
                let ty = rust_type(local.r#type.clone(), module);
                let ty = if local.boxed {
                    format!("runtime::Gc<NativeCell<{ty}>>")
                } else {
                    ty
                };
                let mutable = if local.mutable && !local.boxed {
                    "mut "
                } else {
                    ""
                };
                format!(", {mutable}{}: {ty}", local.id)
            })
            .collect::<String>();
        output.push_str(&format!("fn native_async_loop_{function_index}_{loop_index}(target: runtime::JsPromise<NativeValue>, driver: std::rc::Rc<std::cell::RefCell<NativeAsyncDriver{function_index}>>{params}) {{ let guard = target.clone(); native_async_segment(&guard, move || {{ if {} {{", expr(loop_plan.cond, function, module)));
        segment(
            function_index,
            &loop_plan.body,
            plan,
            function,
            module,
            output,
        );
        output.push_str("} else {");
        segment(
            function_index,
            &loop_plan.after,
            plan,
            function,
            module,
            output,
        );
        output.push_str("} }); }\n");
    }
    for (stage_index, stage) in plan.stages.iter().enumerate() {
        let name = format!("NativeAsyncCfg{function_index}_{stage_index}");
        output.push_str(&format!("struct {name} {{ driver: std::rc::Rc<std::cell::RefCell<NativeAsyncDriver{function_index}>>, target: Option<runtime::JsPromise<NativeValue>>,"));
        for (index, local) in stage.live.iter().enumerate() {
            let ty = rust_type(local.r#type.clone(), module);
            let ty = if local.boxed {
                format!("runtime::Gc<NativeCell<{ty}>>")
            } else {
                ty
            };
            output.push_str(&format!("c{index}: Option<{ty}>,"));
        }
        output.push_str(&format!("}} impl runtime::Trace for {name} {{ fn trace(&self, tracer: &mut runtime::Tracer<'_>) {{ if let Some(value) = &self.target {{ value.trace_native(tracer); }}"));
        for index in 0..stage.live.len() {
            output.push_str(&format!(
                "if let Some(value) = &self.c{index} {{ value.trace_native(tracer); }}"
            ));
        }
        output.push_str(&format!("}} }} impl runtime::ClearEdges for {name} {{ fn clear_edges(&mut self) {{ self.target = None;"));
        for index in 0..stage.live.len() {
            output.push_str(&format!("self.c{index} = None;"));
        }
        output.push_str("} }\n");
        output.push_str(&format!("fn native_async_cfg_resume_{function_index}_{stage_index}(frame: runtime::Gc<{name}>, outcome: Result<NativeValue, runtime::Caught>) {{ let target = frame.with(|frame| frame.target.as_ref().expect(\"scriptc: cleared async target\").clone());"));
        restore(stage, output);
        output.push_str("let driver = frame.with(|frame| frame.driver.clone());");
        output.push_str("let guard = target.clone(); native_async_segment(&guard, move || match outcome { Err(reason) => {");
        if let Resume::ReturnFinally(finally) = &stage.resume {
            for stmt in *finally {
                statement(stmt, function, module, output);
            }
        }
        if let Resume::ReturnValueFinally { finally, .. } = &stage.resume {
            for stmt in *finally {
                statement(stmt, function, module, output);
            }
        }
        if let Some(handler_index) = stage.next.handler {
            handler(function_index, handler_index, "reason", plan, output);
        } else {
            output.push_str("let _ = runtime::promise_reject(&target, reason);");
        }
        output.push_str("}, Ok(value) => {");
        if let Resume::ReturnValueFinally {
            result, finally, ..
        } = &stage.resume
        {
            output.push_str(
                "let pending = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {",
            );
            resume_value(stage, function, module, output);
            let result_expr = expr(result, function, module);
            let boxed = values::box_value(&function.return_type, "returned", module);
            output.push_str(&format!("let returned = {result_expr}; {boxed} }}));"));
            for stmt in *finally {
                statement(stmt, function, module, output);
            }
            output.push_str("match pending { Ok(returned) => { native_promise_plain(&returned); let _ = runtime::promise_fulfill(&target, returned); }, Err(payload) => { let reason = runtime::caught_from_panic(payload); let _ = runtime::promise_reject(&target, reason); } }");
        } else if matches!(stage.resume, Resume::Return | Resume::ReturnFinally(_)) {
            if let Resume::ReturnFinally(finally) = &stage.resume {
                for stmt in *finally {
                    statement(stmt, function, module, output);
                }
            }
            if !matches!(function.return_type, Type::Void | Type::Undefined) {
                let checked = values::checked_value(&function.return_type, "value.clone()", module);
                output.push_str(&format!("let _ = {checked};"));
            }
            output.push_str("let _ = runtime::promise_fulfill(&target, value);");
        } else if let Some(handler_index) = stage.next.handler {
            output.push_str(
                "let native_async_run = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {",
            );
            resume_value(stage, function, module, output);
            segment_raw(function_index, &stage.next, plan, function, module, output);
            let region = ((function_index as u64) << 16) | handler_index as u64;
            output.push_str(&format!("}})); if let Err(payload) = native_async_run {{ let payload = native_async_bypass_check(payload, {region}); let reason = runtime::caught_from_panic(payload);"));
            handler(function_index, handler_index, "reason", plan, output);
            output.push('}');
        } else {
            resume_value(stage, function, module, output);
            segment(function_index, &stage.next, plan, function, module, output);
        }
        output.push_str("} }); }\n");
    }
}
