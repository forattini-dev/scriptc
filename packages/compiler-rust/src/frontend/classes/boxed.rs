//! Primitive wrappers keep nominal identity and private ephemeron payloads.
//! The source Number/String/Boolean interfaces also admit primitive values.
use super::*;
use helpers::Helper;

pub(super) fn kind(class: &str) -> Option<&'static str> {
    match class {
        "native_boxed_Number" => Some("Number"),
        "native_boxed_String" => Some("String"),
        "native_boxed_Boolean" => Some("Boolean"),
        _ => None,
    }
}
pub(super) fn payload(name: &str) -> Type {
    match name {
        "Number" => Type::F64,
        "String" => Type::String,
        "Boolean" => Type::Bool,
        _ => unreachable!(),
    }
}
fn valueof_member(node: Node) -> bool {
    match node.kind() {
        SyntaxKind::PropertyAccessExpression => node.name().text() == "valueOf",
        SyntaxKind::ElementAccessExpression => {
            node.argument_expression().kind() == SyntaxKind::StringLiteral
                && node.argument_expression().text() == "valueOf"
        }
        _ => false,
    }
}
fn text(value: &str, loc: &Loc) -> Expr {
    Expr::StrLit {
        value: value.into(),
        r#type: Type::String,
        loc: loc.clone(),
    }
}
fn operation(name: &str, args: Vec<Expr>, ty: Type, loc: &Loc) -> Expr {
    Expr::LibCall {
        r#fn: name.into(),
        args,
        r#type: ty,
        loc: loc.clone(),
    }
}
fn erase(value: Expr, loc: &Loc) -> Expr {
    if value.ty() == Type::Dyn {
        value
    } else {
        Expr::DynFrom {
            value: Box::new(value),
            r#type: Type::Dyn,
            loc: loc.clone(),
        }
    }
}
impl Lowerer<'_> {
    pub(in crate::frontend::classes) fn boxed_class(&mut self, name: &str) -> usize {
        let class_name = format!("native_boxed_{name}");
        if let Some(index) = self
            .classes
            .definitions
            .iter()
            .position(|d| d.name == class_name)
        {
            return index;
        }
        let loc = Loc {
            file: "<builtin>".into(),
            start: 0,
            end: 0,
        };
        let index = self.classes.definitions.len();
        self.classes.definitions.push(Definition {
            node: Node::NIL,
            name: class_name.clone(),
            file: "<builtin>".into(),
            base: None,
            resolved: true,
            resolving: false,
            signature: None,
            token: None,
        });
        self.classes.layouts.push(Some(ir::Class {
            name: class_name,
            js_name: name.into(),
            runtime: false,
            base: None,
            fields: vec![],
            methods: vec![],
            method_names: vec!["valueOf".into()],
            symbol_methods: vec![],
            loc,
        }));
        let global = ir::Global {
            id: format!("%g.boxed.{name}"),
            name: format!("{name} primitive slots"),
            r#type: Type::Object {
                class_name: weak_maps::CLASS.into(),
            },
            mutable: false,
        };
        self.globals.push(global.clone());
        self.classes.boxed_slots.push((name.into(), global));
        index
    }
    fn boxed_table(&self, name: &str, loc: &Loc) -> Expr {
        let slot = &self
            .classes
            .boxed_slots
            .iter()
            .find(|(n, _)| n == name)
            .unwrap()
            .1;
        Expr::VarRef {
            local_id: slot.id.clone(),
            r#type: slot.r#type.clone(),
            loc: loc.clone(),
        }
    }
    pub(in crate::frontend) fn boxed_prelude(&self) -> Vec<Stmt> {
        self.classes
            .boxed_slots
            .iter()
            .map(|(_, slot)| {
                let loc = Loc {
                    file: "<builtin>".into(),
                    start: 0,
                    end: 0,
                };
                Stmt::Assign {
                    local_id: slot.id.clone(),
                    initializes_global: true,
                    value: Expr::New {
                        class_name: weak_maps::CLASS.into(),
                        args: vec![],
                        r#type: slot.r#type.clone(),
                        loc: loc.clone(),
                    },
                    loc,
                }
            })
            .collect()
    }
    pub(in crate::frontend::classes) fn boxed_constructor(
        &mut self,
        index: usize,
        name: &str,
    ) -> Result<Function, String> {
        let loc = self.classes.layouts[index].as_ref().unwrap().loc.clone();
        let mut helper = Helper::new(
            &format!("%{}.constructor", self.classes.definitions[index].name),
            vec![self.classes.object(index), payload(name)],
            Type::Void,
            loc,
        );
        let value = operation(
            "weakmap.set",
            vec![
                self.boxed_table(name, &helper.loc()),
                erase(helper.read(&helper.param(0)), &helper.loc()),
                erase(helper.read(&helper.param(1)), &helper.loc()),
            ],
            Type::Void,
            &helper.loc(),
        );
        helper.function.body.push(Stmt::Expression {
            expr: value,
            loc: helper.loc(),
        });
        Ok(helper.function)
    }
    pub(in crate::frontend::classes) fn boxed_new(
        &mut self,
        node: Node,
        index: usize,
        name: &str,
    ) -> Result<Expr, String> {
        self.private_table_constructor(node)?;
        self.request_constructor(index)?;
        let mut values = vec![];
        for arg in node.arguments() {
            if arg.kind() == SyntaxKind::SpreadElement {
                return Err(self.refuse(arg, "boxed primitive constructor spreads are not ported"));
            }
            let value = self.primitive_operand(arg)?;
            values.push(self.primitive_capture(value, arg)?);
        }
        let result = self.classes.object(index);
        let mut helper = Helper::new(
            &format!("boxed_new_{name}"),
            values.iter().map(Expr::ty).collect(),
            result.clone(),
            self.loc(node),
        );
        let value = if values.is_empty() {
            match name {
                "Number" => helper.number(0.0),
                "String" => text("", &helper.loc()),
                _ => Expr::BoolLit {
                    value: false,
                    r#type: Type::Bool,
                    loc: helper.loc(),
                },
            }
        } else {
            let value = helper.read(&helper.param(0));
            match name {
                "Number" => self.primitive_number(value, node)?,
                "String" => {
                    if !self.native_type_contains(&value.ty(), |t| {
                        !matches!(
                            t,
                            Type::F64
                                | Type::String
                                | Type::Bool
                                | Type::Null
                                | Type::Undefined
                                | Type::Union { .. }
                        )
                    }) {
                        self.string_value(value, node, strings::Context::Template)?
                    } else {
                        return Err(self.refuse(node, "String wrapper construction needs represented primitives; object hooks are not ported"));
                    }
                }
                _ => self.condition(value, node)?,
            }
        };
        helper.function.body.push(Stmt::Return {
            value: Some(Expr::New {
                class_name: self.classes.definitions[index].name.clone(),
                args: vec![value],
                r#type: result.clone(),
                loc: helper.loc(),
            }),
            loc: helper.loc(),
        });
        Ok(Expr::Call {
            callee: self.install_helper(helper.function),
            args: values,
            r#type: result,
            loc: self.loc(node),
        })
    }
    fn boxed_valueof_function(&mut self, name: &str, site: Node) -> Result<Expr, String> {
        let index = self.boxed_class(name);
        self.private_table_constructor(site)?;
        self.ensure_exception_classes(site)?;
        let ty = payload(name);
        let mut helper = Helper::new(
            &format!("boxed_valueOf_{name}"),
            vec![],
            ty.clone(),
            self.loc(site),
        );
        let receiver = helper.local("receiver", Type::Dyn, false);
        helper.declare(
            &receiver,
            operation("dyn.this", vec![], Type::Dyn, &helper.loc()),
        );
        let test = match name {
            "Number" => "number",
            "String" => "string",
            _ => "boolean",
        };
        helper.function.body.push(Stmt::If {
            cond: Expr::DynTest {
                value: Box::new(helper.read(&receiver)),
                test: test.into(),
                negated: false,
                r#type: Type::Bool,
                loc: helper.loc(),
            },
            then: vec![Stmt::Return {
                value: Some(self.coerce(helper.read(&receiver), ty.clone(), site)?),
                loc: helper.loc(),
            }],
            else_: None,
            loc: helper.loc(),
        });
        let brand = operation(
            "dyn.classInstanceof",
            vec![
                helper.read(&receiver),
                text(&self.classes.definitions[index].name, &helper.loc()),
            ],
            Type::Bool,
            &helper.loc(),
        );
        // Reproject the branded owner before the private lookup. Portable
        // backends may erase a class through a property mirror; the slot key
        // must remain the actual instance allocation, not that mirror.
        let owner = self.coerce(helper.read(&receiver), self.classes.object(index), site)?;
        let value = operation(
            "weakmap.get",
            vec![
                self.boxed_table(name, &helper.loc()),
                erase(owner, &helper.loc()),
            ],
            Type::Dyn,
            &helper.loc(),
        );
        helper.function.body.push(Stmt::If {
            cond: brand,
            then: vec![Stmt::Return {
                value: Some(self.coerce(value, ty.clone(), site)?),
                loc: helper.loc(),
            }],
            else_: None,
            loc: helper.loc(),
        });
        helper.function.body.push(Stmt::Throw {
            value: operation(
                "error.new",
                vec![text(
                    &format!("{name}.prototype.valueOf requires that 'this' be a {name}"),
                    &helper.loc(),
                )],
                Type::Object {
                    class_name: "%TypeError".into(),
                },
                &helper.loc(),
            ),
            loc: helper.loc(),
        });
        let fn_name = self.install_helper(helper.function);
        Ok(Expr::Closure {
            fn_name,
            captures: vec![],
            r#type: Type::Func {
                rest: false,
                params: vec![],
                ret: Box::new(ty),
            },
            loc: self.loc(site),
        })
    }
    fn boxed_lookup(&mut self, receiver: Expr, site: Node) -> Result<Expr, String> {
        let mut helper = Helper::new(
            "boxed_valueOf_lookup",
            vec![Type::Dyn],
            Type::Dyn,
            self.loc(site),
        );
        for name in ["Number", "String", "Boolean"] {
            let function = self.boxed_valueof_function(name, site)?;
            let value = erase(function, &helper.loc());
            let class = operation(
                "dyn.classInstanceof",
                vec![
                    helper.read(&helper.param(0)),
                    text(&format!("native_boxed_{name}"), &helper.loc()),
                ],
                Type::Bool,
                &helper.loc(),
            );
            let test = match name {
                "Number" => "number",
                "String" => "string",
                _ => "boolean",
            };
            let cond = Expr::Logical {
                op: "||".into(),
                left: Box::new(class),
                right: Box::new(Expr::DynTest {
                    value: Box::new(helper.read(&helper.param(0))),
                    test: test.into(),
                    negated: false,
                    r#type: Type::Bool,
                    loc: helper.loc(),
                }),
                r#type: Type::Bool,
                loc: helper.loc(),
            };
            helper.function.body.push(Stmt::If {
                cond,
                then: vec![Stmt::Return {
                    value: Some(value),
                    loc: helper.loc(),
                }],
                else_: None,
                loc: helper.loc(),
            });
        }
        helper.function.body.push(Stmt::Return {
            value: Some(Expr::DynKeyGet {
                value: Box::new(helper.read(&helper.param(0))),
                key: Box::new(text("valueOf", &helper.loc())),
                r#type: Type::Dyn,
                loc: helper.loc(),
            }),
            loc: helper.loc(),
        });
        Ok(Expr::Call {
            callee: self.install_helper(helper.function),
            args: vec![self.coerce(receiver, Type::Dyn, site)?],
            r#type: Type::Dyn,
            loc: self.loc(site),
        })
    }
    pub(in crate::frontend) fn boxed_get(&mut self, node: Node) -> Result<Option<Expr>, String> {
        if !matches!(
            node.kind(),
            SyntaxKind::PropertyAccessExpression | SyntaxKind::ElementAccessExpression
        ) {
            return Ok(None);
        }
        let source = self.checker.get_type_at_location(node.expression());
        let symbol = self.checker.ty(source).symbol().0;
        let known = ["Number", "String", "Boolean"]
            .iter()
            .any(|n| self.primitive_symbol(symbol, n, None));
        if !valueof_member(node) {
            if known {
                return Err(self.refuse(
                    node,
                    "boxed primitive properties beyond valueOf require their own native adapters",
                ));
            }
            return Ok(None);
        }
        let ty = self.ty(node.expression()).ok();
        if !known
            && ty != Some(Type::Dyn)
            && !matches!(ty, Some(Type::F64 | Type::String | Type::Bool))
        {
            return Ok(None);
        }
        let receiver = self.expression(node.expression())?;
        self.boxed_lookup(receiver, node).map(Some)
    }
    pub(in crate::frontend) fn boxed_call(&mut self, node: Node) -> Result<Option<Expr>, String> {
        let member = receivers::reference_node(node.expression());
        if !valueof_member(member) {
            if matches!(
                member.kind(),
                SyntaxKind::PropertyAccessExpression | SyntaxKind::ElementAccessExpression
            ) {
                let source = self.checker.get_type_at_location(member.expression());
                let symbol = self.checker.ty(source).symbol().0;
                if ["Number", "String", "Boolean"]
                    .iter()
                    .any(|name| self.primitive_symbol(symbol, name, None))
                {
                    return Err(self.refuse(
                        node,
                        "boxed primitive methods beyond valueOf require their own native adapters",
                    ));
                }
            }
            return Ok(None);
        }
        let ty = self.ty(member.expression()).ok();
        if !matches!(ty, Some(Type::Dyn | Type::F64 | Type::String | Type::Bool))
            && !matches!(ty, Some(Type::Object { ref class_name }) if kind(class_name).is_some())
        {
            return Ok(None);
        }
        let receiver = self.expression(member.expression())?;
        let receiver = self.coerce(receiver, Type::Dyn, member)?;
        let local = Local {
            id: format!("boxed_receiver_{}", self.locals.len()),
            name: "boxed receiver".into(),
            r#type: Type::Dyn,
            mutable: false,
            boxed: false,
        };
        self.locals.push(local.clone());
        let read = || Expr::VarRef {
            local_id: local.id.clone(),
            r#type: Type::Dyn,
            loc: self.loc(node),
        };
        let lookup = self.boxed_lookup(read(), member)?;
        let target = Local {
            id: format!("boxed_method_{}", self.locals.len()),
            name: "boxed method".into(),
            r#type: Type::Dyn,
            mutable: false,
            boxed: false,
        };
        self.locals.push(target.clone());
        let mut args = vec![Expr::VarRef {
            local_id: local.id.clone(),
            r#type: Type::Dyn,
            loc: self.loc(node),
        }];
        for arg in node.arguments() {
            if arg.kind() == SyntaxKind::SpreadElement {
                return Err(self.refuse(arg, "valueOf argument spreads are not ported"));
            }
            args.push(self.expected_expression(arg, Type::Dyn)?);
        }
        let call = Expr::DynInvoke {
            recv: Box::new(Expr::VarRef {
                local_id: target.id.clone(),
                r#type: Type::Dyn,
                loc: self.loc(node),
            }),
            method: "call".into(),
            args,
            callee_name: "valueOf".into(),
            r#type: Type::Dyn,
            loc: self.loc(node),
        };
        let result = self.ty(node)?;
        let call = self.coerce(call, result.clone(), node)?;
        Ok(Some(Expr::Sequence {
            stmts: vec![
                Stmt::VarDecl {
                    local_id: local.id,
                    init: receiver,
                    loc: self.loc(node),
                },
                Stmt::VarDecl {
                    local_id: target.id,
                    init: lookup,
                    loc: self.loc(node),
                },
            ],
            result: Box::new(call),
            r#type: result,
            loc: self.loc(node),
        }))
    }
}
