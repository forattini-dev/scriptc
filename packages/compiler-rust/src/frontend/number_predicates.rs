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
        (predicate(name) && self.primitive_symbol(symbol.0, name, Some("NumberConstructor")))
            .then(callable)
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
        if self.number_predicate_member(node.expression()) {
            self.call_value(node).map(Some)
        } else {
            Ok(None)
        }
    }

    pub(super) fn number_predicate_value(&mut self, node: Node) -> Result<Option<Expr>, String> {
        if !self.number_predicate_member(node) {
            return Ok(None);
        }
        let name = node.name().text();
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
