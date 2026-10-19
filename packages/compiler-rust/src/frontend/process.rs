//! Live process property reads are recognized by declaration/import identity.
use super::*;

impl Lowerer<'_> {
    fn process_member(&mut self, node: Node, name: &str) -> bool {
        let member = match node.kind() {
            SyntaxKind::PropertyAccessExpression => Some(node.name()),
            SyntaxKind::ElementAccessExpression
                if node.argument_expression().kind() == SyntaxKind::StringLiteral =>
            {
                Some(node.argument_expression())
            }
            _ => None,
        };
        if member.is_some_and(|member| member.text() == name)
            && self.native_namespace(node.expression()) == Some("process")
        {
            return true;
        }
        if node.kind() == SyntaxKind::Identifier {
            let symbol = self.symbol(node);
            return self
                .native_functions
                .get(&symbol)
                .is_some_and(|(module, member)| *module == "process" && member == name);
        }
        false
    }

    pub(super) fn process_read(&mut self, node: Node) -> Result<Option<Expr>, String> {
        for name in ["arch", "platform"] {
            if self.process_member(node, name) {
                let property =
                    builtins::property("process", name).expect("registered process property");
                return Ok(Some(Expr::LibCall {
                    r#fn: property.ir.into(),
                    args: vec![],
                    r#type: property.result,
                    loc: self.loc(node),
                }));
            }
        }
        if !matches!(
            node.kind(),
            SyntaxKind::PropertyAccessExpression | SyntaxKind::ElementAccessExpression
        ) {
            return Ok(None);
        }
        let recv = node.expression();
        if self.process_member(recv, "env") {
            let key = if node.kind() == SyntaxKind::PropertyAccessExpression {
                Expr::StrLit {
                    value: node.name().text().into(),
                    r#type: Type::String,
                    loc: self.loc(node),
                }
            } else {
                self.expected_expression(node.argument_expression(), Type::String)?
            };
            let ty = self
                .intern_union(vec![Type::String, Type::Undefined])
                .unwrap();
            return Ok(Some(Expr::LibCall {
                r#fn: "process.envGet".into(),
                args: vec![key],
                r#type: ty,
                loc: self.loc(node),
            }));
        }
        if node.kind() != SyntaxKind::PropertyAccessExpression || node.name().text() != "isTTY" {
            return Ok(None);
        }
        for (stream, fd) in [("stdin", 0.0), ("stdout", 1.0), ("stderr", 2.0)] {
            if !self.process_member(recv, stream) {
                continue;
            }
            let ty = self
                .intern_union(vec![Type::Bool, Type::Undefined])
                .unwrap();
            let Type::Union { union_id } = ty else {
                unreachable!()
            };
            let boolean = self.unions[union_id]
                .arms
                .iter()
                .position(|t| *t == Type::Bool)
                .unwrap();
            let undefined = self.unions[union_id]
                .arms
                .iter()
                .position(|t| *t == Type::Undefined)
                .unwrap();
            let wrap = |tag, value| Expr::UnionWrap {
                union_id: format!("u{union_id}"),
                tag,
                value: Box::new(value),
                r#type: ty.clone(),
                loc: self.loc(node),
            };
            let cond = Expr::LibCall {
                r#fn: "process.isTTY".into(),
                args: vec![Expr::NumLit {
                    value: fd,
                    spelling: None,
                    r#type: Type::F64,
                    loc: self.loc(node),
                }],
                r#type: Type::Bool,
                loc: self.loc(node),
            };
            return Ok(Some(Expr::Ternary {
                cond: Box::new(cond),
                then: Box::new(wrap(
                    boolean,
                    Expr::BoolLit {
                        value: true,
                        r#type: Type::Bool,
                        loc: self.loc(node),
                    },
                )),
                else_: Box::new(wrap(
                    undefined,
                    Expr::UnitLit {
                        unit: "undefined",
                        r#type: Type::Undefined,
                        loc: self.loc(node),
                    },
                )),
                r#type: ty,
                loc: self.loc(node),
            }));
        }
        Ok(None)
    }
}
