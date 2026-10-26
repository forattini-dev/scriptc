//! Number's callable ABI accepts primitives and preserves BigInt conversion.
//! This is distinct from numeric operator ToNumber, which rejects BigInt.
use super::*;
use helpers::Helper;

pub(super) fn callable() -> Type {
    Type::Func {
        rest: true,
        params: vec![Type::Array {
            elem: Box::new(Type::Dyn),
        }],
        ret: Box::new(Type::F64),
    }
}

impl Lowerer<'_> {
    pub(super) fn standard_number(&mut self, node: Node) -> bool {
        node.kind() == SyntaxKind::Identifier && {
            let symbol = self.symbol(node);
            self.primitive_symbol(symbol, "Number", None)
        }
    }

    pub(super) fn number_constructor_value(&mut self, node: Node) -> Result<Expr, String> {
        self.ensure_exception_classes(node)?;
        let Type::Func { params, .. } = callable() else {
            unreachable!()
        };
        let mut helper = Helper::new("standard_number", params, Type::F64, self.loc(node));
        helper.function.rest = true;
        let arguments = helper.param(0);
        // The rest ABI captures every ordinary argument before conversion.
        // Guard the first slot: Number() is +0, Number(undefined) is NaN.
        helper.function.body.push(Stmt::If {
            cond: Expr::Bin {
                op: "===".into(),
                left: Box::new(helper.length(&arguments)),
                right: Box::new(helper.number(0.0)),
                r#type: Type::Bool,
                loc: helper.loc(),
            },
            then: vec![Stmt::Return {
                value: Some(helper.number(0.0)),
                loc: helper.loc(),
            }],
            else_: None,
            loc: helper.loc(),
        });
        let value = helper.local("original value", Type::Dyn, false);
        helper.declare(
            &value,
            Expr::ArrayGet {
                arr: Box::new(helper.read(&arguments)),
                index: Box::new(helper.number(0.0)),
                r#type: Type::Dyn,
                loc: helper.loc(),
            },
        );
        let result = self.number_primitive(helper.read(&value), node)?;
        helper.function.body.push(Stmt::Return {
            value: Some(result),
            loc: helper.loc(),
        });
        Ok(Expr::Closure {
            fn_name: self.install_helper(helper.function),
            captures: vec![],
            r#type: callable(),
            loc: self.loc(node),
        })
    }

    pub(super) fn number_primitive(&mut self, argument: Expr, node: Node) -> Result<Expr, String> {
        self.ensure_exception_classes(node)?;
        let argument = self.coerce(argument, Type::Dyn, node)?;
        let mut helper = Helper::new(
            "number_primitive",
            vec![Type::Dyn],
            Type::F64,
            self.loc(node),
        );
        let value = helper.param(0);
        let test = |name: &str| Expr::DynTest {
            value: Box::new(helper.read(&value)),
            test: name.into(),
            negated: false,
            r#type: Type::Bool,
            loc: helper.loc(),
        };
        let mut body = Vec::new();
        for (name, ty) in [
            ("number", Type::F64),
            ("string", Type::String),
            ("boolean", Type::Bool),
            ("bigint", Type::Bigint),
        ] {
            let payload = self.coerce(helper.read(&value), ty.clone(), node)?;
            let result = match ty {
                Type::F64 => payload,
                Type::String => Expr::LibCall {
                    r#fn: "num.fromString".into(),
                    args: vec![payload],
                    r#type: Type::F64,
                    loc: helper.loc(),
                },
                Type::Bool => Expr::Ternary {
                    cond: Box::new(payload),
                    then: Box::new(helper.number(1.0)),
                    else_: Box::new(helper.number(0.0)),
                    r#type: Type::F64,
                    loc: helper.loc(),
                },
                Type::Bigint => self.bigint_operation("bigint.toNumber", vec![payload], node),
                _ => unreachable!(),
            };
            body.push(Stmt::If {
                cond: test(name),
                then: vec![Stmt::Return {
                    value: Some(result),
                    loc: helper.loc(),
                }],
                else_: None,
                loc: helper.loc(),
            });
        }
        for (name, number) in [("null", 0.0), ("undefined", f64::NAN)] {
            body.push(Stmt::If {
                cond: test(name),
                then: vec![Stmt::Return {
                    value: Some(helper.number(number)),
                    loc: helper.loc(),
                }],
                else_: None,
                loc: helper.loc(),
            });
        }
        let failure = |message: &str| Stmt::Throw {
            value: Expr::LibCall {
                r#fn: "error.new".into(),
                args: vec![Expr::StrLit {
                    value: message.into(),
                    r#type: Type::String,
                    loc: helper.loc(),
                }],
                r#type: Type::Object {
                    class_name: "%TypeError".into(),
                },
                loc: helper.loc(),
            },
            loc: helper.loc(),
        };
        body.push(Stmt::If {
            cond: test("symbol"),
            then: vec![failure("Cannot convert a Symbol value to a number")],
            else_: None,
            loc: helper.loc(),
        });
        body.push(failure(
            "scriptc: Number object coercion hooks are not ported",
        ));
        helper.function.body.extend(body);
        Ok(Expr::Call {
            callee: self.install_helper(helper.function),
            args: vec![argument],
            r#type: Type::F64,
            loc: self.loc(node),
        })
    }
}
