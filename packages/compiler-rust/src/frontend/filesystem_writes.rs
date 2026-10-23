//! File publication effects normalize options before calling the shared FS ABI.
use super::*;

impl Lowerer<'_> {
    pub(super) fn append_file_call(&mut self, node: Node) -> Result<Expr, String> {
        let arguments = node.arguments().into_iter().collect::<Vec<_>>();
        if arguments.len() < 2
            || arguments
                .iter()
                .any(|arg| arg.kind() == SyntaxKind::SpreadElement)
        {
            return Err(self.refuse(
                node,
                "appendFileSync needs path/data arguments without spreads",
            ));
        }
        self.ensure_exception_classes(node)?;
        let mut stmts = Vec::new();
        let path = self.filesystem_argument(
            arguments[0],
            Type::String,
            "appendFileSync needs represented string path/data and numeric mode",
            &mut stmts,
        )?;
        let data = self.filesystem_argument(
            arguments[1],
            Type::String,
            "appendFileSync needs represented string path/data and numeric mode",
            &mut stmts,
        )?;
        let mut mode = None;
        if let Some(options) = arguments.get(2).copied() {
            let options = receivers::reference_node(options);
            if options.kind() == SyntaxKind::ObjectLiteralExpression {
                for property in options.properties() {
                    if !matches!(
                        property.kind(),
                        SyntaxKind::PropertyAssignment | SyntaxKind::ShorthandPropertyAssignment
                    ) {
                        return Err(self.refuse(
                            property,
                            "appendFileSync options require plain data properties",
                        ));
                    }
                    let value = if property.kind() == SyntaxKind::ShorthandPropertyAssignment {
                        property.name()
                    } else {
                        property.initializer()
                    };
                    let literal = receivers::reference_node(value);
                    match self.data_property_name(property.name()).as_deref() {
                        Some("mode") => mode = Some(self.filesystem_argument(value, Type::F64, "appendFileSync needs represented string path/data and numeric mode", &mut stmts)?),
                        Some("encoding") if Self::filesystem_utf8_literal(literal) => {},
                        Some("flag") if literal.kind() == SyntaxKind::StringLiteral && literal.text() == "a" => {},
                        Some("flush") if literal.kind() == SyntaxKind::FalseKeyword => {},
                        _ => return Err(self.refuse(property, "appendFileSync options require literal utf8/utf-8 encoding, numeric mode, literal a flag or false flush")),
                    }
                }
            } else if !Self::filesystem_utf8_literal(options) {
                let value = self.expression(options)?;
                if !matches!(value.ty(), Type::Null | Type::Undefined) {
                    return Err(self.refuse(
                        options,
                        "appendFileSync requires inline options or literal utf8/utf-8 encoding",
                    ));
                }
                stmts.push(Stmt::Expression {
                    expr: self.coerce(value, Type::Dyn, options)?,
                    loc: self.loc(options),
                });
            }
        }
        // Even ignored arguments and overwritten option values execute before I/O.
        for extra in arguments.into_iter().skip(3) {
            let value = self.expression(extra)?;
            stmts.push(Stmt::Expression {
                expr: value,
                loc: self.loc(extra),
            });
        }
        let name = if mode.is_some() {
            "fs.appendFileModeSync"
        } else {
            "fs.appendFileSync"
        };
        let mut args = vec![path, data];
        if let Some(mode) = mode {
            args.push(mode);
            args.push(Expr::BoolLit {
                value: false,
                r#type: Type::Bool,
                loc: self.loc(node),
            });
        }
        Ok(Expr::Sequence {
            stmts,
            result: Box::new(Expr::LibCall {
                r#fn: name.into(),
                args,
                r#type: Type::Void,
                loc: self.loc(node),
            }),
            r#type: Type::Void,
            loc: self.loc(node),
        })
    }

    pub(super) fn filesystem_utf8_literal(node: Node) -> bool {
        node.kind() == SyntaxKind::StringLiteral && matches!(node.text(), "utf8" | "utf-8")
    }

    pub(super) fn filesystem_argument(
        &mut self,
        node: Node,
        ty: Type,
        requirement: &str,
        stmts: &mut Vec<Stmt>,
    ) -> Result<Expr, String> {
        let value = self.expression(receivers::reference_node(node))?;
        if value.ty() != ty {
            return Err(self.refuse(node, requirement));
        }
        let local = self.construction_local(ty, false);
        stmts.push(Stmt::VarDecl {
            local_id: local.id.clone(),
            init: value,
            loc: self.loc(node),
        });
        Ok(self.construction_read(&local, node))
    }
}
