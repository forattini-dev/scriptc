//! Native erasure for unknown payloads and polymorphic JavaScript boundaries.
use super::*;

impl Lowerer<'_> {
    pub(super) fn dynamic_literal(&mut self, node: Node) -> Result<Expr, String> {
        let loc = self.loc(node);
        if node.kind() == SyntaxKind::ArrayLiteralExpression {
            let elems = node
                .elements()
                .into_iter()
                .map(|n| self.expected_expression(n, Type::Dyn))
                .collect::<Result<Vec<_>, _>>()?;
            return Ok(Expr::DynArrLit {
                elems,
                r#type: Type::Dyn,
                loc,
            });
        }
        let mut fields = Vec::new();
        let mut names = HashSet::new();
        for property in node.properties() {
            if !matches!(
                property.kind(),
                SyntaxKind::PropertyAssignment
                    | SyntaxKind::ShorthandPropertyAssignment
                    | SyntaxKind::MethodDeclaration
            ) || self.data_property_name(property.name()).is_none()
                || (property.name().text() == "__proto__"
                    && property.kind() == SyntaxKind::PropertyAssignment)
            {
                return Err(self.refuse(
                    property,
                    "native value objects require plain named data properties",
                ));
            }
            let name = self.data_property_name(property.name()).unwrap();
            if !names.insert(name) {
                return Err(self.refuse(
                    property,
                    "duplicate native value object properties are not ported",
                ));
            }
            let key = Expr::StrLit {
                value: self.data_property_name(property.name()).unwrap(),
                r#type: Type::String,
                loc: self.loc(property),
            };
            let value = self.object_property_value(property, Type::Dyn)?;
            fields.push(ir::DynamicField { key, value });
        }
        Ok(Expr::DynObjLit {
            fields,
            r#type: Type::Dyn,
            loc,
        })
    }
    pub(super) fn dynamic_get(&self, node: Node, value: Expr, key: Expr) -> Expr {
        Expr::DynKeyGet {
            value: Box::new(value),
            key: Box::new(key),
            r#type: Type::Dyn,
            loc: self.loc(node),
        }
    }
}
