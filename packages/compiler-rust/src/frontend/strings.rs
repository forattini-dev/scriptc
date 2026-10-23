//! Cooked templates and dense array joins lower to portable string operations.
use super::*;
use helpers::Helper;

#[derive(Clone, Copy)]
pub(super) enum Context {
    Template,
    Element,
    Separator,
}

impl Lowerer<'_> {
    pub(super) fn string_addition(
        &mut self,
        left: Expr,
        right: Expr,
        node: Node,
    ) -> Result<Expr, String> {
        if left.ty() == Type::String && right.ty() == Type::String {
            return Ok(self.string_concat(left, right, node));
        }
        for ty in [left.ty(), right.ty()] {
            if self.native_type_contains(&ty, |ty| {
                !matches!(
                    ty,
                    Type::String
                        | Type::F64
                        | Type::Bool
                        | Type::Null
                        | Type::Undefined
                        | Type::Void
                        | Type::Symbol
                        | Type::Dyn
                        | Type::Caught
                        | Type::Union { .. }
                )
            }) {
                return Err(
                    self.refuse(node, "object ToPrimitive for string addition is not ported")
                );
            }
        }
        self.ensure_exception_classes(node)?;
        let capture = |value: Expr, site: Node| {
            if value.ty() == Type::Caught {
                Ok(Expr::CaughtToDyn {
                    value: Box::new(value),
                    r#type: Type::Dyn,
                    loc: self.loc(site),
                })
            } else {
                self.coerce(value, Type::Dyn, site)
            }
        };
        // Both operand values are captured before ToString can throw. In
        // particular a left-hand Symbol must not suppress right-hand effects.
        let args = vec![capture(left, node.left())?, capture(right, node.right())?];
        let mut helper = Helper::new(
            "string_addition",
            vec![Type::Dyn, Type::Dyn],
            Type::String,
            self.loc(node),
        );
        let text = |index| Expr::ToString {
            operand: Box::new(helper.read(&helper.param(index))),
            r#type: Type::String,
            loc: helper.loc(),
        };
        let value = self.string_concat(text(0), text(1), node);
        helper.function.body.push(Stmt::Return {
            value: Some(value),
            loc: helper.loc(),
        });
        Ok(Expr::Call {
            callee: self.install_helper(helper.function),
            args,
            r#type: Type::String,
            loc: self.loc(node),
        })
    }

    fn string_literal(&self, value: &str, node: Node) -> Expr {
        Expr::StrLit {
            value: value.into(),
            r#type: Type::String,
            loc: self.loc(node),
        }
    }

    pub(super) fn string_concat(&self, left: Expr, right: Expr, node: Node) -> Expr {
        Expr::StrConcat {
            left: Box::new(left),
            right: Box::new(right),
            r#type: Type::String,
            loc: self.loc(node),
        }
    }

    pub(super) fn template_expression(&mut self, node: Node) -> Result<Expr, String> {
        let cooked = |part: Node| -> Result<String, String> {
            let bytes = source_frontend::scanner_util::go_string_bytes(part.text());
            std::str::from_utf8(&bytes)
                .map(str::to_owned)
                .map_err(|_| self.refuse(part, "lone UTF-16 surrogates are not ported"))
        };
        let head = cooked(node.head())?;
        let spans = node
            .template_spans()
            .nodes()
            .into_iter()
            .map(|span| Ok((span.expression(), cooked(span.literal())?)))
            .collect::<Result<Vec<_>, String>>()?;
        let mut result = self.string_literal(&head, node);
        for (source, tail) in spans {
            let value = self.expression(source)?;
            let value = self.string_value(value, source, Context::Template)?;
            // Nested concatenation converts this substitution before the next
            // expression runs. Passing all substitutions to a helper would not.
            result = self.string_concat(result, value, node);
            result = self.string_concat(result, self.string_literal(&tail, node), node);
        }
        Ok(result)
    }

    pub(super) fn string_value(
        &mut self,
        value: Expr,
        node: Node,
        context: Context,
    ) -> Result<Expr, String> {
        let ty = value.ty();
        match ty {
            Type::String => Ok(value),
            Type::F64 | Type::Bool => Ok(Expr::ToString {
                operand: Box::new(value),
                r#type: Type::String,
                loc: self.loc(node),
            }),
            Type::Array { .. } => self.join_value(value, self.string_literal(",", node), node),
            Type::Record { shape_id } if self.records[shape_id].tuple => {
                self.join_value(value, self.string_literal(",", node), node)
            }
            Type::Null | Type::Undefined => {
                let value = self.coerce(value, Type::Dyn, node)?;
                self.string_value(value, node, context)
            }
            Type::Union { union_id } => {
                let mut helper = Helper::new(
                    match context {
                        Context::Template => "string_union",
                        Context::Element => "join_union",
                        Context::Separator => "separator_union",
                    },
                    vec![ty],
                    Type::String,
                    self.loc(node),
                );
                let slot = helper.param(0);
                for (tag, arm) in self.unions[union_id].arms.clone().into_iter().enumerate() {
                    let result = if matches!(arm, Type::Null | Type::Undefined) {
                        self.string_literal(
                            match (context, arm) {
                                (Context::Element, _) => "",
                                (Context::Separator, Type::Undefined) => ",",
                                (_, Type::Null) => "null",
                                _ => "undefined",
                            },
                            node,
                        )
                    } else {
                        let operand = Expr::UnionNarrow {
                            union_id: format!("u{union_id}"),
                            tag,
                            value: Box::new(helper.read(&slot)),
                            r#type: arm,
                            loc: helper.loc(),
                        };
                        self.string_value(operand, node, context)?
                    };
                    helper.function.body.push(Stmt::If {
                        cond: Expr::UnionIsTag {
                            union_id: format!("u{union_id}"),
                            tag,
                            negated: false,
                            value: Box::new(helper.read(&slot)),
                            r#type: Type::Bool,
                            loc: helper.loc(),
                        },
                        then: vec![Stmt::Return {
                            value: Some(result),
                            loc: helper.loc(),
                        }],
                        else_: None,
                        loc: helper.loc(),
                    });
                }
                // Tags are exhaustively checked above; the IR still requires a
                // syntactic return for a non-void helper.
                helper.function.body.push(Stmt::Return {
                    value: Some(self.string_literal("", node)),
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
            Type::Dyn => {
                if matches!(context, Context::Template) {
                    return Ok(Expr::ToString {
                        operand: Box::new(value),
                        r#type: Type::String,
                        loc: self.loc(node),
                    });
                }
                let mut helper = Helper::new(
                    match context {
                        Context::Element => "join_dynamic",
                        _ => "separator_dynamic",
                    },
                    vec![Type::Dyn],
                    Type::String,
                    self.loc(node),
                );
                let slot = helper.param(0);
                helper.function.body.push(Stmt::If {
                    cond: Expr::DynTest {
                        value: Box::new(helper.read(&slot)),
                        test: if matches!(context, Context::Element) {
                            "nullish"
                        } else {
                            "undefined"
                        }
                        .into(),
                        negated: false,
                        r#type: Type::Bool,
                        loc: helper.loc(),
                    },
                    then: vec![Stmt::Return {
                        value: Some(self.string_literal(
                            if matches!(context, Context::Element) {
                                ""
                            } else {
                                ","
                            },
                            node,
                        )),
                        loc: helper.loc(),
                    }],
                    else_: None,
                    loc: helper.loc(),
                });
                helper.function.body.push(Stmt::Return {
                    value: Some(Expr::ToString {
                        operand: Box::new(helper.read(&slot)),
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
            _ => Err(self.refuse(
                node,
                "object string conversion requires native ToPrimitive support",
            )),
        }
    }

    pub(super) fn array_join(&mut self, node: Node) -> Result<Expr, String> {
        let receiver = self.expression(node.expression().expression())?;
        let arguments = node.arguments().into_iter().collect::<Vec<_>>();
        if arguments.len() > 1
            || arguments
                .iter()
                .any(|n| n.kind() == SyntaxKind::SpreadElement)
        {
            return Err(self.refuse(node, "array.join accepts at most one non-spread separator"));
        }
        let separator = if let Some(arg) = arguments.first() {
            self.expression(*arg)?
        } else {
            self.string_literal(",", node)
        };
        let separator = self.string_value(separator, node, Context::Separator)?;
        self.join_value(receiver, separator, node)
    }

    fn join_value(&mut self, receiver: Expr, separator: Expr, node: Node) -> Result<Expr, String> {
        if let Type::Record { shape_id } = receiver.ty() {
            let mut helper = Helper::new(
                "tuple_join",
                vec![receiver.ty(), Type::String],
                Type::String,
                self.loc(node),
            );
            let tuple = helper.param(0);
            let separator_slot = helper.param(1);
            let text = helper.local("text", Type::String, true);
            helper.declare(&text, self.string_literal("", node));
            for index in 0..self.records[shape_id].fields.len() {
                // Layout fields are sorted lexically; tuple iteration follows
                // numeric positions, including positions greater than nine.
                let name = index.to_string();
                let field = self.records[shape_id]
                    .fields
                    .iter()
                    .find(|f| f.name == name)
                    .expect("required tuple position")
                    .clone();
                if index != 0 {
                    helper.function.body.push(Stmt::Assign {
                        local_id: text.id.clone(),
                        value: self.string_concat(
                            helper.read(&text),
                            helper.read(&separator_slot),
                            node,
                        ),
                        initializes_global: false,
                        loc: helper.loc(),
                    });
                }
                let item = Expr::RecordGet {
                    obj: Box::new(helper.read(&tuple)),
                    shape_id: format!("r{shape_id}"),
                    field: field.name,
                    r#type: field.r#type,
                    loc: helper.loc(),
                };
                let item = self.string_value(item, node, Context::Element)?;
                helper.function.body.push(Stmt::Assign {
                    local_id: text.id.clone(),
                    value: self.string_concat(helper.read(&text), item, node),
                    initializes_global: false,
                    loc: helper.loc(),
                });
            }
            let callee = self.install_helper(helper.finish(&text));
            return Ok(Expr::Call {
                callee,
                args: vec![receiver, separator],
                r#type: Type::String,
                loc: self.loc(node),
            });
        }
        let Type::Array { elem } = receiver.ty() else {
            unreachable!()
        };
        let mut helper = Helper::new(
            "array_join",
            vec![receiver.ty(), Type::String],
            Type::String,
            self.loc(node),
        );
        let array = helper.param(0);
        let separator_slot = helper.param(1);
        let length = helper.local("length", Type::F64, false);
        let index = helper.local("index", Type::F64, true);
        let text = helper.local("text", Type::String, true);
        helper.declare(&length, helper.length(&array));
        helper.declare(&index, helper.number(0.0));
        helper.declare(&text, self.string_literal("", node));
        let item = self.string_value(helper.get(&array, &index, *elem), node, Context::Element)?;
        helper.function.body.push(Stmt::While {
            cond: helper.less(&index, helper.read(&length)),
            body: vec![
                Stmt::If {
                    cond: Expr::Bin {
                        op: ">".into(),
                        left: Box::new(helper.read(&index)),
                        right: Box::new(helper.number(0.0)),
                        r#type: Type::Bool,
                        loc: helper.loc(),
                    },
                    then: vec![Stmt::Assign {
                        local_id: text.id.clone(),
                        value: self.string_concat(
                            helper.read(&text),
                            helper.read(&separator_slot),
                            node,
                        ),
                        initializes_global: false,
                        loc: helper.loc(),
                    }],
                    else_: None,
                    loc: helper.loc(),
                },
                Stmt::Assign {
                    local_id: text.id.clone(),
                    value: self.string_concat(helper.read(&text), item, node),
                    initializes_global: false,
                    loc: helper.loc(),
                },
                helper.advance(&index),
            ],
            loc: helper.loc(),
        });
        let callee = self.install_helper(helper.finish(&text));
        Ok(Expr::Call {
            callee,
            args: vec![receiver, separator],
            r#type: Type::String,
            loc: self.loc(node),
        })
    }
}
