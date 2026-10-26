//! Source loops invalidate back-edge facts and retain lexical body scopes.
use super::*;

impl Lowerer<'_> {
    pub(super) fn for_statement(&mut self, node: Node) -> Result<Vec<Stmt>, String> {
        let initializer = node.initializer();
        if !initializer.is_nil()
            && initializer.kind() == SyntaxKind::VariableDeclarationList
            && initializer.flags().intersects(NodeFlags::LET)
        {
            let mut names = Vec::new();
            for declaration in initializer.declarations().nodes() {
                bindings::names(declaration.name(), &mut names);
            }
            let symbols = names.into_iter().map(|name| self.symbol(name)).collect();
            if self.captures_for_binding(node, &symbols, false) {
                return Err(self.refuse(
                    node,
                    "captured for-let bindings require per-iteration native cells; not ported",
                ));
            }
        }
        let bindings = self.bindings.clone();
        let mut outer = if initializer.is_nil() {
            Vec::new()
        } else if initializer.kind() == SyntaxKind::VariableDeclarationList {
            self.statement(initializer)?
        } else {
            vec![self.effect_statement(initializer, initializer)?]
        };
        self.var_defined.clear();
        let update = if node.incrementor().is_nil() {
            None
        } else {
            Some(self.effect_statement(node.incrementor(), node.incrementor())?)
        };
        self.var_defined.clear();
        let cond = if node.condition().is_nil() {
            Expr::BoolLit {
                value: true,
                r#type: Type::Bool,
                loc: self.loc(node),
            }
        } else {
            let value = self.condition_value(node.condition())?;
            self.condition(value, node.condition())?
        };
        if !node.condition().is_nil()
            && let Some(symbols) = self.guarded_vars(node.condition(), true)
        {
            self.var_defined.extend(symbols);
        }
        let source_body = self.statement(node.statement())?;
        if let Some(update) = update {
            // Run the update at the next loop entry. This puts it after a
            // continue's finally blocks, and skips it on break/return/throw.
            let first = Local {
                id: format!("for_first{}", self.locals.len()),
                name: "first for iteration".into(),
                r#type: Type::Bool,
                mutable: true,
                boxed: false,
            };
            self.locals.push(first.clone());
            outer.push(Stmt::VarDecl {
                local_id: first.id.clone(),
                init: Expr::BoolLit {
                    value: true,
                    r#type: Type::Bool,
                    loc: self.loc(node),
                },
                loc: self.loc(node),
            });
            let mut body = vec![
                Stmt::If {
                    cond: Expr::VarRef {
                        local_id: first.id.clone(),
                        r#type: Type::Bool,
                        loc: self.loc(node),
                    },
                    then: vec![Stmt::Assign {
                        local_id: first.id,
                        initializes_global: false,
                        value: Expr::BoolLit {
                            value: false,
                            r#type: Type::Bool,
                            loc: self.loc(node),
                        },
                        loc: self.loc(node),
                    }],
                    else_: Some(vec![update]),
                    loc: self.loc(node),
                },
                Stmt::If {
                    cond,
                    then: vec![],
                    else_: Some(vec![Stmt::Break {
                        loc: self.loc(node),
                    }]),
                    loc: self.loc(node),
                },
            ];
            body.extend(source_body);
            outer.push(Stmt::While {
                cond: Expr::BoolLit {
                    value: true,
                    r#type: Type::Bool,
                    loc: self.loc(node),
                },
                body,
                loc: self.loc(node),
            });
        } else {
            outer.push(Stmt::While {
                cond,
                body: source_body,
                loc: self.loc(node),
            });
        }
        self.bindings = bindings;
        self.var_defined.clear();
        Ok(vec![Stmt::Block {
            body: outer,
            loc: self.loc(node),
        }])
    }

    fn captures_for_binding(&mut self, node: Node, symbols: &HashSet<u32>, nested: bool) -> bool {
        let nested = nested
            || matches!(
                node.kind(),
                SyntaxKind::FunctionDeclaration
                    | SyntaxKind::FunctionExpression
                    | SyntaxKind::ArrowFunction
                    | SyntaxKind::MethodDeclaration
                    | SyntaxKind::GetAccessor
                    | SyntaxKind::SetAccessor
                    | SyntaxKind::ClassDeclaration
                    | SyntaxKind::ClassExpression
            );
        if nested && node.kind() == SyntaxKind::Identifier && symbols.contains(&self.symbol(node)) {
            return true;
        }
        let mut found = false;
        node.for_each_child(&mut |child| {
            found |= self.captures_for_binding(child, symbols, nested);
            false
        });
        found
    }

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
                SyntaxKind::WhileStatement
                | SyntaxKind::ForStatement
                | SyntaxKind::ForOfStatement => {
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
                | SyntaxKind::ForInStatement
                | SyntaxKind::DoStatement => break,
                _ => parent = parent.parent(),
            }
        }
        Err(self.refuse(node, "loop jump has no enclosing represented loop"))
    }
}
