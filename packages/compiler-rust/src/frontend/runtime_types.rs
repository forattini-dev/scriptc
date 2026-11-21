//! Link nominal runtime dependencies of published layouts and owning values.
use super::*;

// Record/union edges refer to tables scanned below. Follow only inline type
// constructors here, so recursive catalog graphs are visited once per layout.
fn error_dependency(ty: &Type) -> bool {
    match ty {
        Type::Object { class_name } => ir::builtin_error_class(class_name),
        Type::Array { elem } | Type::Set { elem } | Type::Promise { inner: elem } => {
            error_dependency(elem)
        }
        Type::Generator {
            yield_type,
            return_type,
            next_type,
            ..
        } => {
            error_dependency(yield_type)
                || error_dependency(return_type)
                || error_dependency(next_type)
        }
        Type::Map { key, value } => error_dependency(key) || error_dependency(value),
        Type::Func { params, ret, .. } => {
            params.iter().any(error_dependency) || error_dependency(ret)
        }
        _ => false,
    }
}

impl Lowerer<'_> {
    pub(super) fn link_runtime_types(
        &mut self,
        functions: &[Function],
        site: Node,
    ) -> Result<(), String> {
        let field_dependency =
            |fields: &[ir::Field]| fields.iter().any(|field| error_dependency(&field.r#type));
        let mut needed = self.records.iter().any(|record| {
            field_dependency(&record.fields)
                || record.index_value.as_ref().is_some_and(error_dependency)
        }) || self
            .unions
            .iter()
            .any(|union| union.arms.iter().any(error_dependency))
            || self
                .globals
                .iter()
                .any(|global| error_dependency(&global.r#type))
            || self
                .classes
                .layouts
                .iter()
                .flatten()
                .any(|class| field_dependency(&class.fields))
            || self
                .namespace_values
                .layouts
                .iter()
                .any(|class| field_dependency(&class.fields));
        for function in functions {
            needed |= error_dependency(&function.return_type)
                || function
                    .params
                    .iter()
                    .chain(function.captures.iter().flatten())
                    .any(|param| error_dependency(&param.r#type))
                || function
                    .locals
                    .iter()
                    .any(|local| error_dependency(&local.r#type));
            function.visit_expressions(&mut |value| needed |= error_dependency(&value.ty()));
        }
        if needed {
            // Resolve bundled declarations directly, even when a source module
            // has a lexical class named Error. This only links metadata; it
            // neither evaluates a constructor nor demands an unused function.
            self.ensure_exception_classes(site)?;
        }
        Ok(())
    }
}
