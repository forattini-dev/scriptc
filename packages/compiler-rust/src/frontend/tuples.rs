//! Fixed required tuples reuse the IR's positional record layout.
use super::*;
use source_frontend::flags::ElementFlags;

impl Lowerer<'_> {
    pub(super) fn tuple_type(&mut self, id: TypeId) -> Option<Type> {
        let target = self.checker.ty(id).target();
        if self
            .checker
            .ty(target)
            .as_tuple_type()
            .combined_flags
            .intersects(ElementFlags::NON_REQUIRED)
        {
            return None;
        }
        let source = self.checker.get_type_arguments(id).to_vec();
        let elements = source
            .into_iter()
            .map(|element| self.type_id(element))
            .collect::<Option<Vec<_>>>()?;
        self.intern_tuple(elements)
    }

    pub(super) fn intern_tuple(&mut self, elements: Vec<Type>) -> Option<Type> {
        if elements.iter().any(|ty| {
            matches!(
                ty,
                Type::Void | Type::Null | Type::Undefined | Type::Func { .. }
            )
        }) {
            return None;
        }
        let order = (0..elements.len())
            .map(|i| i.to_string())
            .collect::<Vec<_>>();
        let mut fields = order
            .iter()
            .cloned()
            .zip(elements)
            .map(|(name, r#type)| ir::Field { name, r#type })
            .collect::<Vec<_>>();
        fields.sort_by(|a, b| a.name.cmp(&b.name));
        if let Some(record) = self.records.iter().find(|r| r.tuple && r.fields == fields) {
            return Some(Type::Record {
                shape_id: record.id,
            });
        }
        let shape_id = self.records.len();
        self.records.push(ir::Record {
            id: shape_id,
            fields,
            declared_order: order,
            tuple: true,
            index_value: None,
        });
        Some(Type::Record { shape_id })
    }

    pub(super) fn tuple_literal(&mut self, node: Node, target: Type) -> Result<Expr, String> {
        let Type::Record { shape_id } = target else {
            unreachable!()
        };
        let record = self.records[shape_id].clone();
        let nodes = node.elements().into_iter().collect::<Vec<_>>();
        if !record.tuple || nodes.len() != record.fields.len() {
            return Err(self.refuse(node, "tuple literal arity differs from its layout"));
        }
        let fields = nodes
            .into_iter()
            .enumerate()
            .map(|(index, node)| {
                let name = index.to_string();
                let field = record.fields.iter().find(|f| f.name == name).unwrap();
                Ok(ir::FieldInit {
                    name,
                    value: self.expected_expression(node, field.r#type.clone())?,
                    absent: false,
                    overflow: false,
                })
            })
            .collect::<Result<Vec<_>, String>>()?;
        Ok(Expr::RecordLit {
            fields,
            r#type: target,
            loc: self.loc(node),
        })
    }

    pub(super) fn tuple_get(&mut self, node: Node, object: Expr) -> Result<Expr, String> {
        let Type::Record { shape_id } = object.ty() else {
            unreachable!()
        };
        let index = node.argument_expression();
        // Other key expressions may evaluate user code. Never erase them.
        if !matches!(
            index.kind(),
            SyntaxKind::NumericLiteral | SyntaxKind::StringLiteral
        ) {
            return Err(self.refuse(index, "tuple reads require a literal position"));
        }
        let field = self.records[shape_id]
            .fields
            .iter()
            .find(|f| f.name == index.text())
            .ok_or_else(|| self.refuse(index, "tuple position is outside its layout"))?;
        Ok(Expr::RecordGet {
            obj: Box::new(object),
            shape_id: format!("r{shape_id}"),
            field: field.name.clone(),
            r#type: field.r#type.clone(),
            loc: self.loc(node),
        })
    }
}
