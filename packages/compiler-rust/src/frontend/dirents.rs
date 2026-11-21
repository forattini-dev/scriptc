use super::*;

impl Lowerer<'_> {
    pub(super) fn standard_dirent_type(&self, id: TypeId) -> bool {
        let symbol = self.checker.ty(id).symbol();
        symbol.0 != 0
            && self.checker.sym(symbol).name.as_ref() == "Dirent"
            && self
                .checker
                .sym(symbol)
                .declarations
                .iter()
                .any(|declaration| {
                    let file = source_file_info(get_source_file_of_node(*declaration));
                    file.file_name.ends_with("/fs.d.ts")
                        && (file.file_name.contains("/@types/node/")
                            || file.file_name.contains("/bun-types/"))
                })
    }

    pub(super) fn dirent_get(&mut self, node: Node) -> Result<Option<Expr>, String> {
        if node.kind() != SyntaxKind::PropertyAccessExpression
            || self.ty(node.expression()).ok() != Some(Type::Dirent)
        {
            return Ok(None);
        }
        if node.name().text() != "name" {
            return Ok(None);
        }
        let receiver = self.expected_expression(node.expression(), Type::Dirent)?;
        Ok(Some(Expr::LibCall {
            r#fn: "dirent.name".into(),
            args: vec![receiver],
            r#type: Type::String,
            loc: self.loc(node),
        }))
    }

    pub(super) fn dirent_call(&mut self, node: Node) -> Result<Option<Expr>, String> {
        let member = receivers::reference_node(node.expression());
        if member.kind() != SyntaxKind::PropertyAccessExpression
            || self.ty(member.expression()).ok() != Some(Type::Dirent)
        {
            return Ok(None);
        }
        let operation = match member.name().text() {
            "isFile" => "dirent.isFile",
            "isDirectory" => "dirent.isDirectory",
            "isSymbolicLink" => "dirent.isSymbolicLink",
            _ => return Ok(None),
        };
        if !node.arguments().is_empty() {
            return Err(self.refuse(node, "Dirent predicates do not accept arguments"));
        }
        let receiver = self.expected_expression(member.expression(), Type::Dirent)?;
        Ok(Some(Expr::LibCall {
            r#fn: operation.into(),
            args: vec![receiver],
            r#type: Type::Bool,
            loc: self.loc(node),
        }))
    }
}
