//! Dense typed arrays: map materializes a fresh array before Map consumes it.
use super::*;
use helpers::Helper;

impl Lowerer<'_> {
    pub(super) fn nullable_array_element(&self, ty: &Type) -> Option<Type> {
        let Type::Union { union_id } = ty else {
            return None;
        };
        let arms = &self.unions[*union_id].arms;
        let mut arrays = arms.iter().filter_map(|arm| match arm {
            Type::Array { elem } => Some(elem.as_ref().clone()),
            _ => None,
        });
        let element = arrays.next()?;
        (arrays.next().is_none()
            && arms
                .iter()
                .all(|arm| matches!(arm, Type::Array { .. } | Type::Null | Type::Undefined)))
        .then_some(element)
    }

    pub(super) fn array_view(&self, ty: &Type) -> bool {
        match ty {
            Type::Array { .. } => true,
            Type::Union { union_id } => {
                let arms = &self.unions[*union_id].arms;
                arms.iter().any(|arm| matches!(arm, Type::Array { .. }))
                    && arms
                        .iter()
                        .all(|arm| matches!(arm, Type::Array { .. } | Type::Null | Type::Undefined))
            }
            _ => false,
        }
    }

    pub(super) fn array_length(&mut self, node: Node, receiver: Expr) -> Result<Expr, String> {
        if matches!(receiver.ty(), Type::Array { .. }) {
            return Ok(Expr::ArrayIntrinsic {
                method: "length".into(),
                receiver: Box::new(receiver),
                args: vec![],
                r#type: Type::F64,
                loc: self.loc(node),
            });
        }
        let Type::Union { union_id } = receiver.ty() else {
            unreachable!()
        };
        let arms = self.unions[union_id].arms.clone();
        let mut helper = Helper::new(
            "array_length",
            vec![receiver.ty()],
            Type::F64,
            self.loc(node),
        );
        let input = helper.param(0);
        for (tag, arm) in arms.iter().enumerate() {
            let value = if matches!(arm, Type::Array { .. }) {
                // Keep array ownership typed; length does not require erasing
                // the element layout into a generic object representation.
                Expr::ArrayIntrinsic {
                    method: "length".into(),
                    receiver: Box::new(Expr::UnionNarrow {
                        value: Box::new(helper.read(&input)),
                        union_id: format!("u{union_id}"),
                        tag,
                        r#type: arm.clone(),
                        loc: helper.loc(),
                    }),
                    args: vec![],
                    r#type: Type::F64,
                    loc: helper.loc(),
                }
            } else {
                let receiver = self.coerce(
                    Expr::UnitLit {
                        unit: if *arm == Type::Null {
                            "null"
                        } else {
                            "undefined"
                        },
                        r#type: arm.clone(),
                        loc: helper.loc(),
                    },
                    Type::Dyn,
                    node,
                )?;
                let key = Expr::StrLit {
                    value: "length".into(),
                    r#type: Type::String,
                    loc: helper.loc(),
                };
                let read = self.dynamic_get(node, receiver, key);
                self.coerce(read, Type::F64, node)?
            };
            let ret = Stmt::Return {
                value: Some(value),
                loc: helper.loc(),
            };
            if tag + 1 == arms.len() {
                helper.function.body.push(ret);
            } else {
                helper.function.body.push(Stmt::If {
                    cond: Expr::UnionIsTag {
                        value: Box::new(helper.read(&input)),
                        union_id: format!("u{union_id}"),
                        tag,
                        negated: false,
                        r#type: Type::Bool,
                        loc: helper.loc(),
                    },
                    then: vec![ret],
                    else_: None,
                    loc: helper.loc(),
                });
            }
        }
        let callee = self.install_helper(helper.function);
        Ok(Expr::Call {
            callee,
            args: vec![receiver],
            r#type: Type::F64,
            loc: self.loc(node),
        })
    }

    /// Each spread is consumed before the next source element is evaluated.
    /// Passing all sources to one eager helper would observe later mutations
    /// too early, or copy a source only after its following element changed it.
    pub(super) fn array_spread_literal(&mut self, node: Node, ty: Type) -> Result<Expr, String> {
        let Type::Array { elem } = &ty else {
            unreachable!()
        };
        let output = Local {
            id: format!("array_literal{}", self.locals.len()),
            name: "array construction".into(),
            r#type: ty.clone(),
            mutable: false,
            boxed: false,
        };
        self.locals.push(output.clone());
        let read = |loc: Loc| Expr::VarRef {
            local_id: output.id.clone(),
            r#type: ty.clone(),
            loc,
        };
        let mut stmts = vec![Stmt::VarDecl {
            local_id: output.id.clone(),
            init: Expr::ArrayLit {
                elems: vec![],
                r#type: ty.clone(),
                loc: self.loc(node),
            },
            loc: self.loc(node),
        }];
        for element in node.elements() {
            if element.kind() == SyntaxKind::OmittedExpression {
                return Err(self.refuse(
                    element,
                    "array construction with holes requires a sparse iterator contract",
                ));
            }
            let expr = if element.kind() == SyntaxKind::SpreadElement {
                // Observe the live slot, including any undefined tag left by a
                // preceding callback. Unknown/custom iterators stay refused.
                let source_node = primitives::primitive_source(element.expression());
                let source = if source_node.kind() == SyntaxKind::ArrayLiteralExpression {
                    // Empty literals have never[] in the checker. Their
                    // elements are contextual at this construction boundary.
                    self.expected_expression(source_node, ty.clone())?
                } else {
                    self.condition_value(source_node)?
                };
                match source.ty() {
                    Type::Array { .. } => self.array_extend(element, read(self.loc(element)), source)?,
                    Type::String => self.string_extend(element, read(self.loc(element)), source)?,
                    Type::Record { shape_id } if self.records[shape_id].tuple => {
                        self.tuple_extend(element, read(self.loc(element)), source)?
                    }
                    _ => return Err(self.refuse(element, "array spread requires a native array, string or fixed tuple; general iterators are not ported")),
                }
            } else {
                let value = self.expected_expression(element, (**elem).clone())?;
                Expr::ArrayIntrinsic {
                    method: "push".into(),
                    receiver: Box::new(read(self.loc(element))),
                    args: vec![value],
                    r#type: Type::F64,
                    loc: self.loc(element),
                }
            };
            stmts.push(Stmt::Expression {
                expr,
                loc: self.loc(element),
            });
        }
        Ok(Expr::Sequence {
            stmts,
            result: Box::new(read(self.loc(node))),
            r#type: ty.clone(),
            loc: self.loc(node),
        })
    }

    fn string_extend(&mut self, node: Node, output: Expr, source: Expr) -> Result<Expr, String> {
        let Type::Array { elem } = output.ty() else {
            unreachable!()
        };
        let mut helper = Helper::new(
            "string_extend",
            vec![output.ty(), Type::String],
            output.ty(),
            self.loc(node),
        );
        let result = helper.param(0);
        let input = helper.param(1);
        let index = helper.local("index", Type::F64, true);
        helper.declare(&index, helper.number(0.0));
        let loc = helper.loc();
        let width = self.string_iteration_width(helper.read(&input), helper.read(&index), node);
        let next = Expr::Bin {
            op: "+".into(),
            left: Box::new(helper.read(&index)),
            right: Box::new(width),
            r#type: Type::F64,
            loc: loc.clone(),
        };
        let item = Expr::StringIntrinsic {
            method: "slice".into(),
            receiver: Box::new(helper.read(&input)),
            args: vec![helper.read(&index), next.clone()],
            r#type: Type::String,
            loc: loc.clone(),
        };
        let item = self.coerce(item, *elem, node)?;
        let length = Expr::StringIntrinsic {
            method: "length".into(),
            receiver: Box::new(helper.read(&input)),
            args: vec![],
            r#type: Type::F64,
            loc: loc.clone(),
        };
        helper.function.body.push(Stmt::While {
            cond: helper.less(&index, length),
            body: vec![
                Stmt::Expression {
                    expr: Expr::ArrayIntrinsic {
                        method: "push".into(),
                        receiver: Box::new(helper.read(&result)),
                        args: vec![item],
                        r#type: Type::F64,
                        loc: loc.clone(),
                    },
                    loc: loc.clone(),
                },
                Stmt::Assign {
                    local_id: index.id.clone(),
                    value: next,
                    initializes_global: false,
                    loc: loc.clone(),
                },
            ],
            loc,
        });
        let callee = self.install_helper(helper.finish(&result));
        Ok(Expr::Call {
            callee,
            args: vec![output, source],
            r#type: result.r#type,
            loc: self.loc(node),
        })
    }

    fn array_extend(&mut self, node: Node, output: Expr, source: Expr) -> Result<Expr, String> {
        let Type::Array { elem: target } = output.ty() else {
            unreachable!()
        };
        let Type::Array { elem } = source.ty() else {
            unreachable!()
        };
        let mut helper = Helper::new(
            "array_extend",
            vec![output.ty(), source.ty()],
            output.ty(),
            self.loc(node),
        );
        let result = helper.param(0);
        let input = helper.param(1);
        let index = helper.local("index", Type::F64, true);
        helper.declare(&index, helper.number(0.0));
        let item = self.coerce(helper.get(&input, &index, *elem), *target, node)?;
        let push = Expr::ArrayIntrinsic {
            method: "push".into(),
            receiver: Box::new(helper.read(&result)),
            args: vec![item],
            r#type: Type::F64,
            loc: helper.loc(),
        };
        helper.function.body.push(Stmt::While {
            cond: helper.less(&index, helper.length(&input)),
            body: vec![
                Stmt::Expression {
                    expr: push,
                    loc: helper.loc(),
                },
                helper.advance(&index),
            ],
            loc: helper.loc(),
        });
        let callee = self.install_helper(helper.finish(&result));
        Ok(Expr::Call {
            callee,
            args: vec![output, source],
            r#type: result.r#type,
            loc: self.loc(node),
        })
    }

    fn tuple_extend(&mut self, node: Node, output: Expr, source: Expr) -> Result<Expr, String> {
        let Type::Array { elem } = output.ty() else {
            unreachable!()
        };
        let Type::Record { shape_id } = source.ty() else {
            unreachable!()
        };
        let mut helper = Helper::new(
            "tuple_extend",
            vec![output.ty(), source.ty()],
            output.ty(),
            self.loc(node),
        );
        let result = helper.param(0);
        let input = helper.param(1);
        for name in self.records[shape_id].declared_order.clone() {
            let field = self.records[shape_id]
                .fields
                .iter()
                .find(|field| field.name == name)
                .expect("required tuple position");
            let item = Expr::RecordGet {
                obj: Box::new(helper.read(&input)),
                shape_id: format!("r{shape_id}"),
                field: name,
                r#type: field.r#type.clone(),
                loc: helper.loc(),
            };
            let item = self.coerce(item, (*elem).clone(), node)?;
            helper.function.body.push(Stmt::Expression {
                expr: Expr::ArrayIntrinsic {
                    method: "push".into(),
                    receiver: Box::new(helper.read(&result)),
                    args: vec![item],
                    r#type: Type::F64,
                    loc: helper.loc(),
                },
                loc: helper.loc(),
            });
        }
        let callee = self.install_helper(helper.finish(&result));
        Ok(Expr::Call {
            callee,
            args: vec![output, source],
            r#type: result.r#type,
            loc: self.loc(node),
        })
    }

    pub(super) fn is_array_map(&mut self, node: Node) -> bool {
        if node.kind() != SyntaxKind::CallExpression {
            return false;
        }
        let member = node.expression();
        if member.kind() != SyntaxKind::PropertyAccessExpression || member.name().text() != "map" {
            return false;
        }
        let receiver = member.expression();
        let symbol = self.symbol(receiver);
        let ty = self
            .bindings
            .get(&symbol)
            .or_else(|| self.module_bindings.get(&symbol))
            .map(|l| l.r#type.clone())
            .or_else(|| self.ty(receiver).ok());
        matches!(ty, Some(Type::Array { .. }))
    }

    pub(super) fn array_call(&mut self, node: Node) -> Result<Expr, String> {
        let member = node.expression();
        if member.name().text() == "includes" {
            return self.array_includes(node);
        }
        if member.name().text() == "sort" {
            return self.array_sort(node);
        }
        if matches!(member.name().text(), "some" | "every" | "slice") {
            return self.array_sequence_method(node);
        }
        if member.name().text() == "map" {
            return self.array_map(node, None);
        }
        if member.name().text() == "join" {
            return self.array_join(node);
        }
        if member.name().text() == "pop" {
            return self.array_pop(node);
        }
        if member.name().text() != "push" {
            return Err(self.refuse(node, "array method is not ported"));
        }
        let receiver = self.expression(member.expression())?;
        let Type::Array { elem } = receiver.ty() else {
            return Err(self.refuse(node, "non-array receiver"));
        };
        let args = node
            .arguments()
            .into_iter()
            .map(|arg| self.expected_expression(arg, (*elem).clone()))
            .collect::<Result<Vec<_>, _>>()?;
        Ok(Expr::ArrayIntrinsic {
            method: "push".into(),
            receiver: Box::new(receiver),
            args,
            r#type: Type::F64,
            loc: self.loc(node),
        })
    }

    fn array_sort(&mut self, node: Node) -> Result<Expr, String> {
        let member = node.expression();
        let symbol = self.symbol(member.name());
        if !self.primitive_symbol(symbol, "sort", Some("Array")) {
            return Err(self.refuse(member, "array.sort requires its standard declaration"));
        }
        if !node.arguments().is_empty() {
            return Err(self.refuse(node, "array.sort comparators are not ported"));
        }
        let receiver = self.expression(member.expression())?;
        let receiver = self.live_member_receiver(member.expression(), receiver);
        let ty = receiver.ty();
        if !matches!(&ty, Type::Array { elem } if **elem == Type::String) {
            return Err(self.refuse(node, "default array.sort requires a native string array"));
        }
        let value = self.coerce(receiver, Type::Dyn, node)?;
        let sorted = Expr::DynInvoke {
            recv: Box::new(value),
            method: "sort".into(),
            callee_name: "Array.sort".into(),
            args: vec![],
            r#type: Type::Dyn,
            loc: self.loc(node),
        };
        self.coerce(sorted, ty, node)
    }

    fn array_pop(&mut self, node: Node) -> Result<Expr, String> {
        let source = node.expression().expression();
        let receiver = self.expression(source)?;
        let receiver = self.live_member_receiver(source, receiver);
        let Type::Array { elem } = receiver.ty() else {
            return Err(self.refuse(node, "pop needs a non-null native array"));
        };
        if *elem == Type::Dyn
            || (matches!(*elem, Type::Union { .. }) && !self.optional_storage(&elem))
        {
            return Err(self.refuse(
                node,
                "pop element needs an existing native undefined union contract",
            ));
        }
        let result_type = self.undefined_storage_type(*elem, node)?;
        let local = self.construction_local(receiver.ty(), false);
        let mut stmts = vec![Stmt::VarDecl {
            local_id: local.id.clone(),
            init: receiver,
            loc: self.loc(source),
        }];
        for argument in node.arguments() {
            if argument.kind() == SyntaxKind::SpreadElement {
                return Err(self.refuse(argument, "pop argument spreads are not ported"));
            }
            stmts.push(Stmt::Expression {
                expr: self.expression(argument)?,
                loc: self.loc(argument),
            });
        }
        Ok(Expr::Sequence {
            stmts,
            result: Box::new(Expr::ArrayIntrinsic {
                method: "pop".into(),
                receiver: Box::new(self.construction_read(&local, source)),
                args: vec![],
                r#type: result_type.clone(),
                loc: self.loc(node),
            }),
            r#type: result_type,
            loc: self.loc(node),
        })
    }

    pub(super) fn array_map(&mut self, node: Node, expected: Option<Type>) -> Result<Expr, String> {
        let receiver = self.expression(node.expression().expression())?;
        let Type::Array { elem: source } = receiver.ty() else {
            return Err(self.refuse(node, "map receiver needs a native array"));
        };
        let output = if let Some(expected) = expected {
            expected
        } else {
            self.ty(node)?
        };
        let Type::Array { elem: result } = &output else {
            return Err(self.refuse(node, "array.map result needs a native element type"));
        };
        let arguments = node.arguments().into_iter().collect::<Vec<_>>();
        if arguments.len() != 1 {
            return Err(self.refuse(
                node,
                "array.map requires one callback; thisArg is not ported",
            ));
        }
        let mut callback_node = arguments[0];
        while callback_node.kind() == SyntaxKind::ParenthesizedExpression {
            callback_node = callback_node.expression();
        }
        let inputs = [(*source).clone(), Type::F64, receiver.ty()];
        let callback = if matches!(
            callback_node.kind(),
            SyntaxKind::ArrowFunction | SyntaxKind::FunctionExpression
        ) {
            if callback_node
                .parameters()
                .iter()
                .any(|parameter| !parameter.dot_dot_dot_token().is_nil())
            {
                let ty = self.ty(callback_node)?;
                if !matches!(ty, Type::Func { rest: true, .. }) {
                    return Err(self.refuse(
                        callback_node,
                        "array.map tuple-rest callbacks are not ported",
                    ));
                }
                self.closure(callback_node, Some(ty))?
            } else {
                if callback_node.parameters().len() > 3 {
                    return Err(self.refuse(
                        callback_node,
                        "array.map callback accepts at most three native slots",
                    ));
                }
                let params = callback_node
                    .parameters()
                    .into_iter()
                    .zip(&inputs)
                    .map(|(node, ty)| self.parameter_type(node, ty.clone()))
                    .collect::<Result<Vec<_>, _>>()?;
                self.closure(
                    callback_node,
                    Some(Type::Func {
                        rest: false,
                        params,
                        ret: result.clone(),
                    }),
                )?
            }
        } else {
            self.expression(callback_node)?
        };
        let Type::Func { params, ret, rest } = callback.ty() else {
            return Err(self.refuse(callback_node, "array.map callback is not a native function"));
        };
        if params.len() > if rest { 4 } else { 3 } {
            return Err(self.refuse(
                callback_node,
                "array.map callback requires unsupported argument slots",
            ));
        }
        let mut helper = Helper::new(
            "array_map",
            vec![receiver.ty(), callback.ty()],
            output.clone(),
            self.loc(node),
        );
        let array = helper.param(0);
        let callback_slot = helper.param(1);
        let length = helper.local("length", Type::F64, false);
        let mapped = helper.local("mapped", output.clone(), false);
        let index = helper.local("index", Type::F64, true);
        helper.declare(&length, helper.length(&array));
        helper.declare(
            &mapped,
            Expr::ArrayLit {
                elems: vec![],
                r#type: output.clone(),
                loc: helper.loc(),
            },
        );
        helper.declare(&index, helper.number(0.0));
        let provided = [
            helper.get(&array, &index, *source),
            helper.read(&index),
            helper.read(&array),
        ];
        let args = params
            .iter()
            .enumerate()
            .map(|(index, target)| {
                if rest && index + 1 == params.len() {
                    let Type::Array { elem } = target else {
                        return Err(
                            self.refuse(callback_node, "array.map rest ABI requires an array slot")
                        );
                    };
                    let elems = provided
                        .iter()
                        .skip(index)
                        .cloned()
                        .map(|value| self.coerce(value, (**elem).clone(), callback_node))
                        .collect::<Result<Vec<_>, _>>()?;
                    Ok(Expr::ArrayLit {
                        elems,
                        r#type: target.clone(),
                        loc: helper.loc(),
                    })
                } else {
                    self.coerce(provided[index].clone(), target.clone(), callback_node)
                }
            })
            .collect::<Result<Vec<_>, _>>()?;
        let call = Expr::CallValue {
            callee: Box::new(helper.read(&callback_slot)),
            args,
            r#type: *ret,
            loc: helper.loc(),
        };
        let value = self.coerce(call, (**result).clone(), callback_node)?;
        let push = Expr::ArrayIntrinsic {
            method: "push".into(),
            receiver: Box::new(helper.read(&mapped)),
            args: vec![value],
            r#type: Type::F64,
            loc: helper.loc(),
        };
        helper.function.body.push(Stmt::While {
            cond: helper.less(&index, helper.read(&length)),
            body: vec![
                Stmt::Expression {
                    expr: push,
                    loc: helper.loc(),
                },
                helper.advance(&index),
            ],
            loc: helper.loc(),
        });
        let name = self.install_helper(helper.finish(&mapped));
        Ok(Expr::Call {
            callee: name,
            args: vec![receiver, callback],
            r#type: output,
            loc: self.loc(node),
        })
    }

    pub(super) fn map_from_array(
        &mut self,
        node: Node,
        entries: Expr,
        ty: Type,
    ) -> Result<Expr, String> {
        let Type::Map { key, value } = &ty else {
            unreachable!()
        };
        let Type::Array { elem } = entries.ty() else {
            return Err(self.refuse(node, "Map seed must be a native array of entry tuples"));
        };
        let Type::Record { shape_id } = *elem else {
            return Err(self.refuse(node, "Map entries need native tuple layouts"));
        };
        let record = &self.records[shape_id];
        if !record.tuple || record.fields.len() != 2 {
            return Err(self.refuse(node, "Map entry tuple must contain exactly two positions"));
        }
        let key_type = record.fields[0].r#type.clone();
        let value_type = record.fields[1].r#type.clone();
        let mut helper = Helper::new(
            "map_entries",
            vec![entries.ty()],
            ty.clone(),
            self.loc(node),
        );
        let array = helper.param(0);
        let map = helper.local("map", ty.clone(), false);
        let index = helper.local("index", Type::F64, true);
        let pair = helper.local("entry", *elem, false);
        helper.declare(
            &map,
            Expr::MapNew {
                seed: vec![],
                r#type: ty.clone(),
                loc: helper.loc(),
            },
        );
        helper.declare(&index, helper.number(0.0));
        let read = |position: &str, ty: Type| Expr::RecordGet {
            obj: Box::new(helper.read(&pair)),
            shape_id: format!("r{shape_id}"),
            field: position.into(),
            r#type: ty,
            loc: helper.loc(),
        };
        let key = self.coerce(read("0", key_type), (**key).clone(), node)?;
        let value = self.coerce(read("1", value_type), (**value).clone(), node)?;
        let set = Expr::MapIntrinsic {
            method: "set".into(),
            receiver: Box::new(helper.read(&map)),
            args: vec![key, value],
            r#type: Type::Void,
            loc: helper.loc(),
        };
        let body = vec![
            Stmt::VarDecl {
                local_id: pair.id.clone(),
                init: helper.get(&array, &index, pair.r#type.clone()),
                loc: helper.loc(),
            },
            Stmt::Expression {
                expr: set,
                loc: helper.loc(),
            },
            helper.advance(&index),
        ];
        helper.function.body.push(Stmt::While {
            cond: helper.less(&index, helper.length(&array)),
            body,
            loc: helper.loc(),
        });
        let name = self.install_helper(helper.finish(&map));
        Ok(Expr::Call {
            callee: name,
            args: vec![entries],
            r#type: ty,
            loc: self.loc(node),
        })
    }
}
