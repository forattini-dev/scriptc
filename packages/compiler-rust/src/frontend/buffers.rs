//! Declaration-proven Buffer factories use owning byte handles with runtime brands.
use super::*;
use source_frontend::prelude::{SymbolId, get_source_file_of_node};
impl Lowerer<'_> {
    fn standard_buffer_symbol(&self, symbol: u32) -> bool {
        if symbol == 0 {
            return false;
        }
        let symbol = self.checker.sym(SymbolId(symbol));
        matches!(symbol.name.as_ref(), "Buffer" | "BufferConstructor")
            && !symbol.declarations.is_empty()
            && symbol.declarations.iter().all(|decl| {
                let file = source_file_info(get_source_file_of_node(*decl));
                let path = &file.file_name;
                (path.contains("/@types/node/") || path.contains("/bun-types/"))
                    && (path.ends_with("/buffer.d.ts") || path.ends_with("/buffer.buffer.d.ts"))
            })
    }
    pub(super) fn standard_buffer_type(&self, id: TypeId) -> bool {
        self.standard_buffer_symbol(self.checker.ty(id).symbol().0)
    }
    pub(super) fn buffer_call(&mut self, node: Node) -> Result<Option<Expr>, String> {
        let member = node.expression();
        if member.kind() != SyntaxKind::PropertyAccessExpression {
            return Ok(None);
        }
        let symbol = self.symbol(member.expression());
        if !self.standard_buffer_symbol(symbol) {
            return Ok(None);
        }
        let method = member.name().text();
        if !matches!(method, "alloc" | "allocUnsafe" | "isBuffer") {
            return Err(self.refuse(node, "Buffer static is not ported"));
        }
        let method_symbol = self.symbol(member.name());
        if method_symbol == 0
            || !self
                .checker
                .sym(SymbolId(method_symbol))
                .declarations
                .iter()
                .all(|decl| {
                    let file = source_file_info(get_source_file_of_node(*decl));
                    let path = &file.file_name;
                    path.contains("/@types/node/")
                        && (path.ends_with("/buffer.d.ts") || path.ends_with("/buffer.buffer.d.ts"))
                })
        {
            return Err(self.refuse(node, "Buffer method declaration is not ported"));
        }
        let args = node.arguments().into_iter().collect::<Vec<_>>();
        if args.len() != 1 || args[0].kind() == SyntaxKind::SpreadElement {
            return Err(self.refuse(node, "Buffer factory overload is not ported"));
        }
        self.ensure_exception_classes(node)?;
        let value = self.expression(args[0])?;
        let (ir, value, result) = if method == "isBuffer" {
            (
                "buffer.isBuffer",
                self.coerce(value, Type::Dyn, args[0])?,
                Type::Bool,
            )
        } else {
            if value.ty() != Type::F64 {
                return Err(self.refuse(
                    node,
                    "Buffer allocation requires a represented numeric size",
                ));
            }
            ("buffer.alloc", value, Type::bytes())
        };
        Ok(Some(Expr::LibCall {
            r#fn: ir.into(),
            args: vec![value],
            r#type: result,
            loc: self.loc(node),
        }))
    }
}
