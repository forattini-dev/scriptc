//! Resolution states and transaction boundaries belong to the owned layout graph.
use super::*;

#[derive(Clone, Copy)]
pub(in crate::frontend) enum LayoutKind {
    Other,
    Record,
    Union,
}

#[derive(Clone)]
pub(in crate::frontend) enum Resolution {
    Resolving {
        kind: LayoutKind,
        reference: Option<Type>,
    },
    Ready(Type),
    Failed {
        reference: Option<Type>,
    },
}

// Type adaptation also discovers nominal classes and module capsules. Restore
// those caches with the layout tables when a speculative root cannot complete.
pub(in crate::frontend) struct Checkpoint {
    records: usize,
    unions: usize,
    types: usize,
    classes: classes::ClassGraph,
    namespaces: namespace_values::NamespaceValues,
    globals: usize,
    lifted: usize,
}

impl Checkpoint {
    pub(in crate::frontend) fn new(lowerer: &Lowerer<'_>) -> Self {
        Self {
            records: lowerer.records.len(),
            unions: lowerer.unions.len(),
            types: lowerer.types.mark(),
            classes: lowerer.classes.clone(),
            namespaces: lowerer.namespace_values.clone(),
            globals: lowerer.globals.len(),
            lifted: lowerer.lifted.len(),
        }
    }

    pub(in crate::frontend) fn failed_layout(&self, lowerer: &Lowerer<'_>) -> bool {
        lowerer.types.failed_layout(self.types)
    }

    pub(in crate::frontend) fn restore(self, lowerer: &mut Lowerer<'_>) {
        lowerer.records.truncate(self.records);
        lowerer.unions.truncate(self.unions);
        lowerer.types.rollback(self.types);
        lowerer.callables.retain(|id, _| *id < self.records);
        lowerer
            .polymorphic_callables
            .retain(|_, id| *id < self.records);
        lowerer.classes = self.classes;
        lowerer.namespace_values = self.namespaces;
        lowerer.globals.truncate(self.globals);
        lowerer.lifted.truncate(self.lifted);
    }
}

impl Lowerer<'_> {
    pub(in crate::frontend) fn pending_layout(&self, ty: &Type) -> bool {
        self.type_stack.iter().filter_map(|id| self.types.get(id)).any(|state| {
            matches!(state, Resolution::Resolving { reference: Some(reference), .. } if reference == ty)
        })
    }

    pub(in crate::frontend) fn resolving_layout(&mut self, id: TypeId, kind: LayoutKind) {
        if let Some(Resolution::Resolving { kind: current, .. }) = self.types.get_mut(&id) {
            *current = kind;
        }
    }

    pub(in crate::frontend) fn reserved_layout(&self, id: TypeId) -> Option<Type> {
        match self.types.get(&id) {
            Some(Resolution::Resolving { reference, .. }) => reference.clone(),
            _ => None,
        }
    }

    pub(in crate::frontend) fn recursive_layout(&mut self, id: TypeId) -> Option<Type> {
        let Resolution::Resolving { kind, reference } = self.types.get(&id)?.clone() else {
            return None;
        };
        if reference.is_some() {
            return reference;
        }
        let reference = match kind {
            LayoutKind::Record => {
                let shape_id = self.records.len();
                self.records.push(ir::Record {
                    id: shape_id,
                    fields: vec![],
                    declared_order: vec![],
                    tuple: false,
                    index_value: None,
                });
                Type::Record { shape_id }
            }
            LayoutKind::Union => {
                let union_id = self.unions.len();
                self.unions.push(ir::Union {
                    id: union_id,
                    arms: vec![],
                });
                Type::Union { union_id }
            }
            LayoutKind::Other => return None,
        };
        self.types.insert(
            id,
            Resolution::Resolving {
                kind,
                reference: Some(reference.clone()),
            },
        );
        Some(reference)
    }
}
