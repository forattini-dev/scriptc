//! Source loops invalidate back-edge facts and retain lexical body scopes.
use super::*;

impl Lowerer<'_> {
    pub(super) fn for_statement(&mut self, node: Node) -> Result<Vec<Stmt>, String> {
        let initializer = node.initializer();
        let mut per_iteration_symbols = HashSet::new();
        if !initializer.is_nil()
            && initializer.kind() == SyntaxKind::VariableDeclarationList
            && initializer.flags().intersects(NodeFlags::LET)
        {
            let mut names = Vec::new();
            for declaration in initializer.declarations().nodes() {
                bindings::names(declaration.name(), &mut names);
            }
            let symbols = names
                .into_iter()
                .map(|name| self.symbol(name))
                .collect::<HashSet<_>>();
            per_iteration_symbols.extend(symbols.iter().copied().filter(|symbol| {
                self.captures_for_binding(node.statement(), &HashSet::from([*symbol]), None)
            }));
            let captured_outside_body = [node.condition(), node.incrementor()]
                .into_iter()
                .filter(|part| !part.is_nil())
                .any(|part| self.captures_for_binding(part, &symbols, None));
            if !per_iteration_symbols.is_empty()
                && (captured_outside_body || self.contains_continue(node.statement()))
            {
                return Err(self.refuse(
                    node,
                    "captured for-let bindings in update closures or loops with continue are not ported",
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
        let control_bindings = per_iteration_symbols
            .iter()
            .filter_map(|symbol| {
                self.bindings
                    .get(symbol)
                    .cloned()
                    .map(|local| (*symbol, local))
            })
            .collect::<Vec<_>>();
        // The initializer always executes before the first condition. Retain
        // definitely initialized, uncaptured cells across every loop segment;
        // clearing them here made a hoisted `var i = 0` look undefined inside
        // both the condition and the body even though the back edge can only
        // revisit it after that assignment.
        let initialized = self.immutable_var_facts();
        self.var_defined = initialized.clone();
        let update = if node.incrementor().is_nil() {
            None
        } else {
            Some(self.effect_statement(node.incrementor(), node.incrementor())?)
        };
        self.var_defined = initialized.clone();
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
        let loop_bindings = self.bindings.clone();
        let mut iteration_bindings = Vec::new();
        for (symbol, control) in &control_bindings {
            let iteration = Local {
                id: format!("for_iter{}_{}", self.locals.len(), iteration_bindings.len()),
                name: format!("{} iteration", control.name),
                r#type: control.r#type.clone(),
                mutable: true,
                boxed: true,
            };
            self.locals.push(iteration.clone());
            self.bindings.insert(*symbol, iteration.clone());
            iteration_bindings.push((control.clone(), iteration));
        }
        let mut source_body = self.statement(node.statement())?;
        for (control, iteration) in iteration_bindings.iter().rev() {
            source_body.insert(
                0,
                Stmt::VarDecl {
                    local_id: iteration.id.clone(),
                    init: Expr::VarRef {
                        local_id: control.id.clone(),
                        r#type: control.r#type.clone(),
                        loc: self.loc(node),
                    },
                    loc: self.loc(node),
                },
            );
        }
        for (control, iteration) in &iteration_bindings {
            source_body.push(Stmt::Assign {
                local_id: control.id.clone(),
                initializes_global: false,
                value: Expr::VarRef {
                    local_id: iteration.id.clone(),
                    r#type: iteration.r#type.clone(),
                    loc: self.loc(node),
                },
                loc: self.loc(node),
            });
        }
        self.bindings = loop_bindings;
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
                        target_depth: 0,
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
        self.var_defined = initialized;
        Ok(vec![Stmt::Block {
            body: outer,
            loc: self.loc(node),
        }])
    }

    fn captures_for_binding(
        &mut self,
        node: Node,
        symbols: &HashSet<u32>,
        owner: Option<Node>,
    ) -> bool {
        let owner = if matches!(
            node.kind(),
            SyntaxKind::FunctionDeclaration
                | SyntaxKind::FunctionExpression
                | SyntaxKind::ArrowFunction
                | SyntaxKind::MethodDeclaration
                | SyntaxKind::GetAccessor
                | SyntaxKind::SetAccessor
                | SyntaxKind::ClassDeclaration
                | SyntaxKind::ClassExpression
        ) {
            Some(node)
        } else {
            owner
        };
        if node.kind() == SyntaxKind::Identifier
            && symbols.contains(&self.symbol(node))
            && owner.is_some_and(|function| !self.immediate_array_callback(function))
        {
            return true;
        }
        let mut found = false;
        node.for_each_child(&mut |child| {
            found |= self.captures_for_binding(child, symbols, owner);
            false
        });
        found
    }

    fn contains_continue(&self, node: Node) -> bool {
        if node.kind() == SyntaxKind::ContinueStatement {
            return true;
        }
        if matches!(
            node.kind(),
            SyntaxKind::FunctionDeclaration
                | SyntaxKind::FunctionExpression
                | SyntaxKind::ArrowFunction
                | SyntaxKind::MethodDeclaration
                | SyntaxKind::GetAccessor
                | SyntaxKind::SetAccessor
                | SyntaxKind::ClassDeclaration
                | SyntaxKind::ClassExpression
        ) {
            return false;
        }
        let mut found = false;
        node.for_each_child(&mut |child| {
            found |= self.contains_continue(child);
            false
        });
        found
    }

    /// Typed array callback intrinsics invoke their callback before returning
    /// and never retain it. A closure created at such a call site therefore
    /// cannot observe a later `for (let ...)` iteration, so sharing the loop's
    /// existing boxed cell is observationally equivalent to a fresh one.
    ///
    /// Keep this deliberately narrower than "immediately called": user
    /// functions and dynamic methods may retain a callback even when they also
    /// invoke it synchronously.
    fn immediate_array_callback(&self, function: Node) -> bool {
        let call = function.parent();
        if call.kind() != SyntaxKind::CallExpression {
            return false;
        }
        let member = call.expression();
        member.kind() == SyntaxKind::PropertyAccessExpression
            && matches!(
                member.name().text(),
                "every"
                    | "filter"
                    | "find"
                    | "findIndex"
                    | "flatMap"
                    | "forEach"
                    | "map"
                    | "reduce"
                    | "reduceRight"
                    | "some"
                    | "sort"
            )
    }

    pub(super) fn while_statement(&mut self, node: Node) -> Result<Vec<Stmt>, String> {
        let bindings = self.bindings.clone();
        // The body can change a deferred value before the next condition.
        // Do not reuse first-entry or final-iteration narrowing as a loop fact,
        // but retain definitely initialized uncaptured cells whose source ABI
        // cannot accept undefined.
        let stable_facts = self.immutable_var_facts();
        self.var_defined = stable_facts.clone();
        let value = self.condition_value(node.expression())?;
        let cond = self.condition(value, node.expression())?;
        if let Some(symbols) = self.guarded_vars(node.expression(), true) {
            self.var_defined.extend(symbols);
        }
        let body = self.statement(node.statement())?;
        self.bindings = bindings;
        self.var_defined = stable_facts;
        Ok(vec![Stmt::While {
            cond,
            body,
            loc: self.loc(node),
        }])
    }

    pub(super) fn do_statement(&mut self, node: Node) -> Result<Vec<Stmt>, String> {
        let bindings = self.bindings.clone();
        self.var_defined.clear();
        let value = self.condition_value(node.expression())?;
        let cond = self.condition(value, node.expression())?;
        self.var_defined.clear();
        let source_body = self.statement(node.statement())?;
        let first = Local {
            id: format!("do_first{}", self.locals.len()),
            name: "first do-while iteration".into(),
            r#type: Type::Bool,
            mutable: true,
            boxed: false,
        };
        self.locals.push(first.clone());
        let first_ref = || Expr::VarRef {
            local_id: first.id.clone(),
            r#type: Type::Bool,
            loc: self.loc(node),
        };
        let mut body = vec![Stmt::Assign {
            local_id: first.id.clone(),
            initializes_global: false,
            value: Expr::BoolLit {
                value: false,
                r#type: Type::Bool,
                loc: self.loc(node),
            },
            loc: self.loc(node),
        }];
        body.extend(source_body);
        let result = vec![Stmt::Block {
            body: vec![
                Stmt::VarDecl {
                    local_id: first.id.clone(),
                    init: Expr::BoolLit {
                        value: true,
                        r#type: Type::Bool,
                        loc: self.loc(node),
                    },
                    loc: self.loc(node),
                },
                Stmt::While {
                    cond: Expr::Logical {
                        op: "||".into(),
                        left: Box::new(first_ref()),
                        right: Box::new(cond),
                        r#type: Type::Bool,
                        loc: self.loc(node),
                    },
                    body,
                    loc: self.loc(node),
                },
            ],
            loc: self.loc(node),
        }];
        self.bindings = bindings;
        self.var_defined.clear();
        Ok(result)
    }

    pub(super) fn loop_jump(&self, node: Node) -> Result<Stmt, String> {
        if !node.label().is_nil() {
            let label = node.label().text();
            let mut target_depth = 0;
            let mut parent = node.parent();
            while !parent.is_nil() {
                let break_target = parent.kind() == SyntaxKind::SwitchStatement
                    && node.kind() == SyntaxKind::BreakStatement;
                let loop_target = matches!(
                    parent.kind(),
                    SyntaxKind::WhileStatement
                        | SyntaxKind::DoStatement
                        | SyntaxKind::ForStatement
                        | SyntaxKind::ForInStatement
                        | SyntaxKind::ForOfStatement
                );
                if loop_target
                    && parent.parent().kind() == SyntaxKind::LabeledStatement
                    && parent.parent().label().text() == label
                {
                    return Ok(if node.kind() == SyntaxKind::BreakStatement {
                        Stmt::Break {
                            target_depth,
                            loc: self.loc(node),
                        }
                    } else {
                        Stmt::Continue {
                            target_depth,
                            loc: self.loc(node),
                        }
                    });
                }
                if break_target || loop_target {
                    target_depth += 1;
                }
                if matches!(
                    parent.kind(),
                    SyntaxKind::FunctionDeclaration
                        | SyntaxKind::FunctionExpression
                        | SyntaxKind::ArrowFunction
                        | SyntaxKind::MethodDeclaration
                        | SyntaxKind::Constructor
                        | SyntaxKind::GetAccessor
                        | SyntaxKind::SetAccessor
                        | SyntaxKind::SourceFile
                ) {
                    break;
                }
                parent = parent.parent();
            }
            return Err(self.refuse(node, "labeled loop jump has no represented target"));
        }
        let mut parent = node.parent();
        while !parent.is_nil() {
            match parent.kind() {
                SyntaxKind::SwitchStatement if node.kind() == SyntaxKind::BreakStatement => {
                    return Ok(Stmt::Break {
                        target_depth: 0,
                        loc: self.loc(node),
                    });
                }
                SyntaxKind::WhileStatement
                | SyntaxKind::DoStatement
                | SyntaxKind::ForStatement
                | SyntaxKind::ForInStatement
                | SyntaxKind::ForOfStatement => {
                    return Ok(if node.kind() == SyntaxKind::BreakStatement {
                        Stmt::Break {
                            target_depth: 0,
                            loc: self.loc(node),
                        }
                    } else {
                        Stmt::Continue {
                            target_depth: 0,
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
                | SyntaxKind::SourceFile => break,
                _ => parent = parent.parent(),
            }
        }
        Err(self.refuse(node, "loop jump has no enclosing represented loop"))
    }
}
