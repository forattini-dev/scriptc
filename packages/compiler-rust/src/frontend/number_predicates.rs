//! Number predicates inspect the original value, without numeric coercion.
use super::*;

pub(super) fn predicate(name: &str) -> bool {
    matches!(name, "isFinite" | "isNaN" | "isInteger" | "isSafeInteger")
}

fn callable() -> Type {
    Type::Func {
        rest: true,
        params: vec![Type::Array {
            elem: Box::new(Type::Dyn),
        }],
        ret: Box::new(Type::Bool),
    }
}

impl Lowerer<'_> {
    pub(super) fn number_predicate_type(&self, id: TypeId) -> Option<Type> {
        let symbol = self.checker.ty(id).symbol();
        if symbol.0 == 0 {
            return None;
        }
        let name = self.checker.sym(symbol).name.as_ref();
        (predicate(name)
            && (self.primitive_symbol(symbol.0, name, Some("NumberConstructor"))
                || matches!(name, "isFinite" | "isNaN")
                    && self.primitive_symbol(symbol.0, name, None)))
        .then(callable)
    }

    fn global_number_predicate(&mut self, node: Node) -> bool {
        let node = receivers::reference_node(node);
        let symbol = self.symbol(node);
        node.kind() == SyntaxKind::Identifier
            && matches!(node.text(), "isFinite" | "isNaN")
            && self.primitive_symbol(symbol, node.text(), None)
    }

    fn number_predicate_member(&mut self, node: Node) -> bool {
        if node.kind() != SyntaxKind::PropertyAccessExpression
            || node.expression().kind() != SyntaxKind::Identifier
            || !predicate(node.name().text())
        {
            return false;
        }
        let base = self.symbol(node.expression());
        let member = self.symbol(node.name());
        self.primitive_symbol(base, "Number", None)
            && self.primitive_symbol(member, node.name().text(), Some("NumberConstructor"))
    }

    pub(super) fn number_predicate_call(&mut self, node: Node) -> Result<Option<Expr>, String> {
        if self.global_number_predicate(node.expression()) {
            if let Some(argument) = node.arguments().into_iter().next()
                && argument.kind() != SyntaxKind::SpreadElement
                && let Ok(ty) = self.ty(primitives::primitive_source(argument))
                && self.native_type_contains(&ty, |arm| {
                    matches!(
                        arm,
                        Type::Record { .. }
                            | Type::Array { .. }
                            | Type::Object { .. }
                            | Type::Map { .. }
                            | Type::Set { .. }
                            | Type::Func { .. }
                            | Type::Classval { .. }
                            | Type::Bytes { .. }
                    )
                })
            {
                return Err(self.refuse(
                    argument,
                    "global numeric predicate object coercion hooks are not ported",
                ));
            }
            self.call_value(node).map(Some)
        } else if self.number_predicate_member(node.expression()) {
            self.call_value(node).map(Some)
        } else {
            Ok(None)
        }
    }

    pub(super) fn number_predicate_value(&mut self, node: Node) -> Result<Option<Expr>, String> {
        let global = self.global_number_predicate(node);
        if !global && !self.number_predicate_member(node) {
            return Ok(None);
        }
        let name = if global {
            node.text()
        } else {
            node.name().text()
        };
        let Type::Func { params, .. } = callable() else {
            unreachable!()
        };
        let mut helper = helpers::Helper::new(
            &format!("number_{name}"),
            params,
            Type::Bool,
            self.loc(node),
        );
        helper.function.rest = true;
        if global {
            let arguments = helper.param(0);
            let input = Expr::Ternary {
                cond: Box::new(Expr::Bin {
                    op: "<".into(),
                    left: Box::new(helper.number(0.0)),
                    right: Box::new(helper.length(&arguments)),
                    r#type: Type::Bool,
                    loc: helper.loc(),
                }),
                then: Box::new(Expr::ArrayGet {
                    arr: Box::new(helper.read(&arguments)),
                    index: Box::new(helper.number(0.0)),
                    r#type: Type::Dyn,
                    loc: helper.loc(),
                }),
                else_: Box::new(Expr::DynFrom {
                    value: Box::new(Expr::UnitLit {
                        unit: "undefined",
                        r#type: Type::Undefined,
                        loc: helper.loc(),
                    }),
                    r#type: Type::Dyn,
                    loc: helper.loc(),
                }),
                r#type: Type::Dyn,
                loc: helper.loc(),
            };
            let number = self.strict_number_primitive(input, node)?;
            helper.function.body.push(Stmt::Return {
                value: Some(Expr::LibCall {
                    r#fn: format!("number.{name}"),
                    args: vec![number],
                    r#type: Type::Bool,
                    loc: helper.loc(),
                }),
                loc: helper.loc(),
            });
            return Ok(Some(Expr::Closure {
                fn_name: self.install_helper(helper.function),
                captures: vec![],
                r#type: callable(),
                loc: self.loc(node),
            }));
        }
        helper.function.body.push(Stmt::If {
            cond: Expr::Bin {
                op: "===".into(),
                left: Box::new(helper.length(&helper.param(0))),
                right: Box::new(helper.number(0.0)),
                r#type: Type::Bool,
                loc: helper.loc(),
            },
            then: vec![Stmt::Return {
                value: Some(Expr::BoolLit {
                    value: false,
                    r#type: Type::Bool,
                    loc: helper.loc(),
                }),
                loc: helper.loc(),
            }],
            else_: None,
            loc: helper.loc(),
        });
        let value = helper.local("original value", Type::Dyn, false);
        helper.declare(
            &value,
            Expr::ArrayGet {
                arr: Box::new(helper.read(&helper.param(0))),
                index: Box::new(helper.number(0.0)),
                r#type: Type::Dyn,
                loc: helper.loc(),
            },
        );
        helper.function.body.push(Stmt::If {
            cond: Expr::DynTest {
                value: Box::new(helper.read(&value)),
                test: "number".into(),
                negated: false,
                r#type: Type::Bool,
                loc: helper.loc(),
            },
            then: vec![Stmt::Return {
                value: Some(Expr::LibCall {
                    r#fn: format!("number.{name}"),
                    args: vec![self.coerce(helper.read(&value), Type::F64, node)?],
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
        Ok(Some(Expr::Closure {
            fn_name: self.install_helper(helper.function),
            captures: vec![],
            r#type: callable(),
            loc: self.loc(node),
        }))
    }
}
