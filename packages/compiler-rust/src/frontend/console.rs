//! Ambient console members keep one stable native text-sink identity per member.
use super::*;
use source_frontend::prelude::{SymbolId, get_source_file_of_node};

pub(super) fn text_sink_type() -> Type {
    Type::Func {
        rest: false,
        params: vec![Type::String],
        ret: Box::new(Type::Void),
    }
}
fn member_name(name: &str) -> Option<&'static str> {
    match name {
        "log" => Some("log"),
        "info" => Some("info"),
        "debug" => Some("debug"),
        "warn" => Some("warn"),
        "error" => Some("error"),
        "dir" => Some("dir"),
        _ => None,
    }
}
fn output_intrinsic(name: &str) -> &'static str {
    if matches!(name, "warn" | "error") {
        "console.error"
    } else {
        "console.log"
    }
}
impl Lowerer<'_> {
    fn standard_declaration(&self, node: Node) -> bool {
        if node.is_nil() {
            return false;
        }
        let file = source_file_info(get_source_file_of_node(node));
        let path = &file.file_name;
        self.console_prelude.as_deref() == Some(path.as_str())
            || matches!(
                source_frontend::frontend::bundled::bundled_lib_name(path),
                Some("lib.dom.d.ts" | "lib.webworker.d.ts")
            )
            || (path.contains("/@types/node/")
                && (path.ends_with("/console.d.ts") || path.ends_with("/globals.d.ts")))
            || (path.contains("/bun-types/") && path.ends_with("/globals.d.ts"))
    }

    fn standard_console_symbol(&self, id: u32, global: bool) -> Option<&'static str> {
        if id == 0 {
            return None;
        }
        let symbol = self.checker.sym(SymbolId(id));
        let name = if global {
            (symbol.name.as_ref() == "console").then_some("console")?
        } else {
            member_name(&symbol.name)?
        };
        (!symbol.declarations.is_empty()
            && symbol.declarations.iter().copied().all(|declaration| {
                self.standard_declaration(declaration)
                    && (global || {
                        let owner = declaration.parent();
                        owner.kind() == SyntaxKind::InterfaceDeclaration
                            && owner.name().text() == "Console"
                    })
            }))
        .then_some(name)
    }
    pub(super) fn standard_console_type(&self, id: TypeId) -> bool {
        self.standard_console_symbol(self.checker.ty(id).symbol().0, false)
            .is_some()
    }
    pub(super) fn ambient_console_member(&mut self, node: Node) -> Option<&'static str> {
        if node.kind() != SyntaxKind::PropertyAccessExpression
            || node.expression().kind() != SyntaxKind::Identifier
        {
            return None;
        }
        let receiver = self.symbol(node.expression());
        self.standard_console_symbol(receiver, true)?;
        let member = self.symbol(node.name());
        self.standard_console_symbol(member, false)
    }
    pub(super) fn ignored_console_bind_receiver(&mut self, member: Node, receiver: Node) -> bool {
        if self.ambient_console_member(member).is_none()
            || receiver.kind() != SyntaxKind::Identifier
        {
            return false;
        }
        let symbol = self.symbol(receiver);
        self.standard_console_symbol(symbol, true).is_some()
    }
    pub(super) fn console_value(&mut self, node: Node) -> Result<Option<Expr>, String> {
        let Some(name) = self.ambient_console_member(node) else {
            return Ok(None);
        };
        Ok(Some(self.console_sink_value(name, node)?))
    }
    fn console_sink_value(&mut self, name: &str, node: Node) -> Result<Expr, String> {
        let mut helper = helpers::Helper::new(
            &format!("console_{name}"),
            vec![Type::String],
            Type::Void,
            self.loc(node),
        );
        helper.function.body.push(Stmt::Expression {
            expr: Expr::Intrinsic {
                name: output_intrinsic(name).into(),
                args: vec![helper.read(&helper.param(0))],
                r#type: Type::Void,
                loc: helper.loc(),
            },
            loc: helper.loc(),
        });
        let fn_name = self.install_helper(helper.function);
        Ok(Expr::Closure {
            fn_name,
            captures: vec![],
            r#type: text_sink_type(),
            loc: self.loc(node),
        })
    }
    pub(super) fn global_console_value(&mut self, node: Node) -> Result<Option<Expr>, String> {
        let symbol = self.symbol(node);
        if node.kind() != SyntaxKind::Identifier
            || node.text() != "console"
            || self.standard_console_symbol(symbol, true).is_none()
        {
            return Ok(None);
        }
        if self.console_global.is_none() {
            let slot = ir::Global {
                id: "%g.console".into(),
                name: "global console".into(),
                r#type: Type::Dyn,
                mutable: false,
                loc: self.loc(node),
            };
            let mut fields = Vec::new();
            for name in ["log", "info", "debug", "warn", "error", "dir"] {
                let sink = self.console_sink_value(name, node)?;
                fields.push(ir::DynamicField {
                    key: Expr::StrLit {
                        value: name.into(),
                        r#type: Type::String,
                        loc: self.loc(node),
                    },
                    value: self.coerce(sink, Type::Dyn, node)?,
                });
            }
            let init = Expr::DynObjLit {
                fields,
                r#type: Type::Dyn,
                loc: self.loc(node),
            };
            self.globals.push(slot.clone());
            self.console_global = Some((slot, init));
        }
        let slot = &self.console_global.as_ref().unwrap().0;
        Ok(Some(Expr::VarRef {
            local_id: slot.id.clone(),
            r#type: slot.r#type.clone(),
            loc: self.loc(node),
        }))
    }
    pub(super) fn console_global_prelude(&self) -> Vec<Stmt> {
        self.console_global
            .as_ref()
            .map(|(slot, init)| {
                vec![Stmt::Assign {
                    local_id: slot.id.clone(),
                    initializes_global: true,
                    value: init.clone(),
                    loc: Loc {
                        file: "<builtin>".into(),
                        start: 0,
                        end: 0,
                    },
                }]
            })
            .unwrap_or_default()
    }
    /// Existing projects can supply a narrow ambient console declaration of
    /// their own. Direct primitive calls need its global binding and void
    /// contract, while function values require a recognized standard ABI.
    pub(super) fn declared_console_call_member(&mut self, member: Node) -> Option<&'static str> {
        if member.is_nil()
            || member.kind() != SyntaxKind::PropertyAccessExpression
            || member.expression().kind() != SyntaxKind::Identifier
        {
            return None;
        }
        let name = member_name(member.name().text())?;
        let symbol = self.symbol(member.expression());
        if symbol == 0
            || self.bindings.contains_key(&symbol)
            || self.module_bindings.contains_key(&symbol)
            || self.outer.iter().any(|scope| scope.contains_key(&symbol))
            || self.functions.contains(symbol)
        {
            return None;
        }
        let info = self.checker.sym(SymbolId(symbol));
        if info.name.as_ref() != "console"
            || info.declarations.is_empty()
            || !info.declarations.iter().all(|decl| {
                is_declaration(&source_file_info(get_source_file_of_node(*decl)).file_name)
            })
        {
            return None;
        }
        let ty = self.checker.get_type_at_location(member);
        let signatures = self
            .checker
            .get_signatures_of_type(ty, source_frontend::prelude::SignatureKind::CALL);
        if signatures.is_empty() {
            return None;
        }
        for signature in signatures {
            let result = self.checker.get_return_type_of_signature(signature);
            if !self.checker.ty(result).flags.intersects(TypeFlags::VOID) {
                return None;
            }
        }
        Some(name)
    }
    pub(super) fn console_call(&mut self, node: Node) -> Result<Option<Expr>, String> {
        let Some(name) = self
            .ambient_console_member(node.expression())
            .or_else(|| self.declared_console_call_member(node.expression()))
        else {
            return Ok(None);
        };
        if name == "dir" {
            let arguments = node.arguments().into_iter().collect::<Vec<_>>();
            if arguments
                .iter()
                .any(|argument| argument.kind() == SyntaxKind::SpreadElement)
            {
                return Err(self.refuse(node, "console.dir argument spreads are not ported"));
            }
            let first = if let Some(argument) = arguments.first().copied() {
                self.expected_expression(argument, Type::Dyn)?
            } else {
                self.coerce(
                    Expr::UnitLit {
                        unit: "undefined",
                        r#type: Type::Undefined,
                        loc: self.loc(node),
                    },
                    Type::Dyn,
                    node,
                )?
            };
            let value = self.construction_local(Type::Dyn, false);
            let mut stmts = vec![Stmt::VarDecl {
                local_id: value.id.clone(),
                init: first,
                loc: self.loc(node),
            }];
            for argument in arguments.into_iter().skip(1) {
                stmts.push(Stmt::Expression {
                    expr: self.expected_expression(argument, Type::Dyn)?,
                    loc: self.loc(argument),
                });
            }
            return Ok(Some(Expr::Sequence {
                stmts,
                result: Box::new(Expr::Intrinsic {
                    name: "console.dir".into(),
                    args: vec![self.construction_read(&value, node)],
                    r#type: Type::Void,
                    loc: self.loc(node),
                }),
                r#type: Type::Void,
                loc: self.loc(node),
            }));
        }
        let source_arguments = node.arguments().into_iter().collect::<Vec<_>>();
        if source_arguments
            .iter()
            .any(|argument| argument.kind() == SyntaxKind::SpreadElement)
        {
            // A rest/spread console call has a runtime-sized argument list.
            // Materialize it with the ordinary iterable spread path so each
            // source is consumed in JavaScript evaluation order. The emitter
            // retains the NativeValue list long enough to decide whether the
            // first runtime value is a string and therefore uses util.format
            // semantics, before inspecting the values for output.
            let values = self.array_spread_elements(
                node,
                source_arguments,
                Type::Array {
                    elem: Box::new(Type::Dyn),
                },
            )?;
            return Ok(Some(Expr::Intrinsic {
                name: format!("{}.spread", output_intrinsic(name)),
                args: vec![values],
                r#type: Type::Void,
                loc: self.loc(node),
            }));
        }
        let mut args = Vec::new();
        for arg in source_arguments {
            args.push(self.expression(arg)?);
        }
        let formatted = args.len() > 1
            && (args[0].ty() == Type::String
                || matches!(args[0].ty(), Type::Union { union_id } if self.unions[union_id].arms.contains(&Type::String)))
            && !matches!(&args[0], Expr::StrLit { value, .. } if !value.contains('%'));
        let args = args
            .into_iter()
            .map(|value| self.console_argument(value, node))
            .collect::<Result<Vec<_>, _>>()?;
        Ok(Some(Expr::Intrinsic {
            name: if formatted {
                format!("{}.format", output_intrinsic(name))
            } else {
                output_intrinsic(name).into()
            },
            args,
            r#type: Type::Void,
            loc: self.loc(node),
        }))
    }

    fn console_argument(&mut self, value: Expr, node: Node) -> Result<Expr, String> {
        if value.ty() == Type::Void {
            // A void-valued call still runs and supplies JavaScript undefined.
            return self.coerce(value, Type::Dyn, node);
        }
        if matches!(value.ty(), Type::F64 | Type::String | Type::Bool) {
            return Ok(value);
        }
        if value.ty() == Type::Dyn {
            // Catch aliases and erased dependency values already own a
            // NativeValue. Keep that value intact until the console boundary,
            // where the Rust inspector formats its live runtime brand.
            return Ok(value);
        }
        if value.ty() == Type::Bigint {
            return Ok(self.bigint_operation("bigint.inspect", vec![value], node));
        }
        if value.ty() == Type::Caught {
            return Ok(Expr::Intrinsic {
                name: "caught.toString".into(),
                args: vec![value],
                r#type: Type::String,
                loc: self.loc(node),
            });
        }
        let arms = match value.ty() {
            Type::Union { union_id } => self.unions[union_id].arms.clone(),
            Type::Null => {
                return Ok(Expr::StrLit {
                    value: "null".into(),
                    r#type: Type::String,
                    loc: self.loc(node),
                });
            }
            Type::Undefined => {
                return Ok(Expr::StrLit {
                    value: "undefined".into(),
                    r#type: Type::String,
                    loc: self.loc(node),
                });
            }
            _ => {
                return Err(
                    self.refuse(node, "non-primitive console argument values are not ported")
                );
            }
        };
        if arms.iter().any(|ty| {
            !matches!(
                ty,
                Type::F64 | Type::Bigint | Type::String | Type::Bool | Type::Null | Type::Undefined
            )
        }) {
            return Err(self.refuse(node, "non-primitive console argument values are not ported"));
        }
        let Type::Union { union_id } = value.ty() else {
            unreachable!()
        };
        let mut helper = helpers::Helper::new(
            "console_primitive",
            vec![value.ty()],
            Type::String,
            self.loc(node),
        );
        let parameter = helper.param(0);
        for (tag, arm) in arms.into_iter().enumerate() {
            let read = Expr::UnionNarrow {
                union_id: format!("u{union_id}"),
                tag,
                value: Box::new(helper.read(&parameter)),
                r#type: arm.clone(),
                loc: helper.loc(),
            };
            let formatted = match arm {
                Type::Null | Type::Undefined => Expr::StrLit {
                    value: if arm == Type::Null {
                        "null"
                    } else {
                        "undefined"
                    }
                    .into(),
                    r#type: Type::String,
                    loc: helper.loc(),
                },
                Type::String => read,
                Type::Bigint => self.bigint_operation("bigint.inspect", vec![read], node),
                Type::F64 => {
                    // Console displays -0; String(-0) deliberately does not.
                    let zero = Expr::Bin {
                        op: "===".into(),
                        left: Box::new(read.clone()),
                        right: Box::new(helper.number(0.0)),
                        r#type: Type::Bool,
                        loc: helper.loc(),
                    };
                    let inverse = Expr::Bin {
                        op: "/".into(),
                        left: Box::new(helper.number(1.0)),
                        right: Box::new(read.clone()),
                        r#type: Type::F64,
                        loc: helper.loc(),
                    };
                    let negative = Expr::Bin {
                        op: "<".into(),
                        left: Box::new(inverse),
                        right: Box::new(helper.number(0.0)),
                        r#type: Type::Bool,
                        loc: helper.loc(),
                    };
                    Expr::Ternary {
                        cond: Box::new(Expr::Logical {
                            op: "&&".into(),
                            left: Box::new(zero),
                            right: Box::new(negative),
                            r#type: Type::Bool,
                            loc: helper.loc(),
                        }),
                        then: Box::new(Expr::StrLit {
                            value: "-0".into(),
                            r#type: Type::String,
                            loc: helper.loc(),
                        }),
                        else_: Box::new(Expr::ToString {
                            operand: Box::new(read),
                            r#type: Type::String,
                            loc: helper.loc(),
                        }),
                        r#type: Type::String,
                        loc: helper.loc(),
                    }
                }
                _ => Expr::ToString {
                    operand: Box::new(read),
                    r#type: Type::String,
                    loc: helper.loc(),
                },
            };
            helper.function.body.push(Stmt::If {
                cond: Expr::UnionIsTag {
                    union_id: format!("u{union_id}"),
                    tag,
                    value: Box::new(helper.read(&parameter)),
                    negated: false,
                    r#type: Type::Bool,
                    loc: helper.loc(),
                },
                then: vec![Stmt::Return {
                    value: Some(formatted),
                    loc: helper.loc(),
                }],
                else_: None,
                loc: helper.loc(),
            });
        }
        helper.function.body.push(Stmt::Return {
            value: Some(Expr::StrLit {
                value: String::new(),
                r#type: Type::String,
                loc: helper.loc(),
            }),
            loc: helper.loc(),
        });
        let callee = self.install_helper(helper.function);
        Ok(Expr::Call {
            callee,
            args: vec![value],
            r#type: Type::String,
            loc: self.loc(node),
        })
    }
}
