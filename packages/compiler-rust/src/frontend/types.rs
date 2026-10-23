//! Source-checker identities are adapted to owned scriptc value layouts.
use super::*;

impl Lowerer<'_> {
    fn opaque_object_type(&self, id: TypeId) -> bool {
        if self
            .checker
            .ty(id)
            .flags
            .intersects(TypeFlags::NON_PRIMITIVE)
        {
            return true;
        }
        let symbol = self.checker.ty(id).symbol();
        if symbol.0 == 0 {
            return false;
        }
        let symbol = self.checker.sym(symbol);
        symbol.name.as_ref() == "Object"
            && symbol.declarations.iter().any(|decl| {
                decl.kind() == SyntaxKind::InterfaceDeclaration
                    && source_frontend::frontend::bundled::bundled_lib_name(
                        &source_file_info(source_frontend::prelude::get_source_file_of_node(*decl))
                            .file_name,
                    ) == Some("lib.es5.d.ts")
            })
    }
    pub(super) fn primitive_type(&self, flags: TypeFlags) -> Option<Type> {
        if flags.intersects(TypeFlags::NUMBER_LIKE) {
            Some(Type::F64)
        } else if flags.intersects(TypeFlags::STRING_LIKE) {
            Some(Type::String)
        } else if flags.intersects(TypeFlags::ES_SYMBOL_LIKE) {
            Some(Type::Symbol)
        } else if flags.intersects(TypeFlags::BOOLEAN_LIKE) {
            Some(Type::Bool)
        } else {
            None
        }
    }
    pub(super) fn type_id(&mut self, id: TypeId) -> Option<Type> {
        // This structural platform interface is a view of a thrown owning
        // value. Its annotation must not turn Error into a checked record.
        if self.standard_errno_type(id) {
            return Some(Type::Dyn);
        }
        // Broad annotations describe no closed layout. Retain the actual
        // owning value rather than projecting it into an empty record or
        // recursively treating Object's prototype methods as data fields.
        if self.opaque_object_type(id) || self.raw_json_type(id) {
            return Some(Type::Dyn);
        }
        if let Some(ty) = self.standard_callable_type(id) {
            return Some(ty);
        }
        if let Some(ty) = self.json_callable_type(id) {
            return Some(ty);
        }
        if self.data_types.contains(&id) {
            return Some(Type::Dyn);
        }
        if self
            .checker
            .ty(id)
            .flags
            .intersects(TypeFlags::ANY | TypeFlags::UNKNOWN | TypeFlags::TYPE_PARAMETER)
        {
            return Some(Type::Dyn);
        }
        if let Some(ty) = self.primitive_type(self.checker.ty(id).flags) {
            return Some(ty);
        }
        let symbol = self.checker.ty(id).symbol().0;
        if self.standard_stats_type(id) {
            return Some(Type::Stats);
        }
        if symbol != 0
            && self
                .checker
                .sym(source_frontend::prelude::SymbolId(symbol))
                .name
                .as_ref()
                == "ChildProcess"
            && self.standard_child_symbol(symbol)
        {
            return Some(Type::Child);
        }
        if self.standard_console_type(id) {
            return Some(console::text_sink_type());
        }
        if self.standard_byte_type(id) {
            return Some(Type::bytes());
        }
        if let Some(ty) = self.namespace_value_type(id) {
            return Some(ty);
        }
        if let Some(ty) = self.class_type(id) {
            return Some(ty);
        }
        if self.is_regex_type(id) {
            return Some(Type::Regex);
        }
        self.aggregate_type(id)
    }
    pub(super) fn ty(&mut self, node: Node) -> Result<Type, String> {
        if let Some(ty) = self.raw_json_property_type(node) {
            return Ok(ty);
        }
        if let Some(ty) = self.json_function_type(node) {
            return Ok(ty);
        }
        if let Some(ty) = self.child_projected_type(node) {
            return Ok(ty);
        }
        if self
            .commonjs
            .requires
            .contains_key(&declarations::Key::of(node))
        {
            return Ok(Type::Dyn);
        }
        if let Some(binding) = self.commonjs_binding(node) {
            return Ok(binding.r#type);
        }
        if matches!(self.commonjs_import(node), Some((_, None))) {
            return Ok(Type::Dyn);
        }
        if node.kind() == SyntaxKind::Identifier {
            let symbol = self.symbol(node);
            if self.data_bindings.contains(&symbol) {
                return Ok(Type::Dyn);
            }
        }
        if let Some(ty) = self.enum_type(node) {
            return Ok(ty);
        }
        if let Some(ty) = self.projections.get(&declarations::Key::of(node)) {
            return Ok(ty.clone());
        }
        let id = self.checker.get_type_at_location(node);
        if self.checker.ty(id).flags.intersects(TypeFlags::VOID) {
            return Ok(Type::Undefined);
        }
        self.type_id(id).ok_or_else(|| {
            self.refuse(
                node,
                "type has no representation in the first native IR subset",
            )
        })
    }
    pub(super) fn storage_type(&mut self, node: Node) -> Result<Type, String> {
        let symbol = self.symbol(node);
        if self.data_bindings.contains(&symbol) {
            return Ok(Type::Dyn);
        }
        if node.parent().kind() == SyntaxKind::VariableDeclaration
            && let Some(hint) = self.declared(node.parent())
            && hint.class.is_none()
        {
            if hint.reason.is_none()
                && let Some(ty) = &hint.value_type
            {
                return Ok(ty.clone());
            }
            return hint.function_type().ok_or_else(|| {
                self.refuse(
                    node,
                    "public JavaScript function value has no native signature",
                )
            });
        }
        let ty = self.ty(node)?;
        if matches!(ty, Type::Dyn | Type::Null | Type::Undefined)
            && node.parent().kind() == SyntaxKind::VariableDeclaration
            && !node.parent().initializer().is_nil()
            && (self.file.ends_with(".js")
                || self.file.ends_with(".mjs")
                || self.file.ends_with(".cjs"))
            && node
                .parent()
                .parent()
                .flags()
                .intersects(NodeFlags::LET | NodeFlags::CONST)
        {
            let initial = self
                .checker
                .get_type_at_location(node.parent().initializer());
            if self
                .checker
                .ty(initial)
                .flags
                .intersects(TypeFlags::NULL | TypeFlags::UNDEFINED)
            {
                // An untyped JS unit initializer says nothing about later
                // assignments. Reserve owning value storage before module
                // lowering; initialization still occurs at the source site.
                return Ok(Type::Dyn);
            }
            return Err(self.refuse(
                node,
                "infer unannotated JavaScript lexical storage from its native initializer",
            ));
        }

        if matches!(ty, Type::Null | Type::Undefined) {
            return Err(self.refuse(
                node,
                "standalone unit storage outside a union is not ported",
            ));
        }
        Ok(ty)
    }
}
