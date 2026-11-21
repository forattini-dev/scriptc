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
    /// `if (!value) throw/return; destination = value` has no intervening
    /// operation that can change the observed binding before assignment.
    pub(super) fn guarded_truthy_assignment_site(&mut self, node: Node) -> bool {
        if node.kind() != SyntaxKind::Identifier {
            return false;
        }
        let assignment = node.parent();
        if assignment.kind() != SyntaxKind::BinaryExpression
            || assignment.operator_token().kind() != SyntaxKind::EqualsToken
            || assignment.left().kind() != SyntaxKind::Identifier
            || assignment.right() != node
        {
            return false;
        }
        let statement = assignment.parent();
        let block = statement.parent();
        if statement.kind() != SyntaxKind::ExpressionStatement || block.kind() != SyntaxKind::Block
        {
            return false;
        }
        let statements = block.statements().into_iter().collect::<Vec<_>>();
        let Some(previous) = statements
            .iter()
            .position(|item| *item == statement)
            .and_then(|i| i.checked_sub(1))
        else {
            return false;
        };
        let guard = statements[previous];
        if guard.kind() != SyntaxKind::IfStatement || !guard.else_statement().is_nil() {
            return false;
        }
        let condition = primitives::primitive_source(guard.expression());
        if condition.kind() != SyntaxKind::PrefixUnaryExpression
            || condition.operator() != SyntaxKind::ExclamationToken
        {
            return false;
        }
        let source = primitives::primitive_source(condition.operand());
        let symbol = self.symbol(node);
        if symbol == 0 || source.kind() != SyntaxKind::Identifier || self.symbol(source) != symbol {
            return false;
        }
        let body = guard.then_statement();
        if body.kind() == SyntaxKind::Block {
            let statements = body.statements().into_iter().collect::<Vec<_>>();
            statements.len() == 1
                && matches!(
                    statements[0].kind(),
                    SyntaxKind::ThrowStatement | SyntaxKind::ReturnStatement
                )
        } else {
            matches!(
                body.kind(),
                SyntaxKind::ThrowStatement | SyntaxKind::ReturnStatement
            )
        }
    }

    pub(super) fn guarded_truthy_assignment(&mut self, node: Node, value: &Expr) -> Option<Expr> {
        if !self.guarded_truthy_assignment_site(node) {
            return None;
        }
        let Type::Union { union_id } = value.ty() else {
            return None;
        };
        let present = self.unions[union_id]
            .arms
            .iter()
            .enumerate()
            .filter(|(_, arm)| !matches!(arm, Type::Null | Type::Undefined | Type::Void))
            .collect::<Vec<_>>();
        let [(tag, target)] = present.as_slice() else {
            return None;
        };
        Some(Expr::UnionNarrow {
            union_id: format!("u{union_id}"),
            tag: *tag,
            value: Box::new(value.clone()),
            r#type: (*target).clone(),
            loc: self.loc(node),
        })
    }

    /// A direct truthy return has no intervening operation that could retag
    /// the local. This also works for JS bodies whose checker view is `any`.
    pub(super) fn guarded_truthy_return(&mut self, node: Node, value: &Expr) -> Option<Expr> {
        if node.kind() != SyntaxKind::Identifier
            || node.parent().kind() != SyntaxKind::ReturnStatement
        {
            return None;
        }
        let ret = node.parent();
        let branch = if ret.parent().kind() == SyntaxKind::Block {
            let block = ret.parent();
            let statements = block.statements().into_iter().collect::<Vec<_>>();
            if statements.as_slice() != [ret] {
                return None;
            }
            block
        } else {
            ret
        };
        let guard = branch.parent();
        if guard.kind() != SyntaxKind::IfStatement || guard.then_statement() != branch {
            return None;
        }
        let condition = primitives::primitive_source(guard.expression());
        let condition = if condition.kind() == SyntaxKind::BinaryExpression
            && condition.operator_token().kind() == SyntaxKind::AmpersandAmpersandToken
        {
            // The local passed the left truthiness test before the predicate.
            // Calling the predicate does not expose or retag that lexical cell.
            primitives::primitive_source(condition.left())
        } else {
            condition
        };
        let symbol = self.symbol(node);
        if symbol == 0
            || condition.kind() != SyntaxKind::Identifier
            || self.symbol(condition) != symbol
        {
            return None;
        }
        let Type::Union { union_id } = value.ty() else {
            return None;
        };
        let present = self.unions[union_id]
            .arms
            .iter()
            .enumerate()
            .filter(|(_, arm)| !matches!(arm, Type::Null | Type::Undefined | Type::Void))
            .collect::<Vec<_>>();
        let [(tag, target)] = present.as_slice() else {
            return None;
        };
        Some(Expr::UnionNarrow {
            union_id: format!("u{union_id}"),
            tag: *tag,
            value: Box::new(value.clone()),
            r#type: (*target).clone(),
            loc: self.loc(node),
        })
    }

    pub(super) fn optional_storage(&self, ty: &Type) -> bool {
        matches!(ty, Type::Union { union_id } if self.unions[*union_id].arms.contains(&Type::Undefined))
    }

    // Flow presence and optional storage are deliberately different concepts.
    // A null arm is a present JavaScript value for fields and array elements,
    // but a local `T | null` can still be proven to contain T after a guard.
    pub(super) fn presence_storage(&self, ty: &Type) -> bool {
        matches!(ty, Type::Union { union_id } if self.unions[*union_id]
            .arms
            .iter()
            .any(|arm| matches!(arm, Type::Null | Type::Undefined)))
    }

    fn var_value_type(&mut self, declaration: Node) -> Result<Type, String> {
        let name = declaration.name();
        if name.kind() != SyntaxKind::Identifier {
            return Err(self.refuse(declaration, "var destructuring is not ported"));
        }
        if !declaration.initializer().is_nil()
            && let Some(symbol) = self.symbol_initializer_storage(declaration.initializer())
        {
            return Ok(symbol);
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
            let stable = if let Some(local) = self.bindings.get(symbol) {
                // An ordinary local is not reachable by a callee. Captured
                // mutable locals are boxed when their closure is lowered and
                // must be invalidated because the call may invoke that closure.
                !local.mutable || !local.boxed || !self.nested_assignment_symbols.contains(symbol)
            } else if let Some(global) = self.module_bindings.get(symbol) {
                // A mutable module binding can be observed and changed by any
                // function in the module without using the closure box ABI.
                !global.mutable
            } else {
                self.outer
                    .iter()
                    .rev()
                    .find_map(|scope| scope.get(symbol))
                    .is_some_and(|local| !local.mutable)
            };
            // Calls do not retag immutable snapshots or uncaptured locals.
            // Object properties remain live and are deliberately not facts.
            stable
                || !matches!(
                    self.var_types.get(symbol),
                    Some(Type::Union { .. } | Type::Dyn)
                )
        });
    }

    // A loop may execute zero times or repeatedly. Besides immutable values,
    // a definitely initialized, uncaptured local whose declared value type
    // cannot contain undefined remains defined: every represented assignment
    // is checked against that declared type before it reaches the optional
    // storage cell. Mutable globals and captured cells remain call-observable.
    pub(super) fn immutable_var_facts(&mut self) -> HashSet<u32> {
        let symbols = self.var_defined.iter().copied().collect::<Vec<_>>();
        let mut stable = HashSet::new();
        for symbol in symbols {
            let keep = if let Some(local) = self.bindings.get(&symbol) {
                let (mutable, boxed) = (local.mutable, local.boxed);
                if !mutable {
                    true
                } else if boxed {
                    false
                } else if !matches!(
                    self.var_types.get(&symbol),
                    Some(Type::Union { .. } | Type::Dyn)
                ) {
                    true
                } else {
                    let declared = self
                        .checker
                        .get_type_of_symbol(source_frontend::prelude::SymbolId(symbol));
                    !self.source_has_undefined(declared)
                }
            } else if let Some(global) = self.module_bindings.get(&symbol) {
                !global.mutable
            } else {
                self.outer
                    .iter()
                    .rev()
                    .find_map(|scope| scope.get(&symbol))
                    .is_some_and(|local| !local.mutable)
            };
            if keep {
                stable.insert(symbol);
            }
        }
        stable
    }

    pub(super) fn var_undefined(&self, ty: Type, node: Node) -> Result<Expr, String> {
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
        let (equal, nullish) = match node.operator_token().kind() {
            SyntaxKind::EqualsEqualsEqualsToken => (true, false),
            SyntaxKind::ExclamationEqualsEqualsToken => (false, false),
            SyntaxKind::EqualsEqualsToken => (true, true),
            SyntaxKind::ExclamationEqualsToken => (false, true),
            _ => return None,
        };
        if equal == truth {
            return None;
        }
        for (value, unit) in [(node.left(), node.right()), (node.right(), node.left())] {
            let value = primitives::primitive_source(value);
            let unit = primitives::primitive_source(unit);
            if value.kind() != SyntaxKind::Identifier {
                continue;
            }
            let symbol = self.symbol(value);
            let binding_type = self
                .bindings
                .get(&symbol)
                .or_else(|| self.module_bindings.get(&symbol))
                .or_else(|| self.outer.iter().rev().find_map(|scope| scope.get(&symbol)))
                .map(|binding| binding.r#type.clone());
            if !self.var_types.contains_key(&symbol)
                && !binding_type
                    .as_ref()
                    .is_some_and(|ty| self.presence_storage(ty))
            {
                continue;
            }
            // Only the null-literal loose comparison is lowered. Its
            // non-nullish outcome proves absence of both unit tags. Keep
            // this fact on local cells, never on a mutable property path.
            if nullish {
                if unit.kind() == SyntaxKind::NullKeyword {
                    return Some(symbol);
                }
                continue;
            }
            if unit.kind() == SyntaxKind::NullKeyword
                && binding_type.as_ref().is_some_and(|ty| {
                    matches!(ty, Type::Union { union_id }
                        if self.unions[*union_id].arms.contains(&Type::Null)
                            && !self.unions[*union_id].arms.contains(&Type::Undefined))
                })
            {
                // `value === null` in the false branch (and `!== null`
                // in the true branch) proves presence only when undefined is
                // not another storage arm. Loose null comparisons above prove
                // absence of both unit tags.
                return Some(symbol);
            }
            if unit.kind() != SyntaxKind::Identifier || unit.text() != "undefined" {
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
    /// `[a, b].every((value) => value != null && ...)` evaluates its callback
    /// on every element, so a true result proves each immutable identifier
    /// element present. The predicate must test its parameter with a loose or
    /// strict nullish comparison as a top-level `&&` conjunct. A false result
    /// proves nothing; the call is otherwise an ordinary expression.
    fn guarded_every_literal(&mut self, node: Node, truth: bool) -> Option<HashSet<u32>> {
        let member = node.expression();
        if member.kind() != SyntaxKind::PropertyAccessExpression
            || member.name().text() != "every"
        {
            return None;
        }
        let array = primitives::primitive_source(member.expression());
        if array.kind() != SyntaxKind::ArrayLiteralExpression {
            return None;
        }
        let args = node.arguments().into_iter().collect::<Vec<_>>();
        let [callback] = args.as_slice() else {
            return None;
        };
        let callback = primitives::primitive_source(*callback);
        if callback.kind() != SyntaxKind::ArrowFunction {
            return None;
        }
        let parameters = callback.parameters().into_iter().collect::<Vec<_>>();
        let [parameter] = parameters.as_slice() else {
            return None;
        };
        if parameter.name().kind() != SyntaxKind::Identifier {
            return None;
        }
        let parameter_name = parameter.name().text().to_string();
        let mut body = callback.body();
        if body.kind() == SyntaxKind::Block {
            let statements = body.statements().into_iter().collect::<Vec<_>>();
            let [statement] = statements.as_slice() else {
                return None;
            };
            if statement.kind() != SyntaxKind::ReturnStatement || statement.expression().is_nil() {
                return None;
            }
            body = statement.expression();
        }
        fn tests_presence(node: Node, name: &str) -> bool {
            let node = primitives::primitive_source(node);
            if node.kind() != SyntaxKind::BinaryExpression {
                return false;
            }
            let op = node.operator_token().kind();
            if op == SyntaxKind::AmpersandAmpersandToken {
                return tests_presence(node.left(), name) || tests_presence(node.right(), name);
            }
            if !matches!(
                op,
                SyntaxKind::ExclamationEqualsToken | SyntaxKind::ExclamationEqualsEqualsToken
            ) {
                return false;
            }
            [(node.left(), node.right()), (node.right(), node.left())]
                .into_iter()
                .any(|(value, unit)| {
                    let value = primitives::primitive_source(value);
                    let unit = primitives::primitive_source(unit);
                    value.kind() == SyntaxKind::Identifier
                        && value.text() == name
                        && (unit.kind() == SyntaxKind::NullKeyword
                            && op == SyntaxKind::ExclamationEqualsToken
                            || unit.kind() == SyntaxKind::Identifier
                                && unit.text() == "undefined")
                })
        }
        if !tests_presence(body, &parameter_name) {
            return None;
        }
        if !truth {
            return Some(HashSet::new());
        }
        let mut facts = HashSet::new();
        for element in array.elements() {
            let element = primitives::primitive_source(element);
            if element.kind() != SyntaxKind::Identifier {
                continue;
            }
            let symbol = self.symbol(element);
            let immutable_presence = self
                .bindings
                .get(&symbol)
                .or_else(|| self.module_bindings.get(&symbol))
                .or_else(|| self.outer.iter().rev().find_map(|scope| scope.get(&symbol)))
                .is_some_and(|binding| !binding.mutable && self.presence_storage(&binding.r#type));
            if immutable_presence {
                facts.insert(symbol);
            }
        }
        Some(facts)
    }

    pub(super) fn guarded_vars(&mut self, node: Node, truth: bool) -> Option<HashSet<u32>> {
        if node.is_nil() {
            return None;
        }
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
            let binding_type = self
                .bindings
                .get(&symbol)
                .or_else(|| self.module_bindings.get(&symbol))
                .or_else(|| self.outer.iter().rev().find_map(|scope| scope.get(&symbol)))
                .map(|binding| binding.r#type.clone());
            // Truthiness proves presence, but a falsy value can still be a
            // defined empty string, zero or false. Both observations are pure.
            return (self.var_types.contains_key(&symbol)
                || binding_type
                    .as_ref()
                    .is_some_and(|ty| self.presence_storage(ty)))
            .then(|| {
                if truth {
                    HashSet::from([symbol])
                } else {
                    HashSet::new()
                }
            });
        }
        if node.kind() == SyntaxKind::CallExpression {
            return self.guarded_every_literal(node, truth);
        }
        if node.kind() != SyntaxKind::BinaryExpression {
            return None;
        }
        let op = node.operator_token().kind();
        if matches!(
            op,
            SyntaxKind::AmpersandAmpersandToken | SyntaxKind::BarBarToken
        ) {
            let both_evaluated = (op == SyntaxKind::AmpersandAmpersandToken) == truth;
            let left = self.guarded_vars(node.left(), truth);
            let right = self.guarded_vars(node.right(), truth);
            if both_evaluated {
                if let (Some(left), Some(right)) = (&left, &right) {
                    return Some(left.union(right).copied().collect());
                }
                let mut facts = left.or(right).unwrap_or_default();
                // Calls in the right operand may retag captured mutable cells,
                // but cannot change a const/immutable lexical binding proven
                // present by the left operand.
                facts.retain(|symbol| {
                    self.bindings
                        .get(symbol)
                        .or_else(|| self.module_bindings.get(symbol))
                        .or_else(|| self.outer.iter().rev().find_map(|scope| scope.get(symbol)))
                        .is_some_and(|local| !local.mutable)
                });
                return (!facts.is_empty()).then_some(facts);
            }
            return Some(left?.intersection(&right?).copied().collect());
        }
        if !matches!(
            op,
            SyntaxKind::EqualsEqualsEqualsToken
                | SyntaxKind::ExclamationEqualsEqualsToken
                | SyntaxKind::EqualsEqualsToken
                | SyntaxKind::ExclamationEqualsToken
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
            let value = Expr::VarRef {
                local_id: local.id,
                r#type: local.r#type,
                loc: self.loc(node),
            };
            if value.ty() == Type::Dyn {
                let symbol = self.symbol(node);
                if let Some(signature) = self.recursive_functions.get(&symbol).cloned()
                    && signature != Type::Dyn
                {
                    return Ok(Expr::DynCheck {
                        value: Box::new(value),
                        r#type: signature,
                        loc: self.loc(node),
                    });
                }
            }
            return Ok(value);
        }
        let value = self.expression(node)?;
        if let Some(raw) = self.raw_record_field(&value, node) {
            return Ok(raw);
        }
        if let Some(raw) = self.raw_array_element(&value, node) {
            return Ok(raw);
        }
        if let Expr::DynCheck { value: source, .. } = &value
            && matches!(
                source.as_ref(),
                Expr::DynKeyGet { .. } | Expr::FieldGet { .. }
            )
        {
            // Equality and presence observe the current property tag. A
            // checker scalar view may be stale after an alias mutates it or a
            // class DefineField step stores undefined before the constructor
            // body initializes the declared string/number view.
            return Ok(source.as_ref().clone());
        }
        if let Expr::UnionNarrow { value: source, .. } = &value
            && matches!(source.ty(), Type::Union { union_id } if self.unions[union_id].arms.iter().any(|arm| matches!(arm, Type::Null | Type::Undefined)))
        {
            // A presence/comparison observation reads the owning property
            // slot, including tags changed through an alias or callback.
            if let Some(raw) = self.raw_record_field(source, node) {
                return Ok(raw);
            }
            if let Some(raw) = self.raw_array_element(source, node) {
                return Ok(raw);
            }
            return Ok(source.as_ref().clone());
        }
        Ok(value)
    }

    // Box once into the owning value ABI; testing presence never invokes a callback.
    pub(super) fn condition(&self, value: Expr, node: Node) -> Result<Expr, String> {
        if value.ty() == Type::Bool {
            return Ok(value);
        }
        if let Type::Union { union_id } = value.ty()
            && let Some(tag) = self.unions[union_id]
                .arms
                .iter()
                .position(|arm| self.namespace_capsule(arm))
            && self.unions[union_id]
                .arms
                .iter()
                .enumerate()
                .all(|(index, arm)| {
                    index == tag || matches!(arm, Type::Null | Type::Undefined | Type::Void)
                })
        {
            // Module namespace objects are always truthy. A nullable
            // namespace condition is therefore a pure union-tag test; boxing
            // it as Dyn would discard the namespace descriptor contract.
            return Ok(Expr::UnionIsTag {
                union_id: format!("u{union_id}"),
                tag,
                negated: false,
                value: Box::new(value),
                r#type: Type::Bool,
                loc: self.loc(node),
            });
        }
        if let Type::Union { union_id } = value.ty()
            && let Some(tag) = self.unions[union_id]
                .arms
                .iter()
                .position(|arm| *arm == Type::Stats)
            && self.unions[union_id]
                .arms
                .iter()
                .all(|arm| matches!(arm, Type::Stats | Type::Null | Type::Undefined))
        {
            return Ok(Expr::UnionIsTag {
                union_id: format!("u{union_id}"),
                tag,
                negated: false,
                value: Box::new(value),
                r#type: Type::Bool,
                loc: self.loc(node),
            });
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
        if let Expr::BoolLit { value, .. } = &cond {
            if *value {
                let then = self.statement(node.then_statement())?;
                return Ok(Stmt::If {
                    cond: Expr::BoolLit {
                        value: true,
                        r#type: Type::Bool,
                        loc: self.loc(node.expression()),
                    },
                    then,
                    else_: None,
                    loc: self.loc(node),
                });
            }
            let else_ = if node.else_statement().is_nil() {
                None
            } else {
                Some(self.statement(node.else_statement())?)
            };
            return Ok(Stmt::If {
                cond: Expr::BoolLit {
                    value: false,
                    r#type: Type::Bool,
                    loc: self.loc(node.expression()),
                },
                then: Vec::new(),
                else_,
                loc: self.loc(node),
            });
        }
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
        self.var_defined = if !ir::falls_through(&then) {
            other_defined
        } else if else_.as_ref().is_some_and(|body| !ir::falls_through(body)) {
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
