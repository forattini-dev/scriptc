//! Function/module var instantiation is separate from source-site assignments.
use super::*;

fn declarations(node: Node, out: &mut Vec<Node>) {
    if matches!(
        node.kind(),
        SyntaxKind::FunctionDeclaration
            | SyntaxKind::FunctionExpression
            | SyntaxKind::ArrowFunction
            | SyntaxKind::ClassDeclaration
            | SyntaxKind::ClassExpression
    ) {
        return;
    }
    if node.kind() == SyntaxKind::VariableDeclarationList
        && !node.flags().intersects(NodeFlags::LET | NodeFlags::CONST)
    {
        out.extend(node.declarations().nodes());
        return;
    }
    node.for_each_child(&mut |child| {
        declarations(child, out);
        false
    });
}

impl Lowerer<'_> {
    pub(super) fn optional_storage(&self, ty: &Type) -> bool {
        matches!(ty, Type::Union { union_id } if self.unions[*union_id].arms.contains(&Type::Undefined))
    }

    fn var_value_type(&mut self, declaration: Node) -> Result<Type, String> {
        let name = declaration.name();
        if name.kind() != SyntaxKind::Identifier {
            return Err(self.refuse(declaration, "var destructuring is not ported"));
        }
        let ty = self.storage_type(name)?;
        if matches!(&ty, Type::Map { key, value } if **key == Type::Dyn && **value == Type::Dyn) {
            return Ok(Type::Dyn);
        }
        if matches!(ty, Type::Map { .. }) {
            return Err(self.refuse(declaration, "hoisted Map var storage is not ported"));
        }
        Ok(ty)
    }

    // The source value contract and its undefined-capable cell are separate.
    // Both hoisted var and let without an initializer use this representation;
    // lexical cells still initialize only when their declaration executes.
    pub(super) fn undefined_storage_type(&mut self, ty: Type, node: Node) -> Result<Type, String> {
        if ty == Type::Dyn {
            return Ok(ty);
        }
        let mut arms = if let Type::Union { union_id } = ty {
            self.unions[union_id].arms.clone()
        } else {
            vec![ty]
        };
        arms.push(Type::Undefined);
        self.intern_union(arms)
            .ok_or_else(|| self.refuse(node, "binding has no undefined representation"))
    }

    pub(super) fn var_assignment_fact(&mut self, symbol: u32, value: &Expr) {
        let defined = match value {
            Expr::UnionWrap { value, .. } => value.ty() != Type::Undefined,
            _ => !matches!(value.ty(), Type::Union { .. } | Type::Undefined),
        };
        if defined {
            self.var_defined.insert(symbol);
        } else {
            self.var_defined.remove(&symbol);
        }
    }

    pub(super) fn var_call_effects(&mut self) {
        self.var_defined.retain(|symbol| {
            let immutable = self
                .bindings
                .get(symbol)
                .or_else(|| self.module_bindings.get(symbol))
                .or_else(|| self.outer.iter().rev().find_map(|scope| scope.get(symbol)))
                .is_some_and(|local| !local.mutable);
            // A call can change a captured mutable cell, but cannot retag an
            // immutable value snapshot. Its object's properties remain live.
            immutable
                || !matches!(
                    self.var_types.get(symbol),
                    Some(Type::Union { .. } | Type::Dyn)
                )
        });
    }

    fn var_undefined(&self, ty: Type, node: Node) -> Result<Expr, String> {
        self.coerce(
            Expr::UnitLit {
                unit: "undefined",
                r#type: Type::Undefined,
                loc: self.loc(node),
            },
            ty,
            node,
        )
    }

    pub(super) fn hoist_module_vars(&mut self, files: &[Node]) -> Result<Vec<Stmt>, String> {
        let mut body = Vec::new();
        for file in files {
            self.file = source_file_info(*file).file_name.to_string();
            let mut nodes = Vec::new();
            declarations(*file, &mut nodes);
            for declaration in nodes {
                let symbol = self.symbol(declaration.name());
                if self.native_namespaces.contains_key(&symbol) {
                    continue;
                }
                let ty = self.var_value_type(declaration)?;
                let symbol = self.symbol(declaration.name());
                if self.functions.contains(symbol) {
                    return Err(self.refuse(
                        declaration,
                        "var/function binding collisions are not ported",
                    ));
                }
                if let Some(previous) = self.module_vars.get(&symbol) {
                    if *previous != ty {
                        return Err(
                            self.refuse(declaration, "var redeclarations need one native type")
                        );
                    }
                    continue;
                }
                let storage = self.undefined_storage_type(ty.clone(), declaration)?;
                let local = self.module_binding(declaration.name(), storage.clone(), true);
                self.module_vars.insert(symbol, ty.clone());
                self.var_types.insert(symbol, ty);
                body.push(Stmt::Assign {
                    local_id: local.id,
                    initializes_global: true,
                    value: self.var_undefined(storage, declaration)?,
                    loc: self.loc(declaration),
                });
            }
        }
        Ok(body)
    }

    pub(super) fn hoist_local_vars(&mut self, block: Node) -> Result<Vec<Stmt>, String> {
        let mut nodes = Vec::new();
        declarations(block, &mut nodes);
        let mut body = Vec::new();
        let mut seen = HashSet::new();
        for declaration in nodes {
            if declaration.name().kind() != SyntaxKind::Identifier {
                return Err(self.refuse(declaration, "var destructuring is not ported"));
            }
            let symbol = self.symbol(declaration.name());
            if !seen.insert(symbol) {
                continue;
            }
            if let Some(param) = self.bindings.get(&symbol) {
                // A default can retain undefined even when checker flow assumes
                // a defined body value. Redeclaration preserves that native fact.
                if let std::collections::hash_map::Entry::Vacant(entry) =
                    self.var_types.entry(symbol)
                {
                    entry.insert(param.r#type.clone());
                    self.var_defined.insert(symbol);
                }
                continue;
            }
            let ty = self.var_value_type(declaration)?;
            let storage = self.undefined_storage_type(ty.clone(), declaration)?;
            let local = Local {
                id: format!("v{}", self.locals.len()),
                name: declaration.name().text().into(),
                r#type: storage.clone(),
                mutable: true,
                boxed: false,
            };
            self.locals.push(local.clone());
            self.bindings.insert(symbol, local.clone());
            self.var_types.insert(symbol, ty);
            body.push(Stmt::VarDecl {
                local_id: local.id,
                init: self.var_undefined(storage, declaration)?,
                loc: self.loc(declaration),
            });
        }
        Ok(body)
    }

    pub(super) fn var_statement(&mut self, node: Node) -> Result<Vec<Stmt>, String> {
        let mut body = Vec::new();
        let list = if node.kind() == SyntaxKind::VariableDeclarationList {
            node
        } else {
            node.declaration_list()
        };
        for declaration in list.declarations().nodes() {
            let symbol = self.symbol(declaration.name());
            if self.native_namespaces.contains_key(&symbol) {
                if !self
                    .commonjs
                    .native_declarations
                    .contains(&declarations::Key::of(declaration))
                {
                    return Err(self.refuse(
                        declaration,
                        "native namespace alias redeclaration is not ported",
                    ));
                }
                continue;
            }
            let ty = self.var_types.get(&symbol).cloned().ok_or_else(|| {
                self.refuse(declaration, "var was not instantiated in its native scope")
            })?;
            if declaration.initializer().is_nil() {
                continue;
            }
            let local = self.binding(declaration.name())?;
            let value = self.expected_expression(declaration.initializer(), ty)?;
            let value = self.coerce(value, local.r#type, declaration)?;
            self.var_assignment_fact(symbol, &value);
            body.push(Stmt::Assign {
                local_id: local.id,
                initializes_global: false,
                value,
                loc: self.loc(declaration),
            });
        }
        Ok(body)
    }

    pub(super) fn guarded_var(&mut self, node: Node, truth: bool) -> Option<u32> {
        if node.kind() == SyntaxKind::ParenthesizedExpression {
            return self.guarded_var(node.expression(), truth);
        }
        if node.kind() != SyntaxKind::BinaryExpression {
            return None;
        }
        let equal = match node.operator_token().kind() {
            SyntaxKind::EqualsEqualsEqualsToken => true,
            SyntaxKind::ExclamationEqualsEqualsToken => false,
            _ => return None,
        };
        if equal == truth {
            return None;
        }
        for (value, unit) in [(node.left(), node.right()), (node.right(), node.left())] {
            if value.kind() != SyntaxKind::Identifier
                || unit.kind() != SyntaxKind::Identifier
                || unit.text() != "undefined"
            {
                continue;
            }
            let symbol = self.symbol(value);
            if !self.var_types.contains_key(&symbol) {
                continue;
            }
            let unit_symbol = self.symbol(unit);
            if unit_symbol != 0
                && self
                    .checker
                    .sym(source_frontend::prelude::SymbolId(unit_symbol))
                    .value_declaration
                    .is_nil()
            {
                return Some(symbol);
            }
        }
        None
    }

    // Combine only pure presence tests. Calls or other effects inside a
    // condition can invalidate an earlier test and must not restore its facts.
    pub(super) fn guarded_vars(&mut self, node: Node, truth: bool) -> Option<HashSet<u32>> {
        if node.kind() == SyntaxKind::ParenthesizedExpression {
            return self.guarded_vars(node.expression(), truth);
        }
        if node.kind() == SyntaxKind::PrefixUnaryExpression
            && node.operator() == SyntaxKind::ExclamationToken
        {
            return self.guarded_vars(node.operand(), !truth);
        }
        if node.kind() == SyntaxKind::Identifier {
            let symbol = self.symbol(node);
            // Truthiness proves presence, but a falsy value can still be a
            // defined empty string, zero or false. Both observations are pure.
            return self.var_types.contains_key(&symbol).then(|| {
                if truth {
                    HashSet::from([symbol])
                } else {
                    HashSet::new()
                }
            });
        }
        if node.kind() != SyntaxKind::BinaryExpression {
            return None;
        }
        let op = node.operator_token().kind();
        if matches!(
            op,
            SyntaxKind::AmpersandAmpersandToken | SyntaxKind::BarBarToken
        ) {
            let left = self.guarded_vars(node.left(), truth)?;
            let right = self.guarded_vars(node.right(), truth)?;
            return Some(if (op == SyntaxKind::AmpersandAmpersandToken) == truth {
                left.union(&right).copied().collect()
            } else {
                left.intersection(&right).copied().collect()
            });
        }
        if !matches!(
            op,
            SyntaxKind::EqualsEqualsEqualsToken | SyntaxKind::ExclamationEqualsEqualsToken
        ) {
            return None;
        }
        // A recognized comparison remains pure even on the outcome that does
        // not prove definedness, represented by the empty fact set.
        let defined = self.guarded_var(node, truth);
        if defined.is_some() || self.guarded_var(node, !truth).is_some() {
            return Some(defined.into_iter().collect());
        }
        None
    }

    // A presence test observes the live slot, even when a checker refinement
    // survives a call that can mutate a captured or module binding.
    pub(super) fn condition_value(&mut self, node: Node) -> Result<Expr, String> {
        if node.kind() == SyntaxKind::ParenthesizedExpression {
            return self.condition_value(node.expression());
        }
        if node.kind() == SyntaxKind::Identifier
            && let Ok(local) = self.binding(node)
        {
            // Catch storage holds a completion payload. Observe its existing
            // owning value alias rather than boxing or projecting Caught.
            let local = if local.r#type == Type::Caught {
                let symbol = self.symbol(node);
                self.caught_aliases.get(&symbol).cloned().unwrap_or(local)
            } else {
                local
            };
            return Ok(Expr::VarRef {
                local_id: local.id,
                r#type: local.r#type,
                loc: self.loc(node),
            });
        }
        let value = self.expression(node)?;
        if let Expr::DynCheck { value: source, .. } = &value
            && matches!(source.as_ref(), Expr::DynKeyGet { .. })
        {
            // Equality and presence observe the current property tag. A
            // checker scalar view may be stale after an alias mutates it.
            return Ok(source.as_ref().clone());
        }
        if let Expr::UnionNarrow { value: source, .. } = &value
            && matches!(source.ty(), Type::Union { union_id } if self.unions[union_id].arms.iter().any(|arm| matches!(arm, Type::Null | Type::Undefined)))
        {
            // A presence/comparison observation reads the owning property
            // slot, including tags changed through an alias or callback.
            return Ok(source.as_ref().clone());
        }
        Ok(value)
    }

    // Box once into the owning value ABI; testing presence never invokes a callback.
    pub(super) fn condition(&self, value: Expr, node: Node) -> Result<Expr, String> {
        if value.ty() == Type::Bool {
            return Ok(value);
        }
        if value.ty() == Type::Void {
            return Err(self.refuse(node, "void-valued conditions are not ported"));
        }
        let value = self.coerce(value, Type::Dyn, node)?;
        Ok(Expr::DynTest {
            value: Box::new(value),
            test: "truthy".into(),
            negated: false,
            r#type: Type::Bool,
            loc: self.loc(node),
        })
    }

    pub(super) fn var_if(&mut self, node: Node) -> Result<Stmt, String> {
        let value = self.condition_value(node.expression())?;
        let cond = self.condition(value, node.expression())?;
        let before = self.var_defined.clone();
        if let Some(symbols) = self.guarded_vars(node.expression(), true) {
            self.var_defined.extend(symbols);
        }
        let then = self.statement(node.then_statement())?;
        let then_defined = self.var_defined.clone();
        self.var_defined = before;
        if let Some(symbols) = self.guarded_vars(node.expression(), false) {
            self.var_defined.extend(symbols);
        }
        let else_ = if node.else_statement().is_nil() {
            None
        } else {
            Some(self.statement(node.else_statement())?)
        };
        let other_defined = self.var_defined.clone();
        self.var_defined = if ir::always_returns(&then) {
            other_defined
        } else if else_.as_ref().is_some_and(|body| ir::always_returns(body)) {
            then_defined
        } else {
            then_defined.intersection(&other_defined).copied().collect()
        };
        Ok(Stmt::If {
            cond,
            then,
            else_,
            loc: self.loc(node),
        })
    }
}
