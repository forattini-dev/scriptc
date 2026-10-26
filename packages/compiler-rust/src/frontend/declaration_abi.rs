//! Declaration views do not invent storage for runtime classes or open objects.
use super::*;
use source_frontend::prelude::{SignatureKind, get_source_file_of_node};

impl Lowerer<'_> {
    pub(super) fn declaration_projection(&mut self, id: TypeId) -> bool {
        if self.checker.ty(id).flags.intersects(TypeFlags::UNION) {
            let arms = self.checker.ty(id).types().to_vec();
            return arms.iter().any(|arm| self.declaration_projection(*arm));
        }
        let symbol = self.checker.ty(id).symbol();
        if symbol.0 == 0
            || self
                .checker
                .sym(symbol)
                .flags
                .intersects(SymbolFlags::CLASS)
        {
            return false;
        }
        // Public function/record views use the exported ABI, including callback
        // slots containing nominal references. Local classes, functions and
        // generic library containers must keep their execution-owned layouts.
        self.checker
            .sym(symbol)
            .declarations
            .iter()
            .any(|declaration| {
                let file = source_file_info(get_source_file_of_node(*declaration));
                file.file_name.ends_with(".d.ts")
                    && source_frontend::frontend::bundled::bundled_lib_name(&file.file_name)
                        .is_none()
            })
    }

    pub(super) fn declaration_owning_type(&mut self, id: TypeId) -> bool {
        if !self.declaration_abi
            || !self
                .checker
                .ty(id)
                .flags
                .intersects(TypeFlags::OBJECT | TypeFlags::INTERSECTION)
            || self.checker.is_array_type(id)
            || self.checker.is_tuple_type(id)
            || !self
                .checker
                .get_signatures_of_type(id, SignatureKind::CALL)
                .is_empty()
            || !self
                .checker
                .get_signatures_of_type(id, SignatureKind::CONSTRUCT)
                .is_empty()
        {
            return false;
        }
        let symbol = self.checker.ty(id).symbol();
        if symbol.0 != 0 {
            let info = self.checker.sym(symbol);
            let declaration = info.value_declaration;
            if info.flags.intersects(SymbolFlags::CLASS)
                && !declaration.is_nil()
                && source_file_info(get_source_file_of_node(declaration))
                    .file_name
                    .ends_with(".d.ts")
            {
                // A nominal reference crosses the checked/execution graph boundary
                // as its owning value. The execution graph owns the class layout.
                return true;
            }
        }
        let indexes = self.checker.get_index_infos_of_type(id).to_vec();
        // An open record's declared fields are views, not an exhaustive key set.
        // Keep index payloads, extra keys and object identity in the owning ABI.
        !indexes.is_empty()
            && !self.checker.get_properties_of_type(id).is_empty()
            && indexes.iter().all(|index| {
                self.checker
                    .ty(self.checker.index_info(*index).key_type)
                    .flags
                    .intersects(TypeFlags::STRING | TypeFlags::NUMBER)
            })
    }
}
