//! Array sequence methods use portable iteration and shared sparse storage.
use super::*;
use helpers::Helper;

impl Lowerer<'_> {
    pub(super) fn array_sequence_method(&mut self, node: Node) -> Result<Expr, String> {
        let member = node.expression();
        let name = member.name().text();
        let symbol = self.symbol(member.name());
        if !self.primitive_symbol(symbol, name, Some("Array"))
            && !self.primitive_symbol(symbol, name, Some("ReadonlyArray"))
        {
            return Err(self.refuse(
                member,
                "array sequence methods require their standard declaration",
            ));
        }
        let receiver = self.expression(member.expression())?;
        let receiver = self.live_member_receiver(member.expression(), receiver);
        if !matches!(receiver.ty(), Type::Array { .. }) {
            return Err(self.refuse(
                node,
                "array sequence methods require a non-null native array",
            ));
        }
        let mut values = vec![receiver];
        for argument in node.arguments() {
            if argument.kind() == SyntaxKind::SpreadElement {
                return Err(self.refuse(argument, "array sequence argument spreads are not ported"));
            }
            let value = self.expression(argument)?;
            values.push(self.primitive_capture(value, argument)?);
        }
        if name == "slice" {
            self.array_slice_values(node, values)
        } else {
            self.array_some_values(node, values)
        }
    }

    fn array_slice_values(&mut self, node: Node, values: Vec<Expr>) -> Result<Expr, String> {
        let result_type = values[0].ty();
        let mut helper = Helper::new(
            "array_slice",
            values.iter().map(Expr::ty).collect(),
            result_type.clone(),
            self.loc(node),
        );
        let mut args = Vec::new();
        for (index, default) in [(1, 0.0), (2, f64::INFINITY)] {
            let value = (index < values.len()).then(|| helper.read(&helper.param(index)));
            args.push(self.primitive_string_argument(
                value,
                crate::string_builtins::Argument::Number(default),
                node,
            )?);
        }
        helper.function.body.push(Stmt::Return {
            value: Some(Expr::ArrayIntrinsic {
                method: "slice".into(),
                receiver: Box::new(helper.read(&helper.param(0))),
                args,
                r#type: result_type.clone(),
                loc: helper.loc(),
            }),
            loc: helper.loc(),
        });
        Ok(Expr::Call {
            callee: self.install_helper(helper.function),
            args: values,
            r#type: result_type,
            loc: self.loc(node),
        })
    }

    fn array_some_values(&mut self, node: Node, values: Vec<Expr>) -> Result<Expr, String> {
        if values.len() < 2 || !matches!(values[1].ty(), Type::Func { .. }) {
            return Err(self.refuse(node, "array.some requires a represented native callback"));
        }
        self.ensure_exception_classes(node)?;
        let mut helper = Helper::new(
            "array_some",
            values.iter().map(Expr::ty).collect(),
            Type::Bool,
            self.loc(node),
        );
        let array = helper.param(0);
        let length = helper.local("initial length", Type::F64, false);
        let index = helper.local("index", Type::F64, true);
        helper.declare(&length, helper.length(&array));
        helper.declare(&index, helper.number(0.0));
        let array_value = self.coerce(helper.read(&array), Type::Dyn, node)?;
        let key = Expr::ToString {
            operand: Box::new(helper.read(&index)),
            r#type: Type::String,
            loc: helper.loc(),
        };
        let element = self.dynamic_get(node, array_value.clone(), key);
        let this = if values.len() > 2 {
            self.coerce(helper.read(&helper.param(2)), Type::Dyn, node)?
        } else {
            self.coerce(
                Expr::UnitLit {
                    unit: "undefined",
                    r#type: Type::Undefined,
                    loc: helper.loc(),
                },
                Type::Dyn,
                node,
            )?
        };
        let call = Expr::DynInvoke {
            recv: Box::new(self.coerce(helper.read(&helper.param(1)), Type::Dyn, node)?),
            method: "call".into(),
            callee_name: "Array.some callback".into(),
            args: vec![
                this,
                element,
                self.coerce(helper.read(&index), Type::Dyn, node)?,
                array_value,
            ],
            r#type: Type::Dyn,
            loc: helper.loc(),
        };
        let boolean = |value| Expr::BoolLit {
            value,
            r#type: Type::Bool,
            loc: helper.loc(),
        };
        let done = Stmt::Return {
            value: Some(boolean(false)),
            loc: helper.loc(),
        };
        let body = vec![
            Stmt::Assign {
                local_id: index.id.clone(),
                value: Expr::ArrayIntrinsic {
                    method: "nextPresent".into(),
                    receiver: Box::new(helper.read(&array)),
                    args: vec![helper.read(&index)],
                    r#type: Type::F64,
                    loc: helper.loc(),
                },
                initializes_global: false,
                loc: helper.loc(),
            },
            Stmt::If {
                cond: Expr::Logical {
                    op: "||".into(),
                    left: Box::new(Expr::Bin {
                        op: ">=".into(),
                        left: Box::new(helper.read(&index)),
                        right: Box::new(helper.read(&length)),
                        r#type: Type::Bool,
                        loc: helper.loc(),
                    }),
                    right: Box::new(Expr::Bin {
                        op: ">=".into(),
                        left: Box::new(helper.read(&index)),
                        right: Box::new(helper.length(&array)),
                        r#type: Type::Bool,
                        loc: helper.loc(),
                    }),
                    r#type: Type::Bool,
                    loc: helper.loc(),
                },
                then: vec![done.clone()],
                else_: None,
                loc: helper.loc(),
            },
            Stmt::If {
                cond: self.condition(call, node)?,
                then: vec![Stmt::Return {
                    value: Some(boolean(true)),
                    loc: helper.loc(),
                }],
                else_: None,
                loc: helper.loc(),
            },
            helper.advance(&index),
        ];
        helper.function.body.push(Stmt::While {
            cond: helper.less(&index, helper.read(&length)),
            body,
            loc: helper.loc(),
        });
        helper.function.body.push(done);
        Ok(Expr::Call {
            callee: self.install_helper(helper.function),
            args: values,
            r#type: Type::Bool,
            loc: self.loc(node),
        })
    }
}
