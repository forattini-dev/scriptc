//! Property membership observes storage, never a field's value or its static type.
use super::*;
use helpers::Helper;

impl Lowerer<'_> {
    pub(super) fn object_presence(&mut self, node: Node) -> Result<Expr, String> {
        let receiver = receivers::reference_node(node.right());
        let symbol = self.symbol(receiver);
        if receiver.kind() == SyntaxKind::Identifier && self.primitive_symbol(symbol, "JSON", None)
        {
            return self.standard_object_presence(node);
        }
        let key = self.condition_value(primitives::primitive_source(node.left()))?;
        if self.native_type_contains(&key.ty(), |ty| {
            !matches!(
                ty,
                Type::String
                    | Type::F64
                    | Type::Bigint
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
            return Err(self.refuse(
                node.left(),
                "in operator object ToPropertyKey hooks are not ported",
            ));
        }
        let receiver = self.condition_value(primitives::primitive_source(node.right()))?;
        if !self.presence_receiver(&receiver.ty()) {
            return Err(self.refuse(node.right(), "in operator requires a native data record; exotic prototype presence is not ported"));
        }
        self.ensure_exception_classes(node)?;
        let key = self.presence_value(key, node.left())?;
        let receiver = self.presence_value(receiver, node.right())?;
        let mut helper = Helper::new(
            "data_property_presence",
            vec![Type::Dyn, Type::Dyn],
            Type::Bool,
            self.loc(node),
        );
        let mut body = Vec::new();
        let key_slot = helper.param(0);
        let object_slot = helper.param(1);
        let test = |slot: &Local, name: &str| Expr::DynTest {
            value: Box::new(helper.read(slot)),
            test: name.into(),
            negated: false,
            r#type: Type::Bool,
            loc: helper.loc(),
        };
        // Both operand expressions finish before checking the RHS, and that
        // check precedes ToPropertyKey (which can throw or run user hooks).
        let object = Expr::Logical {
            op: "&&".into(),
            left: Box::new(Expr::Logical {
                op: "||".into(),
                left: Box::new(test(&object_slot, "object")),
                right: Box::new(test(&object_slot, "function")),
                r#type: Type::Bool,
                loc: helper.loc(),
            }),
            right: Box::new(Expr::Unary {
                op: "!".into(),
                operand: Box::new(test(&object_slot, "null")),
                r#type: Type::Bool,
                loc: helper.loc(),
            }),
            r#type: Type::Bool,
            loc: helper.loc(),
        };
        body.push(Stmt::If {
            cond: Expr::Unary {
                op: "!".into(),
                operand: Box::new(object),
                r#type: Type::Bool,
                loc: helper.loc(),
            },
            then: vec![Stmt::Throw {
                value: Expr::LibCall {
                    r#fn: "error.new".into(),
                    args: vec![Expr::StrLit {
                        value: "Right-hand side of 'in' should be an object".into(),
                        r#type: Type::String,
                        loc: helper.loc(),
                    }],
                    r#type: Type::Object {
                        class_name: "%TypeError".into(),
                    },
                    loc: helper.loc(),
                },
                loc: helper.loc(),
            }],
            else_: None,
            loc: helper.loc(),
        });
        let membership = |key| Expr::LibCall {
            r#fn: "dyn.hasKey".into(),
            args: vec![helper.read(&object_slot), key],
            r#type: Type::Bool,
            loc: helper.loc(),
        };
        // Represented ordinary records cannot acquire symbol slots. Still
        // validate their owning layout before answering false: an erased
        // array, class, function or other exotic must retain its explicit fence.
        body.push(Stmt::If {
            cond: test(&key_slot, "symbol"),
            then: vec![
                Stmt::Expression {
                    expr: membership(Expr::StrLit {
                        value: "".into(),
                        r#type: Type::String,
                        loc: helper.loc(),
                    }),
                    loc: helper.loc(),
                },
                Stmt::Return {
                    value: Some(Expr::BoolLit {
                        value: false,
                        r#type: Type::Bool,
                        loc: helper.loc(),
                    }),
                    loc: helper.loc(),
                },
            ],
            else_: None,
            loc: helper.loc(),
        });
        body.push(Stmt::Return {
            value: Some(membership(Expr::ToString {
                operand: Box::new(helper.read(&key_slot)),
                r#type: Type::String,
                loc: helper.loc(),
            })),
            loc: helper.loc(),
        });
        helper.function.body.extend(body);
        Ok(Expr::Call {
            callee: self.install_helper(helper.function),
            args: vec![key, receiver],
            r#type: Type::Bool,
            loc: self.loc(node),
        })
    }

    fn presence_receiver(&self, ty: &Type) -> bool {
        match ty {
            Type::Dyn
            | Type::Caught
            | Type::String
            | Type::F64
            | Type::Bigint
            | Type::Bool
            | Type::Symbol
            | Type::Null
            | Type::Undefined
            | Type::Void => true,
            Type::Record { shape_id } => {
                !self.records[*shape_id].tuple
                    && !self.enum_shape(*shape_id)
                    && !self.callables.contains_key(shape_id)
            }
            Type::Union { union_id } => self.unions[*union_id]
                .arms
                .iter()
                .all(|arm| self.presence_receiver(arm)),
            _ => false,
        }
    }

    fn presence_value(&mut self, value: Expr, node: Node) -> Result<Expr, String> {
        if value.ty() == Type::Caught {
            return Ok(Expr::CaughtToDyn {
                value: Box::new(value),
                r#type: Type::Dyn,
                loc: self.loc(node),
            });
        }
        let value = self.primitive_capture(value, node)?;
        self.coerce(value, Type::Dyn, node)
    }
}
