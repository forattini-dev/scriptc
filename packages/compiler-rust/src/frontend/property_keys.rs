//! Side-effect-free literal property-key conversion shared by native aggregates.
use super::*;

impl Lowerer<'_> {
    // Property names use ECMAScript NumberToString, including radix spellings,
    // rounded large literals, exponent thresholds and negative zero.
    pub(super) fn literal_property_key(&self, node: Node) -> Option<String> {
        match node.kind() {
            SyntaxKind::StringLiteral | SyntaxKind::NoSubstitutionTemplateLiteral => {
                Some(node.text().into())
            }
            SyntaxKind::NumericLiteral => {
                Some(source_frontend::jsnum::from_string(&node.text().replace('_', "")).to_string())
            }
            SyntaxKind::PrefixUnaryExpression
                if node.operand().kind() == SyntaxKind::NumericLiteral =>
            {
                let n =
                    source_frontend::jsnum::from_string(&node.operand().text().replace('_', ""))
                        .value();
                match node.operator() {
                    SyntaxKind::MinusToken => {
                        Some(source_frontend::jsnum::Number::new(-n).to_string())
                    }
                    SyntaxKind::PlusToken => {
                        Some(source_frontend::jsnum::Number::new(n).to_string())
                    }
                    _ => None,
                }
            }
            _ => None,
        }
    }
    pub(super) fn data_property_name(&self, node: Node) -> Option<String> {
        if node.kind() == SyntaxKind::Identifier {
            Some(node.text().into())
        } else {
            self.literal_property_key(node)
        }
    }
    pub(super) fn property_key_expression(&mut self, node: Node) -> Result<Expr, String> {
        if let Some(value) = self.literal_property_key(node) {
            Ok(Expr::StrLit {
                value,
                r#type: Type::String,
                loc: self.loc(node),
            })
        } else {
            let value = self.expression(node)?;
            if value.ty() == Type::F64 {
                // Object keys use NumberToString, not Map's numeric identity.
                Ok(Expr::ToString {
                    operand: Box::new(value),
                    r#type: Type::String,
                    loc: self.loc(node),
                })
            } else if !self.native_type_contains(&value.ty(), |ty| {
                !matches!(
                    ty,
                    Type::String
                        | Type::Bool
                        | Type::Null
                        | Type::Undefined
                        | Type::F64
                        | Type::Union { .. }
                )
            }) {
                // Property keys stringify represented primitives. This is
                // separate from SameValueZero queries in Map/Set containers.
                self.string_value(value, node, strings::Context::Template)
            } else {
                self.coerce(value, Type::String, node)
            }
        }
    }
}
