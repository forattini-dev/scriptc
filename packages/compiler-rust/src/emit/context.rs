//! One immutable module owns one ordered value inventory for one emission.
use super::*;
use std::collections::HashMap;

pub(super) struct Emission<'a> {
    module: &'a Module,
    value_types: Vec<Type>,
    value_ids: HashMap<Type, usize>,
}

impl<'a> Emission<'a> {
    pub(super) fn new(module: &'a Module) -> Self {
        let value_types = values::collect_types(module);
        let value_ids = value_types
            .iter()
            .cloned()
            .enumerate()
            .map(|(id, ty)| (ty, id))
            .collect();
        Self {
            module,
            value_types,
            value_ids,
        }
    }

    pub(super) fn value_types(&self) -> &[Type] {
        &self.value_types
    }

    pub(super) fn value_type_id(&self, ty: &Type) -> usize {
        *self
            .value_ids
            .get(ty)
            .expect("inventoried native value ABI")
    }
}

impl std::ops::Deref for Emission<'_> {
    type Target = Module;

    fn deref(&self) -> &Self::Target {
        self.module
    }
}
