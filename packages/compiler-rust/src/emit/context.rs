//! One immutable module owns one ordered value inventory for one emission.
use super::*;
use std::collections::HashMap;

pub(super) struct Emission<'a> {
    module: &'a Module,
    value_types: Vec<Type>,
    value_ids: HashMap<Type, usize>,
    function_types: Vec<Type>,
    function_ids: HashMap<Type, usize>,
    callable_functions: std::collections::HashSet<String>,
    receiver_types: std::collections::HashSet<Type>,
    record_tags: Vec<usize>,
    direct_records: std::collections::HashSet<usize>,
}

impl<'a> Emission<'a> {
    pub(super) fn new(module: &'a Module) -> Self {
        let tracing = std::env::var("SCRIPTC_TRACE_PHASES").is_ok_and(|value| value == "1");
        let mut stamp = std::time::Instant::now();
        let mut mark = |name: &str| {
            if tracing {
                eprintln!(
                    "scriptc: emission inventory {name} ({} ms)",
                    stamp.elapsed().as_millis()
                );
            }
            stamp = std::time::Instant::now();
        };
        let mut callable_functions = std::collections::HashSet::new();
        module.visit_expressions(&mut |value| {
            if let Expr::Closure { fn_name, .. } = value {
                callable_functions.insert(fn_name.clone());
            }
        });
        callable_functions.extend(
            module
                .classes
                .iter()
                .flat_map(|class| &class.symbol_methods)
                .filter_map(|method| method.function.clone()),
        );
        mark("callable functions");
        let value_types = values::collect_types(module, &callable_functions);
        mark("value types");
        let value_ids = value_types
            .iter()
            .cloned()
            .enumerate()
            .map(|(id, ty)| (ty, id))
            .collect();
        mark("value ids");
        let function_types = functions::collect_types(module, &callable_functions);
        mark("function types");
        let function_ids = function_types
            .iter()
            .cloned()
            .enumerate()
            .map(|(id, ty)| (ty, id))
            .collect();
        mark("function ids");
        let receiver_types = crate::ir::receiver_aware_function_types(&module.functions);
        mark("receiver types");
        let record_tags =
            crate::ir::record_equivalence::record_representatives(&module.records, &module.unions);
        mark("record tags");
        let direct_records = record_storage::direct_records(module);
        mark("record storage");
        Self {
            module,
            value_types,
            value_ids,
            function_types,
            function_ids,
            callable_functions,
            receiver_types,
            record_tags,
            direct_records,
        }
    }

    pub(super) fn value_types(&self) -> &[Type] {
        &self.value_types
    }

    pub(super) fn function_types(&self) -> &[Type] {
        &self.function_types
    }
    pub(super) fn function_reads_receiver(&self, ty: &Type) -> bool {
        self.receiver_types.contains(ty)
    }

    pub(super) fn function_type_id(&self, ty: &Type) -> usize {
        *self
            .function_ids
            .get(ty)
            .expect("inventoried native function signature")
    }

    pub(super) fn callable_function(&self, name: &str) -> bool {
        self.callable_functions.contains(name)
    }

    pub(super) fn callable_function_count(&self) -> usize {
        self.callable_functions.len()
    }

    pub(super) fn value_type_id(&self, ty: &Type) -> usize {
        *self
            .value_ids
            .get(ty)
            .unwrap_or_else(|| panic!("inventoried native value ABI: {ty:?}"))
    }

    pub(super) fn record_tag(&self, shape_id: usize) -> usize {
        self.record_tags[shape_id]
    }

    pub(super) fn record_is_shared(&self, shape_id: usize) -> bool {
        !self.direct_records.contains(&shape_id)
    }
}

impl std::ops::Deref for Emission<'_> {
    type Target = Module;

    fn deref(&self) -> &Self::Target {
        self.module
    }
}
