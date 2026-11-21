//! Conservative IR cleanup before Rust inventory and emission.
use super::*;
use std::collections::HashSet;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct DeadLocalStats {
    pub locals: usize,
    pub declarations: usize,
    pub assignments: usize,
    pub preserved_effects: usize,
}

fn disposable(value: &Expr) -> bool {
    matches!(
        value,
        Expr::UnitLit { .. }
            | Expr::NumLit { .. }
            | Expr::StrLit { .. }
            | Expr::BoolLit { .. }
            | Expr::VarRef { .. }
    )
}

fn protect_statement_bindings(body: &[Stmt], protected: &mut HashSet<String>) {
    for statement in body {
        match statement {
            Stmt::GeneratorForOf { local_id, body, .. } => {
                protected.insert(local_id.clone());
                protect_statement_bindings(body, protected);
            }
            Stmt::TryCatch {
                try_body,
                catch_body,
                catch_local_id,
                finally_body,
                ..
            } => {
                protected.extend(catch_local_id.iter().cloned());
                protect_statement_bindings(try_body, protected);
                for body in [catch_body, finally_body].into_iter().flatten() {
                    protect_statement_bindings(body, protected);
                }
            }
            Stmt::Switch { cases, .. } => {
                for case in cases {
                    protect_statement_bindings(&case.body, protected);
                }
            }
            Stmt::While { body, .. } | Stmt::Block { body, .. } => {
                protect_statement_bindings(body, protected)
            }
            Stmt::If { then, else_, .. } => {
                protect_statement_bindings(then, protected);
                if let Some(body) = else_ {
                    protect_statement_bindings(body, protected);
                }
            }
            _ => {}
        }
    }
}

fn sequence_bindings(body: &[Stmt], protected: &mut HashSet<String>) {
    for statement in body {
        match statement {
            Stmt::VarDecl { local_id, .. }
            | Stmt::Assign {
                local_id,
                initializes_global: false,
                ..
            } => {
                protected.insert(local_id.clone());
            }
            Stmt::GeneratorForOf { local_id, body, .. } => {
                protected.insert(local_id.clone());
                sequence_bindings(body, protected);
            }
            Stmt::TryCatch {
                try_body,
                catch_body,
                catch_local_id,
                finally_body,
                ..
            } => {
                protected.extend(catch_local_id.iter().cloned());
                sequence_bindings(try_body, protected);
                for body in [catch_body, finally_body].into_iter().flatten() {
                    sequence_bindings(body, protected);
                }
            }
            Stmt::Switch { cases, .. } => {
                for case in cases {
                    sequence_bindings(&case.body, protected);
                }
            }
            Stmt::While { body, .. } | Stmt::Block { body, .. } => {
                sequence_bindings(body, protected)
            }
            Stmt::If { then, else_, .. } => {
                sequence_bindings(then, protected);
                if let Some(body) = else_ {
                    sequence_bindings(body, protected);
                }
            }
            _ => {}
        }
    }
}

fn read_locals(function: &Function) -> HashSet<String> {
    let mut read = HashSet::new();
    function.visit_expressions(&mut |value| match value {
        Expr::VarRef { local_id, .. } => {
            read.insert(local_id.clone());
        }
        Expr::Closure { captures, .. } => read.extend(captures.iter().cloned()),
        _ => {}
    });
    read
}

fn protected_locals(function: &Function) -> HashSet<String> {
    let mut protected = function
        .params
        .iter()
        .chain(function.captures.iter().flatten())
        .map(|parameter| parameter.local_id.clone())
        .collect::<HashSet<_>>();
    protect_statement_bindings(&function.body, &mut protected);
    // Sequence expressions own nested lexical statements. Keep their targets
    // until the mutable expression walker can optimize those bodies directly.
    function.visit_expressions(&mut |value| {
        if let Expr::Sequence { stmts, .. } = value {
            sequence_bindings(stmts, &mut protected);
        }
    });
    protected
}

fn rewrite_body(body: Vec<Stmt>, dead: &HashSet<String>, stats: &mut DeadLocalStats) -> Vec<Stmt> {
    let mut result = Vec::with_capacity(body.len());
    for mut statement in body {
        match statement {
            Stmt::VarDecl {
                local_id,
                init,
                loc,
            } if dead.contains(&local_id) => {
                stats.declarations += 1;
                if !disposable(&init) {
                    stats.preserved_effects += 1;
                    result.push(Stmt::Expression { expr: init, loc });
                }
            }
            Stmt::Assign {
                local_id,
                value,
                initializes_global: false,
                loc,
            } if dead.contains(&local_id) => {
                stats.assignments += 1;
                if !disposable(&value) {
                    stats.preserved_effects += 1;
                    result.push(Stmt::Expression { expr: value, loc });
                }
            }
            Stmt::GeneratorForOf { ref mut body, .. }
            | Stmt::While { ref mut body, .. }
            | Stmt::Block { ref mut body, .. } => {
                *body = rewrite_body(std::mem::take(body), dead, stats);
                result.push(statement);
            }
            Stmt::Switch { ref mut cases, .. } => {
                for case in cases {
                    case.body = rewrite_body(std::mem::take(&mut case.body), dead, stats);
                }
                result.push(statement);
            }
            Stmt::TryCatch {
                ref mut try_body,
                ref mut catch_body,
                ref mut finally_body,
                ..
            } => {
                *try_body = rewrite_body(std::mem::take(try_body), dead, stats);
                if let Some(body) = catch_body {
                    *body = rewrite_body(std::mem::take(body), dead, stats);
                }
                if let Some(body) = finally_body {
                    *body = rewrite_body(std::mem::take(body), dead, stats);
                }
                result.push(statement);
            }
            Stmt::If {
                ref mut then,
                ref mut else_,
                ..
            } => {
                *then = rewrite_body(std::mem::take(then), dead, stats);
                if let Some(body) = else_ {
                    *body = rewrite_body(std::mem::take(body), dead, stats);
                }
                result.push(statement);
            }
            _ => result.push(statement),
        }
    }
    result
}

fn eliminate_function(function: &mut Function) -> DeadLocalStats {
    let mut total = DeadLocalStats::default();
    loop {
        let read = read_locals(function);
        let protected = protected_locals(function);
        let dead = function
            .locals
            .iter()
            .filter(|local| !read.contains(&local.id) && !protected.contains(&local.id))
            .map(|local| local.id.clone())
            .collect::<HashSet<_>>();
        if dead.is_empty() {
            break;
        }
        total.locals += dead.len();
        function.body = rewrite_body(std::mem::take(&mut function.body), &dead, &mut total);
        function.locals.retain(|local| !dead.contains(&local.id));
    }
    total
}

pub(crate) fn eliminate_dead_locals(module: &mut Module) -> DeadLocalStats {
    let mut total = DeadLocalStats::default();
    for function in &mut module.functions {
        let stats = eliminate_function(function);
        total.locals += stats.locals;
        total.declarations += stats.declarations;
        total.assignments += stats.assignments;
        total.preserved_effects += stats.preserved_effects;
    }
    total
}

#[cfg(test)]
mod tests {
    use super::*;

    fn loc() -> Loc {
        Loc {
            file: "dead-local.ts".into(),
            start: 0,
            end: 1,
        }
    }

    fn local(id: &str) -> Local {
        Local {
            id: id.into(),
            name: id.into(),
            r#type: Type::F64,
            mutable: true,
            boxed: false,
        }
    }

    fn function(locals: Vec<Local>, body: Vec<Stmt>) -> Function {
        Function {
            is_async: false,
            generator: None,
            rest: false,
            name: "f".into(),
            params: vec![],
            captures: None,
            return_type: Type::Void,
            locals,
            body,
            loc: loc(),
        }
    }

    fn number(value: f64) -> Expr {
        Expr::NumLit {
            value,
            spelling: None,
            r#type: Type::F64,
            loc: loc(),
        }
    }

    #[test]
    fn removes_cascading_unused_literal_bindings() {
        let mut function = function(
            vec![local("a"), local("b")],
            vec![
                Stmt::VarDecl {
                    local_id: "a".into(),
                    init: number(1.0),
                    loc: loc(),
                },
                Stmt::VarDecl {
                    local_id: "b".into(),
                    init: Expr::VarRef {
                        local_id: "a".into(),
                        r#type: Type::F64,
                        loc: loc(),
                    },
                    loc: loc(),
                },
            ],
        );
        let stats = eliminate_function(&mut function);
        assert!(function.locals.is_empty());
        assert!(function.body.is_empty());
        assert_eq!(stats.locals, 2);
        assert_eq!(stats.declarations, 2);
    }

    #[test]
    fn preserves_an_effectful_initializer_without_its_dead_storage() {
        let mut function = function(
            vec![local("unused")],
            vec![Stmt::VarDecl {
                local_id: "unused".into(),
                init: Expr::Call {
                    callee: "effect".into(),
                    args: vec![],
                    r#type: Type::F64,
                    loc: loc(),
                },
                loc: loc(),
            }],
        );
        let stats = eliminate_function(&mut function);
        assert!(function.locals.is_empty());
        assert!(matches!(
            function.body.as_slice(),
            [Stmt::Expression { .. }]
        ));
        assert_eq!(stats.preserved_effects, 1);
    }

    #[test]
    fn parameters_and_closure_captures_remain_live() {
        let mut function = function(vec![local("p"), local("captured")], vec![]);
        function.params.push(Param {
            local_id: "p".into(),
            name: "p".into(),
            r#type: Type::F64,
        });
        function.body.push(Stmt::Expression {
            expr: Expr::Closure {
                fn_name: "nested".into(),
                captures: vec!["captured".into()],
                r#type: Type::Func {
                    params: vec![],
                    ret: Box::new(Type::Void),
                    rest: false,
                },
                loc: loc(),
            },
            loc: loc(),
        });
        assert_eq!(eliminate_function(&mut function), DeadLocalStats::default());
        assert_eq!(function.locals.len(), 2);
    }
}
