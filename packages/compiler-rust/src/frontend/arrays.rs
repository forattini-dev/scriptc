//! Dense typed arrays: map materializes a fresh array before Map consumes it.
use super::*;
use helpers::Helper;

impl Lowerer<'_> {
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
                    Type::Record { shape_id } if self.records[shape_id].tuple => {
                        self.tuple_extend(element, read(self.loc(element)), source)?
                    }
                    _ => return Err(self.refuse(element, "array spread requires a native array or fixed tuple; general iterators are not ported")),
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
        if member.name().text() == "map" {
            return self.array_map(node, None);
        }
        if member.name().text() == "join" {
            return self.array_join(node);
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
