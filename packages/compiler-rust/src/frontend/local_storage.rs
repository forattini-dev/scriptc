//! An inferred local keeps the owning ABI produced by a represented call.
use super::*;
use source_frontend::prelude::{get_source_file_of_node, get_token_pos_of_node, source_file_text};

fn erased_record(
    source: &Type,
    target: &Type,
    records: &[ir::Record],
    active: &mut HashSet<(usize, usize)>,
) -> bool {
    if source == target || *target == Type::Dyn {
        return true;
    }
    let (Type::Record { shape_id: a }, Type::Record { shape_id: b }) = (source, target) else {
        return false;
    };
    let (Some(source), Some(target)) = (records.get(*a), records.get(*b)) else {
        return false;
    };
    if source.tuple
        || target.tuple
        || source.index_value.is_some()
        || target.index_value.is_some()
        || source.fields.len() != target.fields.len()
        || source
            .fields
            .iter()
            .chain(&target.fields)
            .any(|f| f.name == "\0scriptc.call")
    {
        return false;
    }
    if !active.insert((*a, *b)) {
        return true;
    }
    let result = target.fields.iter().all(|field| {
        source
            .fields
            .iter()
            .find(|old| old.name == field.name)
            .is_some_and(|old| erased_record(&old.r#type, &field.r#type, records, active))
    });
    active.remove(&(*a, *b));
    result
}

impl Lowerer<'_> {
    pub(super) fn inferred_call_local(
        &mut self,
        declaration: Node,
        statement: Node,
        flags: NodeFlags,
    ) -> bool {
        if !flags.intersects(NodeFlags::CONST)
            || statement.parent().kind() == SyntaxKind::SourceFile
            || !parameter_abi::is_javascript(declaration)
            || !declaration.type_().is_nil()
            || self.declared(declaration).is_some()
            || !matches!(
                declaration.initializer().kind(),
                SyntaxKind::CallExpression | SyntaxKind::Identifier
            )
        {
            return false;
        }
        let file = get_source_file_of_node(statement);
        let text = source_file_text(file);
        let start = statement.pos().max(0) as usize;
        let token = get_token_pos_of_node(statement, file, false)
            .max(statement.pos())
            .max(0) as usize;
        if !statement.js_doc(file).is_empty()
            || !declaration.js_doc(file).is_empty()
            || text
                .get(start..token)
                .is_none_or(|prefix| prefix.contains("/**"))
        {
            return false;
        }
        match declaration.initializer().kind() {
            SyntaxKind::Identifier => true,
            SyntaxKind::CallExpression => {
                // Private erased functions still need their contextual result
                // ABI. Only a published producer already owns this contract.
                let symbol = self.symbol(declaration.initializer().expression());
                self.functions
                    .source_node(symbol)
                    .and_then(|node| self.declared(node))
                    .is_some_and(|hint| matches!(hint.ret, Some(Type::Record { .. })))
            }
            _ => false,
        }
    }

    pub(super) fn call_record_storage(&self, source: &Type, inferred: &Type) -> bool {
        matches!(source, Type::Record { .. })
            && matches!(inferred, Type::Record { .. })
            && erased_record(source, inferred, &self.records, &mut HashSet::new())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn record(id: usize, fields: &[(&str, Type)]) -> ir::Record {
        ir::Record {
            id,
            fields: fields
                .iter()
                .map(|(name, ty)| ir::Field {
                    name: (*name).into(),
                    r#type: ty.clone(),
                })
                .collect(),
            declared_order: fields.iter().map(|(name, _)| (*name).into()).collect(),
            tuple: false,
            index_value: None,
        }
    }
    #[test]
    fn inferred_record_contract_allows_erasure_without_changing_mutable_layouts() {
        let mut records = vec![
            record(0, &[("value", Type::F64)]),
            record(1, &[("value", Type::Dyn)]),
            record(2, &[("value", Type::String)]),
            record(3, &[("other", Type::Dyn)]),
        ];
        let test = |a, b, records: &[ir::Record]| {
            erased_record(
                &Type::Record { shape_id: a },
                &Type::Record { shape_id: b },
                records,
                &mut HashSet::new(),
            )
        };
        assert!(test(0, 1, &records));
        assert!(!test(1, 0, &records));
        assert!(!test(0, 2, &records));
        assert!(!test(0, 3, &records));
        records[1].tuple = true;
        assert!(!test(0, 1, &records));
    }
}
