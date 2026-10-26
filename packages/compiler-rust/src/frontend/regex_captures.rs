//! Capture rows keep absent groups in their element ABI, independently of null results.
use super::*;

impl Lowerer<'_> {
    pub(super) fn is_regex_capture_type(&self, id: TypeId) -> bool {
        let symbol = self.checker.ty(id).symbol();
        if symbol.0 == 0 {
            return false;
        }
        let symbol = self.checker.sym(symbol);
        symbol.name.as_ref() == "RegExpExecArray"
            && !symbol.declarations.is_empty()
            && symbol.declarations.iter().all(|decl| {
                decl.kind() == SyntaxKind::InterfaceDeclaration
                    && source_frontend::frontend::bundled::bundled_lib_name(
                        &source_file_info(source_frontend::prelude::get_source_file_of_node(*decl))
                            .file_name,
                    )
                    .is_some()
            })
    }
    pub(super) fn regex_capture_slot(&mut self) -> Type {
        self.intern_union(vec![Type::String, Type::Undefined])
            .expect("capture element")
    }
    pub(super) fn regex_capture_array(&mut self) -> Type {
        Type::Array {
            elem: Box::new(self.regex_capture_slot()),
        }
    }
    pub(super) fn regex_capture_get(&mut self, node: Node) -> Result<Option<Expr>, String> {
        if !matches!(
            node.kind(),
            SyntaxKind::PropertyAccessExpression | SyntaxKind::ElementAccessExpression
        ) {
            return Ok(None);
        }
        let source_type = self.checker.get_type_at_location(node.expression());
        if !self.is_regex_capture_type(source_type) {
            return Ok(None);
        }
        let name = if node.kind() == SyntaxKind::PropertyAccessExpression {
            Some(node.name().text().to_owned())
        } else {
            self.literal_property_key(node.argument_expression())
        };
        let Some(name) = name else {
            let key_type = self
                .checker
                .get_type_at_location(node.argument_expression());
            if !self
                .checker
                .ty(key_type)
                .flags
                .intersects(TypeFlags::NUMBER_LIKE)
            {
                return Err(self.refuse(
                    node,
                    "RegExp result computed keys require numeric indices or literal metadata names",
                ));
            }
            return Ok(None);
        };
        let result = match name.as_str() {
            "index" => Type::F64,
            "input" => Type::String,
            "groups" | "indices" => {
                return Err(self.refuse(
                    node,
                    "RegExp result group objects and indices are not ported",
                ));
            }
            _ => return Ok(None),
        };
        let receiver = self.expression(node.expression())?;
        let receiver = self.live_member_receiver(node.expression(), receiver);
        let receiver = self.coerce(receiver, Type::Dyn, node)?;
        let value = self.dynamic_get(
            node,
            receiver,
            Expr::StrLit {
                value: name,
                r#type: Type::String,
                loc: self.loc(node),
            },
        );
        self.coerce(value, result, node).map(Some)
    }
}
