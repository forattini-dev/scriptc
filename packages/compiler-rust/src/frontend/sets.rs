//! Standard-library Sets have typed elements, owning identity and a finite ABI.
use super::*;
use source_frontend::prelude::get_source_file_of_node;

impl Lowerer<'_> {
    /// An immediately consumed built-in iterator has no observable lifetime.
    /// Keep this separate from general Set iterators, which must remain live
    /// across mutations and cannot be implemented by taking a snapshot.
    pub(super) fn immediate_set_first(&mut self, node: Node) -> Result<Option<Expr>, String> {
        if node.name().text() != "value" || !node.question_dot_token().is_nil() {
            return Ok(None);
        }
        let next = node.expression();
        if next.kind() != SyntaxKind::CallExpression
            || !next.question_dot_token().is_nil()
            || next.arguments().into_iter().next().is_some()
        {
            return Ok(None);
        }
        let next_member = next.expression();
        if next_member.kind() != SyntaxKind::PropertyAccessExpression
            || next_member.name().text() != "next"
            || !next_member.question_dot_token().is_nil()
        {
            return Ok(None);
        }
        let values = next_member.expression();
        if values.kind() != SyntaxKind::CallExpression
            || !values.question_dot_token().is_nil()
            || values.arguments().into_iter().next().is_some()
        {
            return Ok(None);
        }
        let member = values.expression();
        if member.kind() != SyntaxKind::PropertyAccessExpression
            || member.name().text() != "values"
            || !member.question_dot_token().is_nil()
        {
            return Ok(None);
        }
        let symbol = self.symbol(member.name());
        if !self.primitive_symbol(symbol, "values", Some("Set"))
            && !self.primitive_symbol(symbol, "values", Some("ReadonlySet"))
        {
            return Ok(None);
        }
        let receiver = self.expression(member.expression())?;
        let Type::Set { elem } = receiver.ty() else {
            return Ok(None);
        };
        if matches!(*elem, Type::Func { .. }) {
            return Err(self.refuse(
                node,
                "immediate Set iteration of functions requires an owning callable array ABI",
            ));
        }
        let result = self
            .intern_union(vec![(*elem).clone(), Type::Undefined])
            .ok_or_else(|| self.refuse(node, "Set iterator result has no native representation"))?;
        let mut helper = helpers::Helper::new(
            "set_immediate_first",
            vec![receiver.ty()],
            result.clone(),
            self.loc(node),
        );
        let array_ty = Type::Array { elem: elem.clone() };
        let array = helper.local("values", array_ty.clone(), false);
        helper.declare(
            &array,
            Expr::SetIntrinsic {
                method: "toArray".into(),
                receiver: Box::new(helper.read(&helper.param(0))),
                args: vec![],
                r#type: array_ty,
                loc: helper.loc(),
            },
        );
        let present = Expr::ArrayGet {
            arr: Box::new(helper.read(&array)),
            index: Box::new(helper.number(0.0)),
            r#type: *elem,
            loc: helper.loc(),
        };
        let missing = Expr::UnitLit {
            unit: "undefined",
            r#type: Type::Undefined,
            loc: helper.loc(),
        };
        let test = Expr::Bin {
            op: "!==".into(),
            left: Box::new(helper.length(&array)),
            right: Box::new(helper.number(0.0)),
            r#type: Type::Bool,
            loc: helper.loc(),
        };
        helper.function.body.push(Stmt::If {
            cond: test,
            then: vec![Stmt::Return {
                value: Some(self.coerce(present, result.clone(), node)?),
                loc: helper.loc(),
            }],
            else_: None,
            loc: helper.loc(),
        });
        helper.function.body.push(Stmt::Return {
            value: Some(self.coerce(missing, result.clone(), node)?),
            loc: helper.loc(),
        });
        let callee = self.install_helper(helper.function);
        Ok(Some(Expr::Call {
            callee,
            args: vec![receiver],
            r#type: result,
            loc: self.loc(node),
        }))
    }

    pub(super) fn set_type(&mut self, id: TypeId) -> Option<Type> {
        let symbol = self.checker.ty(id).symbol();
        if symbol.0 == 0 {
            return None;
        }
        let info = self.checker.sym(symbol);
        if !matches!(info.name.as_ref(), "Set" | "ReadonlySet")
            || !info.declarations.iter().any(|n| {
                !n.is_nil()
                    && source_file_info(get_source_file_of_node(*n))
                        .file_name
                        .ends_with("/lib.es2015.collection.d.ts")
            })
        {
            return None;
        }
        let args = self.checker.get_type_arguments(id).to_vec();
        if args.len() != 1 {
            return None;
        }
        let elem = self.type_id(args[0])?;
        // Portable Sets keep heterogeneous union values in the owning tagged
        // slot. Membership consumes values; no unchecked element is projected.
        let elem = if matches!(elem, Type::Bigint | Type::Union { .. }) {
            Type::Dyn
        } else {
            elem
        };
        elem.set_element().then_some(Type::Set {
            elem: Box::new(elem),
        })
    }

    pub(super) fn set_new(&mut self, node: Node, expected: Option<Type>) -> Result<Expr, String> {
        let ty = match expected {
            Some(ty) => ty,
            None => self.ty(node)?,
        };
        let Type::Set { elem } = &ty else {
            return Err(self.refuse(node, "Set needs a native element type"));
        };
        let symbol = self.symbol(node.expression());
        if symbol == 0
            || self.bindings.contains_key(&symbol)
            || self.module_bindings.contains_key(&symbol)
        {
            return Err(self.refuse(node, "Set constructor must be the standard library value"));
        }
        let info = self.checker.sym(source_frontend::prelude::SymbolId(symbol));
        if info.name.as_ref() != "Set"
            || !info.declarations.iter().any(|n| {
                !n.is_nil()
                    && source_file_info(get_source_file_of_node(*n))
                        .file_name
                        .ends_with("/lib.es2015.collection.d.ts")
            })
        {
            return Err(self.refuse(node, "Set constructor must be the standard library value"));
        }
        let arguments = node.arguments().into_iter().collect::<Vec<_>>();
        if arguments.len() > 1
            || arguments
                .iter()
                .any(|n| n.kind() == SyntaxKind::SpreadElement)
        {
            return Err(self.refuse(node, "Set accepts one native array seed"));
        }
        if let Some(arg) = arguments.first()
            && arg.kind() == SyntaxKind::ArrayLiteralExpression
            && matches!(**elem, Type::Func { .. })
        {
            return self.set_literal_seed(node, *arg, ty.clone(), (**elem).clone());
        }
        let seed = if let Some(arg) = arguments.first() {
            let value = if arg.kind() == SyntaxKind::ArrayLiteralExpression {
                if **elem == Type::Dyn {
                    let value = self.dynamic_literal(*arg)?;
                    Expr::DynCheck {
                        value: Box::new(value),
                        r#type: Type::Array { elem: elem.clone() },
                        loc: self.loc(*arg),
                    }
                } else {
                    self.expected_expression(*arg, Type::Array { elem: elem.clone() })?
                }
            } else {
                let value = self.expression(*arg)?;
                if matches!(**elem, Type::Dyn | Type::Func { .. })
                    && !matches!(value, Expr::UnitLit { .. })
                {
                    return Err(self.refuse(
                        *arg,
                        "dynamic/function Set seeds require a fixed array literal",
                    ));
                }
                value
            };
            if matches!(value, Expr::UnitLit { .. }) {
                None
            } else if value.ty() == (Type::Array { elem: elem.clone() }) {
                Some(Box::new(value))
            } else {
                return Err(self.refuse(
                    *arg,
                    "Set seed requires a native array; general iterables are not ported",
                ));
            }
        } else {
            None
        };
        Ok(Expr::SetNew {
            seed,
            r#type: ty,
            loc: self.loc(node),
        })
    }

    fn set_literal_seed(
        &mut self,
        node: Node,
        seed: Node,
        ty: Type,
        elem: Type,
    ) -> Result<Expr, String> {
        let mut values = Vec::new();
        for item in seed.elements() {
            if matches!(
                item.kind(),
                SyntaxKind::SpreadElement | SyntaxKind::OmittedExpression
            ) {
                return Err(self.refuse(item, "Set literal seeds require fixed present elements"));
            }
            values.push(self.expected_expression(item, elem.clone())?);
        }
        // Snapshot all literal elements before insertion. The temporary source
        // array has no observable identity; each stored value keeps its own.
        let mut helper = helpers::Helper::new(
            "set_literal",
            vec![elem; values.len()],
            ty.clone(),
            self.loc(node),
        );
        let set = helper.local("set", ty.clone(), false);
        helper.declare(
            &set,
            Expr::SetNew {
                seed: None,
                r#type: ty.clone(),
                loc: self.loc(node),
            },
        );
        for index in 0..values.len() {
            helper.function.body.push(Stmt::Expression {
                expr: Expr::SetIntrinsic {
                    method: "add".into(),
                    receiver: Box::new(helper.read(&set)),
                    args: vec![helper.read(&helper.param(index))],
                    r#type: Type::Void,
                    loc: self.loc(node),
                },
                loc: self.loc(node),
            });
        }
        let callee = self.install_helper(helper.finish(&set));
        Ok(Expr::Call {
            callee,
            args: values,
            r#type: ty,
            loc: self.loc(node),
        })
    }

    pub(super) fn set_intrinsic(
        &mut self,
        node: Node,
        receiver: Expr,
        method: &str,
        arguments: Vec<Node>,
    ) -> Result<Expr, String> {
        let Type::Set { elem } = receiver.ty() else {
            return Err(self.refuse(node, "Set receiver may be undefined"));
        };
        if matches!(method, "has" | "delete")
            && arguments.len() == 1
            && matches!(*elem, Type::String | Type::F64)
        {
            let key = self.condition_value(primitives::primitive_source(arguments[0]))?;
            if key.ty() == *elem {
                return Ok(Expr::SetIntrinsic {
                    method: method.into(),
                    receiver: Box::new(receiver),
                    args: vec![key],
                    r#type: Type::Bool,
                    loc: self.loc(node),
                });
            }
            // A query never converts its key to the stored element type.
            // Capture both arguments first, then guard the typed Set ABI.
            let key = self.coerce(key, Type::Dyn, arguments[0])?;
            let mut helper = helpers::Helper::new(
                &format!("set_query_{method}"),
                vec![receiver.ty(), Type::Dyn],
                Type::Bool,
                self.loc(node),
            );
            let set = helper.param(0);
            let query = helper.param(1);
            helper.function.body.push(Stmt::If {
                cond: Expr::DynTest {
                    value: Box::new(helper.read(&query)),
                    test: if *elem == Type::String {
                        "string"
                    } else {
                        "number"
                    }
                    .into(),
                    negated: false,
                    r#type: Type::Bool,
                    loc: helper.loc(),
                },
                then: vec![Stmt::Return {
                    value: Some(Expr::SetIntrinsic {
                        method: method.into(),
                        receiver: Box::new(helper.read(&set)),
                        args: vec![Expr::DynCheck {
                            value: Box::new(helper.read(&query)),
                            r#type: *elem,
                            loc: helper.loc(),
                        }],
                        r#type: Type::Bool,
                        loc: helper.loc(),
                    }),
                    loc: helper.loc(),
                }],
                else_: None,
                loc: helper.loc(),
            });
            helper.function.body.push(Stmt::Return {
                value: Some(Expr::BoolLit {
                    value: false,
                    r#type: Type::Bool,
                    loc: helper.loc(),
                }),
                loc: helper.loc(),
            });
            let callee = self.install_helper(helper.function);
            return Ok(Expr::Call {
                callee,
                args: vec![receiver, key],
                r#type: Type::Bool,
                loc: self.loc(node),
            });
        }
        let (types, result) = match method {
            "add" => (vec![*elem], Type::Void),
            "has" | "delete" => (vec![*elem], Type::Bool),
            "clear" => (vec![], Type::Void),
            "size" => (vec![], Type::F64),
            _ => return Err(self.refuse(node, "Set method is not ported")),
        };
        if types.len() != arguments.len() {
            return Err(self.refuse(node, "Set method arity is not ported"));
        }
        let args = arguments
            .into_iter()
            .zip(types)
            .map(|(n, t)| self.expected_expression(n, t))
            .collect::<Result<Vec<_>, _>>()?;
        if method == "add" {
            // Shared IR add returns void; the source call returns its receiver.
            // Keep both receiver and argument evaluation outside the helper.
            let mut helper = helpers::Helper::new(
                "set_add",
                vec![receiver.ty(), args[0].ty()],
                receiver.ty(),
                self.loc(node),
            );
            let set = helper.param(0);
            helper.function.body.push(Stmt::Expression {
                expr: Expr::SetIntrinsic {
                    method: method.into(),
                    receiver: Box::new(helper.read(&set)),
                    args: vec![helper.read(&helper.param(1))],
                    r#type: Type::Void,
                    loc: helper.loc(),
                },
                loc: helper.loc(),
            });
            let callee = self.install_helper(helper.finish(&set));
            let result = receiver.ty();
            return Ok(Expr::Call {
                callee,
                args: std::iter::once(receiver).chain(args).collect(),
                r#type: result,
                loc: self.loc(node),
            });
        }
        Ok(Expr::SetIntrinsic {
            method: method.into(),
            receiver: Box::new(receiver),
            args,
            r#type: result,
            loc: self.loc(node),
        })
    }
}
