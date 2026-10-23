//! Descriptor source overloads normalize to the shared portable filesystem ABI.
use super::*;

impl Lowerer<'_> {
    pub(super) fn descriptor_call(&mut self, node: Node, member: &str) -> Result<Expr, String> {
        self.ensure_exception_classes(node)?;
        let source = node.arguments().into_iter().collect::<Vec<_>>();
        if source
            .iter()
            .any(|arg| arg.kind() == SyntaxKind::SpreadElement)
        {
            return Err(self.refuse(node, "descriptor argument spreads are not ported"));
        }
        let mut args = Vec::new();
        match member {
            "openSync" if (1..=2).contains(&source.len()) => {
                let path = self.expression(source[0])?;
                if path.ty() != Type::String {
                    return Err(self.refuse(node, "openSync requires a represented string path"));
                }
                args.push(path);
                let flags = if let Some(arg) = source.get(1) {
                    let literal = receivers::reference_node(*arg);
                    if literal.kind() != SyntaxKind::StringLiteral
                        || !matches!(
                            literal.text(),
                            "r" | "r+"
                                | "w"
                                | "w+"
                                | "wx"
                                | "xw"
                                | "wx+"
                                | "xw+"
                                | "a"
                                | "a+"
                                | "ax"
                                | "xa"
                                | "ax+"
                                | "xa+"
                        )
                    {
                        return Err(self.refuse(node, "openSync flags require a basic literal string; synchronous/numeric/dynamic flags are not ported"));
                    }
                    self.expression(*arg)?
                } else {
                    Expr::StrLit {
                        value: "r".into(),
                        r#type: Type::String,
                        loc: self.loc(node),
                    }
                };
                args.push(flags);
            }
            "closeSync" if source.len() == 1 => args.push(self.expression(source[0])?),
            "readSync" if (4..=5).contains(&source.len()) => {
                for arg in &source[..4] {
                    args.push(self.expression(*arg)?);
                }
                let position = source.get(4).map(|arg| self.expression(*arg)).transpose()?;
                args.push(match position {
                    Some(value) if value.ty() == Type::F64 => value,
                    value
                        if value
                            .as_ref()
                            .is_none_or(|v| matches!(v.ty(), Type::Null | Type::Undefined)) =>
                    {
                        let current = Expr::NumLit {
                            value: -1.0,
                            spelling: None,
                            r#type: Type::F64,
                            loc: self.loc(node),
                        };
                        if let Some(value) = value {
                            Expr::Sequence {
                                stmts: vec![Stmt::Expression {
                                    expr: self.coerce(value, Type::Dyn, node)?,
                                    loc: self.loc(node),
                                }],
                                result: Box::new(current),
                                r#type: Type::F64,
                                loc: self.loc(node),
                            }
                        } else {
                            current
                        }
                    }
                    _ => {
                        return Err(self.refuse(
                            node,
                            "readSync position needs a represented number, null or undefined",
                        ));
                    }
                });
            }
            _ => return Err(self.refuse(node, "descriptor overload is not ported")),
        }
        let api = builtins::source("fs", member).expect("descriptor registry");
        let operation = &api.operations[0];
        if args.len() != operation.args.len()
            || args
                .iter()
                .zip(&operation.args)
                .any(|(arg, ty)| arg.ty() != *ty)
        {
            return Err(self.refuse(
                node,
                &format!(
                    "descriptor arguments need represented numeric slots and u8 views; got {:?}",
                    args.iter().map(Expr::ty).collect::<Vec<_>>()
                ),
            ));
        }
        Ok(Expr::LibCall {
            r#fn: operation.ir.into(),
            args,
            r#type: operation.result.clone(),
            loc: self.loc(node),
        })
    }
}
