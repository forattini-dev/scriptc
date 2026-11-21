//! SameValueZero search over owning arrays, including missing element values.
use super::*;
use helpers::Helper;

fn bin(op: &str, left: Expr, right: Expr, ty: Type, loc: &Loc) -> Expr {
    if matches!(op, "&&" | "||") {
        Expr::Logical {
            op: op.into(),
            left: Box::new(left),
            right: Box::new(right),
            r#type: ty,
            loc: loc.clone(),
        }
    } else {
        Expr::Bin {
            op: op.into(),
            left: Box::new(left),
            right: Box::new(right),
            r#type: ty,
            loc: loc.clone(),
        }
    }
}
fn nan(value: Expr, loc: &Loc) -> Expr {
    let number = Expr::DynCheck {
        value: Box::new(value.clone()),
        r#type: Type::F64,
        loc: loc.clone(),
    };
    bin(
        "&&",
        Expr::DynTest {
            value: Box::new(value),
            test: "number".into(),
            negated: false,
            r#type: Type::Bool,
            loc: loc.clone(),
        },
        bin("!==", number.clone(), number, Type::Bool, loc),
        Type::Bool,
        loc,
    )
}

impl Lowerer<'_> {
    pub(super) fn array_includes(&mut self, node: Node) -> Result<Expr, String> {
        let member = node.expression();
        let source = primitives::primitive_source(member.expression());
        if source != member.expression()
            && matches!(self.ty(source), Ok(Type::Record { shape_id }) if self.records[shape_id].tuple)
        {
            let receiver = self.expression(source)?;
            let receiver = self.live_member_receiver(source, receiver);
            if matches!(receiver.ty(), Type::Record { shape_id } if self.records[shape_id].tuple) {
                return self.tuple_includes_value(node, receiver);
            }
            return Err(self.refuse(source, "tuple.includes requires a non-null native tuple"));
        }
        let require_standard_symbol = !matches!(self.ty(member.expression()), Ok(Type::Dyn));
        let receiver = self.checked_array_receiver(member.expression())?;
        // An unannotated JavaScript parameter can own a closed native Array
        // ABI from whole-program planning while the checker still exposes its
        // member as `any`. In that case the represented receiver, not a missing
        // lib.d.ts symbol, proves dispatch to the native Array operation.
        self.array_includes_value(node, receiver, require_standard_symbol)
    }

    pub(super) fn array_includes_value(
        &mut self,
        node: Node,
        receiver: Expr,
        require_standard_symbol: bool,
    ) -> Result<Expr, String> {
        let member = node.expression();
        let symbol = self.symbol(member.name());
        if require_standard_symbol
            && !self.native_array_method_provenance(member.expression(), symbol, "includes")
        {
            return Err(self.refuse(member, "array.includes requires its standard declaration"));
        }
        if !matches!(receiver.ty(), Type::Array { .. }) {
            return Err(self.refuse(node, "array.includes requires a non-null native array"));
        }
        let mut values = vec![receiver];
        for argument in node.arguments() {
            if argument.kind() == SyntaxKind::SpreadElement {
                return Err(self.refuse(argument, "array.includes argument spreads are not ported"));
            }
            let value = self.expression(argument)?;
            values.push(self.primitive_capture(value, argument)?);
        }
        self.ensure_exception_classes(node)?;
        let mut helper = Helper::new(
            "array_includes",
            values.iter().map(Expr::ty).collect(),
            Type::Bool,
            self.loc(node),
        );
        let loc = helper.loc();
        let length = helper.local("initial length", Type::F64, false);
        helper.declare(&length, helper.length(&helper.param(0)));
        let result = |value| Stmt::Return {
            value: Some(Expr::BoolLit {
                value,
                r#type: Type::Bool,
                loc: loc.clone(),
            }),
            loc: loc.clone(),
        };
        helper.function.body.push(Stmt::If {
            cond: bin(
                "===",
                helper.read(&length),
                helper.number(0.0),
                Type::Bool,
                &loc,
            ),
            then: vec![result(false)],
            else_: None,
            loc: loc.clone(),
        });
        let from = if values.len() > 2 {
            self.strict_number_primitive(helper.read(&helper.param(2)), node)?
        } else {
            helper.number(0.0)
        };
        let index = helper.local("index", Type::F64, true);
        helper.declare(
            &index,
            Expr::LibCall {
                r#fn: "math.trunc".into(),
                args: vec![from],
                r#type: Type::F64,
                loc: loc.clone(),
            },
        );
        helper.function.body.push(Stmt::If {
            cond: bin(
                "!==",
                helper.read(&index),
                helper.read(&index),
                Type::Bool,
                &loc,
            ),
            then: vec![Stmt::Assign {
                local_id: index.id.clone(),
                value: helper.number(0.0),
                initializes_global: false,
                loc: loc.clone(),
            }],
            else_: None,
            loc: loc.clone(),
        });
        helper.function.body.push(Stmt::If {
            cond: bin(
                "<",
                helper.read(&index),
                helper.number(0.0),
                Type::Bool,
                &loc,
            ),
            then: vec![Stmt::Assign {
                local_id: index.id.clone(),
                value: Expr::Ternary {
                    cond: Box::new(bin(
                        "<",
                        bin(
                            "+",
                            helper.read(&length),
                            helper.read(&index),
                            Type::F64,
                            &loc,
                        ),
                        helper.number(0.0),
                        Type::Bool,
                        &loc,
                    )),
                    then: Box::new(helper.number(0.0)),
                    else_: Box::new(bin(
                        "+",
                        helper.read(&length),
                        helper.read(&index),
                        Type::F64,
                        &loc,
                    )),
                    r#type: Type::F64,
                    loc: loc.clone(),
                },
                initializes_global: false,
                loc: loc.clone(),
            }],
            else_: None,
            loc: loc.clone(),
        });
        let needle = helper.local("needle", Type::Dyn, false);
        let search = if values.len() > 1 {
            self.coerce(helper.read(&helper.param(1)), Type::Dyn, node)?
        } else {
            self.coerce(
                Expr::UnitLit {
                    unit: "undefined",
                    r#type: Type::Undefined,
                    loc: loc.clone(),
                },
                Type::Dyn,
                node,
            )?
        };
        helper.declare(&needle, search);
        let item = helper.local("item", Type::Dyn, false);
        let object = self.coerce(helper.read(&helper.param(0)), Type::Dyn, node)?;
        let key = Expr::ToString {
            operand: Box::new(helper.read(&index)),
            r#type: Type::String,
            loc: loc.clone(),
        };
        let read = self.dynamic_get(node, object, key);
        let equal = bin(
            "||",
            Expr::DynScalarEq {
                left: Box::new(helper.read(&item)),
                right: Box::new(helper.read(&needle)),
                negated: false,
                r#type: Type::Bool,
                loc: loc.clone(),
            },
            bin(
                "&&",
                nan(helper.read(&item), &loc),
                nan(helper.read(&needle), &loc),
                Type::Bool,
                &loc,
            ),
            Type::Bool,
            &loc,
        );
        helper.function.body.push(Stmt::While {
            cond: helper.less(&index, helper.read(&length)),
            body: vec![
                Stmt::VarDecl {
                    local_id: item.id,
                    init: read,
                    loc: loc.clone(),
                },
                Stmt::If {
                    cond: equal,
                    then: vec![result(true)],
                    else_: None,
                    loc: loc.clone(),
                },
                helper.advance(&index),
            ],
            loc: loc.clone(),
        });
        helper.function.body.push(result(false));
        Ok(Expr::Call {
            callee: self.install_helper(helper.function),
            args: values,
            r#type: Type::Bool,
            loc,
        })
    }
}
