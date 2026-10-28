//! Source-checker identities are adapted to owned scriptc value layouts.
use super::*;

impl Lowerer<'_> {
    /// Aggregate slots need owning values even when the semantic source type
    /// has no payload. Keep type_id's unit/never meaning separate from storage.
    pub(super) fn aggregate_slot_type(&mut self, id: TypeId) -> Option<Type> {
        if self
            .checker
            .ty(id)
            .flags
            .intersects(TypeFlags::NULL | TypeFlags::UNDEFINED | TypeFlags::NEVER | TypeFlags::VOID)
        {
            Some(Type::Dyn)
        } else {
            self.type_id(id).map(|ty| match ty {
                Type::Null | Type::Undefined | Type::Void => Type::Dyn,
                ty => ty,
            })
        }
    }

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
        if flags.intersects(TypeFlags::BIG_INT_LIKE) {
            Some(Type::Bigint)
        } else if flags.intersects(TypeFlags::NUMBER_LIKE) {
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
        if let Some(ty) = self.declared_callable_type(id) {
            return ty;
        }
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
        if let Some(ty) = self.regex_callable_type(id) {
            return Some(ty);
        }
        if let Some(ty) = self.number_predicate_type(id) {
            return Some(ty);
        }
        if let Some(ty) = self.number_parser_type(id) {
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
        // Wrapper interfaces also accept primitives: preserve the actual tag.
        if ["Number", "String", "Boolean"]
            .iter()
            .any(|name| self.primitive_symbol(symbol, name, None))
        {
            return Some(Type::Dyn);
        }
        if self.standard_stats_type(id) {
            return Some(Type::Stats);
        }
        if self.node_writable_owning_type(id) {
            // Writable is an open nominal interface: the annotation may refer
            // to distinct native objects, not just a process output stream.
            // Keep the owning value and do not invent its operations here.
            return Some(Type::Dyn);
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
        if let Some(ty) = self.standard_byte_type(id) {
            return Some(ty);
        }
        if let Some(ty) = self.data_view_type(id) {
            return Some(ty);
        }
        if let Some(ty) = self.namespace_value_type(id) {
            return Some(ty);
        }
        if let Some(ty) = self.class_type(id) {
            return Some(ty);
        }
        if self.declaration_owning_type(id) {
            return Some(Type::Dyn);
        }
        if self.is_regex_type(id) {
            return Some(Type::Regex);
        }
        if self.is_regex_capture_type(id) {
            return Some(self.regex_capture_array());
        }
        self.aggregate_type(id)
    }
    fn owning_rest_call(&mut self, node: Node) -> bool {
        if node.kind() != SyntaxKind::CallExpression {
            return false;
        }
        let callee = receivers::reference_node(node.expression());
        let name = if callee.kind() == SyntaxKind::PropertyAccessExpression {
            callee.name()
        } else {
            callee
        };
        let symbol = self.symbol(name);
        let native = self
            .bindings
            .get(&symbol)
            .or_else(|| self.module_bindings.get(&symbol))
            .or_else(|| self.outer.iter().rev().find_map(|scope| scope.get(&symbol)))
            .map(|local| local.r#type.clone())
            .or_else(|| {
                if symbol == 0 {
                    return None;
                }
                let declaration = self
                    .checker
                    .sym(source_frontend::prelude::SymbolId(symbol))
                    .value_declaration;
                let hint = self.declared(declaration)?;
                hint.value_type.clone().or_else(|| hint.function_type())
            });
        if let Some(ty @ Type::Func { .. }) = native
            && parameters::erased_rest(&ty)
            && let Type::Func { ret, .. } = ty
            && *ret == Type::Dyn
        {
            // The implementation ABI owns every possible return tag.
            // The checker declaration may project away undefined (for
            // example typeof JSON.stringify). Retain the native result.
            return true;
        }
        false
    }

    pub(super) fn ty(&mut self, node: Node) -> Result<Type, String> {
        if node.kind() == SyntaxKind::ElementAccessExpression {
            let source = self.checker.get_type_at_location(node.expression());
            if self.is_regex_capture_type(source) {
                let key = self
                    .checker
                    .get_type_at_location(node.argument_expression());
                if self
                    .checker
                    .ty(key)
                    .flags
                    .intersects(TypeFlags::NUMBER_LIKE)
                    || self
                        .literal_property_key(node.argument_expression())
                        .is_some_and(|key| key.parse::<f64>().is_ok())
                {
                    return Ok(self.regex_capture_slot());
                }
            }
        }
        if self.owning_rest_call(node) {
            return Ok(Type::Dyn);
        }
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
        if let Some(ty) = self.json_import_type(node) {
            return Ok(ty);
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
        if let Some(ty) = self.json_import_type(node) {
            return Ok(ty);
        }
        let symbol = self.symbol(node);
        if let Some(ty) = self.contextual_record_storage.get(&symbol) {
            return Ok(ty.clone());
        }
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
        if node.parent().kind() == SyntaxKind::VariableDeclaration
            && !node.parent().initializer().is_nil()
        {
            let declaration = node.parent();
            let initial = receivers::reference_node(declaration.initializer());
            if declaration.type_().is_nil()
                && self.bytes_named_key_value(initial, &mut HashSet::new())
            {
                self.var_types.entry(symbol).or_insert(Type::Dyn);
                if declaration.parent().parent().parent().kind() == SyntaxKind::SourceFile {
                    self.module_vars.entry(symbol).or_insert(Type::Dyn);
                }
                return Ok(Type::Dyn);
            }
            if declaration.type_().is_nil()
                && let Some(storage) = self.numeric_initializer_type(initial)
            {
                self.var_types.entry(symbol).or_insert(storage.clone());
                if declaration
                    .parent()
                    .flags()
                    .intersects(NodeFlags::LET | NodeFlags::CONST)
                    && declaration.parent().parent().parent().kind() == SyntaxKind::SourceFile
                {
                    self.module_vars.entry(symbol).or_insert(storage.clone());
                }
                return Ok(storage);
            }
            if declaration.type_().is_nil() && initial.kind() == SyntaxKind::Identifier {
                let source = self.symbol(initial);
                let storage = self
                    .bindings
                    .get(&source)
                    .or_else(|| self.module_bindings.get(&source))
                    .or_else(|| self.outer.iter().rev().find_map(|scope| scope.get(&source)))
                    .map(|local| local.r#type.clone());
                if let Some(storage) = storage
                    && (self.optional_storage(&storage)
                        || parameters::erased_rest(&storage)
                        || (storage == Type::Dyn
                            && self.bytes_named_key_value(initial, &mut HashSet::new())))
                {
                    // Inferred aliases snapshot the represented value, including
                    // lookup absence omitted by the checker's declared type.
                    self.var_types.entry(symbol).or_insert(storage.clone());
                    if declaration.parent().parent().parent().kind() == SyntaxKind::SourceFile {
                        self.module_vars.entry(symbol).or_insert(storage.clone());
                    }
                    return Ok(storage);
                }
            }
            if declaration.type_().is_nil()
                && let Some(storage) = self.owning_bind_type(initial)
            {
                self.var_types.entry(symbol).or_insert(storage.clone());
                if declaration.parent().parent().parent().kind() == SyntaxKind::SourceFile {
                    self.module_vars.entry(symbol).or_insert(storage.clone());
                }
                return Ok(storage);
            }
            if declaration.type_().is_nil()
                && initial.kind() == SyntaxKind::CallExpression
                && self.owning_rest_call(initial)
            {
                // Inferred storage follows the owning call ABI. A checked
                // string projection must not discard a possible undefined
                // return from a public erased callable (including aliases).
                self.var_types.entry(symbol).or_insert(Type::Dyn);
                if declaration.parent().parent().parent().kind() == SyntaxKind::SourceFile {
                    self.module_vars.entry(symbol).or_insert(Type::Dyn);
                }
                return Ok(Type::Dyn);
            }
            if declaration.type_().is_nil()
                && matches!(
                    initial.kind(),
                    SyntaxKind::Identifier
                        | SyntaxKind::PropertyAccessExpression
                        | SyntaxKind::ElementAccessExpression
                        | SyntaxKind::ConditionalExpression
                        | SyntaxKind::CallExpression
                )
                && if matches!(
                    initial.kind(),
                    SyntaxKind::ConditionalExpression | SyntaxKind::CallExpression
                ) {
                    !parameter_abi::is_javascript(declaration)
                } else {
                    parameter_abi::is_javascript(declaration)
                }
                && self.argument_may_be_absent(initial, &mut HashSet::new())
            {
                let ty = self.ty(node)?;
                if matches!(ty, Type::String | Type::F64 | Type::Bool) {
                    let storage = self.undefined_storage_type(ty, initial)?;
                    self.var_types.entry(symbol).or_insert(storage.clone());
                    if declaration.parent().parent().parent().kind() == SyntaxKind::SourceFile {
                        self.module_vars.entry(symbol).or_insert(storage.clone());
                    }
                    return Ok(storage);
                }
            }
            if declaration.type_().is_nil() && optional_access::is_access(initial) {
                // An optional index lookup can be absent even when the checker
                // omits undefined under noUncheckedIndexedAccess=false. Reserve
                // this layout before module cells and closures are allocated.
                let value = self.ty(initial)?;
                let storage = self.optional_result_type(value, initial)?;
                self.var_types.entry(symbol).or_insert(storage.clone());
                if declaration.parent().parent().parent().kind() == SyntaxKind::SourceFile {
                    self.module_vars.entry(symbol).or_insert(storage.clone());
                }
                return Ok(storage);
            }
            if declaration.type_().is_nil() && initial.kind() == SyntaxKind::ElementAccessExpression
            {
                let source = self.checker.get_type_at_location(initial.expression());
                if let Some(receiver) = self.type_id(source)
                    && self.string_view(&receiver)
                {
                    let storage = self.string_index_type(initial)?;
                    if self.optional_storage(&storage) {
                        self.var_types.entry(symbol).or_insert(storage.clone());
                        if declaration.parent().parent().parent().kind() == SyntaxKind::SourceFile {
                            self.module_vars.entry(symbol).or_insert(storage.clone());
                        }
                    }
                    return Ok(storage);
                }
            }
            if matches!(
                initial.kind(),
                SyntaxKind::PropertyAccessExpression | SyntaxKind::ElementAccessExpression
            ) {
                let source = self.checker.get_type_at_location(initial.expression());
                if declaration.type_().is_nil()
                    && self.standard_callable_type(source).is_none()
                    && matches!(self.type_id(source), Some(Type::Func { .. }))
                {
                    // An expando property can disappear or change through an
                    // alias. Inferred locals keep its owning snapshot tag.
                    self.function_member_key(initial)?;
                    self.var_types.entry(symbol).or_insert(Type::Dyn);
                    if declaration.parent().parent().parent().kind() == SyntaxKind::SourceFile {
                        self.module_vars.entry(symbol).or_insert(Type::Dyn);
                    }
                    return Ok(Type::Dyn);
                }
                if initial.kind() == SyntaxKind::ElementAccessExpression
                    && self
                        .literal_property_key(initial.argument_expression())
                        .as_deref()
                        != Some("length")
                {
                    let receiver = receivers::reference_node(initial.expression());
                    if declaration.type_().is_nil()
                        && !matches!(
                            initial.argument_expression().kind(),
                            SyntaxKind::NumericLiteral | SyntaxKind::StringLiteral
                        )
                        && let Some(Type::Record { shape_id }) = self.type_id(source)
                        && self.records[shape_id].tuple
                        && let Some(storage) = self.numeric_tuple_result(shape_id)
                    {
                        self.var_types.entry(symbol).or_insert(storage.clone());
                        if declaration.parent().parent().parent().kind() == SyntaxKind::SourceFile {
                            self.module_vars.entry(symbol).or_insert(storage.clone());
                        }
                        return Ok(storage);
                    }
                    let name = if receiver.kind() == SyntaxKind::PropertyAccessExpression {
                        receiver.name()
                    } else {
                        receiver
                    };
                    let receiver_symbol = self.symbol(name);
                    let declared =
                        if receiver_symbol != 0 {
                            let source = self.checker.get_type_of_symbol(
                                source_frontend::prelude::SymbolId(receiver_symbol),
                            );
                            self.type_id(source)
                                .and_then(|ty| self.nullable_array_element(&ty))
                        } else {
                            None
                        };
                    let element = declared.or_else(|| {
                        let receiver = self.type_id(source)?;
                        self.nullable_array_element(&receiver)
                            .or_else(|| match receiver {
                                Type::Array { elem } if self.optional_storage(&elem) => Some(*elem),
                                _ => None,
                            })
                    });
                    if let Some(element) = element {
                        // Reserve the owning lookup's undefined arm before
                        // allocating module cells or callback capture layouts.
                        let storage = if declaration.type_().is_nil() {
                            self.undefined_storage_type(element, initial)?
                        } else {
                            self.ty(node)?
                        };
                        if storage == Type::Dyn || self.optional_storage(&storage) {
                            self.var_types.entry(symbol).or_insert(storage.clone());
                            if declaration.parent().parent().parent().kind()
                                == SyntaxKind::SourceFile
                            {
                                self.module_vars.entry(symbol).or_insert(storage.clone());
                            }
                        }
                        return Ok(storage);
                    }
                }
                if let Some(Type::Record { shape_id }) = self.type_id(source)
                    && let Some(value) = self.records[shape_id].index_value.clone()
                {
                    // Reserve the true lookup layout before module storage and
                    // function captures are allocated; checker inference may
                    // omit undefined or narrow after a preceding property write.
                    let storage = if declaration.type_().is_nil() {
                        self.undefined_storage_type(value, initial)?
                    } else {
                        self.ty(node)?
                    };
                    if storage == Type::Dyn
                        || matches!(storage, Type::Union { union_id } if self.unions[union_id].arms.contains(&Type::Undefined))
                    {
                        self.var_types.entry(symbol).or_insert(storage.clone());
                        if declaration.parent().parent().parent().kind() == SyntaxKind::SourceFile {
                            self.module_vars.entry(symbol).or_insert(storage.clone());
                        }
                    }
                    return Ok(storage);
                }
            }
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
