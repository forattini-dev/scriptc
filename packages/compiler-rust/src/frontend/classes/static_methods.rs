//! Direct static calls carry the class receiver when their body observes it.
use super::*;

pub(super) fn reads_super(node: Node) -> bool {
    fn visit(node: Node, root: bool) -> bool {
        if node.kind() == SyntaxKind::SuperKeyword {
            return true;
        }
        if !root
            && matches!(
                node.kind(),
                SyntaxKind::ClassDeclaration | SyntaxKind::ClassExpression
            )
        {
            return node.heritage_clauses().nodes().into_iter().any(|clause| {
                clause
                    .types()
                    .nodes()
                    .into_iter()
                    .any(|base| visit(base.expression(), false))
            });
        }
        if !root
            && matches!(
                node.kind(),
                SyntaxKind::FunctionDeclaration
                    | SyntaxKind::FunctionExpression
                    | SyntaxKind::MethodDeclaration
                    | SyntaxKind::GetAccessor
                    | SyntaxKind::SetAccessor
            )
        {
            return false;
        }
        let mut found = false;
        node.for_each_child(&mut |child| {
            found |= visit(child, false);
            false
        });
        found
    }
    visit(node, true)
}

impl Lowerer<'_> {
    fn static_method_reads_own_class(&self, method: Node, class: Node) -> bool {
        let name = class.name();
        if name.is_nil() {
            return false;
        }
        let class_name = name.text().to_string();
        fn visit(node: Node, root: Node, class_name: &str) -> bool {
            if node.kind() == SyntaxKind::Identifier
                && node.text() == class_name
                && !(node.parent().kind() == SyntaxKind::PropertyAccessExpression
                    && node.parent().name() == node)
            {
                return true;
            }
            if node != root
                && matches!(
                    node.kind(),
                    SyntaxKind::ClassDeclaration
                        | SyntaxKind::ClassExpression
                        | SyntaxKind::FunctionDeclaration
                        | SyntaxKind::FunctionExpression
                        | SyntaxKind::ArrowFunction
                )
            {
                return false;
            }
            let mut found = false;
            node.for_each_child(&mut |child| {
                found |= visit(child, root, class_name);
                found
            });
            found
        }
        visit(method, method, &class_name)
    }

    pub(in crate::frontend) fn class_static_method_value(
        &mut self,
        member: Node,
    ) -> Result<Option<Expr>, String> {
        if member.kind() != SyntaxKind::PropertyAccessExpression
            || member.expression().kind() != SyntaxKind::Identifier
        {
            return Ok(None);
        }
        let receiver = member.expression();
        self.class_static_method_named(receiver, member.name().text(), member)
    }

    pub(in crate::frontend) fn class_static_method_named(
        &mut self,
        receiver: Node,
        member_name: &str,
        site: Node,
    ) -> Result<Option<Expr>, String> {
        if receiver.kind() != SyntaxKind::Identifier {
            return Ok(None);
        }
        let Some(index) = self.class_symbol(receiver) else {
            return Ok(None);
        };
        let definition = self.classes.definitions[index].clone();
        if definition.node.is_nil()
            || definition.token.is_none()
            || self.symbol(receiver) != self.symbol(definition.node.name())
        {
            return Ok(None);
        }
        self.resolve_class(index)?;
        let name = member_name.to_string();
        let mut current = Some(index);
        let mut found = None;
        while let Some(owner) = current {
            let owner_definition = &self.classes.definitions[owner];
            if !owner_definition.node.is_nil()
                && let Some(node) = owner_definition
                    .node
                    .members()
                    .into_iter()
                    .rev()
                    .find(|node| {
                        node.kind() == SyntaxKind::MethodDeclaration
                            && node.modifier_flags().intersects(ModifierFlags::STATIC)
                            && node.name().text() == name
                    })
            {
                found = Some((owner, node));
                break;
            }
            current = owner_definition.base;
        }
        let Some((owner, method)) = found else {
            return Ok(None);
        };
        if receivers::reads_this(method) {
            return Err(self.refuse(site, "extracted static method this is not ported"));
        }
        // A direct call to a method that references its own class can carry a
        // hidden class receiver. An extracted method has no such argument.
        // Keep their signatures separate so whichever form is lowered first
        // cannot change the other's argument count.
        let separate_extracted = owner == index
            && self.static_method_reads_own_class(method, self.classes.definitions[owner].node);
        let key = (owner, index, name.clone());
        let cached = if separate_extracted {
            self.classes.static_extracted_methods.get(&key)
        } else {
            self.classes.static_methods.get(&key)
        };
        let signature = if let Some(signature) = cached {
            signature.clone()
        } else {
            if !method.type_parameters().is_empty()
                || method.body().is_nil()
                || self.classes.definitions[owner]
                    .node
                    .members()
                    .into_iter()
                    .any(|candidate| {
                        candidate.kind() == SyntaxKind::MethodDeclaration
                            && candidate.modifier_flags().intersects(ModifierFlags::STATIC)
                            && candidate.name().text() == name
                            && candidate.body().is_nil()
                    })
            {
                return Err(self.refuse(
                    method,
                    "generic and overloaded static methods are not ported",
                ));
            }
            let file =
                std::mem::replace(&mut self.file, self.classes.definitions[owner].file.clone());
            let signature = self.function_signature(method, owner);
            self.file = file;
            let mut signature = signature?;
            let suffix = if separate_extracted { "$extracted" } else { "" };
            signature.name = format!(
                "%{}.static.{name}.receiver.{}{suffix}",
                self.classes.definitions[owner].name, self.classes.definitions[index].name
            );
            if separate_extracted {
                self.classes
                    .static_extracted_methods
                    .insert(key, signature.clone());
            } else {
                self.classes.static_methods.insert(key, signature.clone());
            }
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
        Ok(Some(Expr::Sequence {
            stmts: vec![Stmt::Expression {
                expr: self.read_class_token(definition.token.as_ref().unwrap(), receiver),
                loc: self.loc(receiver),
            }],
            result: Box::new(Expr::Closure {
                fn_name: signature.name,
                captures: vec![],
                r#type: ty.clone(),
                loc: self.loc(site),
            }),
            r#type: ty,
            loc: self.loc(site),
        }))
    }

    pub(in crate::frontend) fn class_static_get(
        &mut self,
        member: Node,
    ) -> Result<Option<Expr>, String> {
        if member.kind() != SyntaxKind::PropertyAccessExpression
            || member.expression().kind() != SyntaxKind::Identifier
        {
            return Ok(None);
        }
        let receiver = member.expression();
        let Some(index) = self.class_symbol(receiver) else {
            return Ok(None);
        };
        let definition = self.classes.definitions[index].clone();
        if definition.node.is_nil()
            || definition.token.is_none()
            || self.symbol(receiver) != self.symbol(definition.node.name())
        {
            return Ok(None);
        }
        self.resolve_class(index)?;
        let name = member.name().text().to_string();
        let mut current = Some(index);
        let mut found = None;
        while let Some(owner) = current {
            let owner_definition = &self.classes.definitions[owner];
            if !owner_definition.node.is_nil()
                && let Some(node) = owner_definition
                    .node
                    .members()
                    .into_iter()
                    .rev()
                    .find(|node| {
                        node.kind() == SyntaxKind::GetAccessor
                            && node.modifier_flags().intersects(ModifierFlags::STATIC)
                            && node.name().text() == name
                    })
            {
                found = Some((owner, node));
                break;
            }
            current = owner_definition.base;
        }
        let Some((owner, getter)) = found else {
            return Ok(None);
        };
        let has_receiver = receivers::reads_this(getter);
        let key = (owner, index, name.clone());
        let signature = if let Some(signature) = self.classes.static_accessors.get(&key) {
            signature.clone()
        } else {
            if getter.body().is_nil()
                || !getter.type_parameters().is_empty()
                || !getter.parameters().is_empty()
            {
                return Err(self.refuse(
                    getter,
                    "static getters require a concrete zero-parameter body",
                ));
            }
            let file =
                std::mem::replace(&mut self.file, self.classes.definitions[owner].file.clone());
            let signature = self.function_signature(getter, owner);
            self.file = file;
            let mut signature = signature?;
            signature.name = format!(
                "%{}.static.get:{name}.receiver.{}",
                self.classes.definitions[owner].name, self.classes.definitions[index].name
            );
            if has_receiver {
                for (position, param) in signature.params.iter_mut().enumerate() {
                    param.local_id = format!("p{}", position + 1);
                }
                signature.params.insert(
                    0,
                    Param {
                        local_id: "p0".into(),
                        name: "this".into(),
                        r#type: Type::Classval {
                            class_name: definition.name.clone(),
                        },
                    },
                );
            }
            self.classes.static_accessors.insert(key, signature.clone());
            self.classes.method_queue.push_back(signature.clone());
            signature
        };
        let mut args = Vec::new();
        if has_receiver {
            self.request_constructor(index)?;
            args.push(Expr::ClassRef {
                class_name: definition.name.clone(),
                r#type: Type::Classval {
                    class_name: definition.name.clone(),
                },
                loc: self.loc(receiver),
            });
        }
        let result = Expr::Call {
            callee: signature.name,
            args,
            r#type: signature.return_type.clone(),
            loc: self.loc(member),
        };
        Ok(Some(Expr::Sequence {
            stmts: vec![Stmt::Expression {
                expr: self.read_class_token(definition.token.as_ref().unwrap(), receiver),
                loc: self.loc(receiver),
            }],
            result: Box::new(result),
            r#type: signature.return_type,
            loc: self.loc(member),
        }))
    }

    pub(in crate::frontend) fn class_static_call(
        &mut self,
        call: Node,
    ) -> Result<Option<Expr>, String> {
        let member = call.expression();
        if member.kind() != SyntaxKind::PropertyAccessExpression {
            return Ok(None);
        }
        let receiver = member.expression();
        let Some(index) = self.class_symbol(receiver) else {
            return Ok(None);
        };
        let definition = self.classes.definitions[index].clone();
        if definition.node.is_nil() {
            return Ok(None);
        }
        self.resolve_class(index)?;
        let name = member.name().text().to_string();
        let mut owner = Some(index);
        let mut found = None;
        while let Some(current) = owner {
            let definition = &self.classes.definitions[current];
            if !definition.node.is_nil()
                && let Some(node) = definition.node.members().into_iter().rev().find(|node| {
                    node.kind() == SyntaxKind::MethodDeclaration
                        && node.modifier_flags().intersects(ModifierFlags::STATIC)
                        && node.name().text() == name
                })
            {
                found = Some((current, node));
                break;
            }
            owner = definition.base;
        }
        let Some((owner, node)) = found else {
            return Ok(None);
        };
        let has_receiver = receivers::reads_this(node)
            || (owner == index
                && self.static_method_reads_own_class(node, self.classes.definitions[owner].node));
        let statements = if node.body().is_nil() {
            Vec::new()
        } else {
            node.body().statements().into_iter().collect::<Vec<_>>()
        };
        let returns_receiver = has_receiver
            && node.type_().is_nil()
            && self.declared(node).is_none()
            && !node.modifier_flags().intersects(ModifierFlags::ASYNC)
            && statements.len() == 1
            && statements[0].kind() == SyntaxKind::ReturnStatement
            && !statements[0].expression().is_nil()
            && primitives::primitive_source(statements[0].expression()).kind()
                == SyntaxKind::ThisKeyword;
        let key = (owner, index, name.clone());
        let signature = if let Some(signature) = self.classes.static_methods.get(&key) {
            signature.clone()
        } else {
            if !node.type_parameters().is_empty()
                || node.body().is_nil()
                || self.classes.definitions[owner]
                    .node
                    .members()
                    .into_iter()
                    .any(|member| {
                        member.kind() == SyntaxKind::MethodDeclaration
                            && member.modifier_flags().intersects(ModifierFlags::STATIC)
                            && member.name().text() == name
                            && member.body().is_nil()
                    })
            {
                return Err(
                    self.refuse(node, "generic and overloaded static methods are not ported")
                );
            }
            let file =
                std::mem::replace(&mut self.file, self.classes.definitions[owner].file.clone());
            let signature = self.function_signature(node, owner);
            self.file = file;
            let mut signature = signature?;
            if returns_receiver {
                // Preserve the actual constructor when the method is inherited.
                signature.return_type = Type::Classval {
                    class_name: definition.name.clone(),
                };
            }
            signature.name = format!(
                "%{}.static.{name}.receiver.{}",
                self.classes.definitions[owner].name, self.classes.definitions[index].name
            );
            if has_receiver {
                for (position, param) in signature.params.iter_mut().enumerate() {
                    param.local_id = format!("p{}", position + 1);
                }
                signature.params.insert(
                    0,
                    Param {
                        local_id: "p0".into(),
                        name: "this".into(),
                        r#type: Type::Classval {
                            class_name: definition.name.clone(),
                        },
                    },
                );
            }
            self.classes.static_methods.insert(key, signature.clone());
            self.classes.method_queue.push_back(signature.clone());
            signature
        };
        let types = signature
            .params
            .iter()
            .skip(usize::from(has_receiver))
            .map(|p| p.r#type.clone())
            .collect::<Vec<_>>();
        let mut args = if signature.rest {
            self.rest_call_arguments(call, &types, true)?
        } else {
            self.method_arguments(call, &types)?
        };
        if has_receiver {
            self.request_constructor(index)?;
            let expected_receiver = Type::Classval {
                class_name: definition.name.clone(),
            };
            let receiver_value = self.expression(receiver)?;
            let receiver_value = if receiver_value.ty() == expected_receiver {
                receiver_value
            } else {
                // CommonJS class exports retain their runtime constructor
                // identity in a dynamic owning slot. The static body still
                // needs that exact receiver for `this` and named-class self
                // references, so project it back to the proven layout here.
                self.coerce(receiver_value, expected_receiver, receiver)?
            };
            args.insert(0, receiver_value);
        }
        let result = Expr::Call {
            callee: signature.name,
            args,
            r#type: signature.return_type.clone(),
            loc: self.loc(call),
        };
        if receiver.kind() == SyntaxKind::Identifier
            && let Some(token) = definition.token.as_ref()
            && self.symbol(receiver) == self.symbol(definition.node.name())
        {
            return Ok(Some(Expr::Sequence {
                stmts: vec![Stmt::Expression {
                    expr: self.read_class_token(token, receiver),
                    loc: self.loc(receiver),
                }],
                result: Box::new(result),
                r#type: signature.return_type,
                loc: self.loc(call),
            }));
        }
        Ok(Some(result))
    }
}
