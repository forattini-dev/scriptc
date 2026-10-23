//! Whole-file source reads select their explicit text result before IR emission.
use super::*;

impl Lowerer<'_> {
    pub(super) fn read_file_call(&mut self, node: Node) -> Result<Expr, String> {
        let arguments = node.arguments().into_iter().collect::<Vec<_>>();
        if arguments.len() < 2
            || arguments
                .iter()
                .any(|arg| arg.kind() == SyntaxKind::SpreadElement)
        {
            return Err(self.refuse(
                node,
                "readFileSync needs path and explicit UTF-8 encoding without spreads",
            ));
        }
        self.ensure_exception_classes(node)?;
        let mut stmts = Vec::new();
        let path = self.filesystem_argument(
            arguments[0],
            Type::String,
            "readFileSync requires a represented string path",
            &mut stmts,
        )?;
        let options = receivers::reference_node(arguments[1]);
        let mut encoding = None;
        if options.kind() == SyntaxKind::ObjectLiteralExpression {
            for property in options.properties() {
                if property.kind() != SyntaxKind::PropertyAssignment {
                    return Err(self.refuse(
                        property,
                        "readFileSync options require plain literal encoding/flag properties",
                    ));
                }
                let value = receivers::reference_node(property.initializer());
                match self.data_property_name(property.name()).as_deref() {
                    Some("encoding") if Self::filesystem_utf8_literal(value) => encoding = Some(value),
                    Some("flag") if value.kind() == SyntaxKind::StringLiteral && value.text() == "r" => {},
                    _ => return Err(self.refuse(property, "readFileSync options require literal utf8/utf-8 encoding and literal r flag")),
                }
            }
        } else if Self::filesystem_utf8_literal(options) {
            encoding = Some(options);
        }
        let encoding = encoding.ok_or_else(|| self.refuse(options, "readFileSync requires literal utf8/utf-8 encoding; Buffer results and dynamic options are not ported"))?;
        let encoding = self.expression(encoding)?;
        for extra in arguments.into_iter().skip(2) {
            stmts.push(Stmt::Expression {
                expr: self.expression(extra)?,
                loc: self.loc(extra),
            });
        }
        Ok(Expr::Sequence {
            stmts,
            result: Box::new(Expr::LibCall {
                r#fn: "fs.readFileSync".into(),
                args: vec![path, encoding],
                r#type: Type::String,
                loc: self.loc(node),
            }),
            r#type: Type::String,
            loc: self.loc(node),
        })
    }
}
