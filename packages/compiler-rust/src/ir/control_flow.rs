//! Possible completions distinguish function exits from loop-local jumps.
use super::*;

const NORMAL: u8 = 1;
const RETURN: u8 = 2;
const THROW: u8 = 4;
const BREAK: u8 = 8;
const CONTINUE: u8 = 16;

pub(super) fn validate_targets(body: &[Stmt], depth: usize) -> Result<(), String> {
    for stmt in body {
        match stmt {
            Stmt::Break { .. } | Stmt::Continue { .. } if depth == 0 => {
                return Err("loop jump has no enclosing loop".into());
            }
            Stmt::While { body, .. } => validate_targets(body, depth + 1)?,
            Stmt::Block { body, .. } => validate_targets(body, depth)?,
            Stmt::If { then, else_, .. } => {
                validate_targets(then, depth)?;
                if let Some(body) = else_ {
                    validate_targets(body, depth)?;
                }
            }
            Stmt::TryCatch {
                try_body,
                catch_body,
                finally_body,
                ..
            } => {
                validate_targets(try_body, depth)?;
                for body in [catch_body, finally_body].into_iter().flatten() {
                    validate_targets(body, depth)?;
                }
            }
            _ => {}
        }
    }
    Ok(())
}

fn completions(body: &[Stmt]) -> u8 {
    let mut result = NORMAL;
    for stmt in body {
        if result & NORMAL == 0 {
            break;
        }
        result = (result & !NORMAL) | completion(stmt);
    }
    result
}

fn completion(stmt: &Stmt) -> u8 {
    match stmt {
        Stmt::Return { .. } => RETURN | THROW,
        Stmt::Throw { .. } => THROW,
        Stmt::Break { .. } => BREAK,
        Stmt::Continue { .. } => CONTINUE,
        Stmt::Block { body, .. } => completions(body),
        Stmt::If { then, else_, .. } => {
            completions(then) | else_.as_ref().map_or(NORMAL, |b| completions(b)) | THROW
        }
        Stmt::While { cond, body, .. } => {
            let body = completions(body);
            let infinite = matches!(cond, Expr::BoolLit { value: true, .. });
            (body & (RETURN | THROW))
                | if infinite {
                    if body & BREAK != 0 { NORMAL } else { 0 }
                } else {
                    NORMAL | THROW
                }
        }
        Stmt::TryCatch {
            try_body,
            catch_body,
            finally_body,
            ..
        } => {
            let mut pending = completions(try_body);
            if let Some(body) = catch_body
                && pending & THROW != 0
            {
                pending = (pending & !THROW) | completions(body);
            }
            if let Some(body) = finally_body {
                let finalizer = completions(body);
                pending = (finalizer & !NORMAL) | if finalizer & NORMAL != 0 { pending } else { 0 };
            }
            pending
        }
        _ => NORMAL | THROW,
    }
}

pub(super) fn function_exits(body: &[Stmt]) -> bool {
    completions(body) & (NORMAL | BREAK | CONTINUE) == 0
}

#[cfg(test)]
mod tests {
    use super::*;
    fn loc() -> Loc {
        Loc {
            file: "loops.ts".into(),
            start: 0,
            end: 1,
        }
    }
    fn forever(body: Vec<Stmt>) -> Stmt {
        Stmt::While {
            cond: Expr::BoolLit {
                value: true,
                r#type: Type::Bool,
                loc: loc(),
            },
            body,
            loc: loc(),
        }
    }
    #[test]
    fn targets_cannot_escape_their_function() {
        assert!(validate_targets(&[Stmt::Break { loc: loc() }], 0).is_err());
        assert!(validate_targets(&[Stmt::Continue { loc: loc() }], 0).is_err());
        assert!(validate_targets(&[forever(vec![Stmt::Continue { loc: loc() }])], 0).is_ok());
    }
    #[test]
    fn finally_jump_replaces_a_pending_return() {
        let stmt = Stmt::TryCatch {
            try_body: vec![Stmt::Return {
                value: None,
                loc: loc(),
            }],
            catch_body: None,
            catch_local_id: None,
            finally_body: Some(vec![Stmt::Break { loc: loc() }]),
            loc: loc(),
        };
        assert!(!function_exits(&[forever(vec![stmt])]));
    }
    #[test]
    fn inner_break_does_not_exit_an_outer_loop() {
        assert!(function_exits(&[forever(vec![forever(vec![
            Stmt::Break { loc: loc() }
        ])])]));
        assert!(!function_exits(&[forever(vec![Stmt::Break {
            loc: loc()
        }])]));
    }
}
