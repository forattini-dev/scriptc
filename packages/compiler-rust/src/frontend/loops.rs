//! Source loops invalidate back-edge facts and retain lexical body scopes.
use super::*;

impl Lowerer<'_> {
    pub(super) fn while_statement(&mut self, node: Node) -> Result<Vec<Stmt>, String> {
        let bindings = self.bindings.clone();
        // The body can change a deferred value before the next condition.
        // Do not reuse first-entry or final-iteration narrowing as a loop fact.
        self.var_defined.clear();
        let value = self.condition_value(node.expression())?;
        let cond = self.condition(value, node.expression())?;
        if let Some(symbols) = self.guarded_vars(node.expression(), true) {
            self.var_defined.extend(symbols);
        }
        let body = self.statement(node.statement())?;
        self.bindings = bindings;
        self.var_defined.clear();
        Ok(vec![Stmt::While {
            cond,
            body,
            loc: self.loc(node),
        }])
    }

    pub(super) fn loop_jump(&self, node: Node) -> Result<Stmt, String> {
        if !node.label().is_nil() {
            return Err(self.refuse(node, "labeled loop jumps are not ported"));
        }
        let mut parent = node.parent();
        while !parent.is_nil() {
            match parent.kind() {
                SyntaxKind::WhileStatement => {
                    return Ok(if node.kind() == SyntaxKind::BreakStatement {
                        Stmt::Break {
                            loc: self.loc(node),
                        }
                    } else {
                        Stmt::Continue {
                            loc: self.loc(node),
                        }
                    });
                }
                SyntaxKind::FunctionDeclaration
                | SyntaxKind::FunctionExpression
                | SyntaxKind::ArrowFunction
                | SyntaxKind::MethodDeclaration
                | SyntaxKind::Constructor
                | SyntaxKind::GetAccessor
                | SyntaxKind::SetAccessor
                | SyntaxKind::SourceFile
                | SyntaxKind::SwitchStatement
                | SyntaxKind::ForStatement
                | SyntaxKind::ForOfStatement
                | SyntaxKind::ForInStatement
                | SyntaxKind::DoStatement => break,
                _ => parent = parent.parent(),
            }
        }
        Err(self.refuse(node, "loop jump has no enclosing represented while loop"))
    }
}
