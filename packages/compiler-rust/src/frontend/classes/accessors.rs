//! Prototype descriptors normalize to receiver-explicit calls in portable IR.
//! Data slots remain separate: a getter is never loaded from instance storage.
use super::*;

impl ClassGraph {
    pub(super) fn abstract_property(&self, mut owner: usize, name: &str) -> Option<(usize, Node)> {
        for _ in 0..=self.definitions.len() {
            let definition = &self.definitions[owner];
            if !definition.node.is_nil()
                && let Some(node) = definition.node.members().into_iter().find(|member| {
                    member.kind() == SyntaxKind::PropertyDeclaration
                        && member.modifier_flags().intersects(ModifierFlags::ABSTRACT)
                        && member.name().text() == name
                })
            {
                return Some((owner, node));
            }
            owner = definition.base?;
        }
        None
    }

    pub(in crate::frontend) fn accessor(
        &self,
        mut owner: usize,
        name: &str,
    ) -> Option<(usize, Node, Node)> {
        for _ in 0..=self.definitions.len() {
            if self.definitions[owner].node.is_nil() {
                return None;
            }
            let mut get = Node::NIL;
            let mut set = Node::NIL;
            for member in self.definitions[owner].node.members() {
                if !matches!(
                    member.kind(),
                    SyntaxKind::GetAccessor | SyntaxKind::SetAccessor
                ) || member.modifier_flags().intersects(ModifierFlags::STATIC)
                {
                    continue;
                }
                if member.name().text() != name {
                    continue;
                }
                match member.kind() {
                    SyntaxKind::GetAccessor => get = member,
                    SyntaxKind::SetAccessor => set = member,
                    _ => {}
                }
            }
            if !get.is_nil() || !set.is_nil() {
                // A derived descriptor replaces the entire inherited one;
                // missing halves must not fall through to a base accessor.
                return Some((owner, get, set));
            }
            owner = self.definitions[owner].base?;
        }
        None
    }
}

impl Lowerer<'_> {
    pub(super) fn abstract_property_get(
        &mut self,
        site: Node,
        object: Expr,
        name: &str,
    ) -> Result<Option<Expr>, String> {
        let Type::Object { class_name } = object.ty() else {
            return Ok(None);
        };
        let Some(index) = self
            .classes
            .definitions
            .iter()
            .position(|definition| definition.name == class_name)
        else {
            return Ok(None);
        };
        let Some((_, declaration)) = self.classes.abstract_property(index, name) else {
            return Ok(None);
        };
        let result = self.ty(declaration.name())?;
        enum Implementation {
            Accessor(usize, Signature),
            Field(usize, Type),
        }
        let descendants = self
            .classes
            .definitions
            .iter()
            .enumerate()
            .filter(|(child, definition)| {
                *child != index
                    && self.classes.subclass(&definition.name, &class_name)
                    && !definition
                        .node
                        .modifier_flags()
                        .intersects(ModifierFlags::ABSTRACT)
            })
            .map(|(child, _)| child)
            .collect::<Vec<_>>();
        let mut variants = Vec::new();
        for child in descendants {
            self.resolve_class(child)?;
            self.layout_class(child)?;
            if let Some((owner, getter, _)) = self.classes.accessor(child, name) {
                if getter.is_nil() {
                    return Err(self.refuse(site, "abstract property implementation is write-only"));
                }
                let signature = self.request_accessor(owner, name, false, getter)?;
                if signature.return_type != result {
                    return Err(self.refuse(
                        getter,
                        "abstract property getter has a different native result ABI",
                    ));
                }
                variants.push((child, Implementation::Accessor(owner, signature)));
                continue;
            }
            let child_name = self.classes.definitions[child].name.clone();
            let Some(storage) = self.field_type(&child_name, name) else {
                return Err(self.refuse(
                    site,
                    "concrete subclass does not implement the abstract property",
                ));
            };
            variants.push((child, Implementation::Field(child, storage)));
        }
        if variants.is_empty() {
            return Err(self.refuse(
                site,
                "abstract property has no concrete native implementation",
            ));
        }
        variants.sort_by_key(|(child, _)| {
            let mut depth = 0;
            let mut owner = self.classes.definitions[*child].base;
            while let Some(parent) = owner {
                depth += 1;
                owner = self.classes.definitions[parent].base;
            }
            std::cmp::Reverse(depth)
        });
        let mut helper = helpers::Helper::new(
            &format!("abstract_property_get_{class_name}_{name}"),
            vec![object.ty()],
            result.clone(),
            self.loc(site),
        );
        for (child, implementation) in variants {
            let child_name = self.classes.definitions[child].name.clone();
            let receiver = Expr::Downcast {
                value: Box::new(helper.read(&helper.param(0))),
                r#type: self.classes.object(child),
                loc: helper.loc(),
            };
            let value = match implementation {
                Implementation::Accessor(owner, signature) => {
                    let owner_name = self.classes.definitions[owner].name.clone();
                    let receiver = if owner == child {
                        receiver
                    } else {
                        Expr::Upcast {
                            value: Box::new(receiver),
                            r#type: Type::Object {
                                class_name: owner_name,
                            },
                            loc: helper.loc(),
                        }
                    };
                    Expr::Call {
                        callee: signature.name,
                        args: vec![receiver],
                        r#type: signature.return_type,
                        loc: helper.loc(),
                    }
                }
                Implementation::Field(owner, storage) => {
                    let value = Expr::FieldGet {
                        obj: Box::new(receiver),
                        class_name: self.classes.definitions[owner].name.clone(),
                        field: name.into(),
                        r#type: storage,
                        loc: helper.loc(),
                    };
                    self.coerce(value, result.clone(), site)?
                }
            };
            helper.function.body.push(Stmt::If {
                cond: Expr::InstanceOf {
                    value: Box::new(helper.read(&helper.param(0))),
                    class_name: child_name,
                    r#type: Type::Bool,
                    loc: helper.loc(),
                },
                then: vec![Stmt::Return {
                    value: Some(value),
                    loc: helper.loc(),
                }],
                else_: None,
                loc: helper.loc(),
            });
        }
        self.ensure_exception_classes(site)?;
        helper.function.body.push(Stmt::Throw {
            value: Expr::LibCall {
                r#fn: "error.new".into(),
                args: vec![Expr::StrLit {
                    value: format!("Cannot read abstract property {name}"),
                    r#type: Type::String,
                    loc: helper.loc(),
                }],
                r#type: Type::Object {
                    class_name: "%TypeError".into(),
                },
                loc: helper.loc(),
            },
            loc: helper.loc(),
        });
        Ok(Some(Expr::Call {
            callee: self.install_helper(helper.function),
            args: vec![object],
            r#type: result,
            loc: self.loc(site),
        }))
    }

    pub(in crate::frontend) fn class_accessor_assignment(
        &mut self,
        node: Node,
    ) -> Result<Option<Expr>, String> {
        let member = node.left();
        let receiver = member.expression();
        let ty = if matches!(
            receiver.kind(),
            SyntaxKind::ThisKeyword | SyntaxKind::SuperKeyword
        ) {
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
            .position(|d| d.name == class_name)
        else {
            return Ok(None);
        };
        // Runtime-owned classes (notably Error) have no source prototype
        // declaration to inspect. Their expando writes are ordinary dynamic
        // properties, not source accessors.
        if self.classes.definitions[index].node.is_nil() {
            return Ok(None);
        }
        self.resolve_class(index)?;
        let lookup = if receiver.kind() == SyntaxKind::SuperKeyword {
            self.classes.definitions[index].base.ok_or_else(|| {
                self.refuse(node, "super property requires a derived instance body")
            })?
        } else {
            index
        };
        let name = member.name().text();
        let Some((owner, _, setter)) = self.classes.accessor(lookup, name) else {
            return Ok(None);
        };
        if setter.is_nil() {
            return Err(self.refuse(node, "writing a getter-only property is not ported"));
        }
        let signature = self.request_accessor(owner, name, true, setter)?;
        let object = if receiver.kind() == SyntaxKind::SuperKeyword {
            self.this_expression(receiver)?
        } else {
            self.expression(receiver)?
        };
        let value = self.expected_expression(node.right(), signature.params[1].r#type.clone())?;
        let value = self
            .accessor_call(member, object, name, Some(value))?
            .unwrap();
        Ok(Some(self.narrowed(value, node)?))
    }

    pub(in crate::frontend) fn request_accessor(
        &mut self,
        owner: usize,
        name: &str,
        write: bool,
        node: Node,
    ) -> Result<Signature, String> {
        let key = (owner, name.to_string(), write);
        if let Some(signature) = self.classes.accessors.get(&key) {
            return Ok(signature.clone());
        }
        self.layout_class(owner)?;
        if node.body().is_nil()
            || !node.type_parameters().is_empty()
            || node.parameters().len() != usize::from(write)
        {
            return Err(self.refuse(
                node,
                "accessors require a concrete getter or one-parameter setter",
            ));
        }
        if let Some((_, ty)) = self
            .class_contract(self.classes.definitions[owner].node)
            .and_then(|hint| hint.fields.iter().find(|(field, _)| field == name))
            .cloned()
        {
            let ty =
                ty.ok_or_else(|| self.refuse(node, "public accessor has no native property type"))?;
            self.declarations.insert(
                declarations::Key::of(node),
                declarations::Hint {
                    rest: false,
                    params: if write {
                        vec![Some(ty.clone())]
                    } else {
                        vec![]
                    },
                    optional: vec![false; usize::from(write)],
                    parametric_callback_results: vec![false; usize::from(write)],
                    ret: Some(if write { Type::Void } else { ty }),
                    reason: None,
                    value_type: None,
                    class: None,
                },
            );
        }
        let file = std::mem::replace(&mut self.file, self.classes.definitions[owner].file.clone());
        let signature = self.function_signature(node, owner);
        self.file = file;
        let mut signature = signature?;
        if write && signature.return_type != Type::Void {
            return Err(self.refuse(node, "setter return values are not ported"));
        }
        signature.name = format!(
            "%{}.{}:{name}",
            self.classes.definitions[owner].name,
            if write { "set" } else { "get" }
        );
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
        self.classes.accessors.insert(key, signature.clone());
        self.classes.method_queue.push_back(signature.clone());
        Ok(signature)
    }

    pub(super) fn accessor_call(
        &mut self,
        site: Node,
        object: Expr,
        name: &str,
        value: Option<Expr>,
    ) -> Result<Option<Expr>, String> {
        let Type::Object { class_name } = object.ty() else {
            return Ok(None);
        };
        let Some(index) = self
            .classes
            .definitions
            .iter()
            .position(|d| d.name == class_name)
        else {
            return Ok(None);
        };
        self.resolve_class(index)?;
        let is_super = site.expression().kind() == SyntaxKind::SuperKeyword;
        let lookup = if is_super {
            self.classes.definitions[index].base.ok_or_else(|| {
                self.refuse(site, "super property requires a derived instance body")
            })?
        } else {
            index
        };
        let Some((owner, get, set)) = self.classes.accessor(lookup, name) else {
            return Ok(None);
        };
        let write = value.is_some();
        let node = if write { set } else { get };
        if node.is_nil() {
            return Err(self.refuse(site, "accessor read/write requires its own descriptor half; inherited halves are not merged"));
        }
        let signature = self.request_accessor(owner, name, write, node)?;
        let args = if let Some(value) = value {
            vec![
                object,
                self.coerce(value, signature.params[1].r#type.clone(), site)?,
            ]
        } else {
            vec![object]
        };
        let mut variants = vec![];
        if !is_super {
            for child in 0..self.classes.definitions.len() {
                self.resolve_class(child)?;
                if child == index
                    || !self
                        .classes
                        .subclass(&self.classes.definitions[child].name, &class_name)
                {
                    continue;
                }
                self.layout_class(child)?;
                let Some((implementation, get, set)) = self.classes.accessor(child, name) else {
                    return Err(self.refuse(site, "accessor override changes the property kind"));
                };
                if implementation == owner {
                    continue;
                }
                let node = if write { set } else { get };
                if node.is_nil() {
                    return Err(self.refuse(
                        site,
                        "accessor override omits the requested descriptor half",
                    ));
                }
                let other = self.request_accessor(implementation, name, write, node)?;
                if other.params.iter().skip(1).map(|p| &p.r#type).ne(signature
                    .params
                    .iter()
                    .skip(1)
                    .map(|p| &p.r#type))
                    || other.return_type != signature.return_type
                {
                    return Err(self.refuse(
                        node,
                        "accessor override requires an identical native parameter/result ABI",
                    ));
                }
                variants.push((child, other));
            }
        }
        // The helper evaluates receiver then RHS exactly once. Its return value
        // is the assigned RHS, independent of the setter's void result.
        let result = if write {
            args[1].ty()
        } else {
            signature.return_type.clone()
        };
        let mut helper = helpers::Helper::new(
            &format!(
                "accessor_{class_name}_{}_{}_{name}",
                if is_super { "super" } else { "virtual" },
                if write { "set" } else { "get" }
            ),
            args.iter().map(Expr::ty).collect(),
            result.clone(),
            self.loc(site),
        );
        variants.sort_by_key(|(child, _)| {
            let mut depth = 0;
            let mut owner = self.classes.definitions[*child].base;
            while let Some(index) = owner {
                depth += 1;
                owner = self.classes.definitions[index].base;
            }
            std::cmp::Reverse(depth)
        });
        let invoke = |target: &Signature, helper: &helpers::Helper| {
            let receiver = helper.read(&helper.param(0));
            let target_type = target.params[0].r#type.clone();
            let receiver = if receiver.ty() == target_type {
                receiver
            } else {
                let Type::Object {
                    class_name: target_name,
                } = &target_type
                else {
                    unreachable!()
                };
                if self.classes.subclass(&class_name, target_name) {
                    Expr::Upcast {
                        value: Box::new(receiver),
                        r#type: target_type,
                        loc: helper.loc(),
                    }
                } else {
                    Expr::Downcast {
                        value: Box::new(receiver),
                        r#type: target_type,
                        loc: helper.loc(),
                    }
                }
            };
            let call = Expr::Call {
                callee: target.name.clone(),
                args: std::iter::once(receiver)
                    .chain((1..args.len()).map(|i| helper.read(&helper.param(i))))
                    .collect(),
                r#type: target.return_type.clone(),
                loc: helper.loc(),
            };
            if write {
                vec![
                    Stmt::Expression {
                        expr: call,
                        loc: helper.loc(),
                    },
                    Stmt::Return {
                        value: Some(helper.read(&helper.param(1))),
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
            loc: self.loc(site),
        }))
    }
}
