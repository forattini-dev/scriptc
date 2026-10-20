//! File-backed module metadata is owned source provenance, independent of emission.
use super::*;
use source_frontend::ast::get_source_file_of_node;

impl Lowerer<'_> {
    pub(super) fn module_metadata(&self, node: Node) -> Result<Option<Expr>, String> {
        let meta = node.expression();
        if meta.kind() != SyntaxKind::MetaProperty
            || meta.keyword_token() != SyntaxKind::ImportKeyword
            || meta.name().text() != "meta"
        {
            return Ok(None);
        }
        let source = source_file_info(get_source_file_of_node(node));
        let path = std::fs::canonicalize(source.file_name.as_str())
            .map_err(|_| self.refuse(node, "module metadata requires a local source file"))?;
        let value = match node.name().text() {
            "url" => url::Url::from_file_path(&path)
                .map_err(|_| self.refuse(node, "module source has no file URL representation"))?
                .to_string(),
            "filename" => native_filename(&path)
                .ok_or_else(|| self.refuse(node, "non-Unicode module filenames are not ported"))?,
            "dirname" => path.parent().and_then(native_filename).ok_or_else(|| {
                self.refuse(node, "module source has no directory representation")
            })?,
            _ => {
                return Err(self.refuse(
                    node,
                    "only file-backed import.meta.url/filename/dirname reads are ported",
                ));
            }
        };
        Ok(Some(Expr::StrLit {
            value,
            r#type: Type::String,
            loc: self.loc(node),
        }))
    }
}

fn native_filename(path: &Path) -> Option<String> {
    let path = path.to_str()?;
    #[cfg(windows)]
    let path = path
        .strip_prefix(r"\\?\UNC\")
        .map(|unc| format!(r"\\{unc}"))
        .unwrap_or_else(|| path.strip_prefix(r"\\?\").unwrap_or(path).to_owned());
    Some(path.to_owned())
}
