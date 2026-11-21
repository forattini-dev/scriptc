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
                is_declaration(&file.file_name)
                    && source_frontend::frontend::bundled::bundled_lib_name(&file.file_name)
                        .is_none()
            })
    }

    pub(super) fn declaration_owning_type(&mut self, id: TypeId) -> bool {
        if !self
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
            if self.declaration_abi && std::env::var_os("SCRIPTC_TRACE_DECLARATION_ABI").is_some() {
                let declaration = info.value_declaration;
                eprintln!(
                    "scriptc declaration ABI: type={id:?} symbol={} flags={:?} declaration={:?} file={}",
                    info.name,
                    info.flags,
                    if declaration.is_nil() {
                        SyntaxKind::Unknown
                    } else {
                        declaration.kind()
                    },
                    if declaration.is_nil() {
                        "<none>".to_string()
                    } else {
                        source_file_info(get_source_file_of_node(declaration))
                            .file_name
                            .to_string()
                    }
                );
            }
            if info
                .flags
                .intersects(SymbolFlags::VALUE_MODULE | SymbolFlags::NAMESPACE_MODULE)
            {
                // `typeof import("pkg")` is an identity-bearing module
                // namespace, not a closed Rust struct containing a snapshot of
                // every export. Large declaration packages make that mistake
                // especially visible: mutually-referential exports create a
                // recursive record and copying it would lose live bindings.
                // The execution view supplies the native namespace capsule at
                // actual value sites; the declaration ABI carries it opaquely.
                return true;
            }
            let declaration = info.value_declaration;
            let declaration_file = (!declaration.is_nil())
                .then(|| source_file_info(get_source_file_of_node(declaration)));
            let declaration_only = declaration_file
                .as_ref()
                .is_some_and(|file| is_declaration(&file.file_name));
            let external_declaration = declaration_file.as_ref().is_some_and(|file| {
                is_declaration(&file.file_name)
                    && source_frontend::frontend::bundled::bundled_lib_name(&file.file_name)
                        .is_none()
            });
            if info.flags.intersects(SymbolFlags::CLASS) && declaration_only {
                // A nominal reference crosses the checked/execution graph boundary
                // as its owning value. The execution graph owns the class layout.
                return true;
            }
            if external_declaration
                && info.flags.intersects(SymbolFlags::INTERFACE)
                && info.flags.intersects(SymbolFlags::VALUE)
            {
                // JavaScript libraries commonly publish a runtime constructor
                // as an interface plus a same-named `declare const` construct
                // signature. The interface is the nominal instance view of
                // that live object, not a record to recursively copy. This is
                // the declaration equivalent of `class`; treating it as an
                // owning value also prevents fluent generic APIs from
                // expanding their complete conditional-type graph.
                return true;
            }
        }
        if !self.declaration_abi {
            return false;
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
