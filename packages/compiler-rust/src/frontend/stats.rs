//! Node filesystem snapshots retain their nominal owning runtime identity.
use super::*;
use source_frontend::prelude::get_source_file_of_node;

impl Lowerer<'_> {
    pub(super) fn standard_stats_type(&self, id: TypeId) -> bool {
        let symbol = self.checker.ty(id).symbol();
        symbol.0 != 0
            && self.checker.sym(symbol).name.as_ref() == "Stats"
            && self.checker.sym(symbol).declarations.iter().any(|decl| {
                let file = source_file_info(get_source_file_of_node(*decl));
                file.file_name.ends_with("/fs.d.ts")
                    && (file.file_name.contains("/@types/node/")
                        || file.file_name.contains("/bun-types/"))
            })
    }

    pub(super) fn stats_get(&mut self, node: Node) -> Result<Option<Expr>, String> {
        if self.ty(node.expression()).ok() != Some(Type::Stats) {
            return Ok(None);
        }
        if node.name().text() != "size" {
            return Err(self.refuse(node, "Stats properties beyond size are not ported"));
        }
        let receiver = self.expression(node.expression())?;
        if receiver.ty() != Type::Stats {
            return Err(self.refuse(node, "Stats property needs a represented snapshot"));
        }
        Ok(Some(Expr::LibCall {
            r#fn: "stats.size".into(),
            args: vec![receiver],
            r#type: Type::F64,
            loc: self.loc(node),
        }))
    }

    pub(super) fn stats_call(&mut self, node: Node) -> Result<Option<Expr>, String> {
        let member = receivers::reference_node(node.expression());
        if member.kind() != SyntaxKind::PropertyAccessExpression
            || !matches!(
                member.name().text(),
                "isFile" | "isDirectory" | "isSymbolicLink"
            )
            || self.ty(member.expression()).ok() != Some(Type::Stats)
        {
            return Ok(None);
        }
        if !node.arguments().is_empty() {
            return Err(self.refuse(node, "Stats method argument overloads are not ported"));
        }
        let receiver = self.expression(member.expression())?;
        if receiver.ty() != Type::Stats {
            return Err(self.refuse(node, "Stats method needs a represented snapshot"));
        }
        Ok(Some(Expr::LibCall {
            r#fn: format!("stats.{}", member.name().text()),
            args: vec![receiver],
            r#type: Type::Bool,
            loc: self.loc(node),
        }))
    }
}
