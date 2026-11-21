use super::*;

fn base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut output = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let value = (u32::from(chunk[0]) << 16)
            | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8)
            | u32::from(*chunk.get(2).unwrap_or(&0));
        output.push(TABLE[((value >> 18) & 63) as usize] as char);
        output.push(TABLE[((value >> 12) & 63) as usize] as char);
        output.push(if chunk.len() > 1 {
            TABLE[((value >> 6) & 63) as usize] as char
        } else {
            '='
        });
        output.push(if chunk.len() > 2 {
            TABLE[(value & 63) as usize] as char
        } else {
            '='
        });
    }
    output
}

impl Lowerer<'_> {
    pub(super) fn asset_import(
        &mut self,
        node: Node,
        path: &str,
        kind: modules::AssetKind,
    ) -> Result<(), String> {
        let clause = node.import_clause();
        let name = if clause.is_nil() {
            Node::NIL
        } else {
            clause.name()
        };
        if name.is_nil() || !clause.named_bindings().is_nil() {
            return Err(self.refuse(node, "file asset import requires one default binding"));
        }
        let binding = self.module_binding(name, Type::String, false);
        if self.asset_initializers.iter().any(|statement| {
            matches!(statement, Stmt::Assign { local_id, initializes_global: true, .. } if *local_id == binding.id)
        }) {
            // Module planning can encounter the same import declaration along
            // more than one reachable edge. The module binding is interned;
            // its immutable asset initializer must be interned as well.
            return Ok(());
        }
        let value = match kind {
            modules::AssetKind::Text => {
                let content = std::fs::read_to_string(path).map_err(|error| {
                    self.refuse(
                        node,
                        &format!("text asset could not be read as UTF-8: {error}"),
                    )
                })?;
                Expr::StrLit {
                    value: content,
                    r#type: Type::String,
                    loc: self.loc(node),
                }
            }
            modules::AssetKind::File => {
                let bytes = std::fs::read(path).map_err(|error| {
                    self.refuse(node, &format!("file asset could not be read: {error}"))
                })?;
                let basename = std::path::Path::new(path)
                    .file_name()
                    .and_then(|name| name.to_str())
                    .ok_or_else(|| self.refuse(node, "file asset has no UTF-8 basename"))?;
                Expr::LibCall {
                    r#fn: "asset.file".into(),
                    args: vec![
                        Expr::StrLit {
                            value: base64(&bytes),
                            r#type: Type::String,
                            loc: self.loc(node),
                        },
                        Expr::StrLit {
                            value: basename.into(),
                            r#type: Type::String,
                            loc: self.loc(node),
                        },
                    ],
                    r#type: Type::String,
                    loc: self.loc(node),
                }
            }
        };
        self.asset_initializers.push(Stmt::Assign {
            local_id: binding.id,
            initializes_global: true,
            value,
            loc: self.loc(node),
        });
        Ok(())
    }

    pub(super) fn asset_prelude(&mut self) -> Vec<Stmt> {
        std::mem::take(&mut self.asset_initializers)
    }
}
