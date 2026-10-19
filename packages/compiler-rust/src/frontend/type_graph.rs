//! Cycle-safe queries over owned native type layouts.
use super::*;
impl Lowerer<'_> {
    pub(super) fn native_type_contains(
        &self,
        ty: &Type,
        predicate: impl Fn(&Type) -> bool,
    ) -> bool {
        fn visit(
            lowerer: &Lowerer<'_>,
            predicate: &impl Fn(&Type) -> bool,
            ty: &Type,
            seen: &mut HashSet<Type>,
        ) -> bool {
            if !seen.insert(ty.clone()) {
                return false;
            }
            if predicate(ty) {
                return true;
            }
            match ty {
                Type::Array { elem } | Type::Set { elem } | Type::Promise { inner: elem } => {
                    visit(lowerer, predicate, elem, seen)
                }
                Type::Map { key, value } => {
                    visit(lowerer, predicate, key, seen) || visit(lowerer, predicate, value, seen)
                }
                Type::Func { params, ret, .. } => {
                    params.iter().any(|t| visit(lowerer, predicate, t, seen))
                        || visit(lowerer, predicate, ret, seen)
                }
                Type::Union { union_id } => lowerer.unions[*union_id]
                    .arms
                    .iter()
                    .any(|t| visit(lowerer, predicate, t, seen)),
                Type::Object { class_name } => lowerer
                    .classes
                    .layouts
                    .iter()
                    .flatten()
                    .find(|c| c.name == *class_name)
                    .is_some_and(|c| {
                        c.fields
                            .iter()
                            .any(|f| visit(lowerer, predicate, &f.r#type, seen))
                    }),
                Type::Record { shape_id } => {
                    let record = &lowerer.records[*shape_id];
                    record
                        .fields
                        .iter()
                        .any(|f| visit(lowerer, predicate, &f.r#type, seen))
                        || record
                            .index_value
                            .as_ref()
                            .is_some_and(|t| visit(lowerer, predicate, t, seen))
                }
                _ => false,
            }
        }
        visit(self, &predicate, ty, &mut HashSet::new())
    }
}
