//! Declaration-owned private slots use internal ephemeron tables in portable IR.
//! Table presence is the brand/installation bit; stored undefined is a value.
use super::*;

#[derive(Clone)]
pub(super) struct Slot {
    owner: usize,
    declaration: Node,
    label: String,
    global: ir::Global,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Access {
    Read,
    Write,
    Install,
    MethodReceiver,
}

impl Lowerer<'_> {
    pub(in crate::frontend) fn private_brand_check(&mut self, node: Node) -> Result<Expr, String> {
        let slot = self.private_slot(node.left())?;
        let receiver = self.expression(node.right())?;
        let key = if matches!(receiver.ty(), Type::Object { .. }) {
            receiver
        } else if self.dynamic_erasure_reason(&receiver.ty()).is_none() {
            self.coerce(receiver, Type::Dyn, node.right())?
        } else {
            return Err(self.refuse(
                node.right(),
                "private brand checks require an identity-bearing object",
            ));
        };
        Ok(Expr::LibCall {
            r#fn: "weakmap.has".into(),
            args: vec![
                Expr::VarRef {
                    local_id: slot.global.id,
                    r#type: slot.global.r#type,
                    loc: self.loc(node.left()),
                },
                key,
            ],
            r#type: Type::Bool,
            loc: self.loc(node),
        })
    }

    pub(super) fn inventory_private_slots(&mut self, owner: usize) -> Result<(), String> {
        let node = self.classes.definitions[owner].node;
        let mut names = HashSet::new();
        for (ordinal, field) in node
            .members()
            .into_iter()
            .filter(|n| {
                matches!(
                    n.kind(),
                    SyntaxKind::PropertyDeclaration
                        | SyntaxKind::MethodDeclaration
                        | SyntaxKind::GetAccessor
                ) && n.name().kind() == SyntaxKind::PrivateIdentifier
            })
            .enumerate()
        {
            if field.modifier_flags().intersects(ModifierFlags::AMBIENT)
                || !names.insert(field.name().text().to_string())
            {
                return Err(self.refuse(
                    field,
                    "ambient or duplicate private declarations are not ported",
                ));
            }
            let symbol = self.symbol(field.name());
            if symbol == 0 {
                return Err(self.refuse(field, "private field has no lexical declaration identity"));
            }
            if self.classes.private_slots.contains_key(&symbol) {
                continue;
            }
            let global = ir::Global {
                id: format!(
                    "%g.private.{}.{ordinal}",
                    self.classes.definitions[owner].name
                ),
                name: format!("private slot {ordinal}"),
                r#type: Type::Object {
                    class_name: weak_maps::CLASS.into(),
                },
                mutable: false,
                loc: self.loc(field),
            };
            self.globals.push(global.clone());
            self.classes.private_slots.insert(
                symbol,
                Slot {
                    owner,
                    declaration: field,
                    label: field.name().text().into(),
                    global,
                },
            );
        }
        Ok(())
    }

    fn private_slot(&mut self, name: Node) -> Result<Slot, String> {
        let symbol = self.symbol(name);
        if let Some(slot) = self.classes.private_slots.get(&symbol) {
            return Ok(slot.clone());
        }
        // Checked projections can expose a transient member symbol. Resolve
        // the lexical private environment, never the receiver's public type.
        let mut scope = name.parent();
        while !scope.is_nil() {
            if matches!(
                scope.kind(),
                SyntaxKind::ClassDeclaration | SyntaxKind::ClassExpression
            ) && let Some(member) = scope.members().into_iter().find(|member| {
                !member.name().is_nil()
                    && member.name().kind() == SyntaxKind::PrivateIdentifier
                    && member.name().text() == name.text()
            }) {
                let symbol = self.symbol(member.name());
                if let Some(slot) = self.classes.private_slots.get(&symbol) {
                    return Ok(slot.clone());
                }
                break;
            }
            scope = scope.parent();
        }
        Err(self.refuse(
            name,
            "unresolved private declaration; private accessors are not ported",
        ))
    }

    // This intrinsic identity is independent of source bindings and lib choices.
    pub(in crate::frontend::classes) fn private_table_constructor(
        &mut self,
        site: Node,
    ) -> Result<(), String> {
        let index = if let Some(index) = self
            .classes
            .definitions
            .iter()
            .position(|d| d.name == weak_maps::CLASS)
        {
            index
        } else {
            let index = self.classes.definitions.len();
            self.classes.definitions.push(Definition {
                node: Node::NIL,
                name: weak_maps::CLASS.into(),
                file: "<builtin>".into(),
                base: None,
                resolved: true,
                resolving: false,
                signature: None,
                token: None,
                captures: Vec::new(),
            });
            self.classes.layouts.push(Some(ir::Class {
                name: weak_maps::CLASS.into(),
                js_name: "WeakMap".into(),
                runtime: false,
                base: None,
                fields: vec![],
                captures: vec![],
                methods: vec![],
                symbol_methods: vec![],
                symbol_brand: None,
                method_names: vec!["get".into(), "set".into(), "has".into(), "delete".into()],
                loc: self.loc(site),
            }));
            index
        };
        self.request_constructor(index)?;
        Ok(())
    }

    pub(super) fn initialize_private_storage(
        &mut self,
        owner: usize,
        site: Node,
    ) -> Result<Vec<Stmt>, String> {
        let mut body = vec![];
        for field in self.classes.definitions[owner].node.members() {
            if !matches!(
                field.kind(),
                SyntaxKind::PropertyDeclaration
                    | SyntaxKind::MethodDeclaration
                    | SyntaxKind::GetAccessor
            ) || field.name().kind() != SyntaxKind::PrivateIdentifier
            {
                continue;
            }
            self.private_table_constructor(site)?;
            let slot = self.private_slot(field.name())?;
            body.push(Stmt::Assign {
                local_id: slot.global.id,
                initializes_global: true,
                value: Expr::New {
                    class_name: weak_maps::CLASS.into(),
                    args: vec![],
                    r#type: slot.global.r#type,
                    loc: self.loc(site),
                },
                loc: self.loc(site),
            });
        }
        Ok(body)
    }

    fn private_receiver(&mut self, mut node: Node) -> Result<Expr, String> {
        // Assertions are erased by JavaScript; brand checking observes the
        // original value, rather than an earlier checked class projection.
        while matches!(
            node.kind(),
            SyntaxKind::ParenthesizedExpression
                | SyntaxKind::AsExpression
                | SyntaxKind::TypeAssertionExpression
                | SyntaxKind::SatisfiesExpression
                | SyntaxKind::NonNullExpression
        ) {
            node = node.expression();
        }
        let value = self.expression(node)?;
        if matches!(value.ty(), Type::Null | Type::Undefined) {
            self.coerce(value, Type::Dyn, node)
        } else {
            Ok(value)
        }
    }

    pub(in crate::frontend) fn private_get(&mut self, node: Node) -> Result<Expr, String> {
        let slot = self.private_slot(node.name())?;
        if slot.declaration.kind() == SyntaxKind::MethodDeclaration {
            let signature = self.request_private_method(&slot)?;
            let receiver = self.private_receiver(node.expression())?;
            let receiver = if matches!(receiver.ty(), Type::Union { .. }) {
                self.coerce(receiver, Type::Dyn, node.expression())?
            } else {
                receiver
            };
            // PrivateGet performs the lexical brand check before producing the
            // callable. Native closures have no implicit JavaScript `this`
            // channel, so retain that checked receiver as an explicit capture.
            let receiver =
                self.private_access(&slot, receiver, None, Access::MethodReceiver, node)?;
            let params = signature
                .params
                .iter()
                .skip(1)
                .map(|param| param.r#type.clone())
                .collect::<Vec<_>>();
            let callable = Type::Func {
                rest: signature.rest,
                params: params.clone(),
                ret: Box::new(signature.return_type.clone()),
            };
            let adapter_name = format!("private_method_value_{}", self.next_closure);
            self.next_closure += 1;
            let capture = Param {
                local_id: "c0".into(),
                name: "this".into(),
                r#type: receiver.ty(),
            };
            let mut adapter = helpers::Helper::new(
                &adapter_name,
                params,
                signature.return_type.clone(),
                self.loc(node),
            );
            adapter.function.rest = signature.rest;
            adapter.function.captures = Some(vec![capture.clone()]);
            adapter.function.locals.push(Local {
                id: capture.local_id.clone(),
                name: capture.name.clone(),
                r#type: capture.r#type.clone(),
                mutable: false,
                boxed: true,
            });
            let mut args = vec![Expr::VarRef {
                local_id: capture.local_id,
                r#type: capture.r#type,
                loc: self.loc(node),
            }];
            for index in 0..adapter.function.params.len() {
                let param = adapter.param(index);
                args.push(adapter.read(&param));
            }
            let call = Expr::Call {
                callee: signature.name,
                args,
                r#type: signature.return_type.clone(),
                loc: self.loc(node),
            };
            if signature.return_type == Type::Void {
                adapter.function.body.push(Stmt::Expression {
                    expr: call,
                    loc: self.loc(node),
                });
                adapter.function.body.push(Stmt::Return {
                    value: None,
                    loc: self.loc(node),
                });
            } else {
                adapter.function.body.push(Stmt::Return {
                    value: Some(call),
                    loc: self.loc(node),
                });
            }
            self.lifted.push(adapter.function);

            let mut factory = helpers::Helper::new(
                &format!("{adapter_name}_factory"),
                vec![receiver.ty()],
                callable.clone(),
                self.loc(node),
            );
            factory.function.locals[0].boxed = true;
            factory.function.body.push(Stmt::Return {
                value: Some(Expr::Closure {
                    fn_name: adapter_name,
                    captures: vec![factory.param(0).id],
                    r#type: callable.clone(),
                    loc: self.loc(node),
                }),
                loc: self.loc(node),
            });
            let callee = self.install_helper(factory.function);
            return Ok(Expr::Call {
                callee,
                args: vec![receiver],
                r#type: callable,
                loc: self.loc(node),
            });
        }
        if slot.declaration.kind() == SyntaxKind::GetAccessor {
            let signature = self.request_private_method(&slot)?;
            let receiver = self.private_receiver(node.expression())?;
            let receiver =
                self.private_access(&slot, receiver, None, Access::MethodReceiver, node)?;
            let value = Expr::Call {
                callee: signature.name,
                args: vec![receiver],
                r#type: signature.return_type,
                loc: self.loc(node),
            };
            return self.narrowed(value, node);
        }
        let receiver = self.private_receiver(node.expression())?;
        let value = self.private_access(&slot, receiver, None, Access::Read, node)?;
        if self.checker_any(node) {
            let target = self.ty(slot.declaration.name())?;
            if !matches!(target, Type::Null | Type::Undefined) {
                return self.coerce(value, target, node);
            }
        }
        self.private_result(value, node)
    }

    pub(in crate::frontend) fn private_assignment(&mut self, node: Node) -> Result<Expr, String> {
        let member = node.left();
        let slot = self.private_slot(member.name())?;
        if matches!(
            slot.declaration.kind(),
            SyntaxKind::MethodDeclaration | SyntaxKind::GetAccessor
        ) {
            return Err(self.refuse(member, "writes to private methods are not ported"));
        }
        let receiver = self.private_receiver(member.expression())?;
        // Retain contextual callback/container contracts before erasing the
        // owning payload into the slot. Erasing first can change a closure ABI.
        let target = if self.checker_any(member) {
            self.ty(slot.declaration.name())?
        } else {
            self.ty(member)?
        };
        let unchecked_unit_initializer =
            parameter_abi::is_javascript(self.classes.definitions[slot.owner].node)
                && matches!(target, Type::Null | Type::Undefined);
        let value = if unchecked_unit_initializer {
            // In unchecked JavaScript, `#slot = null`/`undefined` is an
            // initializer, not a permanent storage contract. Private slots
            // already own dynamic payloads, so retain the assigned value's
            // native representation instead of projecting it back to the
            // initializer's unit type.
            self.expression(node.right())?
        } else {
            self.expected_expression(node.right(), target)?
        };
        // A contextual optional slot may wrap a known RHS arm. Assignment
        // yields that RHS value, not the wider storage contract.
        let result_type = match &value {
            Expr::UnionWrap { value, .. } => value.ty(),
            _ => value.ty(),
        };
        let value = self.coerce(value, Type::Dyn, node.right())?;
        let value = self.private_access(&slot, receiver, Some(value), Access::Write, member)?;
        if matches!(result_type, Type::Null | Type::Undefined) {
            Ok(value)
        } else {
            self.coerce(value, result_type, node)
        }
    }

    fn private_result(&mut self, value: Expr, node: Node) -> Result<Expr, String> {
        if matches!(self.ty(node), Ok(Type::Null | Type::Undefined)) {
            return Ok(value);
        }
        self.narrowed(value, node)
    }

    pub(super) fn initialize_private_field(&mut self, field: Node) -> Result<Stmt, String> {
        let slot = self.private_slot(field.name())?;
        let value = if field.initializer().is_nil() {
            self.coerce(
                Expr::UnitLit {
                    unit: "undefined",
                    r#type: Type::Undefined,
                    loc: self.loc(field),
                },
                Type::Dyn,
                field,
            )?
        } else {
            let target = self.ty(field.name())?;
            let value = self.expected_expression(field.initializer(), target)?;
            self.coerce(value, Type::Dyn, field.initializer())?
        };
        let receiver = self.this_expression(field)?;
        let expr = self.private_access(&slot, receiver, Some(value), Access::Install, field)?;
        Ok(Stmt::Expression {
            expr,
            loc: self.loc(field),
        })
    }

    fn private_throw(&self, message: String, loc: Loc) -> Stmt {
        Stmt::Throw {
            value: Expr::LibCall {
                r#fn: "error.new".into(),
                args: vec![Expr::StrLit {
                    value: message,
                    r#type: Type::String,
                    loc: loc.clone(),
                }],
                r#type: Type::Object {
                    class_name: "%TypeError".into(),
                },
                loc: loc.clone(),
            },
            loc,
        }
    }

    fn private_access(
        &mut self,
        slot: &Slot,
        receiver: Expr,
        value: Option<Expr>,
        access: Access,
        site: Node,
    ) -> Result<Expr, String> {
        self.ensure_exception_classes(site)?;
        self.layout_class(slot.owner)?;
        let mut args = vec![receiver];
        if let Some(value) = value {
            args.push(value);
        }
        let kind = match access {
            Access::Read => "read",
            Access::Write => "write",
            Access::Install => "install",
            Access::MethodReceiver => "method_receiver",
        };
        let method_receiver = access == Access::MethodReceiver;
        let result = if method_receiver {
            self.classes.object(slot.owner)
        } else {
            Type::Dyn
        };
        let mut helper = helpers::Helper::new(
            &format!("private_{kind}_{}", slot.global.id),
            args.iter().map(Expr::ty).collect(),
            result.clone(),
            self.loc(site),
        );
        let read = matches!(access, Access::Read | Access::MethodReceiver);
        let class_label = if self.classes.definitions[slot.owner].node.name().is_nil() {
            "anonymous"
        } else {
            self.classes.definitions[slot.owner].node.name().text()
        }
        .to_string();
        let brand_message = if method_receiver {
            format!("Receiver must be an instance of class {class_label}")
        } else {
            format!(
                "Cannot {} private member {} {} an object whose class did not declare it",
                if read { "read" } else { "write" },
                slot.label,
                if read { "from" } else { "to" }
            )
        };
        let ty = helper.param(0).r#type;
        let receiver = if ty == Type::Dyn {
            for (unit, target) in [("null", Type::Null), ("undefined", Type::Undefined)] {
                helper.function.body.push(Stmt::If {
                    cond: Expr::DynScalarEq {
                        left: Box::new(helper.read(&helper.param(0))),
                        right: Box::new(self.coerce(
                            Expr::UnitLit {
                                unit,
                                r#type: target,
                                loc: helper.loc(),
                            },
                            Type::Dyn,
                            site,
                        )?),
                        negated: false,
                        r#type: Type::Bool,
                        loc: helper.loc(),
                    },
                    then: vec![self.private_throw(
                        format!(
                            "Cannot {} properties of {unit} ({} '{}')",
                            if read { "read" } else { "set" },
                            if read { "reading" } else { "setting" },
                            if method_receiver {
                                &class_label
                            } else {
                                &slot.label
                            }
                        ),
                        helper.loc(),
                    )],
                    else_: None,
                    loc: helper.loc(),
                });
            }
            let name = self.classes.definitions[slot.owner].name.clone();
            helper.function.body.push(Stmt::If {
                cond: Expr::Unary {
                    op: "!".into(),
                    operand: Box::new(Expr::LibCall {
                        r#fn: "dyn.classInstanceof".into(),
                        args: vec![
                            helper.read(&helper.param(0)),
                            Expr::StrLit {
                                value: name,
                                r#type: Type::String,
                                loc: helper.loc(),
                            },
                        ],
                        r#type: Type::Bool,
                        loc: helper.loc(),
                    }),
                    r#type: Type::Bool,
                    loc: helper.loc(),
                },
                then: vec![self.private_throw(brand_message.clone(), helper.loc())],
                else_: None,
                loc: helper.loc(),
            });
            Expr::DynCheck {
                value: Box::new(helper.read(&helper.param(0))),
                r#type: self.classes.object(slot.owner),
                loc: helper.loc(),
            }
        } else if let Type::Object { class_name } = &ty
            && (!method_receiver
                || self
                    .classes
                    .subclass(class_name, &self.classes.definitions[slot.owner].name)
                || self
                    .classes
                    .subclass(&self.classes.definitions[slot.owner].name, class_name))
        {
            helper.read(&helper.param(0))
        } else {
            helper
                .function
                .body
                .push(self.private_throw(brand_message, helper.loc()));
            let callee = self.install_helper(helper.function);
            return Ok(Expr::Call {
                callee,
                args,
                r#type: result,
                loc: self.loc(site),
            });
        };
        let local = helper.local("private receiver", receiver.ty(), false);
        helper.declare(&local, receiver);
        let operation = |name: &str, helper: &helpers::Helper| {
            let mut args = vec![
                Expr::VarRef {
                    local_id: slot.global.id.clone(),
                    r#type: slot.global.r#type.clone(),
                    loc: helper.loc(),
                },
                Expr::DynFrom {
                    value: Box::new(helper.read(&local)),
                    r#type: Type::Dyn,
                    loc: helper.loc(),
                },
            ];
            if name == "set" {
                args.push(helper.read(&helper.param(1)));
            }
            Expr::LibCall {
                r#fn: format!("weakmap.{name}"),
                args,
                r#type: match name {
                    "has" => Type::Bool,
                    "set" => Type::Void,
                    _ => Type::Dyn,
                },
                loc: helper.loc(),
            }
        };
        let has = operation("has", &helper);
        helper.function.body.push(Stmt::If {
            cond: if access == Access::Install {
                has
            } else {
                Expr::Unary {
                    op: "!".into(),
                    operand: Box::new(has),
                    r#type: Type::Bool,
                    loc: helper.loc(),
                }
            },
            then: vec![self.private_throw(
                if access == Access::Install {
                    format!("Cannot initialize {} twice on the same object", slot.label)
                } else {
                    brand_message
                },
                helper.loc(),
            )],
            else_: None,
            loc: helper.loc(),
        });
        if !read {
            helper.function.body.push(Stmt::Expression {
                expr: operation("set", &helper),
                loc: helper.loc(),
            });
        }
        helper.function.body.push(Stmt::Return {
            value: Some(if method_receiver {
                let receiver = helper.read(&local);
                if receiver.ty() == result { receiver }
                else if matches!(receiver.ty(), Type::Object { class_name } if self.classes.subclass(&class_name, &self.classes.definitions[slot.owner].name)) {
                    Expr::Upcast { value: Box::new(receiver), r#type: result.clone(), loc: helper.loc() }
                } else {
                    Expr::Downcast { value: Box::new(receiver), r#type: result.clone(), loc: helper.loc() }
                }
            } else if read {
                operation("get", &helper)
            } else {
                helper.read(&helper.param(1))
            }),
            loc: helper.loc(),
        });
        let callee = self.install_helper(helper.function);
        Ok(Expr::Call {
            callee,
            args,
            r#type: result,
            loc: self.loc(site),
        })
    }
}

mod methods;
