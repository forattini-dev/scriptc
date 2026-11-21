//! `fs.globSync` lowers its options object to an explicit native ABI.
use super::*;

impl Lowerer<'_> {
    pub(super) fn glob_call(&mut self, node: Node) -> Result<Expr, String> {
        let arguments = node.arguments().into_iter().collect::<Vec<_>>();
        if arguments.len() != 2
            || arguments
                .iter()
                .any(|argument| argument.kind() == SyntaxKind::SpreadElement)
        {
            return Err(self.refuse(
                node,
                "globSync requires a pattern and plain inline options without spreads",
            ));
        }
        let options = receivers::reference_node(arguments[1]);
        if options.kind() != SyntaxKind::ObjectLiteralExpression {
            return Err(self.refuse(options, "globSync options require a plain inline object"));
        }
        for property in options.properties() {
            if property.kind() != SyntaxKind::PropertyAssignment
                || !matches!(
                    self.data_property_name(property.name()).as_deref(),
                    Some("cwd" | "exclude")
                )
            {
                return Err(self.refuse(
                    property,
                    "globSync options support only plain cwd and exclude properties",
                ));
            }
        }

        self.ensure_exception_classes(node)?;
        let mut stmts = Vec::new();
        let pattern = self.filesystem_argument(
            arguments[0],
            Type::String,
            "globSync requires a represented string pattern",
            &mut stmts,
        )?;
        let mut cwd = None;
        let mut exclude = None;
        for property in options.properties() {
            let value = receivers::reference_node(property.initializer());
            match self.data_property_name(property.name()).as_deref() {
                Some("cwd") => {
                    cwd = Some(self.filesystem_argument(
                        value,
                        Type::String,
                        "globSync cwd requires a represented string",
                        &mut stmts,
                    )?);
                }
                Some("exclude") => {
                    let strings = builtins::strings();
                    let value = self
                        .expected_expression(value, strings.clone())
                        .and_then(|value| self.coerce(value, strings.clone(), property))
                        .map_err(|_| {
                            self.refuse(
                                property,
                                "globSync exclude requires a represented string array",
                            )
                        })?;
                    let local = self.construction_local(strings, false);
                    stmts.push(Stmt::VarDecl {
                        local_id: local.id.clone(),
                        init: value,
                        loc: self.loc(property),
                    });
                    exclude = Some(self.construction_read(&local, property));
                }
                _ => unreachable!("glob option was validated above"),
            }
        }
        let cwd = cwd.ok_or_else(|| {
            self.refuse(options, "globSync native options require an explicit cwd")
        })?;
        let exclude = exclude.unwrap_or_else(|| Expr::ArrayLit {
            elems: Vec::new(),
            r#type: builtins::strings(),
            loc: self.loc(options),
        });
        Ok(Expr::Sequence {
            stmts,
            result: Box::new(Expr::LibCall {
                r#fn: "fs.globSync".into(),
                args: vec![pattern, cwd, exclude],
                r#type: builtins::strings(),
                loc: self.loc(node),
            }),
            r#type: builtins::strings(),
            loc: self.loc(node),
        })
    }
}
