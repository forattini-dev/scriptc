//! Standard-library Sets have typed elements, owning identity and a finite ABI.
use super::*;
use source_frontend::prelude::get_source_file_of_node;

impl Lowerer<'_> {
    /// Recover the owner of a direct standard Set keys/values iterator call.
    pub(super) fn set_iterator_source(&mut self, node: Node) -> Result<Option<Expr>, String> {
        if node.kind() != SyntaxKind::CallExpression
            || !node.question_dot_token().is_nil()
            || node.arguments().into_iter().next().is_some()
        {
            return Ok(None);
        }
        let member = node.expression();
        if member.kind() != SyntaxKind::PropertyAccessExpression
            || !member.question_dot_token().is_nil()
            || !matches!(member.name().text(), "keys" | "values")
        {
            return Ok(None);
        }
        let method = member.name().text();
        let symbol = self.symbol(member.name());
        if !self.primitive_symbol(symbol, method, Some("Set"))
            && !self.primitive_symbol(symbol, method, Some("ReadonlySet"))
        {
            return Ok(None);
        }
        let receiver = self.expression(member.expression())?;
        if !matches!(receiver.ty(), Type::Set { .. }) {
            return Ok(None);
        }
        Ok(Some(receiver))
    }

    /// Materialize a built-in Set iterator only when its consumer immediately
    /// exhausts it. A snapshot preserves insertion order without pretending
    /// that general escaping Set iterators have an Array ABI.
    pub(super) fn immediate_set_iteration(&mut self, node: Node) -> Result<Option<Expr>, String> {
        let Some(receiver) = self.set_iterator_source(node)? else {
            return Ok(None);
        };
        let Type::Set { elem } = receiver.ty() else {
            unreachable!("validated Set iterator")
        };
        let array = Type::Array { elem };
        Ok(Some(Expr::SetIntrinsic {
            method: "toArray".into(),
            receiver: Box::new(receiver),
            args: vec![],
            r#type: array,
            loc: self.loc(node),
        }))
    }

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
        // Set storage is owning even when the semantic element has no typed
        // payload (`undefined`, `null`, or `never`). Route those values through
        // NativeValue instead of rejecting a valid Set such as Zod's
        // `new Set([undefined])`.
        let elem = self.aggregate_slot_type(args[0])?;
        // Portable Sets keep heterogeneous union values in the owning tagged
        // slot. Membership consumes values; no unchecked element is projected.
        let elem = if matches!(elem, Type::Bigint | Type::Union { .. }) {
            Type::Dyn
        } else if !elem.set_element()
            && matches!(elem, Type::Object { .. } | Type::Array { .. } | Type::Bytes { .. })
            && self.dynamic_erasure_reason(&elem).is_none()
        {
            // Object identities (class instances, arrays, byte views) keep
            // their owning handle in a NativeValue slot; SameValueZero
            // membership compares those handles, as JavaScript does.
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
                // A type assertion in a literal is not a runtime conversion.
                // Build its actual values before consuming the iterable.
                self.dynamic_literal(*arg)?
            } else {
                let mut value = self.expression(*arg)?;
                if value.ty() == Type::String && **elem == Type::String {
                    value = Expr::LibCall {
                        r#fn: "string.iterArray".into(),
                        args: vec![value],
                        r#type: Type::Array {
                            elem: Box::new(Type::String),
                        },
                        loc: self.loc(*arg),
                    };
                }
                // Dynamic arrays already own cloneable `NativeValue` slots and
                // the backend canonicalizes each one through `native_map_key`.
                // They therefore have the same safe seed path as primitive
                // arrays. Bare function slots still need the literal helper's
                // explicit callable ownership ABI.
                if matches!(**elem, Type::Func { .. }) && !matches!(value, Expr::UnitLit { .. }) {
                    return Err(
                        self.refuse(*arg, "function Set seeds require a fixed array literal")
                    );
                }
                value
            };
            if matches!(value, Expr::UnitLit { .. }) {
                None
            } else {
                self.materialize_erased_symbol_methods(&value.ty())?;
                Some(Box::new(self.coerce(value, Type::Dyn, *arg)?))
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
        if matches!(method, "add" | "has" | "delete") && arguments.len() == 1 {
            // Set keys are not coerced to a TypeScript element annotation.
            // The owning store retains actual JavaScript values and compares
            // them with SameValueZero, including values entering through any.
            let key = self.condition_value(primitives::primitive_source(arguments[0]))?;
            self.materialize_erased_symbol_methods(&key.ty())?;
            let key = self.coerce(key, Type::Dyn, arguments[0])?;
            let intrinsic = match method {
                "add" => "addValue",
                "has" => "hasValue",
                "delete" => "deleteValue",
                _ => unreachable!(),
            };
            if method != "add" || node.parent().kind() == SyntaxKind::ExpressionStatement {
                return Ok(Expr::SetIntrinsic {
                    method: intrinsic.into(),
                    receiver: Box::new(receiver),
                    args: vec![key],
                    r#type: if method == "add" {
                        Type::Void
                    } else {
                        Type::Bool
                    },
                    loc: self.loc(node),
                });
            }
            let mut helper = helpers::Helper::new(
                "set_add_value",
                vec![receiver.ty(), Type::Dyn],
                receiver.ty(),
                self.loc(node),
            );
            let set = helper.param(0);
            helper.function.body.push(Stmt::Expression {
                expr: Expr::SetIntrinsic {
                    method: intrinsic.into(),
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
                args: vec![receiver, key],
                r#type: result,
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
            if node.parent().kind() == SyntaxKind::ExpressionStatement {
                // The source return value is the receiver, but a standalone
                // call cannot observe it. Keep receiver-before-argument
                // evaluation in the intrinsic and avoid synthesizing a helper
                // that clones the Set into and back out of a function call.
                return Ok(Expr::SetIntrinsic {
                    method: method.into(),
                    receiver: Box::new(receiver),
                    args,
                    r#type: Type::Void,
                    loc: self.loc(node),
                });
            }
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
