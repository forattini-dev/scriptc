//! Source-checker identities are adapted to owned scriptc value layouts.
use super::*;

impl Lowerer<'_> {
    /// Aggregate slots need owning values even when the semantic source type
    /// has no payload. Keep type_id's unit/never meaning separate from storage.
    pub(super) fn aggregate_slot_type(&mut self, id: TypeId) -> Option<Type> {
        let plain_iterable = |source: TypeId| {
            let symbol = self.checker.ty(source).symbol();
            symbol.0 != 0
                && self.checker.sym(symbol).name.as_ref() == "Iterable"
                && self.standard_iterator_type(source)
        };
        if plain_iterable(id)
            || (self.checker.ty(id).flags.intersects(TypeFlags::UNION)
                && self
                    .checker
                    .ty(id)
                    .types()
                    .iter()
                    .copied()
                    .any(plain_iterable))
        {
            // Iterable is a protocol, not a generator layout: arrays, Sets,
            // generators and user iterables must share the owning slot without
            // projecting their identity to any one implementation.
            return Some(Type::Dyn);
        }
        if self.checker.ty(id).flags.intersects(TypeFlags::UNION)
            && self
                .checker
                .ty(id)
                .types()
                .iter()
                .any(|arm| self.checker.ty(*arm).flags.intersects(TypeFlags::VOID))
        {
            // A callback returning `void | Promise<T>` may yield undefined
            // or a live Promise. A single owning Dyn slot carries both.
            return Some(Type::Dyn);
        }
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

    fn global_object_type(&self, id: TypeId) -> bool {
        let global = |source: TypeId| {
            let symbol = self.checker.ty(source).symbol();
            if symbol.0 == 0 {
                return false;
            }
            let symbol = self.checker.sym(symbol);
            match symbol.name.as_ref() {
                "globalThis" => true,
                "Window" => symbol.declarations.iter().any(|declaration| {
                    source_frontend::frontend::bundled::bundled_lib_name(
                        &source_file_info(source_frontend::prelude::get_source_file_of_node(
                            *declaration,
                        ))
                        .file_name,
                    )
                    .is_some()
                }),
                _ => false,
            }
        };
        global(id)
            || (self.checker.ty(id).flags.intersects(TypeFlags::INTERSECTION)
                && self.checker.ty(id).types().iter().copied().any(global))
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
        if self.standard_path_namespace_type(id) {
            // `path.posix` and `path.win32` are immutable strategy objects.
            // Keep the selected strategy as a compact native discriminant;
            // calls on it are lowered by namespace_values.rs.
            return Some(Type::Bool);
        }
        if self.bun_file_type(id) {
            // A native BunFile handle owns only its validated path. Operations
            // in bun.rs preserve the BunFile brand at their call boundary.
            return Some(Type::String);
        }
        if self.bun_crypto_hasher_type(id) {
            return Some(Type::CryptoHash);
        }
        if self.crypto_sign_type(id) {
            return Some(Type::CryptoSign);
        }
        if self.timer_handle_type(id) {
            return Some(Type::F64);
        }
        if self.sqlite_database_type(id) {
            // The first native frontend keeps this opaque kernel handle in a
            // numeric slot. Only sqlite.rs may construct or consume it.
            return Some(Type::F64);
        }
        // V8's `Error.prepareStackTrace` hook is declared as a method but is
        // absent unless installed; its slot is an owning optional value.
        {
            let symbol = self.checker.ty(id).symbol().0;
            if symbol != 0
                && self.primitive_symbol(symbol, "prepareStackTrace", Some("ErrorConstructor"))
            {
                return Some(Type::Dyn);
            }
        }
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
        // A constructor-only annotation (`new (...) => Like`, not a declared
        // class) describes a runtime constructor value: keep the owning value;
        // `new` constructs dynamically and checks the declared instance view.
        if self.checker.ty(id).flags.intersects(TypeFlags::OBJECT)
            && !self
                .checker
                .get_signatures_of_type(id, source_frontend::prelude::SignatureKind::CONSTRUCT)
                .is_empty()
            && self
                .checker
                .get_signatures_of_type(id, source_frontend::prelude::SignatureKind::CALL)
                .is_empty()
            && self.checker.get_properties_of_type(id).is_empty()
            && self.checker.ty(id).symbol().0 != 0
            && self
                .checker
                .sym(self.checker.ty(id).symbol())
                .declarations
                .iter()
                .all(|declaration| {
                    matches!(
                        declaration.kind(),
                        SyntaxKind::ConstructorType | SyntaxKind::TypeLiteral
                    )
                })
        {
            return Some(Type::Dyn);
        }
        if self.standard_crypto_key_type(id) {
            // Native Web Crypto keeps imported PKCS8 material in an owning,
            // non-script-visible byte handle. Only crypto.rs may consume it.
            return Some(Type::bytes());
        }
        if self.standard_array_buffer_type(id) {
            return Some(Type::Dyn);
        }
        if self.standard_url_type(id) {
            // URL is an identity-bearing runtime value with native property
            // dispatch. Structural interface views must not turn it into a
            // copied record or lose its brand when it enters a union.
            return Some(Type::Dyn);
        }
        if self.standard_search_params_type(id) {
            return Some(Type::Dyn);
        }
        if self.global_object_type(id) {
            // `typeof globalThis` and the DOM `Window` view (as in UMD
            // `typeof self == 'object' && self`) describe the host global
            // object, not a closed record layout.
            return Some(Type::Dyn);
        }
        if self.standard_fetch_value_type(id) {
            // Response and Headers are native identity-bearing host values.
            // Their TypeScript interfaces are usage views, not exhaustive
            // record storage, and distinct libraries project different
            // method sets over the same runtime object.
            return Some(Type::Dyn);
        }
        if self.checker.ty(id).flags.intersects(
            TypeFlags::ANY
                | TypeFlags::UNKNOWN
                | TypeFlags::TYPE_PARAMETER
                | TypeFlags::CONDITIONAL,
        ) {
            // Awaited<T> can remain an unresolved conditional type inside
            // an erased generic function. Its value needs the same owning
            // dynamic slot as T itself.
            return Some(Type::Dyn);
        }
        if let Some(ty) = self.primitive_type(self.checker.ty(id).flags) {
            return Some(ty);
        }
        if self
            .checker
            .ty(id)
            .flags
            .intersects(TypeFlags::INTERSECTION)
        {
            let parts = self.checker.ty(id).types().to_vec();
            if parts.iter().any(|part| {
                self.checker
                    .ty(*part)
                    .flags
                    .intersects(TypeFlags::STRING_LIKE)
            }) && parts.iter().all(|part| {
                self.checker
                    .ty(*part)
                    .flags
                    .intersects(TypeFlags::STRING_LIKE)
                    || (self.checker.ty(*part).flags.intersects(TypeFlags::OBJECT)
                        && self.checker.get_properties_of_type(*part).is_empty()
                        && self.checker.get_index_infos_of_type(*part).is_empty()
                        && self
                            .checker
                            .get_signatures_of_type(
                                *part,
                                source_frontend::prelude::SignatureKind::CALL,
                            )
                            .is_empty()
                        && self
                            .checker
                            .get_signatures_of_type(
                                *part,
                                source_frontend::prelude::SignatureKind::CONSTRUCT,
                            )
                            .is_empty())
            }) {
                // `string & {}` is a common open string arm in literal
                // unions. The empty object constraint carries no value data.
                return Some(Type::String);
            }
            // A primitive narrowed by an object/array guard (`string & any[]`
            // after `Array.isArray(stack)`) has no ordinary value of both
            // kinds. Keep the owning dynamic value and its runtime checks.
            let primitive = parts.iter().any(|part| {
                self.checker.ty(*part).flags.intersects(
                    TypeFlags::STRING_LIKE | TypeFlags::NUMBER_LIKE | TypeFlags::BOOLEAN_LIKE,
                )
            });
            let object = parts.iter().any(|part| {
                self.checker.is_array_type(*part)
                    || (self.checker.ty(*part).flags.intersects(TypeFlags::OBJECT)
                        && (!self.checker.get_properties_of_type(*part).is_empty()
                            || !self.checker.get_index_infos_of_type(*part).is_empty()))
            });
            if primitive && object {
                return Some(Type::Dyn);
            }
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
        if self.standard_statfs_type(id) {
            return Some(Type::Array {
                elem: Box::new(Type::F64),
            });
        }
        if self.standard_dirent_type(id) {
            return Some(Type::Dirent);
        }
        if self.node_stream_owning_type(id) {
            // Node streams are open nominal objects: the annotation may refer
            // to process stdio, files, sockets or user-provided subclasses.
            // Keep the owning value and do not invent its operations here.
            return Some(Type::Dyn);
        }
        if self.web_stream_owning_type(id) {
            // WHATWG streams, readers and read-result records carry native
            // identity and lock state. Keep them behind the dynamic ABI so a
            // Bun pipe is never copied into a structural record.
            return Some(Type::Dyn);
        }
        if symbol != 0
            && matches!(
                self.checker
                    .sym(source_frontend::prelude::SymbolId(symbol))
                    .name
                    .as_ref(),
                "ChildProcess"
                    | "ChildProcessWithoutNullStreams"
                    | "ChildProcessByStdio"
                    | "Subprocess"
            )
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
        if let Some(ty) = self.string_decoder_type(id) {
            return Some(ty);
        }
        if self.standard_date_type(id) {
            return Some(Type::Dyn);
        }
        if let Some(ty) = self.namespace_value_type(id) {
            return Some(ty);
        }
        if self.declaration_abi && self.declaration_owning_type(id) {
            // Declaration-backed nominal values must short-circuit before
            // local class discovery. Interface-plus-value class facades can
            // otherwise make class_type instantiate their full recursive
            // generic surface before the owning ABI gets a chance to erase
            // the view.
            return Some(Type::Dyn);
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
        if let Some(ty) = self.inferred_map_new_type(node) {
            return Ok(ty);
        }
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
        let checked = self.checker.ty(id);
        if checked.flags.intersects(TypeFlags::VOID)
            || (checked.flags.intersects(TypeFlags::UNION)
                && checked.types().iter().all(|arm| {
                    self.checker
                        .ty(*arm)
                        .flags
                        .intersects(TypeFlags::VOID | TypeFlags::UNDEFINED | TypeFlags::NEVER)
                }))
        {
            // A value-level `void | undefined` still has the single runtime
            // value `undefined`. This occurs naturally for `await obj?.run()`:
            // the call contributes void and the skipped optional chain adds
            // undefined. Do not require a synthetic union tag for one unit.
            return Ok(Type::Undefined);
        }
        if checked.flags.intersects(TypeFlags::UNION)
            && checked.types().iter().any(|arm| {
                self.checker
                    .ty(*arm)
                    .flags
                    .intersects(TypeFlags::VOID | TypeFlags::UNDEFINED | TypeFlags::NEVER)
            })
        {
            // A mixed value such as number | void needs an owning slot that
            // can carry both the number and JavaScript undefined. Unit arms
            // have no standalone typed storage, so keep the value in Dyn.
            return Ok(Type::Dyn);
        }
        let represented = self.type_id(id).or_else(|| {
            (node.kind() == SyntaxKind::Identifier)
                .then(|| {
                    let symbol = self.symbol(node);
                    self.bindings
                        .get(&symbol)
                        .or_else(|| self.module_bindings.get(&symbol))
                        .or_else(|| self.outer.iter().rev().find_map(|scope| scope.get(&symbol)))
                        .map(|local| local.r#type.clone())
                })
                .flatten()
        });
        if let Some(represented) = represented {
            return Ok(represented);
        }
        if node.kind() == SyntaxKind::ArrayLiteralExpression && parameter_abi::is_javascript(node) {
            // JavaScript arrays are owning heterogeneous containers. When the
            // checker synthesizes an element union with no native structural
            // representation (notably a local class constructor combined with
            // a dynamic global constructor), retain the values in the dynamic
            // element ABI instead of rejecting the entire literal. Contextual
            // array targets still take the precise path above.
            return Ok(Type::Array {
                elem: Box::new(Type::Dyn),
            });
        }
        Err({
            let identifier = (node.kind() == SyntaxKind::Identifier)
                .then(|| format!("; identifier: {}", node.text()))
                .unwrap_or_default();
            self.refuse(
                node,
                &format!("type has no representation in the first native IR subset{identifier}"),
            )
        })
    }
    pub(super) fn storage_type(&mut self, node: Node) -> Result<Type, String> {
        if node.parent().kind() == SyntaxKind::VariableDeclaration {
            let initializer = node.parent().initializer();
            let source = primitives::primitive_source(initializer);
            if node.parent().type_().is_nil()
                && !source.is_nil()
                && source.kind() == SyntaxKind::CallExpression
                && source.expression().kind() == SyntaxKind::PropertyAccessExpression
                && source.expression().name().text() == "match"
                && source.arguments().len() == 1
                && self.ty(source.arguments().get(0)).ok() == Some(Type::Dyn)
            {
                // An erased pattern may implement Symbol.match and return any
                // JavaScript value, despite the checker's RegExpMatchArray view.
                return Ok(Type::Dyn);
            }
            if !source.is_nil()
                && source.kind() == SyntaxKind::Identifier
                && source.text() == "unescape"
            {
                let symbol = self.symbol(source);
                if self.standard_unescape_symbol(symbol) {
                    return Ok(Type::Dyn);
                }
            }
            if !source.is_nil()
                && source.kind() == SyntaxKind::Identifier
                && source.text() == "RegExp"
            {
                let symbol = self.symbol(source);
                if self.regex_symbol(symbol) {
                    return Ok(Type::Dyn);
                }
            }
            let source_type = (!source.is_nil() && source.kind() == SyntaxKind::Identifier)
                .then(|| self.checker.get_type_at_location(source));
            if !initializer.is_nil()
                && source != initializer
                && source_type
                    .and_then(|source_type| self.namespace_value_type(source_type))
                    .is_some()
            {
                let asserted = self.checker.get_type_at_location(initializer);
                if let Some(Type::Record { shape_id }) = self.type_id(asserted)
                    && self.records[shape_id].index_value.is_some()
                {
                    // `namespace as unknown as Record<string, T>` is a
                    // computed dictionary view over heterogeneous live export
                    // values. Its owner must remain dynamic from the global
                    // planning phase onward; freezing the slot to T would
                    // reject real non-T exports before their key is selected.
                    return Ok(Type::Dyn);
                }
            }
        }
        if let Some(ty) = self.json_import_type(node) {
            return Ok(ty);
        }
        let symbol = self.symbol(node);
        if node.parent().kind() == SyntaxKind::VariableDeclaration
            && node.parent().type_().is_nil()
            && parameter_abi::is_javascript(node.parent())
        {
            let initializer = primitives::primitive_source(node.parent().initializer());
            if !initializer.is_nil() && initializer.kind() == SyntaxKind::CallExpression {
                let member = initializer.expression();
                if member.kind() == SyntaxKind::PropertyAccessExpression
                    && member.name().text() == "getOwnPropertyDescriptor"
                    && self.standard_object(member.expression())
                {
                    // The JavaScript result can be undefined, a data
                    // descriptor, or an accessor descriptor. Preserve the
                    // actual value instead of adopting a checker-narrowed
                    // record that assumes fields are always present.
                    self.var_types.insert(symbol, Type::Dyn);
                    self.native_dynamic_values.insert(symbol);
                    return Ok(Type::Dyn);
                }
            }
        }
        if node.parent().kind() == SyntaxKind::VariableDeclaration {
            let initializer = receivers::reference_node(node.parent().initializer());
            if !initializer.is_nil() && initializer.kind() == SyntaxKind::CallExpression {
                let member = receivers::reference_node(initializer.expression());
                if member.kind() == SyntaxKind::PropertyAccessExpression
                    && member.name().text() == "assign"
                    && self.standard_object(member.expression())
                    && let Some(target) = initializer.arguments().into_iter().next()
                    && let Ok(ty @ Type::Object { .. }) = self.ty(target)
                {
                    // Object.assign returns its first argument. Structural
                    // intersection fields are expando views on that owning
                    // instance, not a replacement closed-record allocation.
                    self.var_types.insert(symbol, ty.clone());
                    return Ok(ty);
                }
            }
        }
        if node.parent().kind() == SyntaxKind::VariableDeclaration {
            let initializer = receivers::reference_node(node.parent().initializer());
            if !initializer.is_nil()
                && initializer.kind() == SyntaxKind::PropertyAccessExpression
                && initializer.expression().kind() == SyntaxKind::ThisKeyword
                && initializer.name().text() == "constructor"
                && matches!(
                    self.instance_this.as_ref().map(|local| &local.r#type),
                    Some(Type::Object { .. })
                )
            {
                // `constructor` is an ordinary property: an own value or a
                // prototype descriptor can replace the original class value.
                self.var_types.insert(symbol, Type::Dyn);
                return Ok(Type::Dyn);
            }
        }
        if node.parent().kind() == SyntaxKind::VariableDeclaration {
            let initializer = node.parent().initializer();
            let member_symbol = if !initializer.is_nil()
                && initializer.kind() == SyntaxKind::PropertyAccessExpression
            {
                self.symbol(initializer.name())
            } else {
                0
            };
            if !initializer.is_nil()
                && initializer.kind() == SyntaxKind::PropertyAccessExpression
                && initializer.name().text() == "splice"
                && initializer.expression().kind() == SyntaxKind::ArrayLiteralExpression
                && initializer.expression().elements().is_empty()
                && self.primitive_symbol(member_symbol, "splice", Some("Array"))
            {
                // An extracted rest-ABI builtin is an erased callable value;
                // retaining the checker's variadic signature would demand a
                // generated closure ABI that the intrinsic does not own.
                return Ok(Type::Dyn);
            }
        }
        if node.parent().kind() == SyntaxKind::VariableDeclaration
            && let Some(ty) = self.indexed_initializer_storage(node.parent())?
        {
            self.var_types.insert(symbol, ty.clone());
            return Ok(ty);
        }
        if node.parent().kind() == SyntaxKind::VariableDeclaration
            && let Some(ty) = self.planned_local_storage.get(&symbol)
        {
            return Ok(ty.clone());
        }
        if node.parent().kind() == SyntaxKind::VariableDeclaration {
            let declaration = node.parent();
            let initializer = declaration.initializer();
            if declaration.type_().is_nil()
                && parameter_abi::is_javascript(declaration)
                && !initializer.is_nil()
                && initializer.kind() == SyntaxKind::CallExpression
                && self.ty(initializer).ok() == Some(Type::Dyn)
            {
                // The declaration-name view can already include a later flow
                // fact (for example `if (!value) throw`) in checked JavaScript.
                // It must not replace the owning ABI established by an erased
                // call initializer with that temporary boolean/scalar view.
                self.var_types.insert(symbol, Type::Dyn);
                return Ok(Type::Dyn);
            }
        }
        if node.parent().kind() == SyntaxKind::VariableDeclaration
            && let Some(ty) = self.inferred_map_new_type(node.parent().initializer())
        {
            return Ok(ty);
        }
        if node.parent().kind() == SyntaxKind::VariableDeclaration
            && node.parent().type_().is_nil()
            && !node.parent().initializer().is_nil()
            && node.parent().initializer().kind() == SyntaxKind::ArrayLiteralExpression
        {
            let initializer = node.parent().initializer();
            if let Ok(Type::Array { elem }) = self.ty(initializer) {
                let mut arms = vec![(*elem).clone()];
                let mut widened = false;
                for element in initializer.elements() {
                    if element.kind() == SyntaxKind::SpreadElement {
                        widened = false;
                        break;
                    }
                    if let Some(ty) = self.numeric_initializer_type(element) {
                        widened |= ty != *elem;
                        arms.push(ty);
                    }
                }
                if widened && let Some(elem) = self.intern_union(arms) {
                    return Ok(Type::Array {
                        elem: Box::new(elem),
                    });
                }
            }
        }
        if node.parent().kind() == SyntaxKind::Parameter
            && let Some(ty) = self.js_parameter_types.get(&symbol)
        {
            return Ok(ty.clone());
        }
        if self.absence_assignments.contains(&symbol)
            && node.parent().kind() == SyntaxKind::VariableDeclaration
            && self.declared(node.parent()).is_none()
            && !self.data_bindings.contains(&symbol)
        {
            let ty = self.ty(node)?;
            if matches!(ty, Type::F64 | Type::String | Type::Bool) {
                return self.undefined_storage_type(ty, node);
            }
        }
        if let Some(ty) = self.contextual_record_storage.get(&symbol) {
            return Ok(ty.clone());
        }
        if self.data_bindings.contains(&symbol) {
            return Ok(Type::Dyn);
        }
        if node.parent().kind() == SyntaxKind::VariableDeclaration
            && node.parent().type_().is_nil()
            && !node.parent().initializer().is_nil()
            && parameter_abi::is_javascript(node)
            && !node.parent().initializer().is_nil()
        {
            let initial = receivers::reference_node(node.parent().initializer());
            if self.accessor_literal_source(initial, &mut HashSet::new()) {
                self.var_types.insert(symbol, Type::Dyn);
                if node.parent().parent().parent().parent().kind() == SyntaxKind::SourceFile {
                    self.module_vars.insert(symbol, Type::Dyn);
                }
                return Ok(Type::Dyn);
            }
        }
        if node.parent().kind() == SyntaxKind::VariableDeclaration
            && node.parent().type_().is_nil()
            && !node.parent().initializer().is_nil()
            && let Some(ty) =
                self.assigned_function_type(receivers::reference_node(node.parent().initializer()))
        {
            self.var_types.entry(symbol).or_insert(ty.clone());
            if node.parent().parent().parent().kind() == SyntaxKind::SourceFile {
                self.module_vars.entry(symbol).or_insert(ty.clone());
            }
            return Ok(ty);
        }
        if node.parent().kind() == SyntaxKind::VariableDeclaration
            && node.parent().type_().is_nil()
            && parameter_abi::is_javascript(node)
        {
            let initial = receivers::reference_node(node.parent().initializer());
            if !initial.is_nil() && initial.kind() == SyntaxKind::Identifier {
                let source = self.symbol(initial);
                let owning = self
                    .bindings
                    .get(&source)
                    .or_else(|| self.module_bindings.get(&source))
                    .or_else(|| self.outer.iter().rev().find_map(|scope| scope.get(&source)))
                    .map(|local| local.r#type.clone())
                    .or_else(|| self.planned_local_storage.get(&source).cloned())
                    .or_else(|| self.module_vars.get(&source).cloned());
                if owning == Some(Type::Dyn) {
                    // An inferred alias snapshots the complete owning value.
                    // Declaration projections learned from later property
                    // reads must not freeze that cell to one scalar field ABI.
                    self.var_types.entry(symbol).or_insert(Type::Dyn);
                    return Ok(Type::Dyn);
                }
            }
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
            let raw_initial = declaration.initializer();
            let initial = receivers::reference_node(declaration.initializer());
            if declaration.type_().is_nil()
                && raw_initial.kind() == SyntaxKind::NewExpression
                && let Some(class_name) =
                    self.source_constructed_class_name(raw_initial.expression())
            {
                // The checker can project a destructured CommonJS constructor
                // back to the module namespace record (for example
                // `const { Console } = require("node:console")`). Keep the
                // runtime class identity when reserving the variable cell so
                // constructor lowering does not have to coerce the object into
                // that unrelated record layout.
                let storage = Type::Object { class_name };
                self.var_types.entry(symbol).or_insert(storage.clone());
                if declaration.parent().parent().parent().kind() == SyntaxKind::SourceFile {
                    self.module_vars.entry(symbol).or_insert(storage.clone());
                }
                return Ok(storage);
            }
            if declaration.type_().is_nil()
                && let Some(storage) = self.array_concat_result_type(initial)
            {
                self.var_types.entry(symbol).or_insert(storage.clone());
                if declaration.parent().parent().parent().kind() == SyntaxKind::SourceFile {
                    self.module_vars.entry(symbol).or_insert(storage.clone());
                }
                return Ok(storage);
            }
            if declaration.type_().is_nil()
                && self.bind_intrinsic_value(initial, &mut HashSet::new())
            {
                self.var_types.entry(symbol).or_insert(Type::Dyn);
                if declaration.parent().parent().parent().kind() == SyntaxKind::SourceFile {
                    self.module_vars.entry(symbol).or_insert(Type::Dyn);
                }
                return Ok(Type::Dyn);
            }
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
                if parameter_abi::is_javascript(declaration) && source != 0 {
                    let owner = self
                        .checker
                        .sym(source_frontend::prelude::SymbolId(source))
                        .value_declaration;
                    if !owner.is_nil()
                        && let Some(ty @ Type::Func { .. }) =
                            self.declared(owner).and_then(|hint| {
                                hint.value_type.clone().or_else(|| hint.function_type())
                            })
                    {
                        self.var_types.entry(symbol).or_insert(ty.clone());
                        if declaration
                            .parent()
                            .flags()
                            .intersects(NodeFlags::LET | NodeFlags::CONST)
                            && declaration.parent().parent().parent().kind()
                                == SyntaxKind::SourceFile
                        {
                            self.module_vars.entry(symbol).or_insert(ty.clone());
                        }
                        return Ok(ty);
                    }
                }
                let storage = self
                    .bindings
                    .get(&source)
                    .or_else(|| self.module_bindings.get(&source))
                    .or_else(|| self.outer.iter().rev().find_map(|scope| scope.get(&source)))
                    .map(|local| local.r#type.clone())
                    .or_else(|| self.planned_local_storage.get(&source).cloned())
                    .or_else(|| self.module_vars.get(&source).cloned());
                if let Some(storage) = storage
                    && (self.optional_storage(&storage)
                        || parameters::erased_rest(&storage)
                        || matches!(storage, Type::Classval { .. })
                        || storage == Type::Dyn)
                {
                    // Inferred aliases snapshot the represented value,
                    // including erased owning identities such as a class
                    // returned by a JavaScript constructor factory.
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
        // Module inventory fixes the owning cell layout before any body or
        // initializer is lowered. In particular, a heterogeneous CommonJS
        // registry may intentionally use Dyn even when the checker exposes an
        // unrepresentable structural projection. Do not re-infer that cell at
        // its declaration site.
        if let Some(binding) = self.module_bindings.get(&symbol) {
            return Ok(binding.r#type.clone());
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
            // An unannotated JavaScript lexical whose checker projection is
            // erased still owns a concrete runtime value. Planning may later
            // replace this with a precise initializer ABI; Dyn is the stable
            // fallback for CommonJS calls and imported JSDoc interfaces.
            return Ok(Type::Dyn);
        }

        if matches!(ty, Type::Null | Type::Undefined)
            && node.parent().kind() == SyntaxKind::Parameter
            && parameter_abi::is_javascript(node)
            && !node.parent().initializer().is_nil()
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
                // A JavaScript default only supplies the omitted-argument
                // value; it does not constrain explicitly passed values.
                return Ok(Type::Dyn);
            }
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
