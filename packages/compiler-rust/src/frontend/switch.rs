//! Lazy strict-equality selection and fallthrough use the portable switch node.
use super::*;

fn switch_identifiers(node: Node, out: &mut Vec<Node>) {
    if node.kind() == SyntaxKind::Identifier {
        out.push(node);
    }
    node.for_each_child(&mut |child| {
        switch_identifiers(child, out);
        false
    });
}

impl Lowerer<'_> {
    pub(super) fn exhaustive_literal_switch(&mut self, node: Node) -> bool {
        let clauses = node.case_block().clauses().nodes();
        if clauses
            .clone()
            .into_iter()
            .any(|clause| clause.kind() == SyntaxKind::DefaultClause)
        {
            return false;
        }
        let discriminant = self.checker.get_type_at_location(node.expression());
        if !self
            .checker
            .ty(discriminant)
            .flags
            .intersects(TypeFlags::UNION)
        {
            return false;
        }
        let arms = self.checker.ty(discriminant).types().to_vec();
        if arms.is_empty()
            || arms
                .iter()
                .any(|arm| !self.checker.ty(*arm).flags.intersects(TypeFlags::LITERAL))
        {
            return false;
        }
        let choices = clauses
            .into_iter()
            .filter(|clause| clause.kind() == SyntaxKind::CaseClause)
            .filter_map(|clause| {
                let choice = self.checker.get_type_at_location(clause.expression());
                (self.checker.ty(choice).flags.intersects(TypeFlags::LITERAL)
                    && !self.checker.ty(choice).flags.intersects(TypeFlags::UNION))
                .then_some(choice)
            })
            .collect::<Vec<_>>();
        arms.into_iter().all(|arm| {
            choices
                .iter()
                .any(|choice| self.checker.is_type_assignable_to(arm, *choice))
        })
    }

    pub(super) fn switch_statement(&mut self, node: Node) -> Result<Vec<Stmt>, String> {
        let exhaustive = self.exhaustive_literal_switch(node);
        let saved_bindings = self.bindings.clone();
        let saved_types = self.var_types.clone();
        let clauses = node
            .case_block()
            .clauses()
            .nodes()
            .into_iter()
            .collect::<Vec<_>>();
        let mut case_lexicals = HashMap::new();
        for (case_index, clause) in clauses.iter().copied().enumerate() {
            for statement in clause.statements() {
                if statement.kind() != SyntaxKind::VariableStatement
                    || !statement
                        .declaration_list()
                        .flags()
                        .intersects(NodeFlags::LET | NodeFlags::CONST)
                {
                    continue;
                }
                for declaration in statement.declaration_list().declarations().nodes() {
                    let name = declaration.name();
                    if name.kind() != SyntaxKind::Identifier {
                        return Err(self.refuse(
                            declaration,
                            "switch case lexical destructuring is not ported",
                        ));
                    }
                    let symbol = self.symbol(name);
                    if symbol == 0
                        || case_lexicals
                            .insert(symbol, (case_index, declaration, name))
                            .is_some()
                    {
                        return Err(self.refuse(
                            declaration,
                            "switch case lexical binding needs one native declaration identity",
                        ));
                    }
                }
            }
        }
        // JavaScript gives all unbraced cases one lexical environment. Cases
        // whose bindings do not escape their own source region can be emitted
        // as isolated native blocks with identical observable semantics. Keep
        // cross-case and pre-declaration reads refused because they require a
        // shared TDZ cell instantiated before any case test executes.
        if !case_lexicals.is_empty() {
            for (case_index, clause) in clauses.iter().copied().enumerate() {
                let mut identifiers = Vec::new();
                switch_identifiers(clause, &mut identifiers);
                for identifier in identifiers {
                    let symbol = self.symbol(identifier);
                    let Some((owner, declaration, name)) = case_lexicals.get(&symbol) else {
                        continue;
                    };
                    if identifier == *name {
                        continue;
                    }
                    if case_index != *owner || identifier.pos() < declaration.end() {
                        return Err(self.refuse(
                            identifier,
                            "switch case lexical reads across cases or before initialization require shared TDZ storage",
                        ));
                    }
                }
            }
        }
        self.var_defined.clear();
        let value = self.condition_value(node.expression())?;
        let value = self.primitive_capture(value, node.expression())?;
        let value = self.coerce(value, Type::Dyn, node.expression())?;
        let source = self.construction_local(Type::Dyn, false);
        let loc = self.loc(node);
        let mut cases = Vec::new();
        for clause in clauses {
            if !case_lexicals.is_empty() {
                self.bindings = saved_bindings.clone();
                self.var_types = saved_types.clone();
            }
            self.var_defined.clear();
            let test = if clause.kind() == SyntaxKind::DefaultClause {
                None
            } else {
                let value = self.condition_value(clause.expression())?;
                let value = self.primitive_capture(value, clause.expression())?;
                Some(Expr::DynScalarEq {
                    left: Box::new(self.construction_read(&source, clause)),
                    right: Box::new(self.coerce(value, Type::Dyn, clause.expression())?),
                    negated: false,
                    r#type: Type::Bool,
                    loc: self.loc(clause),
                })
            };
            self.var_defined.clear();
            let body = self.statements(clause.statements())?;
            let body = if case_lexicals.is_empty() {
                body
            } else {
                vec![Stmt::Block {
                    body,
                    loc: self.loc(clause),
                }]
            };
            cases.push(ir::SwitchCase { test, body });
        }
        if exhaustive {
            self.ensure_exception_classes(node)?;
            cases.push(ir::SwitchCase {
                test: None,
                body: vec![Stmt::Throw {
                    value: Expr::LibCall {
                        r#fn: "error.new".into(),
                        args: vec![Expr::StrLit {
                            value: "exhaustive switch received an impossible value".into(),
                            r#type: Type::String,
                            loc: loc.clone(),
                        }],
                        r#type: Type::Object {
                            class_name: "%TypeError".into(),
                        },
                        loc: loc.clone(),
                    },
                    loc: loc.clone(),
                }],
            });
        }
        self.bindings = saved_bindings;
        self.var_types = saved_types;
        self.var_defined.clear();
        Ok(vec![Stmt::Block {
            body: vec![
                Stmt::VarDecl {
                    local_id: source.id,
                    init: value,
                    loc: loc.clone(),
                },
                Stmt::Switch {
                    disc: Expr::BoolLit {
                        value: true,
                        r#type: Type::Bool,
                        loc: loc.clone(),
                    },
                    cases,
                    loc: loc.clone(),
                },
            ],
            loc,
        }])
    }
}
