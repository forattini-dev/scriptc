//! Canonical iteration keys and receiver-explicit method demand.
use super::*;
use ir::SymbolMethodKey;

impl ClassGraph {
    pub(in crate::frontend) fn has_symbol_surface(&self, class_name: &str) -> bool {
        self.symbol_nodes.keys().any(|(owner, _)| {
            let name = &self.definitions[*owner].name;
            (self.subclass(name, class_name) || self.subclass(class_name, name))
                && self.layouts[*owner].as_ref().is_none_or(|layout| {
                    layout
                        .symbol_methods
                        .iter()
                        .any(|method| method.function.is_none())
                })
        })
    }

    pub(in crate::frontend) fn symbol_surface_debug(&self, class_name: &str) -> String {
        self.definitions
            .iter()
            .enumerate()
            .filter(|(_, definition)| {
                self.subclass(&definition.name, class_name)
                    || self.subclass(class_name, &definition.name)
            })
            .filter_map(|(owner, definition)| {
                let keys = self
                    .symbol_nodes
                    .keys()
                    .filter_map(|(candidate, key)| (*candidate == owner).then_some(key.name()))
                    .collect::<Vec<_>>();
                if keys.is_empty() {
                    return None;
                }
                let descriptors = self.layouts[owner]
                    .as_ref()
                    .map(|layout| {
                        layout
                            .symbol_methods
                            .iter()
                            .map(|method| {
                                format!(
                                    "{}={}",
                                    method.key.name(),
                                    method.function.as_deref().unwrap_or("missing")
                                )
                            })
                            .collect::<Vec<_>>()
                            .join(",")
                    })
                    .unwrap_or_else(|| "unlaid".into());
                Some(format!(
                    "{}@{} keys=[{}] descriptors=[{}]",
                    definition.name,
                    definition.file,
                    keys.join(","),
                    descriptors
                ))
            })
            .collect::<Vec<_>>()
            .join("; ")
    }

    fn symbol_method(&self, mut owner: usize, key: SymbolMethodKey) -> Option<(usize, Node)> {
        for _ in 0..=self.definitions.len() {
            if let Some(node) = self.symbol_nodes.get(&(owner, key)) {
                return Some((owner, *node));
            }
            owner = self.definitions[owner].base?;
        }
        None
    }
}

impl Lowerer<'_> {
    pub(in crate::frontend) fn materialize_erased_symbol_methods(
        &mut self,
        ty: &Type,
    ) -> Result<(), String> {
        let owners = self
            .classes
            .definitions
            .iter()
            .enumerate()
            .filter_map(|(owner, definition)| {
                self.native_type_contains(ty, |part| {
                    matches!(part, Type::Object { class_name }
                        if self.classes.subclass(&definition.name, class_name)
                            || self.classes.subclass(class_name, &definition.name))
                })
                .then_some(owner)
            })
            .collect::<HashSet<_>>();
        let pending = self
            .classes
            .symbol_nodes
            .iter()
            .filter_map(|((owner, key), node)| {
                owners.contains(owner).then_some((*owner, *key, *node))
            })
            .collect::<Vec<_>>();
        for (owner, key, node) in pending {
            self.request_symbol_method(owner, key, node)?;
        }
        Ok(())
    }

    pub(super) fn static_symbol_method_value(
        &mut self,
        owner: usize,
        key: SymbolMethodKey,
        node: Node,
    ) -> Result<Expr, String> {
        if !node.type_parameters().is_empty() || node.body().is_nil() || receivers::reads_this(node)
        {
            return Err(self.refuse(
                node,
                "generic, overloaded or this-dependent static symbol methods are not ported",
            ));
        }
        let cache_key = (owner, owner, format!("symbol.{}", key.name()));
        let signature = if let Some(signature) = self.classes.static_methods.get(&cache_key) {
            signature.clone()
        } else {
            let file =
                std::mem::replace(&mut self.file, self.classes.definitions[owner].file.clone());
            let signature = self.function_signature(node, owner);
            self.file = file;
            let mut signature = signature?;
            signature.name = format!(
                "%{}.static.%symbol.{}",
                self.classes.definitions[owner].name,
                key.name()
            );
            self.classes
                .static_methods
                .insert(cache_key, signature.clone());
            self.classes.method_queue.push_back(signature.clone());
            signature
        };
        let ty = Type::Func {
            rest: signature.rest,
            params: signature
                .params
                .iter()
                .map(|param| param.r#type.clone())
                .collect(),
            ret: Box::new(signature.return_type),
        };
        let value = Expr::Closure {
            fn_name: signature.name,
            captures: vec![],
            r#type: ty,
            loc: self.loc(node),
        };
        self.coerce(value, Type::Dyn, node)
    }

    fn imported_commonjs_symbol(&mut self, expression: Node, declaration: Node) -> bool {
        if !matches!(
            declaration.kind(),
            SyntaxKind::PropertyAssignment | SyntaxKind::ShorthandPropertyAssignment
        ) {
            return false;
        }
        let (variable, wanted) = if expression.kind() == SyntaxKind::PropertyAccessExpression {
            let namespace = expression.expression();
            if namespace.kind() != SyntaxKind::Identifier {
                return false;
            }
            let local = self.checker.get_symbol_at_location(namespace, false);
            if local.0 == 0 {
                return false;
            }
            let declarations = self.checker.sym(local).declarations.clone();
            if declarations.len() != 1 {
                return false;
            }
            (declarations[0], expression.name().text())
        } else {
            let local = self.checker.get_symbol_at_location(expression, false);
            if local.0 == 0 {
                return false;
            }
            let declarations = self.checker.sym(local).declarations.clone();
            if declarations.len() != 1 {
                return false;
            }
            let binding = declarations[0];
            if binding.kind() != SyntaxKind::BindingElement
                || binding.name().kind() != SyntaxKind::Identifier
                || binding.parent().kind() != SyntaxKind::ObjectBindingPattern
            {
                return false;
            }
            (
                binding.parent().parent(),
                binding.property_name_or_name().text(),
            )
        };
        if variable.kind() != SyntaxKind::VariableDeclaration
            || !variable.parent().flags().intersects(NodeFlags::CONST)
            || variable.parent().parent().parent().kind() != SyntaxKind::SourceFile
        {
            return false;
        }
        let require = variable.initializer();
        if require.kind() != SyntaxKind::CallExpression {
            return false;
        }
        let Some(file) = self.commonjs_require_file(require) else {
            return false;
        };
        let statements = file.statements();
        let Some(last) = statements.last() else {
            return false;
        };
        if last.kind() != SyntaxKind::ExpressionStatement {
            return false;
        }
        let export = last.expression();
        if export.kind() != SyntaxKind::BinaryExpression
            || export.operator_token().kind() != SyntaxKind::EqualsToken
            || export.left().kind() != SyntaxKind::PropertyAccessExpression
            || export.left().name().text() != "exports"
            || export.left().expression().kind() != SyntaxKind::Identifier
            || export.left().expression().text() != "module"
            || export.right().kind() != SyntaxKind::ObjectLiteralExpression
        {
            return false;
        }
        let object = export.right();
        let mut matches = 0;
        for property in object.properties() {
            if !matches!(
                property.kind(),
                SyntaxKind::PropertyAssignment | SyntaxKind::ShorthandPropertyAssignment
            ) {
                return false;
            }
            if property.name().text() != wanted {
                continue;
            }
            if property != declaration {
                return false;
            }
            let initializer = if property.kind() == SyntaxKind::PropertyAssignment {
                property.initializer()
            } else {
                let declarations = statements
                    .iter()
                    .filter(|statement| {
                        statement.kind() == SyntaxKind::VariableStatement
                            && statement.pos() < last.pos()
                            && statement
                                .declaration_list()
                                .flags()
                                .intersects(NodeFlags::CONST)
                    })
                    .flat_map(|statement| statement.declaration_list().declarations().nodes())
                    .filter(|variable| {
                        variable.name().kind() == SyntaxKind::Identifier
                            && variable.name().text() == wanted
                    })
                    .collect::<Vec<_>>();
                let [variable] = declarations.as_slice() else {
                    return false;
                };
                variable.initializer()
            };
            let initializer = primitives::primitive_source(initializer);
            if initializer.kind() != SyntaxKind::CallExpression {
                return false;
            }
            let callee = initializer.expression();
            let local_symbol = self.standard_symbol(callee);
            let registry_symbol = callee.kind() == SyntaxKind::PropertyAccessExpression
                && callee.name().text() == "for"
                && self.standard_symbol(callee.expression())
                && initializer.arguments().len() == 1
                && initializer
                    .arguments()
                    .into_iter()
                    .next()
                    .is_some_and(|argument| argument.kind() == SyntaxKind::StringLiteral);
            if !local_symbol && !registry_symbol {
                return false;
            }
            matches += 1;
        }
        matches == 1
    }

    /// For a statically represented class, prototype membership can dispatch
    /// on its actual native subclass without erasing its symbol surface.
    pub(in crate::frontend) fn class_symbol_presence(
        &mut self,
        node: Node,
    ) -> Result<Option<Expr>, String> {
        let Some(key) = self.class_symbol_key(node.left()) else {
            return Ok(None);
        };
        let Ok(Type::Object { class_name }) = self.ty(node.right()) else {
            return Ok(None);
        };
        let Some(index) = self
            .classes
            .definitions
            .iter()
            .position(|class| class.name == class_name)
        else {
            return Ok(None);
        };
        if self.classes.definitions[index].node.is_nil() {
            return Ok(None);
        }
        for child in 0..self.classes.definitions.len() {
            self.resolve_class(child)?;
        }
        let mut ancestor = Some(index);
        while let Some(current) = ancestor {
            if self.classes.definitions[current].node.is_nil() {
                return Ok(None);
            }
            ancestor = self.classes.definitions[current].base;
        }
        let key_value = self.expression(node.left())?;
        let key_value = self.coerce(key_value, Type::Symbol, node.left())?;
        let receiver = self.expression(node.right())?;
        let receiver = self.coerce(receiver, self.classes.object(index), node.right())?;
        let mut helper = helpers::Helper::new(
            &format!("symbol_presence_{class_name}_{}", key.name()),
            vec![Type::Symbol, receiver.ty()],
            Type::Bool,
            self.loc(node),
        );
        if self.classes.symbol_method(index, key).is_some() {
            helper.function.body.push(Stmt::Return {
                value: Some(Expr::BoolLit {
                    value: true,
                    r#type: Type::Bool,
                    loc: helper.loc(),
                }),
                loc: helper.loc(),
            });
        } else {
            for child in 0..self.classes.definitions.len() {
                if child == index
                    || !self
                        .classes
                        .subclass(&self.classes.definitions[child].name, &class_name)
                    || self.classes.symbol_method(child, key).is_none()
                {
                    continue;
                }
                helper.function.body.push(Stmt::If {
                    cond: Expr::InstanceOf {
                        value: Box::new(helper.read(&helper.param(1))),
                        class_name: self.classes.definitions[child].name.clone(),
                        r#type: Type::Bool,
                        loc: helper.loc(),
                    },
                    then: vec![Stmt::Return {
                        value: Some(Expr::BoolLit {
                            value: true,
                            r#type: Type::Bool,
                            loc: helper.loc(),
                        }),
                        loc: helper.loc(),
                    }],
                    else_: None,
                    loc: helper.loc(),
                });
            }
            helper.function.body.push(Stmt::Return {
                value: Some(Expr::BoolLit {
                    value: false,
                    r#type: Type::Bool,
                    loc: helper.loc(),
                }),
                loc: helper.loc(),
            });
        }
        Ok(Some(Expr::Call {
            callee: self.install_helper(helper.function),
            args: vec![key_value, receiver],
            r#type: Type::Bool,
            loc: self.loc(node),
        }))
    }

    pub(in crate::frontend) fn class_symbol_key(
        &mut self,
        expression: Node,
    ) -> Option<SymbolMethodKey> {
        let mut expression = primitives::primitive_source(expression);
        let mut visited = HashSet::new();
        loop {
            if self.node_util_inspect_custom(expression) {
                return Some(SymbolMethodKey::InspectCustom);
            }
            if expression.kind() == SyntaxKind::PropertyAccessExpression
                && self.standard_symbol(expression.expression())
            {
                return SymbolMethodKey::from_name(expression.name().text());
            }
            if expression.kind() == SyntaxKind::PropertyAccessExpression {
                let symbol = self.checker.get_symbol_at_location(expression, false);
                if symbol.0 != 0 {
                    let declarations = self.checker.sym(symbol).declarations.clone();
                    if declarations.len() == 1
                        && self.imported_commonjs_symbol(expression, declarations[0])
                    {
                        return Some(SymbolMethodKey::Unique(symbol.0));
                    }
                }
                return None;
            }
            if expression.kind() != SyntaxKind::Identifier {
                return None;
            }
            let symbol = self.symbol(expression);
            if symbol == 0 || !visited.insert(symbol) {
                return None;
            }
            let declarations = self
                .checker
                .sym(source_frontend::prelude::SymbolId(symbol))
                .declarations
                .clone();
            if declarations.len() != 1 {
                return None;
            }
            let declaration = declarations[0];
            if self.imported_commonjs_symbol(expression, declaration) {
                return Some(SymbolMethodKey::Unique(symbol));
            }
            if declaration.kind() != SyntaxKind::VariableDeclaration
                || !declaration.parent().flags().intersects(NodeFlags::CONST)
                || declaration.parent().parent().parent().kind() != SyntaxKind::SourceFile
            {
                return None;
            }
            let initializer = declaration.initializer();
            if initializer.is_nil() {
                return None;
            }
            let initializer = primitives::primitive_source(initializer);
            if initializer.kind() == SyntaxKind::CallExpression {
                let callee = primitives::primitive_source(initializer.expression());
                if self.standard_symbol(callee)
                    || (callee.kind() == SyntaxKind::PropertyAccessExpression
                        && callee.name().text() == "for"
                        && self.standard_symbol(callee.expression()))
                {
                    return Some(SymbolMethodKey::Unique(symbol));
                }
            }
            expression = initializer;
        }
    }

    pub(in crate::frontend) fn request_symbol_method(
        &mut self,
        owner: usize,
        key: SymbolMethodKey,
        node: Node,
    ) -> Result<Signature, String> {
        if let Some(signature) = self.classes.symbol_signatures.get(&(owner, key)) {
            return Ok(signature.clone());
        }
        self.layout_class(owner)?;
        for member in self.classes.definitions[owner].node.members() {
            if matches!(
                member.kind(),
                SyntaxKind::MethodDeclaration | SyntaxKind::GetAccessor
            ) && member.name().kind() == SyntaxKind::ComputedPropertyName
                && member.body().is_nil()
                && self.class_symbol_key(member.name().expression()) == Some(key)
            {
                return Err(self.refuse(member, "overloaded symbol method bodies are not ported"));
            }
        }
        if !node.type_parameters().is_empty() || node.body().is_nil() {
            return Err(self.refuse(
                node,
                "demanded generic or overloaded symbol methods are not ported",
            ));
        }
        let file = std::mem::replace(&mut self.file, self.classes.definitions[owner].file.clone());
        let signature = self.function_signature(node, owner);
        self.file = file;
        let mut signature = signature?;
        signature.name = key.function_name(&self.classes.definitions[owner].name);
        for (index, param) in signature.params.iter_mut().enumerate() {
            param.local_id = format!("p{}", index + 1);
        }
        signature.params.insert(
            0,
            Param {
                local_id: "p0".into(),
                name: "this".into(),
                r#type: self.classes.object(owner),
            },
        );
        self.classes
            .symbol_signatures
            .insert((owner, key), signature.clone());
        self.classes.method_queue.push_back(signature.clone());
        let descriptor = self.classes.layouts[owner]
            .as_mut()
            .unwrap()
            .symbol_methods
            .iter_mut()
            .find(|method| method.key == key)
            .unwrap();
        descriptor.function = Some(signature.name.clone());
        Ok(signature)
    }

    pub(in crate::frontend) fn class_symbol_call(
        &mut self,
        call: Node,
    ) -> Result<Option<Expr>, String> {
        let member = call.expression();
        if member.kind() != SyntaxKind::ElementAccessExpression {
            return Ok(None);
        }
        let Some(key) = self.class_symbol_key(member.argument_expression()) else {
            return Ok(None);
        };
        let receiver = member.expression();
        let is_super = receiver.kind() == SyntaxKind::SuperKeyword;
        let ty = if is_super || receiver.kind() == SyntaxKind::ThisKeyword {
            self.instance_this
                .as_ref()
                .map(|local| local.r#type.clone())
        } else {
            self.ty(receiver).ok()
        };
        let Some(Type::Object { class_name }) = ty else {
            return Ok(None);
        };
        let Some(index) = self
            .classes
            .definitions
            .iter()
            .position(|class| class.name == class_name)
        else {
            return Ok(None);
        };
        for child in 0..self.classes.definitions.len() {
            self.resolve_class(child)?;
        }
        let lookup = if is_super {
            self.classes.definitions[index].base.ok_or_else(|| {
                self.refuse(call, "super symbol method requires a derived instance")
            })?
        } else {
            index
        };
        let Some((owner, node)) = self.classes.symbol_method(lookup, key) else {
            return Ok(None);
        };
        let signature = self.request_symbol_method(owner, key, node)?;
        let mut variants = Vec::new();
        if !is_super {
            for child in 0..self.classes.definitions.len() {
                if child == index
                    || !self
                        .classes
                        .subclass(&self.classes.definitions[child].name, &class_name)
                {
                    continue;
                }
                if let Some((implementation, node)) = self.classes.symbol_method(child, key) {
                    let other = self.request_symbol_method(implementation, key, node)?;
                    if other.params.iter().skip(1).map(|p| &p.r#type).ne(signature
                        .params
                        .iter()
                        .skip(1)
                        .map(|p| &p.r#type))
                        || other.return_type != signature.return_type
                    {
                        return Err(self.refuse(node, "symbol method override requires an identical native parameter/result ABI"));
                    }
                    // Include inherited implementations too: a deeper class may
                    // inherit the base implementation after a sibling overrides it.
                    variants.push((child, other));
                }
            }
        }
        let object = if is_super {
            self.this_expression(receiver)?
        } else {
            self.expression(receiver)?
        };
        let object = self.coerce(object, self.classes.object(index), receiver)?;
        let types = signature
            .params
            .iter()
            .skip(1)
            .map(|p| p.r#type.clone())
            .collect::<Vec<_>>();
        let mut args = vec![object];
        if primitives::primitive_source(member.argument_expression()).kind()
            == SyntaxKind::Identifier
        {
            let source = member.argument_expression();
            let value = self.expression(source)?;
            args.push(self.coerce(value, Type::Symbol, source)?);
        }
        let first_argument = args.len();
        args.extend(self.method_arguments(call, &types)?);
        let result = signature.return_type.clone();
        let mut helper = helpers::Helper::new(
            &format!("symbol_{class_name}_{}_{is_super}", key.name()),
            args.iter().map(Expr::ty).collect(),
            result.clone(),
            self.loc(call),
        );
        variants.sort_by_key(|(child, _)| {
            let mut depth = 0;
            let mut base = self.classes.definitions[*child].base;
            while let Some(index) = base {
                depth += 1;
                base = self.classes.definitions[index].base;
            }
            std::cmp::Reverse(depth)
        });
        let invoke = |target: &Signature, helper: &helpers::Helper| {
            let object = helper.read(&helper.param(0));
            let target_type = target.params[0].r#type.clone();
            let Type::Object {
                class_name: target_name,
            } = &target_type
            else {
                unreachable!()
            };
            let object = if object.ty() == target_type {
                object
            } else if self.classes.subclass(&class_name, target_name) {
                Expr::Upcast {
                    value: Box::new(object),
                    r#type: target_type,
                    loc: helper.loc(),
                }
            } else {
                Expr::Downcast {
                    value: Box::new(object),
                    r#type: target_type,
                    loc: helper.loc(),
                }
            };
            let call = Expr::Call {
                callee: target.name.clone(),
                args: std::iter::once(object)
                    .chain(
                        (first_argument..args.len()).map(|index| helper.read(&helper.param(index))),
                    )
                    .collect(),
                r#type: target.return_type.clone(),
                loc: helper.loc(),
            };
            if target.return_type == Type::Void {
                vec![
                    Stmt::Expression {
                        expr: call,
                        loc: helper.loc(),
                    },
                    Stmt::Return {
                        value: None,
                        loc: helper.loc(),
                    },
                ]
            } else {
                vec![Stmt::Return {
                    value: Some(call),
                    loc: helper.loc(),
                }]
            }
        };
        for (child, target) in variants {
            helper.function.body.push(Stmt::If {
                cond: Expr::InstanceOf {
                    value: Box::new(helper.read(&helper.param(0))),
                    class_name: self.classes.definitions[child].name.clone(),
                    r#type: Type::Bool,
                    loc: helper.loc(),
                },
                then: invoke(&target, &helper),
                else_: None,
                loc: helper.loc(),
            });
        }
        helper.function.body.extend(invoke(&signature, &helper));
        let callee = self.install_helper(helper.function);
        Ok(Some(Expr::Call {
            callee,
            args,
            r#type: result,
            loc: self.loc(call),
        }))
    }
}
