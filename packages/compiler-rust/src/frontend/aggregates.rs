//! Closed structural records, function-valued fields and tagged native unions.
use super::*;
use source_frontend::prelude::{ObjectFlags, SignatureKind};

fn flow_shape_distance(
    source: &Type,
    target: &Type,
    records: &[ir::Record],
    unions: &[ir::Union],
    depth: usize,
) -> usize {
    if source == target {
        return 0;
    }
    if depth >= 16 {
        return 10;
    }
    if *target == Type::Dyn {
        return 1;
    }
    if let Type::Union { union_id } = target {
        return unions[*union_id]
            .arms
            .iter()
            .map(|arm| flow_shape_distance(source, arm, records, unions, depth + 1))
            .min()
            .unwrap_or(10);
    }
    if let Type::Union { union_id } = source {
        return unions[*union_id]
            .arms
            .iter()
            .map(|arm| flow_shape_distance(arm, target, records, unions, depth + 1))
            .min()
            .unwrap_or(10);
    }
    if let (Type::Array { elem: source }, Type::Array { elem: target }) = (source, target) {
        return flow_shape_distance(source, target, records, unions, depth + 1);
    }
    if let (
        Type::Record {
            shape_id: source_id,
        },
        Type::Record {
            shape_id: target_id,
        },
    ) = (source, target)
    {
        let source = &records[*source_id];
        let target = &records[*target_id];
        if source.tuple || target.tuple {
            return 10;
        }
        let missing = target
            .fields
            .iter()
            .filter(|field| !source.fields.iter().any(|old| old.name == field.name))
            .count();
        let extra = source
            .fields
            .iter()
            .filter(|field| !target.fields.iter().any(|old| old.name == field.name))
            .count();
        return missing * 10
            + extra * 2
            + target
                .fields
                .iter()
                .filter_map(|field| {
                    let old = source.fields.iter().find(|old| old.name == field.name)?;
                    Some(flow_shape_distance(
                        &old.r#type,
                        &field.r#type,
                        records,
                        unions,
                        depth + 1,
                    ))
                })
                .sum::<usize>();
    }
    if let (
        Type::Func {
            params: source_params,
            ret: source_ret,
            rest: source_rest,
        },
        Type::Func {
            params: target_params,
            ret: target_ret,
            rest: target_rest,
        },
    ) = (source, target)
        && source_rest == target_rest
        && source_params.len() <= target_params.len()
    {
        return source_params
            .iter()
            .zip(target_params)
            .map(|(source, target)| flow_shape_distance(source, target, records, unions, depth + 1))
            .sum::<usize>()
            + flow_shape_distance(source_ret, target_ret, records, unions, depth + 1);
    }
    10
}

impl Lowerer<'_> {
    fn inherited_class_type(&mut self, id: TypeId) -> Option<Type> {
        let checked = self.checker.ty(id);
        let declaration = if checked.object_flags().intersects(ObjectFlags::REFERENCE) {
            checked.target()
        } else {
            id
        };
        let checked = self.checker.ty(declaration);
        let symbol = checked.symbol();
        let interface = checked.object_flags().intersects(ObjectFlags::INTERFACE)
            || (symbol.0 != 0
                && self
                    .checker
                    .sym(symbol)
                    .flags
                    .intersects(SymbolFlags::INTERFACE));
        if !interface {
            return None;
        }

        let bases = self.checker.get_base_types(declaration);
        let represented = bases
            .iter()
            .map(|base| (*base, self.type_id(*base)))
            .collect::<Vec<_>>();
        if let [(base, Some(Type::Dyn))] = represented.as_slice()
            && self.declaration_owning_type(*base)
        {
            // The declaration graph names the nominal base while the matching
            // JavaScript implementation owns its native class layout. Retain
            // the owning value here; the execution-side checker view performs
            // the nominal instance check at the actual use site.
            return Some(Type::Dyn);
        }
        let mut nominal = represented
            .into_iter()
            .filter_map(|(_, base)| base)
            .filter(|base| matches!(base, Type::Object { .. }))
            .collect::<Vec<_>>();
        nominal.dedup();
        match nominal.as_slice() {
            [Type::Object { class_name }]
                if self
                    .classes
                    .subclass(class_name, "native_builtin_EventEmitter")
                    && self
                        .checker
                        .sym(symbol)
                        .declarations
                        .iter()
                        .any(|declaration| {
                            declaration.kind() == SyntaxKind::InterfaceDeclaration
                                && !declaration.members().is_empty()
                        }) =>
            {
                Some(Type::Dyn)
            }
            [base] => Some(base.clone()),
            _ => None,
        }
    }

    fn readonly_array_element(&mut self, id: TypeId) -> Option<TypeId> {
        let symbol = self.checker.ty(id).symbol();
        if symbol.0 == 0 {
            return None;
        }
        let info = self.checker.sym(symbol);
        if info.name.as_ref() != "ReadonlyArray"
            || !info.declarations.iter().any(|declaration| {
                !declaration.is_nil()
                    && source_frontend::frontend::bundled::bundled_lib_name(
                        &source_file_info(source_frontend::prelude::get_source_file_of_node(
                            *declaration,
                        ))
                        .file_name,
                    ) == Some("lib.es5.d.ts")
            })
        {
            return None;
        }
        let arguments = self.checker.get_type_arguments(id);
        (arguments.len() == 1).then_some(arguments[0])
    }

    fn nominal_identity_available(&mut self, id: TypeId, seen: &mut HashSet<TypeId>) -> bool {
        if !seen.insert(id) {
            return false;
        }
        let checked = self.checker.ty(id);
        let symbol = checked.symbol().0;
        if symbol != 0 && self.classes.has_identity(symbol) {
            return true;
        }
        if self.checker.is_array_type(id) {
            let element = self.checker.get_element_type_of_array_type(id);
            return self.nominal_identity_available(element, seen);
        }
        if checked
            .flags
            .intersects(TypeFlags::UNION | TypeFlags::INTERSECTION)
        {
            let arms = checked.types().to_vec();
            return arms
                .into_iter()
                .any(|arm| self.nominal_identity_available(arm, seen));
        }
        // A callable view resolved before class discovery (for example
        // `(builder: Builder) => Builder`) names classes in its signature.
        let signatures = self
            .checker
            .get_signatures_of_type(id, SignatureKind::CALL)
            .to_vec();
        for signature in signatures {
            let parameters = self.checker.sig(signature).parameters.clone();
            for parameter in parameters {
                let parameter = self.checker.get_type_of_symbol(parameter);
                if self.nominal_identity_available(parameter, seen) {
                    return true;
                }
            }
            let result = self.checker.get_return_type_of_signature(signature);
            if self.nominal_identity_available(result, seen) {
                return true;
            }
        }
        false
    }

    pub(super) fn aggregate_type(&mut self, id: TypeId) -> Option<Type> {
        let flags = self.checker.ty(id).flags;
        if flags.intersects(TypeFlags::NULL) {
            return Some(Type::Null);
        }
        if flags.intersects(TypeFlags::UNDEFINED) {
            return Some(Type::Undefined);
        }
        let retry_nominal_aggregate = matches!(
            self.types.get(&id),
            Some(type_graph::Resolution::Failed { .. })
        ) && self.nominal_identity_available(id, &mut HashSet::new());
        if let Some(cached) = self.types.get(&id)
            && !retry_nominal_aggregate
        {
            return match cached {
                type_graph::Resolution::Ready(ty) => Some(ty.clone()),
                type_graph::Resolution::Failed { .. } => None,
                type_graph::Resolution::Resolving { .. } => self.recursive_layout(id),
            };
        }
        let checkpoint = self
            .type_stack
            .is_empty()
            .then(|| type_graph::Checkpoint::new(self));
        self.type_stack.push(id);
        self.types.insert(
            id,
            type_graph::Resolution::Resolving {
                kind: type_graph::LayoutKind::Other,
                reference: None,
            },
        );
        let mut result = self.aggregate_type_inner(id);
        let reference = self.reserved_layout(id);
        self.types.insert(
            id,
            match &result {
                Some(ty) => type_graph::Resolution::Ready(ty.clone()),
                None => type_graph::Resolution::Failed { reference },
            },
        );
        assert_eq!(self.type_stack.pop(), Some(id));
        if let Some(checkpoint) = checkpoint {
            if checkpoint.failed_layout(self) {
                result = None;
            }
            if result.is_none() {
                checkpoint.restore(self);
                self.types
                    .insert(id, type_graph::Resolution::Failed { reference: None });
            }
        }
        result
    }

    fn aggregate_type_inner(&mut self, id: TypeId) -> Option<Type> {
        let flags = self.checker.ty(id).flags;
        if flags.intersects(TypeFlags::INTERSECTION)
            && self
                .checker
                .ty(id)
                .types()
                .iter()
                .any(|part| self.checker.is_tuple_type(*part))
        {
            return self.tuple_intersection_type(id);
        }
        if self.checker.is_tuple_type(id) {
            return self.tuple_type(id);
        }
        let array_element = if self.checker.is_array_type(id) {
            Some(self.checker.get_element_type_of_array_type(id))
        } else {
            self.readonly_array_element(id)
        };
        if let Some(element) = array_element {
            let elem = self.aggregate_slot_type(element)?;
            if matches!(
                elem,
                Type::Void | Type::Null | Type::Undefined | Type::Stats
            ) || matches!(&elem, Type::Union { union_id } if self.unions[*union_id].arms.contains(&Type::Stats))
            {
                return None;
            }
            return Some(Type::Array {
                elem: Box::new(elem),
            });
        }
        if let Some(ty) = self.iterator_generator_type(id) {
            // The engine-free native subset admits standard Iterable/Iterator
            // annotations only when backed by our stateful generator handle.
            // Publishing that handle directly preserves single-consumer state
            // and makes [Symbol.iterator]() the generator identity operation.
            return Some(ty);
        }
        if let Some(ty) = self.generator_type(id) {
            return Some(ty);
        }
        if let Some(ty) = self.promise_type(id) {
            return Some(ty);
        }
        if let Some(ty) = self.map_type(id) {
            return Some(ty);
        }
        if let Some(ty) = self.set_type(id) {
            return Some(ty);
        }
        if let Some(ty) = self.inherited_class_type(id) {
            // An interface extending a class refines the checker view of the
            // same JavaScript instance; it does not allocate a structural
            // object. Keep the nominal class handle so generator/callback ABIs
            // preserve prototype identity across declaration boundaries.
            return Some(ty);
        }
        let symbol = self.checker.ty(id).symbol();
        if symbol.0 != 0 {
            let info = self.checker.sym(symbol);
            if info.name.as_ref() == "Function"
                && info.declarations.iter().any(|declaration| {
                    !declaration.is_nil()
                        && source_frontend::frontend::bundled::bundled_lib_name(
                            &source_file_info(source_frontend::prelude::get_source_file_of_node(
                                *declaration,
                            ))
                            .file_name,
                        ) == Some("lib.es5.d.ts")
                })
            {
                // The standard Function interface describes a callable object,
                // including prototype methods. Keep the live callable identity.
                return Some(Type::Dyn);
            }
        }
        if flags.intersects(TypeFlags::INTERSECTION) {
            let parts = self.checker.ty(id).types().to_vec();
            let class_instance = parts.iter().any(|part| {
                let symbol = self.checker.ty(*part).symbol();
                symbol.0 != 0
                    && self
                        .checker
                        .sym(symbol)
                        .flags
                        .intersects(SymbolFlags::CLASS)
            });
            let callable = parts.iter().any(|part| {
                !self
                    .checker
                    .get_signatures_of_type(*part, SignatureKind::CALL)
                    .is_empty()
            });
            if class_instance && callable {
                // A callable facade over a class is one live JavaScript
                // function object. Its assigned methods need not equal the
                // class declaration's entire prototype projection.
                return Some(Type::Dyn);
            }
        }
        if flags.intersects(TypeFlags::OBJECT | TypeFlags::INTERSECTION)
            && !self
                .checker
                .get_signatures_of_type(id, SignatureKind::CALL)
                .is_empty()
        {
            return self.callable_type(id);
        }
        if flags.intersects(TypeFlags::UNION) {
            self.resolving_layout(id, type_graph::LayoutKind::Union);
            let source = self.checker.ty(id).types().to_vec();
            let mut arms = Vec::new();
            for source in source {
                let symbol = self.checker.ty(source).symbol().0;
                let constructor = !self
                    .checker
                    .get_signatures_of_type(source, SignatureKind::CONSTRUCT)
                    .is_empty();
                let arm = self
                    .classes
                    .nominal_identity_type(symbol, constructor)
                    .or_else(|| self.type_id(source))?;
                if let Type::Union { union_id } = arm {
                    if self.unions[union_id].arms.is_empty() {
                        return None;
                    }
                    arms.extend(self.unions[union_id].arms.clone());
                } else {
                    arms.push(arm);
                }
            }
            if let Some(Type::Union { union_id }) = self.reserved_layout(id) {
                let arms = self.union_arms(arms)?;
                if arms.len() < 2 || arms.contains(&Type::Dyn) {
                    return None;
                }
                self.unions[union_id].arms = arms;
                return Some(Type::Union { union_id });
            }
            return self.intern_union(arms);
        }
        if !flags.intersects(TypeFlags::OBJECT | TypeFlags::INTERSECTION)
            || self
                .checker
                .ty(id)
                .object_flags()
                .intersects(ObjectFlags::CLASS)
            // Instantiated generic classes carry REFERENCE rather than CLASS
            // object flags. They still have nominal instance storage; a checked
            // declaration snapshot must never project them into a plain record.
            || (self.checker.ty(id).symbol().0 != 0
                && self.checker.sym(self.checker.ty(id).symbol()).flags.intersects(SymbolFlags::CLASS))
            || !self
                .checker
                .get_signatures_of_type(id, SignatureKind::CALL)
                .is_empty()
            || !self
                .checker
                .get_signatures_of_type(id, SignatureKind::CONSTRUCT)
                .is_empty()
        {
            return None;
        }
        if self
            .checker
            .ty(id)
            .object_flags()
            .intersects(ObjectFlags::MAPPED)
        {
            let alias = self.checker.ty(id).alias();
            if let Some(alias) = alias {
                let arguments = alias.type_arguments();
                if self.checker.sym(alias.symbol()).name.as_ref() == "Record"
                    && arguments.len() == 2
                    && self
                        .checker
                        .ty(arguments[0])
                        .flags
                        .intersects(TypeFlags::TEMPLATE_LITERAL)
                {
                    // `Record<`prefix:${string}`, T>` has an unbounded string
                    // key space but no ordinary all-string index signature.
                    // Asking the checker to enumerate its apparent properties
                    // recursively expands that template mapping. Keep the
                    // JavaScript dictionary as one owning dynamic object; its
                    // element reads still validate/call the selected value at
                    // the use site.
                    return Some(Type::Dyn);
                }
            }
        }
        let properties = self.checker.get_properties_of_type(id).to_vec();
        let indexes = self.checker.get_index_infos_of_type(id).to_vec();
        if properties.iter().any(|property| {
            self.checker
                .sym(*property)
                .flags
                .intersects(SymbolFlags::ACCESSOR)
        }) {
            // Accessors cannot be represented as fixed data slots: reading or
            // writing them must dispatch the live descriptor with its receiver.
            // Preserve the owning object so dynamic property operations keep
            // getter/setter behavior and identity instead of copying the view.
            return Some(Type::Dyn);
        }
        let class_method_surface = properties.iter().all(|property| {
            self.checker
                .sym(*property)
                .declarations
                .iter()
                .any(|declaration| {
                    declaration.kind() == SyntaxKind::MethodDeclaration
                        && matches!(
                            declaration.parent().kind(),
                            SyntaxKind::ClassDeclaration | SyntaxKind::ClassExpression
                        )
                })
        });
        let structural_callable_surface = properties.iter().all(|property| {
            self.checker
                .sym(*property)
                .declarations
                .iter()
                .any(|declaration| {
                    (declaration.kind() == SyntaxKind::MethodSignature
                        && declaration.parent().kind() == SyntaxKind::InterfaceDeclaration)
                        || (declaration.kind() == SyntaxKind::PropertySignature
                            && declaration.parent().kind() == SyntaxKind::TypeLiteral)
                })
        });
        // JavaScript/JSDoc can reduce a live client object to the single
        // erased `call: any` or `call: Function` member observed by a wrapper. That projection
        // must retain the source object's method identity.
        let erased_call_surface =
            if properties.len() == 1 && self.checker.sym(properties[0]).name.as_ref() == "call" {
                let value = self.checker.get_type_of_symbol(properties[0]);
                let symbol = self.checker.ty(value).symbol();
                self.checker.ty(value).flags.intersects(TypeFlags::ANY)
                    || (symbol.0 != 0 && self.checker.sym(symbol).name.as_ref() == "Function")
            } else {
                false
            };
        if (self
            .checker
            .ty(id)
            .object_flags()
            .intersects(ObjectFlags::MAPPED)
            || class_method_surface
            || structural_callable_surface
            || erased_call_surface)
            && !properties.is_empty()
            && indexes.is_empty()
            && properties.iter().all(|property| {
                let value = self.checker.get_type_of_symbol(*property);
                !self
                    .checker
                    .get_signatures_of_type(value, SignatureKind::CALL)
                    .is_empty()
                    || erased_call_surface
            })
        {
            if structural_callable_surface || erased_call_surface {
                self.classes.defer_interface_methods(
                    id,
                    properties
                        .iter()
                        .map(|property| self.checker.sym(*property).name.to_string())
                        .collect(),
                );
            }
            for property in &properties {
                let name = self.checker.sym(*property).name.to_string();
                let declarations = self.checker.sym(*property).declarations.clone();
                for declaration in declarations {
                    if declaration.kind() != SyntaxKind::MethodDeclaration {
                        continue;
                    }
                    self.classes.defer_erased_method(declaration, name.clone());
                }
            }
            // Pick<Owner, "method"> may describe a class instance whose
            // methods live on its prototype. Keep the original object and
            // dispatch the selected methods through its live property store.
            return Some(Type::Dyn);
        }
        if indexes.len() == 1 && !properties.is_empty() {
            let index = self.checker.index_info(indexes[0]);
            let key = index.key_type;
            let element = index.value_type;
            let element_flags = self.checker.ty(element).flags;
            let string_values = self.checker.ty(key).flags.intersects(TypeFlags::STRING)
                && (element_flags.intersects(TypeFlags::STRING_LIKE)
                    || (element_flags.intersects(TypeFlags::UNION)
                        && self.checker.ty(element).types().iter().all(|arm| {
                            self.checker
                                .ty(*arm)
                                .flags
                                .intersects(TypeFlags::STRING_LIKE | TypeFlags::UNDEFINED)
                        })));
            let compatible = string_values
                && properties.iter().all(|property| {
                    if self
                        .checker
                        .sym(*property)
                        .flags
                        .intersects(SymbolFlags::ACCESSOR)
                    {
                        return false;
                    }
                    let field = self.checker.get_type_of_symbol(*property);
                    self.checker.is_type_assignable_to(field, element)
                });
            if compatible {
                // Keep an owning object when named fields and an index overlap.
                // Dynamic reads and writes retain the same backing identity.
                return Some(Type::Dyn);
            }
        }
        // TypeScript's empty-object type `{}` is the set of all non-nullish
        // values, including strings, numbers and booleans. It is not an
        // ordinary object layout and must not become an empty native record:
        // doing so breaks contravariant callback adapters by requiring a
        // record handle for primitive values. Keep its owning value ABI.
        if properties.is_empty()
            && indexes.is_empty()
            && [
                self.checker.get_string_type(),
                self.checker.get_number_type(),
                self.checker.get_boolean_type(),
            ]
            .into_iter()
            .any(|primitive| self.checker.is_type_assignable_to(primitive, id))
        {
            return Some(Type::Dyn);
        }
        self.resolving_layout(id, type_graph::LayoutKind::Record);
        let index_value = if indexes.is_empty() {
            None
        } else {
            // A named field and an index signature are two typed views over
            // the same own-property store. Keep the explicit fields precise
            // and use the index payload only for the remaining keys.
            if indexes.len() != 1 {
                return None;
            }
            let index = self.checker.index_info(indexes[0]);
            if !self
                .checker
                .ty(index.key_type)
                .flags
                .intersects(TypeFlags::STRING | TypeFlags::NUMBER)
            {
                return None;
            }
            let source = index.value_type;
            for property in &properties {
                let property_type = self.checker.get_type_of_symbol(*property);
                if !self.checker.is_type_assignable_to(property_type, source) {
                    return None;
                }
            }
            let ty = match self.type_id(source)? {
                // Indexed storage has no closed per-key callable ABI: each
                // function remains an owning JavaScript value and dynamic
                // invocation checks the selected entry at the call site.
                Type::Func { .. } => Type::Dyn,
                ty => ty,
            };
            if matches!(
                ty,
                Type::Null | Type::Undefined | Type::Void | Type::Map { .. } | Type::Stats
            ) || matches!(&ty, Type::Union { union_id } if self.unions[*union_id].arms.contains(&Type::Stats))
            {
                return None;
            }
            Some(ty)
        };
        let mut fields = Vec::new();
        for property in properties {
            let property_info = self.checker.sym(property);
            let name = property_info.name.to_string();
            let declaration = property_info.value_declaration;
            let syntactic_optional = property_info
                .declarations
                .iter()
                .copied()
                .chain((!declaration.is_nil()).then_some(declaration))
                .any(|declaration| {
                    (declaration.kind() == SyntaxKind::JsDocPropertyTag
                        && declaration.is_bracketed())
                        || (declaration.kind() == SyntaxKind::PropertySignature
                            && !declaration.question_token().is_nil())
                });
            let prototype_syntax = self
                .checker
                .sym(property)
                .declarations
                .iter()
                .copied()
                .chain((!declaration.is_nil()).then_some(declaration))
                .any(|declaration| declaration.kind() == SyntaxKind::PropertyAssignment);
            // In an object literal, colon-form `__proto__: value` is prototype
            // syntax rather than an own data property.  Do not bake the
            // checker's synthetic property into the native record layout;
            // record construction below validates the supported null value and
            // records the prototype bit separately. Shorthand and method forms
            // still describe real own properties and remain in the layout.
            if name == "__proto__" && prototype_syntax {
                continue;
            }
            // Ordinary object methods use owning function fields and the
            // existing call-site receiver ABI.
            let source = self.checker.get_type_of_symbol(property);
            let mut ty = match self.aggregate_slot_type(source) {
                Some(ty) => ty,
                // One open mapped/generic/nominal field must not erase every
                // other slot in an otherwise closed record. NativeValue owns
                // that field while concrete consumers install checked views;
                // represented siblings keep their precise Rust storage.
                None => Type::Dyn,
            };
            // A JavaScript object literal may refer to an exported function
            // whose declaration contract is narrower than the execution
            // checker's inferred callable. Keep the actual owning signature
            // in the field, instead of inventing a new function identity.
            if matches!(ty, Type::Func { .. })
                && !declaration.is_nil()
                && declaration.kind() == SyntaxKind::ShorthandPropertyAssignment
                && parameter_abi::is_javascript(declaration)
            {
                let symbol = self.symbol(declaration.name());
                if symbol != 0 {
                    let owner = self
                        .checker
                        .sym(source_frontend::prelude::SymbolId(symbol))
                        .value_declaration;
                    if !owner.is_nil()
                        && let Some(actual) = self.declared(owner).and_then(|hint| {
                            hint.value_type.clone().or_else(|| hint.function_type())
                        })
                        && matches!(actual, Type::Func { .. })
                    {
                        ty = actual;
                    }
                }
            }
            if ty != Type::Dyn
                && (self
                    .checker
                    .sym(property)
                    .flags
                    .intersects(SymbolFlags::OPTIONAL)
                    || syntactic_optional
                    || (self.js_absent_fields.contains(&(id, name.clone()))
                        && matches!(ty, Type::String | Type::F64 | Type::Bool)))
            {
                if matches!(ty, Type::Union { union_id } if self.unions[union_id].arms.is_empty()) {
                    // A recursive union is reserved before its arms exist.
                    // Copying the empty arm list would collapse this field to
                    // undefined. Retain the reference when its source union
                    // already owns absence; otherwise refuse this layout query.
                    if !self.checker.ty(source).flags.intersects(TypeFlags::UNION)
                        || !self
                            .checker
                            .ty(source)
                            .types()
                            .iter()
                            .any(|arm| self.checker.ty(*arm).flags.intersects(TypeFlags::UNDEFINED))
                    {
                        return None;
                    }
                } else {
                    let mut arms = match ty {
                        Type::Union { union_id } => self.unions[union_id].arms.clone(),
                        _ => vec![ty],
                    };
                    arms.push(Type::Undefined);
                    ty = self.intern_union(arms)?;
                }
            }
            fields.push(ir::Field { name, r#type: ty });
        }
        let declared_order = fields.iter().map(|f| f.name.clone()).collect();
        fields.sort_by(|a, b| a.name.cmp(&b.name));
        if let Some(Type::Record { shape_id }) = self.reserved_layout(id) {
            self.records[shape_id] = ir::Record {
                id: shape_id,
                fields,
                declared_order,
                tuple: false,
                index_value,
            };
            return Some(Type::Record { shape_id });
        }
        if let Some(record) = self.records.iter().find(|r| {
            !r.tuple
                && !self.pending_layout(&Type::Record { shape_id: r.id })
                && !self.enum_shape(r.id)
                && !self.is_data_view(&Type::Record { shape_id: r.id })
                && !self.callables.contains_key(&r.id)
                && r.fields == fields
                && r.index_value == index_value
        }) {
            return Some(Type::Record {
                shape_id: record.id,
            });
        }
        let shape_id = self.records.len();
        self.records.push(ir::Record {
            id: shape_id,
            fields,
            declared_order,
            tuple: false,
            index_value,
        });
        Some(Type::Record { shape_id })
    }

    fn union_arms(&self, arms: Vec<Type>) -> Option<Vec<Type>> {
        fn flatten(
            this: &Lowerer<'_>,
            arm: Type,
            active: &mut HashSet<usize>,
            result: &mut Vec<Type>,
        ) -> Option<()> {
            let Type::Union { union_id } = arm else {
                result.push(arm);
                return Some(());
            };
            let Some(union) = this.unions.get(union_id) else {
                return None;
            };
            if union.arms.is_empty() {
                // A reserved recursive union is not complete enough to
                // normalize yet. Keep its identity so the reservation can be
                // filled by the owning type mapper.
                result.push(Type::Union { union_id });
                return Some(());
            }
            if !active.insert(union_id) {
                return None;
            }
            for nested in union.arms.clone() {
                flatten(this, nested, active, result)?;
            }
            active.remove(&union_id);
            Some(())
        }

        let mut normalized = Vec::new();
        for arm in arms {
            flatten(self, arm, &mut HashSet::new(), &mut normalized)?;
        }
        let mut arms = normalized;
        if arms.contains(&Type::Dyn) {
            return Some(vec![Type::Dyn]);
        }
        arms.sort_by_key(|a| format!("{a:?}"));
        arms.dedup();
        // `Derived | Base` denotes the base class: its nominal handle already
        // owns every subclass instance, so keep only the common ancestor.
        let objects = arms
            .iter()
            .filter_map(|arm| match arm {
                Type::Object { class_name } => Some(class_name.clone()),
                _ => None,
            })
            .collect::<Vec<_>>();
        if objects.len() > 1
            && let Some(base) = objects.iter().find(|base| {
                objects
                    .iter()
                    .all(|class| class == *base || self.classes.subclass(class, base))
            })
        {
            let base = base.clone();
            arms.retain(|arm| !matches!(arm, Type::Object { class_name } if *class_name != base));
        }
        if arms.len() == 1 {
            return Some(arms);
        }
        if arms.is_empty()
            || (arms.iter().any(|a| matches!(a, Type::Set { .. }))
                && (arms.iter().filter(|a| matches!(a, Type::Set { .. })).count() != 1
                    || arms.iter().any(|a| !matches!(a, Type::Set { .. } | Type::Null | Type::Undefined))))
            || (arms.iter().any(|a| matches!(a, Type::Map { .. }))
                && (arms.iter().filter(|a| matches!(a, Type::Map { .. })).count() != 1
                    || arms.iter().any(|a| !matches!(a, Type::Map { .. } | Type::Null | Type::Undefined))))
            // Different static Error views can alias the same object. Keep a
            // single object arm until cross-arm identity is part of the IR ABI.
            || arms.iter().filter(|a| matches!(a, Type::Object { .. })).count() > 1
            || (arms.contains(&Type::Stats)
                && arms.iter().any(|a| !matches!(a, Type::Stats | Type::Null | Type::Undefined)))
            || arms.iter().any(|a| matches!(a, Type::Void))
        {
            return None;
        }
        Some(arms)
    }

    pub(super) fn intern_union(&mut self, arms: Vec<Type>) -> Option<Type> {
        let arms = self.union_arms(arms)?;
        if arms.len() == 1 {
            return Some(arms[0].clone());
        }
        if let Some(union) = self.unions.iter().find(|u| u.arms == arms) {
            return Some(Type::Union { union_id: union.id });
        }
        let union_id = self.unions.len();
        self.unions.push(ir::Union { id: union_id, arms });
        Some(Type::Union { union_id })
    }

    pub(super) fn dynamic_erasure_reason(&self, ty: &Type) -> Option<&'static str> {
        // DataView uses a reserved record layout and a stable runtime record
        // tag, so ordinary record erasure preserves its native brand.
        if self.native_type_contains(ty, |ty| matches!(ty, Type::Object { class_name } if self.classes.has_symbol_surface(class_name))) {
            return Some("erasing symbol methods requires a native descriptor contract");
        }
        // A class instance that owns WeakMap/WeakSet state is erased as its
        // instance handle; only the collection value itself lacks a dynamic
        // descriptor contract.
        // An erased WeakMap keeps its native instance identity; dynamic
        // get/set/has/delete dispatch on that handle (emitter support).
        if self.native_value_contains(ty, classes::weak_sets::instance) {
            return Some("erasing WeakSet requires a native property descriptor contract");
        }
        if self.native_type_contains(ty, async_context::instance) {
            return Some(
                "erasing AsyncLocalStorage requires a native property descriptor contract",
            );
        }
        if self.contains_namespace(ty) {
            return Some(
                "erasing module namespaces requires a native namespace descriptor contract",
            );
        }
        None
    }

    pub(super) fn structural_callable_view_compatible(&self, source: &Type, target: &Type) -> bool {
        let (
            Type::Func {
                params: source_params,
                ret: source_ret,
                rest: source_rest,
            },
            Type::Func {
                params: target_params,
                ret: target_ret,
                rest: target_rest,
            },
        ) = (source, target)
        else {
            return false;
        };
        let accepts_undefined = |ty: &Type| match ty {
            Type::Dyn | Type::Undefined => true,
            Type::Union { union_id } => self.unions[*union_id]
                .arms
                .iter()
                .any(|arm| matches!(arm, Type::Undefined)),
            _ => false,
        };
        if source_rest != target_rest
            || (**source_ret == Type::Void
                && **target_ret != Type::Void
                && !accepts_undefined(target_ret))
        {
            return false;
        }
        if !source_rest
            && source_params.len() > target_params.len()
            && source_params[target_params.len()..]
                .iter()
                .any(|ty| *ty != Type::Dyn && !self.optional_storage(ty))
        {
            return false;
        }
        if *source_rest && source_params.len() != target_params.len() {
            return false;
        }
        let bridgeable = |ty: &Type| {
            self.dynamic_erasure_reason(ty).is_none()
                && !ir::contains_set(ty, &self.records, &self.unions)
                && *ty != Type::Void
        };
        let erased_record_views = source_params.len() == target_params.len()
            && source_params
                .iter()
                .zip(target_params)
                .all(|(source, target)| {
                    matches!((source, target), (Type::Record { .. }, Type::Record { .. }))
                        && bridgeable(source)
                        && bridgeable(target)
                });
        let parameters = source_params.iter().chain(target_params).all(bridgeable)
            && (source_params
                .iter()
                .zip(target_params)
                .all(|(source, target)| self.callable_parameter_accepts(source, target))
                || erased_record_views);
        let record_result_view = matches!(
            (source_ret.as_ref(), target_ret.as_ref()),
            (Type::Record { .. }, Type::Record { .. })
        ) && (ir::record_views::dynamic_view_pairs(
            source_ret,
            target_ret,
            &self.records,
            &self.unions,
        )
        .is_some()
            || self.contextual_result_compatible(source_ret, target_ret));
        parameters
            && (**target_ret == Type::Void
                || (**source_ret == Type::Void && accepts_undefined(target_ret))
                || record_result_view
                || [source_ret.as_ref(), target_ret.as_ref()]
                    .into_iter()
                    .all(bridgeable))
    }

    fn callable_parameter_accepts(&self, accepted: &Type, provided: &Type) -> bool {
        if accepted == provided || *accepted == Type::Dyn || *provided == Type::Dyn {
            return true;
        }
        if let Type::Union { union_id } = provided {
            return self.unions[*union_id]
                .arms
                .iter()
                .all(|arm| self.callable_parameter_accepts(accepted, arm));
        }
        if let Type::Union { union_id } = accepted {
            return self.unions[*union_id]
                .arms
                .iter()
                .any(|arm| self.contextual_result_compatible(provided, arm));
        }
        // Parameters are contravariant: a value emitted by the target call
        // site must fit the parameter accepted by the source implementation.
        self.contextual_result_compatible(provided, accepted)
            || ir::record_views::dynamic_view_pairs(provided, accepted, &self.records, &self.unions)
                .is_some()
            || (matches!(
                (provided, accepted),
                (Type::Array { .. }, Type::Array { .. })
            ) && !ir::contains_set(provided, &self.records, &self.unions)
                && !ir::contains_set(accepted, &self.records, &self.unions))
    }

    pub(super) fn live_container_view_compatible(&self, source: &Type, target: &Type) -> bool {
        if self.recursive_json_value_views(source, target) {
            return true;
        }
        if self.contextual_result_compatible(source, target)
            || ir::record_views::dynamic_view_pairs(source, target, &self.records, &self.unions)
                .is_some()
        {
            return true;
        }
        match (source, target) {
            (Type::Array { elem: source }, Type::Array { elem: target }) => {
                self.live_container_view_compatible(source, target)
            }
            (Type::Record { shape_id }, Type::Array { elem }) if self.records[*shape_id].tuple => {
                **elem == Type::Dyn
                    || self.records[*shape_id]
                        .fields
                        .iter()
                        .all(|field| self.live_container_view_compatible(&field.r#type, elem))
            }
            (source, Type::Union { union_id }) => self.unions[*union_id]
                .arms
                .iter()
                .any(|arm| self.live_container_view_compatible(source, arm)),
            (Type::Union { union_id }, target) => self.unions[*union_id]
                .arms
                .iter()
                .all(|arm| self.live_container_view_compatible(arm, target)),
            _ => false,
        }
    }

    pub(super) fn indexed_json_union_views(&self, source: &Type, target: &Type) -> bool {
        let pair = |ty: &Type| {
            let Type::Union { union_id } = ty else {
                return false;
            };
            let arms = &self.unions[*union_id].arms;
            arms.len() == 2
                && arms.iter().any(|arm| matches!(arm, Type::Array { .. }))
                && arms.iter().any(|arm| {
                    matches!(arm,
                    Type::Record { shape_id }
                        if self.records[*shape_id].fields.is_empty()
                            && self.records[*shape_id].index_value.is_some())
                })
                && arms.iter().all(|arm| {
                    self.dynamic_erasure_reason(arm).is_none()
                        && !ir::contains_set(arm, &self.records, &self.unions)
                })
        };
        pair(source) && pair(target)
    }

    fn recursive_json_value_union(&self, ty: &Type) -> bool {
        let Type::Union { union_id } = ty else {
            return false;
        };
        let arms = &self.unions[*union_id].arms;
        let mut array = false;
        let mut dictionary = false;
        let mut string = false;
        let mut number = false;
        let mut boolean = false;
        let mut null = false;
        for arm in arms {
            match arm {
                Type::String => string = true,
                Type::F64 => number = true,
                Type::Bool => boolean = true,
                Type::Null => null = true,
                Type::Array { elem } if matches!(elem.as_ref(), Type::Union { .. }) => array = true,
                Type::Record { shape_id }
                    if self.records[*shape_id].fields.is_empty()
                        && matches!(
                            self.records[*shape_id].index_value,
                            Some(Type::Union { .. })
                        ) =>
                {
                    dictionary = true;
                }
                _ => return false,
            }
        }
        array && dictionary && string && number && boolean && null
    }

    fn recursive_json_value_views(&self, source: &Type, target: &Type) -> bool {
        self.recursive_json_value_union(source) && self.recursive_json_value_union(target)
    }

    /// Dynamic observation must read the owning property rather than first
    /// projecting the checker-only field type, which can exclude live values.
    pub(super) fn raw_record_field(&self, value: &Expr, node: Node) -> Option<Expr> {
        let Expr::RecordGet { obj, field, .. } = value else {
            return None;
        };
        let Type::Record { shape_id } = obj.ty() else {
            return None;
        };
        if self.records.get(shape_id)?.tuple
            || field.starts_with('\0')
            || self.dynamic_erasure_reason(&value.ty()).is_some()
            || self.dynamic_erasure_reason(&obj.ty()).is_some()
        {
            return None;
        }
        let owner = self.coerce(obj.as_ref().clone(), Type::Dyn, node).ok()?;
        Some(self.dynamic_get(
            node,
            owner,
            Expr::StrLit {
                value: field.clone(),
                r#type: Type::String,
                loc: self.loc(node),
            },
        ))
    }

    /// Scalar checker projections do not change the owning runtime value.
    pub(super) fn raw_primitive_projection(&self, value: &Expr) -> Option<Expr> {
        match value {
            Expr::DynCheck { value: source, r#type, .. }
                if source.ty() == Type::Dyn
                    && matches!(r#type, Type::F64 | Type::String | Type::Bool | Type::Bigint | Type::Symbol) =>
            {
                Some(source.as_ref().clone())
            }
            _ => None,
        }
    }

    /// Observe the owning array slot before applying a typed view's element
    /// projection. Missing slots and values installed through aliases remain
    /// visible to JavaScript truthiness, typeof and other dynamic consumers.
    pub(super) fn raw_array_element(&self, value: &Expr, node: Node) -> Option<Expr> {
        let Expr::ArrayGet { arr, index, .. } = value else {
            return None;
        };
        if self.dynamic_erasure_reason(&arr.ty()).is_some()
            || self.dynamic_erasure_reason(&value.ty()).is_some()
        {
            return None;
        }
        let owner = self.coerce(arr.as_ref().clone(), Type::Dyn, node).ok()?;
        let key = self.coerce(index.as_ref().clone(), Type::Dyn, node).ok()?;
        Some(self.dynamic_get(node, owner, key))
    }

    pub(super) fn coerce(&self, value: Expr, target: Type, node: Node) -> Result<Expr, String> {
        let value = ir::normalize::scalar_round_trip(value, &target);
        if value.ty() == target {
            return Ok(value);
        }
        if let (Type::Promise { inner: source }, Type::Promise { inner: destination }) =
            (value.ty(), &target)
            && **destination == Type::Dyn
            && *source != **destination
            && self.dynamic_erasure_reason(source.as_ref()).is_none()
        {
            // Every native Promise already carries an owning NativeValue.
            // Retain the same handle and expose only the wider IR payload view.
            return Ok(Expr::Intrinsic {
                name: "promise.valueView".into(),
                args: vec![value],
                r#type: target,
                loc: self.loc(node),
            });
        }
        if parameter_abi::is_javascript(node)
            && let (
                Type::Record {
                    shape_id: source_id,
                },
                Type::Record {
                    shape_id: target_id,
                },
            ) = (value.ty(), &target)
            && self.callables.contains_key(&source_id)
            && !self.callables.contains_key(target_id)
        {
            // Object.assign's generic intersection may advertise [[Call]]
            // from a source even though the fresh target remains an ordinary
            // object. Both structural records can therefore share the same
            // owning property store through the dynamic boundary.
            let value = self.coerce(value, Type::Dyn, node)?;
            return self.coerce(value, target, node);
        }
        if self.indexed_json_union_views(&value.ty(), &target) {
            // This is one mutable JavaScript value with two recursive JSON
            // declaration views. Keep the owning tagged union; consumers
            // validate their narrower array/dictionary view at use sites.
            return Ok(value);
        }
        if let Type::Array { elem } = value.ty()
            && let Type::Generator {
                r#async: false,
                yield_type,
                return_type,
                next_type,
            } = &target
            && *elem == **yield_type
            && matches!(**return_type, Type::Void | Type::Undefined)
            && matches!(**next_type, Type::Void | Type::Undefined | Type::Dyn)
        {
            return Ok(Expr::LibCall {
                r#fn: "array.generator".into(),
                args: vec![value],
                r#type: target,
                loc: self.loc(node),
            });
        }
        if matches!(value.ty(), Type::Object { .. })
            && matches!(target, Type::Generator { r#async: false, .. })
            && self.dynamic_erasure_reason(&value.ty()).is_none()
        {
            // A JavaScript class can implement Iterator/IterableIterator with
            // an ordinary stateful `next()` method instead of `function*`.
            // Preserve the instance identity through NativeValue and let the
            // checked generator projection install the native protocol driver.
            let erased = Expr::DynFrom {
                value: Box::new(value),
                r#type: Type::Dyn,
                loc: self.loc(node),
            };
            return Ok(Expr::DynCheck {
                value: Box::new(erased),
                r#type: target,
                loc: self.loc(node),
            });
        }
        if let Expr::DynCheck {
            value: erased,
            r#type: Type::Union { union_id },
            loc,
        } = &value
            && erased.ty() == Type::Dyn
            && self.unions[*union_id].arms.contains(&target)
        {
            // The first check only materializes a tagged view of one erased
            // value. When the consumer requires one exact union arm, fuse the
            // checks so the runtime validates that arm directly instead of
            // asking for an unsound static union-to-arm coercion.
            return Ok(Expr::DynCheck {
                value: erased.clone(),
                r#type: target,
                loc: loc.clone(),
            });
        }
        if matches!(value.ty(), Type::Array { .. })
            && let Type::Union { union_id } = &target
        {
            let Type::Array {
                elem: source_element,
            } = value.ty()
            else {
                unreachable!()
            };
            let arrays = self.unions[*union_id]
                .arms
                .iter()
                .enumerate()
                .filter(|(_, arm)| {
                    let Type::Array {
                        elem: target_element,
                    } = arm
                    else {
                        return false;
                    };
                    self.live_container_view_compatible(&source_element, target_element)
                })
                .collect::<Vec<_>>();
            if let [(tag, array)] = arrays.as_slice() {
                let array = (**array).clone();
                let value = self.coerce(value, array, node)?;
                return Ok(Expr::UnionWrap {
                    union_id: format!("u{union_id}"),
                    tag: *tag,
                    value: Box::new(value),
                    r#type: target,
                    loc: self.loc(node),
                });
            }
        }
        if let (Type::Array { elem: source }, Type::Array { elem: destination }) =
            (value.ty(), &target)
            && source != *destination
            && self.live_container_view_compatible(&source, destination)
            && [source.as_ref(), destination.as_ref()]
                .into_iter()
                .all(|ty| {
                    *ty != Type::Void
                        && self.dynamic_erasure_reason(ty).is_none()
                        && !ir::contains_set(ty, &self.records, &self.unions)
                })
        {
            // Arrays are mutable and identity-bearing. Install a checked live
            // element view instead of copying elements when a declaration or
            // contextual call exposes a structurally compatible record ABI.
            // Reads validate the consumer view and writes validate the owner.
            return Ok(Expr::LibCall {
                r#fn: "array.view".into(),
                args: vec![value],
                r#type: target,
                loc: self.loc(node),
            });
        }
        if let (
            Type::Map {
                key: source_key,
                value: source_value,
            },
            Type::Map {
                key: target_key,
                value: target_value,
            },
        ) = (value.ty(), &target)
            && source_key == *target_key
            && source_value != *target_value
            && self.dynamic_erasure_reason(&source_value).is_none()
            && self.dynamic_erasure_reason(target_value).is_none()
        {
            return Ok(Expr::LibCall {
                r#fn: "map.valueView".into(),
                args: vec![value],
                r#type: target,
                loc: self.loc(node),
            });
        }
        if value.ty() == Type::Caught {
            if target == Type::Dyn {
                return Ok(Expr::CaughtToDyn {
                    value: Box::new(value),
                    r#type: Type::Dyn,
                    loc: self.loc(node),
                });
            }
            if let Type::Union { union_id } = &target {
                let candidates = self.unions[*union_id]
                    .arms
                    .iter()
                    .enumerate()
                    .filter(|(_, arm)| {
                        matches!(
                            arm,
                            Type::F64 | Type::String | Type::Bool | Type::Object { .. }
                        )
                    })
                    .collect::<Vec<_>>();
                if let [(tag, narrowed)] = candidates.as_slice()
                    && self.unions[*union_id].arms.iter().all(|arm| {
                        matches!(
                            arm,
                            Type::Null
                                | Type::Undefined
                                | Type::F64
                                | Type::String
                                | Type::Bool
                                | Type::Object { .. }
                        )
                    })
                {
                    let narrowed = (**narrowed).clone();
                    let value = Expr::CaughtNarrow {
                        value: Box::new(value),
                        r#type: narrowed,
                        loc: self.loc(node),
                    };
                    return Ok(Expr::UnionWrap {
                        union_id: format!("u{union_id}"),
                        tag: *tag,
                        value: Box::new(value),
                        r#type: target,
                        loc: self.loc(node),
                    });
                }
            }
            if matches!(
                target,
                Type::F64 | Type::String | Type::Bool | Type::Object { .. }
            ) {
                return Ok(Expr::CaughtNarrow {
                    value: Box::new(value),
                    r#type: target,
                    loc: self.loc(node),
                });
            }
            if target == Type::Symbol {
                let value = Expr::CaughtToDyn {
                    value: Box::new(value),
                    r#type: Type::Dyn,
                    loc: self.loc(node),
                };
                return self.coerce(value, target, node);
            }
        }
        if let Type::Record { shape_id } = value.ty()
            && let Some(source) = self.callables.get(&shape_id).cloned()
            && let Type::Union { union_id } = target
        {
            let callable = self.unions[union_id]
                .arms
                .iter()
                .filter(|arm| matches!(arm, Type::Func { .. }))
                .cloned()
                .collect::<Vec<_>>();
            if let [destination] = callable.as_slice()
                && self.unions[union_id]
                    .arms
                    .iter()
                    .all(|arm| matches!(arm, Type::Func { .. } | Type::Null | Type::Undefined))
                && (source == *destination
                    || ir::callable_view_compatible(&source, destination)
                    || self.structural_callable_view_compatible(&source, destination))
            {
                let function = Expr::RecordGet {
                    obj: Box::new(value),
                    shape_id: format!("r{shape_id}"),
                    field: callables::CALL_FIELD.into(),
                    r#type: source,
                    loc: self.loc(node),
                };
                let function = self.coerce(function, destination.clone(), node)?;
                return self.coerce(function, target, node);
            }
        }
        if target == Type::Void
            || (matches!(value.ty(), Type::Void | Type::Undefined) && target == Type::Undefined)
        {
            let loc = self.loc(node);
            let unit = Expr::UnitLit {
                unit: if target == Type::Void {
                    "void"
                } else {
                    "undefined"
                },
                r#type: target.clone(),
                loc: loc.clone(),
            };
            if matches!(value, Expr::UnitLit { .. }) {
                return Ok(unit);
            }
            return Ok(Expr::Sequence {
                stmts: vec![Stmt::Expression {
                    expr: value,
                    loc: loc.clone(),
                }],
                result: Box::new(unit),
                r#type: target,
                loc,
            });
        }
        if target == Type::Void && node.kind() == SyntaxKind::YieldExpression {
            let loc = self.loc(node);
            return Ok(Expr::Sequence {
                stmts: vec![Stmt::Expression {
                    expr: value,
                    loc: loc.clone(),
                }],
                result: Box::new(Expr::UnitLit {
                    unit: "void",
                    r#type: Type::Void,
                    loc: loc.clone(),
                }),
                r#type: Type::Void,
                loc,
            });
        }
        if ir::callable_view_compatible(&value.ty(), &target)
            || self.structural_callable_view_compatible(&value.ty(), &target)
        {
            // Preserve the function object through the dynamic owning value;
            // the checked view shares its properties and native call target.
            let value = if self.dynamic_erasure_reason(&value.ty())
                == Some("erasing symbol methods requires a native descriptor contract")
            {
                // A proven forwarding view boxes arguments and checks the
                // result at every call. Symbol-bearing records nested in that
                // callable ABI remain typed payload contracts; they are not
                // exposed as dynamically dispatched symbol methods merely by
                // preserving the function object's identity.
                Expr::LibCall {
                    r#fn: "callable.opaqueViewSource".into(),
                    args: vec![value],
                    r#type: Type::Dyn,
                    loc: self.loc(node),
                }
            } else {
                self.coerce(value, Type::Dyn, node)?
            };
            return self.coerce(value, target, node);
        }
        // DataView records carry a dedicated runtime record tag.  The normal
        // record boxing/checking path therefore preserves their brand across
        // dynamic boundaries instead of treating them as structural objects.
        // Unit payloads have no stored fields, but their producing expressions
        // can still evaluate conditions, reads and calls. Lift their control
        // flow before boxing a unit or constructing a payload-free union arm.
        let value = if matches!(value.ty(), Type::Null | Type::Undefined)
            && !matches!(value, Expr::UnitLit { .. })
        {
            match value {
                Expr::Ternary {
                    cond,
                    then,
                    else_,
                    loc,
                    ..
                } => {
                    return Ok(Expr::Ternary {
                        cond,
                        then: Box::new(self.coerce(*then, target.clone(), node)?),
                        else_: Box::new(self.coerce(*else_, target.clone(), node)?),
                        r#type: target,
                        loc,
                    });
                }
                Expr::Sequence {
                    stmts, result, loc, ..
                } => {
                    return Ok(Expr::Sequence {
                        stmts,
                        result: Box::new(self.coerce(*result, target.clone(), node)?),
                        r#type: target,
                        loc,
                    });
                }
                value if target != Type::Dyn => {
                    let unit = Expr::UnitLit {
                        unit: if value.ty() == Type::Null {
                            "null"
                        } else {
                            "undefined"
                        },
                        r#type: value.ty(),
                        loc: self.loc(node),
                    };
                    return Ok(Expr::Sequence {
                        stmts: vec![Stmt::Expression {
                            expr: self.coerce(value, Type::Dyn, node)?,
                            loc: self.loc(node),
                        }],
                        result: Box::new(self.coerce(unit, target.clone(), node)?),
                        r#type: target,
                        loc: self.loc(node),
                    });
                }
                value => value,
            }
        } else {
            value
        };
        if let Type::Union { union_id } = value.ty()
            && matches!(target, Type::Promise { .. })
        {
            let present = self.unions[union_id]
                .arms
                .iter()
                .enumerate()
                .filter(|(_, arm)| !matches!(arm, Type::Null | Type::Undefined))
                .collect::<Vec<_>>();
            if let [(tag, source @ Type::Promise { .. })] = present.as_slice() {
                // A captured promise slot can lose its compile-time presence
                // fact after arbitrary calls even though the public callback
                // contract asserts that it is initialized. Keep the runtime
                // union check, then install the ordinary identity-preserving
                // promise payload view (including Dyn -> void discard).
                let value = Expr::UnionNarrow {
                    union_id: format!("u{union_id}"),
                    tag: *tag,
                    value: Box::new(value),
                    r#type: (*source).clone(),
                    loc: self.loc(node),
                };
                return self.coerce(value, target, node);
            }
        }
        if matches!(value.ty(), Type::Promise { .. }) && matches!(target, Type::Promise { .. }) {
            let value = self.coerce(value, Type::Dyn, node)?;
            return self.coerce(value, target, node);
        }
        if target == Type::Dyn {
            if node.kind() == SyntaxKind::NonNullExpression
                && let Expr::UnionNarrow { value: source, .. } = &value
                && let Some(raw) = self
                    .raw_array_element(source, node)
                    .or_else(|| self.raw_record_field(source, node))
            {
                // The assertion only changes the checker view; retrieve the
                // owning slot or field before its potentially invalid projection.
                return Ok(raw);
            }
            if let Expr::DynCheck {
                value: source,
                r#type,
                ..
            } = &value
                && matches!(
                    r#type,
                    Type::F64 | Type::String | Type::Bool | Type::Bigint | Type::Symbol
                )
            {
                // Scalar checker projections do not change the JS value.
                // Container and generator checks can install real native
                // adapters, which must survive the subsequent erasure.
                return Ok(source.as_ref().clone());
            }
            if let Some(raw) = self.raw_record_field(&value, node) {
                return Ok(raw);
            }
            if let Some(raw) = self.raw_array_element(&value, node) {
                return Ok(raw);
            }
            if value.ty() == Type::Void {
                // A call with a void ABI still evaluates in argument position
                // and contributes the JavaScript undefined value.
                let undefined = self.coerce(
                    Expr::UnitLit {
                        unit: "undefined",
                        r#type: Type::Undefined,
                        loc: self.loc(node),
                    },
                    Type::Dyn,
                    node,
                )?;
                return Ok(Expr::Sequence {
                    stmts: vec![Stmt::Expression {
                        expr: value,
                        loc: self.loc(node),
                    }],
                    result: Box::new(undefined),
                    r#type: Type::Dyn,
                    loc: self.loc(node),
                });
            }
            if let Some(reason) = self.dynamic_erasure_reason(&value.ty()) {
                return Err(self.refuse(
                    node,
                    &format!(
                        "{reason}: native type {:?}; symbol surface {}",
                        value.ty(),
                        match value.ty() {
                            Type::Object { ref class_name } =>
                                self.classes.symbol_surface_debug(class_name),
                            _ => String::new(),
                        }
                    ),
                ));
            }
            return Ok(Expr::DynFrom {
                value: Box::new(value),
                r#type: Type::Dyn,
                loc: self.loc(node),
            });
        }
        if value.ty() == Type::Dyn && !matches!(target, Type::Null | Type::Undefined | Type::Void) {
            return Ok(Expr::DynCheck {
                value: Box::new(value),
                r#type: target,
                loc: self.loc(node),
            });
        }
        if node.kind() == SyntaxKind::Identifier
            && matches!(
                target,
                Type::F64 | Type::Bigint | Type::String | Type::Bool | Type::Symbol
            )
            && matches!(
                value.ty(),
                Type::Record { .. } | Type::Object { .. } | Type::Union { .. }
            )
        {
            // Flow-sensitive JS checks such as `typeof value === "string"`
            // may project a primitive view from a cell whose closed-world
            // callers currently populate only with object arms. Preserve the
            // owning value and perform the checked primitive view in the
            // guarded branch; this is not an object-to-primitive coercion.
            if let Some(reason) = self.dynamic_erasure_reason(&value.ty()) {
                return Err(self.refuse(node, reason));
            }
            let value = Expr::DynFrom {
                value: Box::new(value),
                r#type: Type::Dyn,
                loc: self.loc(node),
            };
            return Ok(Expr::DynCheck {
                value: Box::new(value),
                r#type: target,
                loc: self.loc(node),
            });
        }
        if let (
            Type::Union { union_id: source },
            Type::Union {
                union_id: destination,
            },
        ) = (value.ty(), &target)
        {
            let destination_arrays = self.unions[*destination]
                .arms
                .iter()
                .filter_map(|arm| match arm {
                    Type::Array { elem } => Some(elem.as_ref()),
                    _ => None,
                })
                .collect::<Vec<_>>();
            let mut needs_array_view = false;
            let preserves_all_arms = self.unions[source].arms.iter().all(|arm| {
                if self.unions[*destination].arms.contains(arm) {
                    return true;
                }
                let (Type::Array { elem }, [target_elem]) = (arm, destination_arrays.as_slice()) else {
                    return false;
                };
                let Type::Union { union_id } = target_elem else {
                    return false;
                };
                let compatible = self.unions[*union_id].arms.contains(elem.as_ref());
                needs_array_view |= compatible;
                compatible
            });
            if preserves_all_arms
                && needs_array_view
                && self.dynamic_erasure_reason(&value.ty()).is_none()
                && self.dynamic_erasure_reason(&target).is_none()
            {
                // A union may widen an array's element view as well as its
                // outer tag. Preserve every live arm and the array owner;
                // narrowing to the sole exactly shared scalar arm would fail
                // whenever the array arm is active.
                let value = self.coerce(value, Type::Dyn, node)?;
                return self.coerce(value, target, node);
            }
            let common = self.unions[source]
                .arms
                .iter()
                .enumerate()
                .filter_map(|(source_tag, arm)| {
                    self.unions[*destination]
                        .arms
                        .iter()
                        .position(|target| target == arm)
                        .map(|target_tag| (source_tag, target_tag, arm.clone()))
                })
                .collect::<Vec<_>>();
            if let [(source_tag, target_tag, arm)] = common.as_slice() {
                // A contextual ABI may retain one valid arm while adding an
                // absence tag (for example Number|BigInt -> Number|undefined).
                // Check the live source tag, then re-tag the same payload in
                // the consumer union instead of coercing or copying it.
                let narrowed = Expr::UnionNarrow {
                    union_id: format!("u{source}"),
                    tag: *source_tag,
                    value: Box::new(value),
                    r#type: arm.clone(),
                    loc: self.loc(node),
                };
                return Ok(Expr::UnionWrap {
                    union_id: format!("u{destination}"),
                    tag: *target_tag,
                    value: Box::new(narrowed),
                    r#type: target,
                    loc: self.loc(node),
                });
            }
            if !common.is_empty()
                && self.dynamic_erasure_reason(&value.ty()).is_none()
                && self.dynamic_erasure_reason(&target).is_none()
            {
                // Flow analysis can project one of several shared arms while
                // the owning local deliberately retains a wider tagged ABI.
                // Route that identity through NativeValue and check the
                // consumer union at runtime; invalid non-shared arms fail
                // instead of being silently retagged.
                let value = self.coerce(value, Type::Dyn, node)?;
                return self.coerce(value, target, node);
            }
        }
        if let (
            Type::Union { union_id: source },
            Type::Union {
                union_id: destination,
            },
        ) = (value.ty(), &target)
            && self.unions[source]
                .arms
                .iter()
                .all(|arm| self.unions[*destination].arms.contains(arm))
            && self.dynamic_erasure_reason(&value.ty()).is_none()
            && self.dynamic_erasure_reason(&target).is_none()
        {
            // Widening a union changes its tag layout, not the active value.
            // The owning dynamic bridge preserves arrays and records as well
            // as primitives; unsafe branded/callable erasures are rejected by
            // the guards above.
            let value = self.coerce(value, Type::Dyn, node)?;
            return self.coerce(value, target, node);
        }
        if let Type::Record { shape_id } = value.ty()
            && let Some(callable) = self.callables.get(&shape_id).cloned()
            && (callable == target || ir::callable_view_compatible(&callable, &target))
        {
            let value = Expr::RecordGet {
                obj: Box::new(value),
                shape_id: format!("r{shape_id}"),
                field: callables::CALL_FIELD.into(),
                r#type: callable.clone(),
                loc: self.loc(node),
            };
            return if callable == target {
                Ok(value)
            } else {
                self.coerce(value, target, node)
            };
        }
        if let Type::Record { shape_id } = &target
            && let Some(callable) = self.callables.get(shape_id).cloned()
            && (callable == value.ty()
                || ir::callable_view_compatible(&value.ty(), &callable)
                || self.structural_callable_view_compatible(&value.ty(), &callable)
                || matches!(value.ty(), Type::Classval { .. }))
        {
            let value = if matches!(value.ty(), Type::Classval { .. }) || value.ty() == callable {
                value
            } else {
                self.coerce(value, callable, node)?
            };
            return Ok(Expr::LibCall {
                r#fn: "callable.view".into(),
                args: vec![value],
                r#type: target,
                loc: self.loc(node),
            });
        }
        let object_assign = node.kind() == SyntaxKind::CallExpression && {
            let callee = node.expression();
            callee.kind() == SyntaxKind::PropertyAccessExpression
                && callee.name().text() == "assign"
                && callee.expression().kind() == SyntaxKind::Identifier
                && callee.expression().text() == "Object"
        };
        if object_assign
            && matches!(value.ty(), Type::Record { .. })
            && matches!(target, Type::Record { .. })
        {
            // Object.assign can widen the live own-key set of its target.
            // Preserve that target identity through the shared dynamic store
            // and install the consumer's checked record view over it.
            let value = self.coerce(value, Type::Dyn, node)?;
            return self.coerce(value, target, node);
        }
        let plain_record = |ty: &Type| {
            let Type::Record { shape_id } = ty else {
                return false;
            };
            let record = &self.records[*shape_id];
            !record.tuple
                && !record
                    .fields
                    .iter()
                    .any(|field| field.name == callables::CALL_FIELD)
        };
        if plain_record(&value.ty())
            && let Type::Union { union_id } = &target
        {
            let records = self.unions[*union_id]
                .arms
                .iter()
                .enumerate()
                .filter(|(_, arm)| {
                    plain_record(arm)
                        && (ir::record_equivalence::equivalent(
                            &value.ty(),
                            arm,
                            &self.records,
                            &self.unions,
                        ) || ir::record_views::view_pairs(
                            &value.ty(),
                            arm,
                            &self.records,
                            &self.unions,
                        )
                        .is_some()
                            || ir::record_views::dynamic_view_pairs(
                                &value.ty(),
                                arm,
                                &self.records,
                                &self.unions,
                            )
                            .is_some())
                })
                .map(|(tag, arm)| (tag, arm.clone()))
                .collect::<Vec<_>>();
            if let [(tag, record)] = records.as_slice()
                && self.unions[*union_id].arms.iter().all(|arm| {
                    plain_record(arm)
                        || matches!(
                            arm,
                            Type::Null
                                | Type::Undefined
                                | Type::String
                                | Type::F64
                                | Type::Bool
                                | Type::Bigint
                                | Type::Array { .. }
                        )
                })
            {
                let value = self.coerce(value, record.clone(), node)?;
                return Ok(Expr::UnionWrap {
                    union_id: format!("u{union_id}"),
                    tag: *tag,
                    value: Box::new(value),
                    r#type: target,
                    loc: self.loc(node),
                });
            }
        }
        if plain_record(&value.ty())
            && let Type::Union { union_id } = &target
            && let Type::Record {
                shape_id: source_id,
            } = value.ty()
        {
            let source_record = &self.records[source_id];
            let records = self.unions[*union_id]
                .arms
                .iter()
                .enumerate()
                .filter(|(_, arm)| {
                    let Type::Record { shape_id } = arm else {
                        return false;
                    };
                    let record = &self.records[*shape_id];
                    let indexed_view = source_record.fields.is_empty()
                        && match (&source_record.index_value, &record.index_value) {
                            (Some(Type::Dyn), Some(target)) => {
                                self.dynamic_erasure_reason(target).is_none()
                                    && !ir::contains_set(target, &self.records, &self.unions)
                            }
                            (Some(source), Some(target)) => ir::record_equivalence::equivalent(
                                source,
                                target,
                                &self.records,
                                &self.unions,
                            ),
                            _ => false,
                        };
                    !record.tuple
                        && !self.callables.contains_key(shape_id)
                        && !self.enum_shape(*shape_id)
                        && (record.index_value.is_none() && record.fields.is_empty()
                            || indexed_view)
                })
                .map(|(tag, arm)| (tag, arm.clone()))
                .collect::<Vec<_>>();
            if let [(tag, record)] = records.as_slice()
                && self.unions[*union_id]
                    .arms
                    .iter()
                    .all(|arm| plain_record(arm) || matches!(arm, Type::Null | Type::Undefined))
                && self.dynamic_erasure_reason(&value.ty()).is_none()
            {
                // A declaration can expose an opaque empty options object or
                // an independently materialized but equivalent dictionary.
                // Both views share the same own-key store; indexed views stay
                // invariant through coinductive element-layout equality.
                let value = self.coerce(value, Type::Dyn, node)?;
                let value = self.coerce(value, record.clone(), node)?;
                return Ok(Expr::UnionWrap {
                    union_id: format!("u{union_id}"),
                    tag: *tag,
                    value: Box::new(value),
                    r#type: target,
                    loc: self.loc(node),
                });
            }
        }
        if parameter_abi::is_javascript(node)
            && plain_record(&value.ty())
            && plain_record(&target)
            && self.dynamic_erasure_reason(&value.ty()).is_none()
            && self.dynamic_erasure_reason(&target).is_none()
        {
            // A checked .d.ts facade can demand a wider structural record than
            // its JavaScript implementation constructs. Keep the same own-key
            // store and install a lazy checked view: represented fields retain
            // identity, erased fields are checked when read, and a genuinely
            // absent required field still throws at that typed read boundary.
            let value = self.coerce(value, Type::Dyn, node)?;
            return self.coerce(value, target, node);
        }
        if parameter_abi::is_javascript(node)
            && plain_record(&value.ty())
            && let Type::Union { union_id } = &target
        {
            let records = self.unions[*union_id]
                .arms
                .iter()
                .enumerate()
                .filter(|(_, arm)| plain_record(arm))
                .map(|(tag, arm)| (tag, arm.clone()))
                .collect::<Vec<_>>();
            if let [(tag, record)] = records.as_slice()
                && self.unions[*union_id].arms.iter().all(|arm| {
                    plain_record(arm)
                        || matches!(
                            arm,
                            Type::Bool
                                | Type::F64
                                | Type::String
                                | Type::Bigint
                                | Type::Symbol
                                | Type::Null
                                | Type::Undefined
                        )
                })
            {
                // A record has a disjoint runtime category from every scalar
                // arm. A single structural record candidate is therefore an
                // unambiguous tag even for public unions such as
                // `VNode | string | number | boolean | null | undefined`.
                let value = self.coerce(value, record.clone(), node)?;
                return Ok(Expr::UnionWrap {
                    union_id: format!("u{union_id}"),
                    tag: *tag,
                    value: Box::new(value),
                    r#type: target,
                    loc: self.loc(node),
                });
            }
        }
        if let (Type::Object { class_name: child }, Type::Object { class_name: parent }) =
            (value.ty(), &target)
            && self.classes.subclass(&child, parent)
        {
            return Ok(Expr::Upcast {
                value: Box::new(value),
                r#type: target,
                loc: self.loc(node),
            });
        }
        if let Type::Union { union_id } = value.ty()
            && let Some(tag) = self.unions[union_id]
                .arms
                .iter()
                .position(|arm| *arm == target)
            && !matches!(target, Type::Null | Type::Undefined | Type::Void)
        {
            // A consumer can carry a stronger flow view than the JavaScript
            // implementation signature, especially for inferred calls in
            // emitted packages. Keep the owning tagged value and check the
            // selected ABI arm at the boundary instead of dropping optional
            // tags or inventing a container conversion.
            return Ok(Expr::UnionNarrow {
                union_id: format!("u{union_id}"),
                tag,
                value: Box::new(value),
                r#type: target,
                loc: self.loc(node),
            });
        }
        if let Type::Union { union_id } = value.ty() {
            let candidates = self.unions[union_id]
                .arms
                .iter()
                .enumerate()
                .filter(|(_, arm)| {
                    !matches!(arm, Type::Null | Type::Undefined)
                        && ir::record_views::dynamic_view_pairs(
                            arm,
                            &target,
                            &self.records,
                            &self.unions,
                        )
                        .is_some()
                })
                .map(|(tag, arm)| (tag, arm.clone()))
                .collect::<Vec<_>>();
            // An explicit `value as T` assertion names the only arm the
            // program relies on. Select that arm with a checked narrow; a
            // type-unsound program fails at the assertion instead of later.
            let asserted = {
                let mut parent = node.parent();
                while parent.kind() == SyntaxKind::ParenthesizedExpression {
                    parent = parent.parent();
                }
                matches!(
                    parent.kind(),
                    SyntaxKind::AsExpression | SyntaxKind::TypeAssertionExpression
                )
            };
            // When the destination union still represents every nullish arm of
            // the source, nothing proved those arms absent: narrowing would
            // abort on a live null. Convert through the owning dynamic value,
            // which checks the actual arm against the destination.
            let target_keeps_nullish = !asserted
                && matches!(&target, Type::Union { union_id: target_union }
                    if self.unions[union_id].arms.iter()
                        .filter(|arm| matches!(arm, Type::Null | Type::Undefined))
                        .all(|arm| self.unions[*target_union].arms.contains(arm))
                        && self.unions[union_id].arms.iter()
                            .any(|arm| matches!(arm, Type::Null | Type::Undefined)));
            if target_keeps_nullish && candidates.len() == 1 && self.dynamic_erasure_reason(&value.ty()).is_none() {
                let dynamic = self.coerce(value, Type::Dyn, node)?;
                return self.coerce(dynamic, target, node);
            }
            if let [(tag, arm)] = candidates.as_slice()
                && (asserted
                    || self.unions[union_id].arms.iter().all(|candidate| {
                        candidate == arm || matches!(candidate, Type::Null | Type::Undefined)
                    }))
            {
                // Flow narrowing and the non-null assertion can retain a
                // source record tag whose structural destination is another
                // recursive view. First remove the nullish union tag, then
                // install the ordinary shared-record view without copying.
                let narrowed = Expr::UnionNarrow {
                    union_id: format!("u{union_id}"),
                    tag: *tag,
                    value: Box::new(value),
                    r#type: arm.clone(),
                    loc: self.loc(node),
                };
                return self.coerce(narrowed, target, node);
            }
        }
        if matches!(value.ty(), Type::Func { .. })
            && let Type::Union { union_id } = &target
        {
            let candidates = self.unions[*union_id]
                .arms
                .iter()
                .enumerate()
                .filter(|(_, arm)| {
                    ir::callable_view_compatible(&value.ty(), arm)
                        || self.structural_callable_view_compatible(&value.ty(), arm)
                })
                .collect::<Vec<_>>();
            if let [(tag, callable)] = candidates.as_slice()
                && self.unions[*union_id]
                    .arms
                    .iter()
                    .all(|arm| {
                        matches!(
                            arm,
                            Type::Func { .. }
                                | Type::Bool
                                | Type::F64
                                | Type::String
                                | Type::Bigint
                                | Type::Symbol
                                | Type::Null
                                | Type::Undefined
                        ) || matches!(arm, Type::Record { shape_id } if !self.callables.contains_key(shape_id))
                    })
            {
                // A statically callable value selects the unique compatible
                // function arm even when the public API also accepts a plain
                // record (for example Component | VNode). Plain records and
                // scalars are disjoint from the callable runtime brand; a
                // callable record remains excluded to avoid an ambiguous view.
                let value = self.coerce(value, (*callable).clone(), node)?;
                return Ok(Expr::UnionWrap {
                    union_id: format!("u{union_id}"),
                    tag: *tag,
                    value: Box::new(value),
                    r#type: target,
                    loc: self.loc(node),
                });
            }
        }
        if let Type::Promise { inner: source } = value.ty()
            && let Type::Union { union_id } = &target
        {
            let candidates = self.unions[*union_id]
                .arms
                .iter()
                .enumerate()
                .filter(|(_, arm)| matches!(arm, Type::Promise { .. } if *source != Type::Void))
                .collect::<Vec<_>>();
            if let [(tag, promise)] = candidates.as_slice() {
                let value = self.coerce(value, (*promise).clone(), node)?;
                return Ok(Expr::UnionWrap {
                    union_id: format!("u{union_id}"),
                    tag: *tag,
                    value: Box::new(value),
                    r#type: target,
                    loc: self.loc(node),
                });
            }
        }
        if let Type::Union { union_id } = target
            && let Some(tag) = self.unions[union_id]
                .arms
                .iter()
                .position(|a| *a == value.ty())
        {
            return Ok(Expr::UnionWrap {
                union_id: format!("u{union_id}"),
                tag,
                value: Box::new(value),
                r#type: target,
                loc: self.loc(node),
            });
        }
        if let Type::Union { union_id } = target
            && let Type::Object { class_name: child } = value.ty()
        {
            let candidates = self.unions[union_id].arms.iter().enumerate().filter(|(_, arm)| matches!(arm, Type::Object { class_name: parent } if self.classes.subclass(&child, parent))).collect::<Vec<_>>();
            if let [(tag, arm)] = candidates.as_slice() {
                let value = self.coerce(value, (*arm).clone(), node)?;
                return Ok(Expr::UnionWrap {
                    union_id: format!("u{union_id}"),
                    tag: *tag,
                    value: Box::new(value),
                    r#type: target,
                    loc: self.loc(node),
                });
            }
        }
        if let (
            Type::Record {
                shape_id: source_id,
            },
            Type::Array { elem: _ },
        ) = (value.ty(), &target)
            && self.records[source_id].tuple
        {
            let dynamic = Type::Array {
                elem: Box::new(Type::Dyn),
            };
            let value = self.coerce(value, Type::Dyn, node)?;
            let value = self.coerce(value, dynamic.clone(), node)?;
            return if target == dynamic {
                Ok(value)
            } else {
                self.coerce(value, target, node)
            };
        }
        if ir::record_views::view_pairs(&value.ty(), &target, &self.records, &self.unions).is_some()
        {
            return Ok(Expr::LibCall {
                r#fn: "record.view".into(),
                args: vec![value],
                r#type: target,
                loc: self.loc(node),
            });
        }
        if ir::record_views::dynamic_view_pairs(&value.ty(), &target, &self.records, &self.unions)
            .is_some()
        {
            // Checked structural views may also select one record arm of a
            // wider union. The runtime keeps the same property store, checks
            // narrowed fields on access, and wraps the selected target arm
            // without erasing the record through Dyn.
            return Ok(Expr::LibCall {
                r#fn: "record.checkedView".into(),
                args: vec![value],
                r#type: target,
                loc: self.loc(node),
            });
        }
        if let (
            Type::Record {
                shape_id: source_id,
            },
            Type::Record {
                shape_id: target_id,
            },
        ) = (value.ty(), &target)
        {
            let source = self.records[source_id].clone();
            let destination = self.records[*target_id].clone();
            let plain = !source.tuple
                && !destination.tuple
                && source.index_value.is_none()
                && destination.index_value.is_none()
                && !source
                    .fields
                    .iter()
                    .any(|field| field.name == callables::CALL_FIELD)
                && !destination
                    .fields
                    .iter()
                    .any(|field| field.name == callables::CALL_FIELD);
            let optional = |ty: &Type| {
                matches!(ty, Type::Dyn | Type::Undefined)
                    || matches!(ty, Type::Union { union_id } if self.unions[*union_id].arms.contains(&Type::Undefined))
            };
            if plain
                && destination.fields.iter().all(|field| {
                    source.fields.iter().any(|old| old.name == field.name)
                        || optional(&field.r#type)
                })
            {
                if ir::record_views::dynamic_view_pairs(
                    &value.ty(),
                    &target,
                    &self.records,
                    &self.unions,
                )
                .is_some()
                {
                    // TypeScript permits a required source property to flow
                    // into an optional destination slot. Keep one backing
                    // object and check reads through either typed view rather
                    // than copying the record or changing its identity. Fresh
                    // record expressions use the same shared property store as
                    // locals and field reads, so they can enter this view
                    // directly as contextual array/spread elements too.
                    return Ok(Expr::LibCall {
                        r#fn: "record.checkedView".into(),
                        args: vec![value],
                        r#type: target,
                        loc: self.loc(node),
                    });
                }
                return Err(self.refuse(
                    node,
                    &format!(
                        "record representation conversion requires an identity-preserving shared view: {} -> {}",
                        self.contextual_type_description(&value.ty()),
                        self.contextual_type_description(&target)
                    ),
                ));
            }
        }
        let describe = |ty: &Type| {
            if let Type::Union { union_id } = ty
                && let Some(union) = self.unions.get(*union_id)
            {
                let arms = union
                    .arms
                    .iter()
                    .take(8)
                    .map(|arm| match arm {
                        Type::Record { shape_id } => self
                            .records
                            .get(*shape_id)
                            .map(|shape| {
                                let fields = shape
                                    .fields
                                    .iter()
                                    .take(8)
                                    .map(|field| format!("{}: {:?}", field.name, field.r#type))
                                    .collect::<Vec<_>>()
                                    .join(", ");
                                format!(
                                    "record r{shape_id} [tuple={}, index={:?}, callable={}] {{{fields}{}}}",
                                    shape.tuple,
                                    shape.index_value,
                                    self.callables.contains_key(shape_id),
                                    if shape.fields.len() > 8 { ", ..." } else { "" }
                                )
                            })
                            .unwrap_or_else(|| format!("{arm:?}")),
                        Type::Object { class_name } => {
                            format!("object {}", self.classes.describe(class_name))
                        }
                        _ => format!("{arm:?}"),
                    })
                    .collect::<Vec<_>>()
                    .join(", ");
                return format!(
                    "union u{union_id} [{arms}{}]",
                    if union.arms.len() > 8 { ", ..." } else { "" }
                );
            }
            if let Type::Record { shape_id } = ty
                && let Some(shape) = self.records.get(*shape_id)
            {
                let fields = shape
                    .fields
                    .iter()
                    .take(8)
                    .map(|field| format!("{}: {:?}", field.name, field.r#type))
                    .collect::<Vec<_>>()
                    .join(", ");
                return format!(
                    "record r{shape_id} [tuple={}, index={}, callable={}] {{{fields}{}}}",
                    shape.tuple,
                    shape.index_value.as_ref().map_or_else(
                        || "none".into(),
                        |index| self.contextual_type_description(index),
                    ),
                    self.callables.contains_key(shape_id),
                    if shape.fields.len() > 8 { ", ..." } else { "" }
                );
            }
            if let Type::Object { class_name } = ty {
                return format!("object {}", self.classes.describe(class_name));
            }
            format!("{ty:?}")
        };
        let record_delta = match (value.ty(), &target) {
            (
                Type::Record {
                    shape_id: source_id,
                },
                Type::Record {
                    shape_id: target_id,
                },
            ) => self
                .records
                .get(source_id)
                .zip(self.records.get(*target_id))
                .map(|(source, target)| {
                    let mut changes = Vec::new();
                    for field in &target.fields {
                        match source.fields.iter().find(|old| old.name == field.name) {
                            Some(old) if old.r#type != field.r#type => changes.push(format!(
                                "{}: {:?} -> {:?}",
                                field.name, old.r#type, field.r#type
                            )),
                            None => changes
                                .push(format!("{}: <absent> -> {:?}", field.name, field.r#type)),
                            _ => {}
                        }
                    }
                    for field in &source.fields {
                        if !target.fields.iter().any(|new| new.name == field.name) {
                            changes.push(format!("{}: {:?} -> <absent>", field.name, field.r#type));
                        }
                    }
                    (!changes.is_empty())
                        .then(|| format!("; field changes: {}", changes.join(", ")))
                })
                .flatten()
                .unwrap_or_default(),
            _ => String::new(),
        };
        let identifier = (node.kind() == SyntaxKind::Identifier)
            .then(|| format!("; identifier: {}", node.text()))
            .unwrap_or_default();
        let property_context = (node.kind() == SyntaxKind::PropertyAccessExpression)
            .then(|| {
                let parent = node.parent();
                let grandparent = parent.parent();
                let condition = (grandparent.kind() == SyntaxKind::ConditionalExpression)
                    .then(|| grandparent.condition());
                let condition_detail = condition.map(|value| {
                    (
                        value.kind(),
                        value.text().to_string(),
                        (value.kind() == SyntaxKind::PropertyAccessExpression)
                            .then(|| value.name().text().to_string()),
                        (value.kind() == SyntaxKind::PropertyAccessExpression)
                            .then(|| {
                                (
                                    value.expression().kind(),
                                    value.expression().text().to_string(),
                                )
                            }),
                    )
                });
                format!(
                    "; property: {}; receiver: {:?}/{:?}; parent: {:?}; grandparent: {:?}; branch is true: {}; condition: {:?}",
                    node.name().text(),
                    node.expression().kind(),
                    node.expression().text(),
                    parent.kind(),
                    grandparent.kind(),
                    grandparent.kind() == SyntaxKind::ConditionalExpression
                        && grandparent.when_true() == parent,
                    condition_detail,
                )
            })
            .unwrap_or_default();
        // A plain record entering a union of plain records: when exactly one
        // arm declares every source field and every other arm field accepts
        // undefined, that arm is the only representable shape. Convert through
        // the owning dynamic value, which checks each declared field.
        if let Type::Record { shape_id: source_id } = value.ty()
            && !self.records[source_id].tuple
            && !self.callables.contains_key(&source_id)
            && let Type::Union { union_id } = &target
            && self.dynamic_erasure_reason(&value.ty()).is_none()
        {
            let accepts_undefined = |ty: &Type| match ty {
                Type::Dyn | Type::Undefined => true,
                Type::Union { union_id } => self.unions[*union_id].arms.contains(&Type::Undefined),
                _ => false,
            };
            let source_fields = self.records[source_id]
                .fields
                .iter()
                .map(|field| field.name.clone())
                .collect::<Vec<_>>();
            let candidates = self.unions[*union_id]
                .arms
                .iter()
                .enumerate()
                .filter(|(_, arm)| {
                    let Type::Record { shape_id } = arm else {
                        return false;
                    };
                    let record = &self.records[*shape_id];
                    !record.tuple
                        && !self.callables.contains_key(shape_id)
                        && record.index_value.is_none()
                        && source_fields
                            .iter()
                            .all(|name| record.fields.iter().any(|field| field.name == *name))
                        && record.fields.iter().all(|field| {
                            source_fields.contains(&field.name) || accepts_undefined(&field.r#type)
                        })
                })
                .map(|(tag, arm)| (tag, arm.clone()))
                .collect::<Vec<_>>();
            // Equal field sets that differ only in optionality (for example a
            // `{ $ref: string }` view beside `{ $ref?: string }`): the arm that
            // admits undefined in the most fields represents every value the
            // others do. A tie stays ambiguous.
            let field_names = |ty: &Type| {
                let Type::Record { shape_id } = ty else { unreachable!() };
                let mut names = self.records[*shape_id]
                    .fields
                    .iter()
                    .map(|field| field.name.clone())
                    .collect::<Vec<_>>();
                names.sort();
                names
            };
            let strict_fields = |ty: &Type| {
                let Type::Record { shape_id } = ty else { unreachable!() };
                self.records[*shape_id]
                    .fields
                    .iter()
                    .filter(|field| !accepts_undefined(&field.r#type))
                    .count()
            };
            let chosen = match candidates.as_slice() {
                [only] => Some(only.clone()),
                [first, rest @ ..]
                    if rest.iter().all(|(_, arm)| field_names(arm) == field_names(&first.1)) =>
                {
                    let least = candidates.iter().map(|(_, arm)| strict_fields(arm)).min().unwrap_or(0);
                    let best = candidates
                        .iter()
                        .filter(|(_, arm)| strict_fields(arm) == least)
                        .cloned()
                        .collect::<Vec<_>>();
                    (best.len() == 1).then(|| best[0].clone())
                }
                _ => None,
            };
            if let Some((tag, arm)) = chosen {
                let dynamic = self.coerce(value.clone(), Type::Dyn, node)?;
                if let Ok(selected) = self.coerce(dynamic, arm.clone(), node) {
                    return Ok(Expr::UnionWrap {
                        union_id: format!("u{union_id}"),
                        tag,
                        value: Box::new(selected),
                        r#type: target,
                        loc: self.loc(node),
                    });
                }
            }
        }
        // A function value with a different native ABI (for example a bound
        // `emit` with a rest vector passed where `(a, b) => void` is
        // expected): cross the dynamic callable view, which forwards the
        // arguments and checks the result.
        if matches!(value.ty(), Type::Func { .. })
            && matches!(target, Type::Func { .. })
            && self.dynamic_erasure_reason(&value.ty()).is_none()
        {
            let dynamic = self.coerce(value.clone(), Type::Dyn, node)?;
            if let Ok(view) = self.coerce(dynamic, target.clone(), node) {
                return Ok(view);
            }
        }
        // An array of mixed elements entering a union of array views (for
        // example `Array<Row | unknown[]>` into `Row[] | any[][]`) selects
        // its arm at runtime through the owning dynamic array.
        if matches!(value.ty(), Type::Array { .. })
            && let Type::Union { union_id } = &target
            && self.unions[*union_id]
                .arms
                .iter()
                .all(|arm| matches!(arm, Type::Array { .. }))
            && self.dynamic_erasure_reason(&value.ty()).is_none()
        {
            let dynamic = self.coerce(value.clone(), Type::Dyn, node)?;
            if let Ok(selected) = self.coerce(dynamic, target.clone(), node) {
                return Ok(selected);
            }
        }
        if std::env::var_os("SCRIPTC_TRACE_RECORD_VIEWS").is_some()
            && matches!(value.ty(), Type::Record { .. })
            && let Type::Union { union_id } = &target
        {
            eprintln!(
                "scriptc: record-union view source={} target=u{union_id}",
                self.contextual_type_description(&value.ty())
            );
            for (tag, arm) in self.unions[*union_id].arms.iter().enumerate() {
                eprintln!(
                    "scriptc: record-union candidate tag={tag} type={} invariant={} checked={} equivalent={} resultCompatible={}",
                    self.contextual_type_description(arm),
                    ir::record_views::view_pairs(&value.ty(), arm, &self.records, &self.unions,)
                        .is_some(),
                    ir::record_views::dynamic_view_pairs(
                        &value.ty(),
                        arm,
                        &self.records,
                        &self.unions,
                    )
                    .is_some(),
                    ir::record_equivalence::equivalent(
                        &value.ty(),
                        arm,
                        &self.records,
                        &self.unions,
                    ),
                    self.contextual_result_compatible(&value.ty(), arm),
                );
            }
        }
        Err(self.refuse(
            node,
            &format!(
                "native representation coercion is not ported: {} -> {}{}{}{}",
                describe(&value.ty()),
                describe(&target),
                record_delta,
                identifier,
                property_context,
            ),
        ))
    }

    pub(super) fn narrowed(&mut self, value: Expr, node: Node) -> Result<Expr, String> {
        let trace_identifier = std::env::var_os("SCRIPTC_TRACE_IDENTIFIER_STAGES").is_some();
        if trace_identifier {
            eprintln!(
                "scriptc: narrowed stage start {}:{}..{} {:?}",
                self.file,
                node.pos(),
                node.end(),
                value.ty()
            );
        }
        if let Some(value) = self.guarded_truthy_assignment(node, &value) {
            return Ok(value);
        }
        if trace_identifier {
            eprintln!(
                "scriptc: narrowed stage assignment-guard {}:{}..{}",
                self.file,
                node.pos(),
                node.end()
            );
        }
        if let Some(value) = self.nonoptional_property_guarded_value(node, &value) {
            return Ok(value);
        }
        if let Some(value) = self.array_guarded_value(node, &value) {
            return Ok(value);
        }
        if let Some(value) = self.validated_record_value(node, &value) {
            return Ok(value);
        }
        if trace_identifier {
            eprintln!(
                "scriptc: narrowed stage property-guard {}:{}..{}",
                self.file,
                node.pos(),
                node.end()
            );
        }
        if node.kind() == SyntaxKind::Identifier
            && let Type::Union { union_id } = value.ty()
        {
            let mut branch = node;
            while branch.parent().kind() == SyntaxKind::ParenthesizedExpression {
                branch = branch.parent();
            }
            let conditional = branch.parent();
            if conditional.kind() == SyntaxKind::ConditionalExpression {
                let truth = conditional.when_true() == branch;
                let condition = primitives::primitive_source(conditional.condition());
                if condition.kind() == SyntaxKind::BinaryExpression {
                    let equal = match condition.operator_token().kind() {
                        SyntaxKind::EqualsEqualsEqualsToken => Some(true),
                        SyntaxKind::ExclamationEqualsEqualsToken => Some(false),
                        _ => None,
                    };
                    if let Some(equal) = equal {
                        let function_guard = [
                            (condition.left(), condition.right()),
                            (condition.right(), condition.left()),
                        ]
                        .into_iter()
                        .any(|(test, kind)| {
                            let test = primitives::primitive_source(test);
                            let operand = if test.kind() == SyntaxKind::TypeOfExpression {
                                primitives::primitive_source(test.expression())
                            } else {
                                Node::NIL
                            };
                            test.kind() == SyntaxKind::TypeOfExpression
                                && operand.kind() == SyntaxKind::Identifier
                                && (self.symbol(operand) == self.symbol(node)
                                    || operand.text() == node.text())
                                && kind.kind() == SyntaxKind::StringLiteral
                                && kind.text() == "function"
                        });
                        if function_guard && truth == equal {
                            let functions = self.unions[union_id]
                                .arms
                                .iter()
                                .enumerate()
                                .filter(|(_, arm)| matches!(arm, Type::Func { .. }))
                                .collect::<Vec<_>>();
                            if let [(tag, function)] = functions.as_slice() {
                                return Ok(Expr::UnionNarrow {
                                    union_id: format!("u{union_id}"),
                                    tag: *tag,
                                    value: Box::new(value),
                                    r#type: (*function).clone(),
                                    loc: self.loc(node),
                                });
                            }
                        }
                    }
                }
            }
        }
        if self.directly_truthy_selected_property(node)
            && let Type::Union { union_id } = value.ty()
        {
            let present = self.unions[union_id]
                .arms
                .iter()
                .enumerate()
                .filter(|(_, arm)| !matches!(arm, Type::Null | Type::Undefined | Type::Void))
                .collect::<Vec<_>>();
            if let [(tag, target)] = present.as_slice() {
                return Ok(Expr::UnionNarrow {
                    union_id: format!("u{union_id}"),
                    tag: *tag,
                    value: Box::new(value),
                    r#type: (*target).clone(),
                    loc: self.loc(node),
                });
            }
        }
        if trace_identifier {
            eprintln!(
                "scriptc: narrowed stage direct-truthy {}:{}..{}",
                self.file,
                node.pos(),
                node.end()
            );
        }
        if value.ty() == Type::Caught {
            let target = self.ty(node)?;
            if target == Type::Symbol {
                // The shared caughtNarrow contract covers numeric/string/Error
                // views. Other primitive payloads use its owning dynamic bridge.
                let value = Expr::CaughtToDyn {
                    value: Box::new(value),
                    r#type: Type::Dyn,
                    loc: self.loc(node),
                };
                return self.coerce(value, target, node);
            }
            if matches!(
                target,
                Type::F64 | Type::String | Type::Bool | Type::Object { .. }
            ) {
                return Ok(Expr::CaughtNarrow {
                    value: Box::new(value),
                    r#type: target,
                    loc: self.loc(node),
                });
            }
            return Ok(Expr::CaughtToDyn {
                value: Box::new(value),
                r#type: Type::Dyn,
                loc: self.loc(node),
            });
        }
        // Concrete non-polymorphic values have no native flow projection to
        // compute here. In particular, avoid asking the checker for an `any`
        // fact after a recursive source type has already been lowered to a
        // concrete record/sequence representation.
        if !matches!(
            value.ty(),
            Type::Dyn | Type::Union { .. } | Type::Object { .. }
        ) {
            return Ok(value);
        }
        if trace_identifier {
            eprintln!(
                "scriptc: narrowed stage checker-any {}:{}..{}",
                self.file,
                node.pos(),
                node.end()
            );
        }
        // A lowered value already carries a verified native representation.
        // Untyped JS doesn't supply additional control-flow evidence.
        if self.checker_any(node) {
            if let Some(narrowed) = self.guarded_truthy_return(node, &value) {
                return Ok(narrowed);
            }
            return Ok(value);
        }
        if let Type::Object { class_name: parent } = value.ty() {
            let target = self.ty(node)?;
            if let Type::Object { class_name: child } = &target
                && *child != parent
                && self.classes.subclass(child, &parent)
            {
                return Ok(Expr::Downcast {
                    value: Box::new(value),
                    r#type: target,
                    loc: self.loc(node),
                });
            }
            return Ok(value);
        }
        if value.ty() == Type::Dyn {
            if node.kind() == SyntaxKind::Identifier {
                let symbol = self.symbol(node);
                if self.planned_local_storage.get(&symbol) == Some(&Type::Dyn) {
                    // The native cell was widened because a nested closure
                    // assigns an erased value. TypeScript's flow view still
                    // follows the initializer-only type in JavaScript files;
                    // projecting that stale view would discard the actual
                    // captured assignment domain.
                    return Ok(value);
                }
            }
            if node.kind() == SyntaxKind::Identifier
                && self.accessor_literal_source(node, &mut HashSet::new())
            {
                return Ok(value);
            }
            if self.bytes_named_key_value(node, &mut HashSet::new()) {
                return Ok(value);
            }
            let target = self.ty(node)?;
            if matches!(
                node.kind(),
                SyntaxKind::PropertyAccessExpression | SyntaxKind::ElementAccessExpression
            ) && matches!(
                target,
                Type::Record { .. } | Type::Array { .. } | Type::Map { .. } | Type::Union { .. }
            ) {
                return Ok(value);
            }

            if !matches!(target, Type::Dyn | Type::Null | Type::Undefined) {
                return self.coerce(value, target, node);
            }
        }
        if !matches!(value.ty(), Type::Union { .. }) {
            return Ok(value);
        }
        // An unreachable checker view has no runtime payload to project.
        // Source updates may make the cell observable again; retain its
        // owning tags rather than demanding a representation for never.
        let checked = self.checker.get_type_at_location(node);
        if self.checker.ty(checked).flags.intersects(TypeFlags::NEVER) {
            return Ok(value);
        }
        let target = self.ty(node)?;
        if value.ty() == target {
            return Ok(value);
        }
        if node.kind() == SyntaxKind::Identifier
            && matches!(value.ty(), Type::Union { .. })
            && matches!(target, Type::Union { .. })
        {
            let symbol = self.symbol(node);
            if self.planned_local_storage.get(&symbol) == Some(&value.ty()) {
                let Type::Union { union_id } = value.ty() else {
                    unreachable!()
                };
                let target_arms = match &target {
                    Type::Union { union_id } => &self.unions[*union_id].arms,
                    _ => unreachable!(),
                };
                let retained = self.unions[union_id]
                    .arms
                    .iter()
                    .filter(|arm| {
                        !matches!(arm, Type::Null | Type::Undefined) || target_arms.contains(arm)
                    })
                    .cloned()
                    .collect::<Vec<_>>();
                if retained.len() < self.unions[union_id].arms.len()
                    && let Some(projected) = self.intern_union(retained)
                {
                    if let Type::Union { .. } = projected {
                        return Ok(Expr::UnionProject {
                            value: Box::new(value),
                            r#type: projected,
                            loc: self.loc(node),
                        });
                    }
                    if let Some(tag) = self.unions[union_id]
                        .arms
                        .iter()
                        .position(|arm| *arm == projected)
                    {
                        return Ok(Expr::UnionNarrow {
                            union_id: format!("u{union_id}"),
                            tag,
                            value: Box::new(value),
                            r#type: projected,
                            loc: self.loc(node),
                        });
                    }
                }
                // Use-site planning can give an unannotated JavaScript local a
                // more precise owning union than the checker's initializer
                // view. Truthiness and later property narrowing must operate
                // on that live tagged cell; projecting it back to the stale
                // inferred result would discard its native ABI.
                return Ok(value);
            }
        }
        // TypeScript represents a truthy view of broad unions such as
        // JsonValue with `{}`. The native type mapper intentionally erases
        // that structural top type to Dyn, but the checker has not erased the
        // value's owning union tags. Retain those tags here; a later ABI
        // coercion can still convert the value to Dyn when the consumer
        // actually requires a dynamic payload.
        if target == Type::Dyn {
            return Ok(value);
        }
        // Unit values have no standalone IR storage. Keep the tagged value
        // for equality tests even when the checker already knows its tag.
        if matches!(target, Type::Null | Type::Undefined)
            && matches!(value.ty(), Type::Union { .. })
        {
            return Ok(value);
        }
        if node.kind() == SyntaxKind::Identifier {
            let symbol = self.symbol(node);
            if symbol != 0 {
                let declared = self
                    .checker
                    .get_type_of_symbol(source_frontend::prelude::SymbolId(symbol));
                if !self.source_has_undefined(declared)
                    && !self.var_defined.contains(&symbol)
                    && self.argument_may_be_absent(node, &mut HashSet::new())
                {
                    // The checker can omit absent indexed values or erase a
                    // non-null assertion. It has not proven the runtime tag.
                    return Ok(value);
                }
            }
        }
        let guarded_symbol = (node.kind() == SyntaxKind::Identifier).then(|| self.symbol(node));
        if guarded_symbol.is_some_and(|symbol| self.var_defined.contains(&symbol))
            && let (
                Type::Union {
                    union_id: source_union,
                },
                Type::Union {
                    union_id: target_union,
                },
            ) = (value.ty(), &target)
        {
            let source_present = self.unions[source_union]
                .arms
                .iter()
                .enumerate()
                .filter(|(_, arm)| !matches!(arm, Type::Null | Type::Undefined | Type::Void))
                .collect::<Vec<_>>();
            let target_present = self.unions[*target_union]
                .arms
                .iter()
                .enumerate()
                .filter(|(_, arm)| !matches!(arm, Type::Null | Type::Undefined | Type::Void))
                .collect::<Vec<_>>();
            if let ([(source_tag, source_arm)], [(target_tag, target_arm)]) =
                (source_present.as_slice(), target_present.as_slice())
                && matches!(source_arm, Type::Record { .. })
                && matches!(target_arm, Type::Record { .. })
                && ir::record_views::view_pairs(source_arm, target_arm, &self.records, &self.unions)
                    .is_some()
            {
                // The surrounding guard proved the owning slot present, but
                // a consumer can retain an optional structural view. Select
                // the live record arm, install that identity-preserving view,
                // then wrap only the consumer's present tag. No reachable
                // nullish value is translated between null and undefined.
                let narrowed = Expr::UnionNarrow {
                    union_id: format!("u{source_union}"),
                    tag: *source_tag,
                    value: Box::new(value),
                    r#type: (*source_arm).clone(),
                    loc: self.loc(node),
                };
                let viewed = self.coerce(narrowed, (*target_arm).clone(), node)?;
                return Ok(Expr::UnionWrap {
                    union_id: format!("u{target_union}"),
                    tag: *target_tag,
                    value: Box::new(viewed),
                    r#type: target,
                    loc: self.loc(node),
                });
            }
        }
        if let Type::Union { union_id } = value.ty()
            && let Some(tag) = self.unions[union_id].arms.iter().position(|a| *a == target)
        {
            return Ok(Expr::UnionNarrow {
                union_id: format!("u{union_id}"),
                tag,
                value: Box::new(value),
                r#type: target,
                loc: self.loc(node),
            });
        }
        if let (Type::Union { union_id }, Type::Object { class_name: parent }) =
            (value.ty(), &target)
        {
            let candidates = self.unions[union_id]
                .arms
                .iter()
                .enumerate()
                .filter(|(_, arm)| {
                    matches!(arm, Type::Object { class_name: child }
                        if self.classes.subclass(child, parent))
                })
                .collect::<Vec<_>>();
            if let [(tag, child)] = candidates.as_slice()
                && self.unions[union_id].arms.iter().all(|arm| {
                    arm == *child || matches!(arm, Type::Null | Type::Undefined | Type::Void)
                })
            {
                // The owning optional slot retains the concrete derived-class
                // tag while the checker publishes its base-class flow view.
                // Remove only the proven nullish alternatives, then perform
                // the ordinary nominal upcast without copying the instance.
                let narrowed = Expr::UnionNarrow {
                    union_id: format!("u{union_id}"),
                    tag: *tag,
                    value: Box::new(value),
                    r#type: (*child).clone(),
                    loc: self.loc(node),
                };
                return self.coerce(narrowed, target, node);
            }
        }
        if let Type::Union { union_id } = value.ty()
            && matches!(target, Type::Func { .. })
        {
            let candidates = self.unions[union_id]
                .arms
                .iter()
                .enumerate()
                .filter(|(_, arm)| {
                    ir::callable_view_compatible(arm, &target)
                        || self.structural_callable_view_compatible(arm, &target)
                })
                .collect::<Vec<_>>();
            if let [(tag, source)] = candidates.as_slice() {
                let narrowed = Expr::UnionNarrow {
                    union_id: format!("u{union_id}"),
                    tag: *tag,
                    value: Box::new(value),
                    r#type: (*source).clone(),
                    loc: self.loc(node),
                };
                return self.coerce(narrowed, target, node);
            }
        }
        if let (
            Type::Union { union_id },
            Type::Record {
                shape_id: target_id,
            },
        ) = (value.ty(), &target)
        {
            let target_record = &self.records[*target_id];
            let mut candidates = self.unions[union_id]
                .arms
                .iter()
                .enumerate()
                .filter_map(|(tag, arm)| {
                    let Type::Record {
                        shape_id: source_id,
                    } = arm
                    else {
                        return None;
                    };
                    let source_record = &self.records[*source_id];
                    let eligible = !source_record.tuple
                        && !target_record.tuple
                        && target_record.fields.iter().all(|target_field| {
                            source_record
                                .fields
                                .iter()
                                .any(|field| field.name == target_field.name)
                        });
                    eligible.then(|| {
                        (
                            flow_shape_distance(arm, &target, &self.records, &self.unions, 0),
                            tag,
                            arm.clone(),
                        )
                    })
                })
                .collect::<Vec<_>>();
            candidates.sort_by_key(|(score, _, _)| *score);
            if let Some((score, tag, arm)) = candidates.first()
                && candidates
                    .iter()
                    .filter(|(candidate, _, _)| candidate == score)
                    .count()
                    == 1
            {
                // Unannotated JavaScript object literals often carry a broad
                // checker-only shape (for example `start: unknown[]`) while
                // their owning cell uses a discriminated record union. Select
                // the unique compatible storage arm and retain its precise
                // field ABI instead of projecting the union into a copy.
                return Ok(Expr::UnionNarrow {
                    union_id: format!("u{union_id}"),
                    tag: *tag,
                    value: Box::new(value),
                    r#type: arm.clone(),
                    loc: self.loc(node),
                });
            }
        }
        if let (Type::Union { union_id }, Type::Array { elem: target_elem }) = (value.ty(), &target)
        {
            let arrays = self.unions[union_id]
                .arms
                .iter()
                .enumerate()
                .filter(|(_, arm)| {
                    matches!(arm, Type::Array { elem }
                        if **target_elem == Type::Dyn
                            || elem == target_elem
                            || self.recursive_json_value_views(elem, target_elem)
                            || ir::callable_view_compatible(elem, target_elem)
                            || self.structural_callable_view_compatible(elem, target_elem)
                            || matches!((elem.as_ref(), target_elem.as_ref()),
                                (Type::Func { params: source_params, rest: source_rest, .. },
                                 Type::Func { params: target_params, rest: target_rest, .. })
                                    if source_params.len() == target_params.len()
                                        && source_rest == target_rest))
                })
                .collect::<Vec<_>>();
            if let [(tag, array)] = arrays.as_slice() {
                // The checker may widen a JavaScript array read to unknown[]
                // even though the owning field has a more precise native
                // element ABI. Narrow the presence tag while retaining that
                // concrete storage instead of attempting an identity-breaking
                // array conversion.
                return Ok(Expr::UnionNarrow {
                    union_id: format!("u{union_id}"),
                    tag: *tag,
                    value: Box::new(value),
                    r#type: (*array).clone(),
                    loc: self.loc(node),
                });
            }
        }
        if let (
            Type::Union { union_id: source },
            Type::Union {
                union_id: target_id,
            },
        ) = (value.ty(), target.clone())
        {
            let source_arms = &self.unions[source].arms;
            let target_arms = &self.unions[target_id].arms;
            let source_callable = source_arms
                .iter()
                .filter_map(|arm| match arm {
                    Type::Func { params, rest, .. } => Some((params.len(), *rest)),
                    _ => None,
                })
                .collect::<Vec<_>>();
            let target_callable = target_arms
                .iter()
                .filter_map(|arm| match arm {
                    Type::Func { params, rest, .. } => Some((params.len(), *rest)),
                    _ => None,
                })
                .collect::<Vec<_>>();
            let callable_arrays = |arms: &[Type]| {
                arms.iter()
                    .filter_map(|arm| match arm {
                        Type::Array { elem } => match elem.as_ref() {
                            Type::Func { params, rest, .. } => Some((params.len(), *rest)),
                            _ => None,
                        },
                        _ => None,
                    })
                    .collect::<Vec<_>>()
            };
            let source_callable_arrays = callable_arrays(source_arms);
            let target_callable_arrays = callable_arrays(target_arms);
            let same_units = [Type::Null, Type::Undefined]
                .into_iter()
                .all(|unit| source_arms.contains(&unit) == target_arms.contains(&unit));
            if same_units
                && source_arms
                    .iter()
                    .any(|arm| matches!(arm, Type::Record { .. }))
                && source_arms
                    .iter()
                    .all(|arm| matches!(arm, Type::Record { .. } | Type::Null | Type::Undefined))
                && target_arms
                    .iter()
                    .all(|arm| matches!(arm, Type::Record { .. } | Type::Null | Type::Undefined))
            {
                // The execution graph and a declaration/flow view may intern
                // different closed shapes for the same family of JavaScript
                // objects. The tagged execution union owns their identity;
                // retagging or projecting into checker-only records would copy
                // storage. Keep the owning union and let member/call boundaries
                // apply the narrower structural view where it is consumed.
                return Ok(value);
            }
            let indexed_json_pair = |arms: &[Type]| {
                if arms.len() != 2 {
                    return false;
                }
                arms.iter().any(|arm| matches!(arm, Type::Array { .. }))
                    && arms.iter().any(|arm| {
                        matches!(arm,
                        Type::Record { shape_id }
                            if self.records[*shape_id].fields.is_empty()
                                && self.records[*shape_id].index_value.is_some())
                    })
                    && arms.iter().all(|arm| {
                        !ir::contains_set(arm, &self.records, &self.unions)
                            && self.dynamic_erasure_reason(arm).is_none()
                    })
            };
            if same_units && indexed_json_pair(source_arms) && indexed_json_pair(target_arms) {
                // Both array and indexed-dictionary arms own dynamic storage.
                // A checker projection may assign fresh recursive union IDs
                // without changing either runtime tag or the backing value.
                return Ok(value);
            }
            if source_arms.len() == target_arms.len()
                && same_units
                && source_callable.len() == 1
                && source_callable == target_callable
            {
                // Storage planning and the checker can materialize distinct
                // structural signatures for the same optional JS callable
                // (for example a supplied `fetch`). No tag was removed here:
                // retain the owning function/undefined union. A consumer that
                // requests the other signature crosses the dynamic callable
                // view and performs its argument/result checks there.
                return Ok(value);
            }
            if source_arms.len() == target_arms.len()
                && same_units
                && source_callable_arrays.len() == 1
                && source_callable_arrays == target_callable_arrays
            {
                // Class storage and a flow read can independently intern the
                // parameter records of callbacks held in the same optional
                // array.  The array and closure identities are unchanged;
                // retain the owning union just as for the scalar callable case
                // above.  Array element consumers apply their requested
                // callable view at the read/call boundary.
                return Ok(value);
            }
            if target_arms.len() < source_arms.len()
                && target_arms.iter().all(|arm| source_arms.contains(arm))
            {
                return Ok(Expr::UnionProject {
                    value: Box::new(value),
                    r#type: target,
                    loc: self.loc(node),
                });
            }
        }
        // A user type guard (`tui is ExtendedContext`) can refine a nullable
        // record view to a wider interface. The guard proved its runtime
        // test; check the owning object against the target view.
        // A hoisted `var ar = []` keeps `Array<Dyn> | undefined` storage while
        // flow narrows it to a typed array view; check that view the same way.
        if let Type::Union { union_id } = value.ty()
            && match &target {
                Type::Record { shape_id } => !self.records[*shape_id].tuple,
                Type::Array { .. } => true,
                _ => false,
            }
            && self.unions[union_id].arms.iter().all(|arm| {
                matches!(arm, Type::Null | Type::Undefined | Type::Array { .. })
                    || matches!(arm, Type::Record { shape_id } if !self.records[*shape_id].tuple)
            })
            && let Ok(dynamic) = self.coerce(value.clone(), Type::Dyn, node)
            && let Ok(view) = self.coerce(dynamic, target.clone(), node)
        {
            return Ok(view);
        }
        // Literal domains widen to one primitive representation. Other
        // refinements need an explicit IR operation rather than a Rust cast.
        let union_detail = match (value.ty(), &target) {
            (Type::Union { union_id: source }, Type::Union { union_id: target }) => format!(
                "; source arms: {:?}; target arms: {:?}",
                self.unions[source].arms, self.unions[*target].arms
            ),
            (
                Type::Union { union_id: source },
                Type::Record {
                    shape_id: target_id,
                },
            ) => format!(
                "; source arms: {:?}; target fields: {:?}",
                self.unions[source].arms,
                self.records[*target_id]
                    .fields
                    .iter()
                    .map(|field| field.name.as_str())
                    .take(24)
                    .collect::<Vec<_>>()
            ),
            (Type::Union { union_id: source }, _) => {
                format!("; source arms: {:?}", self.unions[source].arms)
            }
            _ => String::new(),
        };
        Err(self.refuse(
            node,
            &format!(
                "flow narrowing has no native projection: {:?} -> {:?}; identifier: {}{}",
                value.ty(),
                target,
                node.text(),
                union_detail,
            ),
        ))
    }

    pub(super) fn inferred_conditional_expression(&mut self, node: Node) -> Result<Expr, String> {
        debug_assert_eq!(node.kind(), SyntaxKind::ConditionalExpression);
        let condition = self.condition_value(node.condition())?;
        if let Expr::BoolLit { value, .. } = condition {
            let selected = if value {
                node.when_true()
            } else {
                node.when_false()
            };
            if node.parent().kind() == SyntaxKind::ExpressionStatement
                && selected.kind() == SyntaxKind::BinaryExpression
                && selected.operator_token().kind() == SyntaxKind::EqualsToken
            {
                let stmt = self.effect_statement(selected, node.parent())?;
                let loc = self.loc(node);
                return Ok(Expr::Sequence {
                    stmts: vec![stmt],
                    result: Box::new(Expr::DynFrom {
                        value: Box::new(Expr::UnitLit {
                            unit: "undefined",
                            r#type: Type::Undefined,
                            loc: loc.clone(),
                        }),
                        r#type: Type::Dyn,
                        loc: loc.clone(),
                    }),
                    r#type: Type::Dyn,
                    loc,
                });
            }
            return self.expression(selected);
        }
        let cond = Box::new(self.condition(condition, node.condition())?);
        let before = self.var_defined.clone();
        if let Some(symbols) = self.guarded_vars(node.condition(), true) {
            self.var_defined.extend(symbols);
        }
        let mut then = self.expression(node.when_true())?;
        let then_defined = self.var_defined.clone();
        self.var_defined = before;
        if let Some(symbols) = self.guarded_vars(node.condition(), false) {
            self.var_defined.extend(symbols);
        }
        let mut else_ = self.expression(node.when_false())?;
        self.var_defined = then_defined
            .intersection(&self.var_defined)
            .copied()
            .collect();

        if let Some(tag) = self.presence_guard_union_arm(
            node.condition(),
            node.when_true(),
            &then.ty(),
            &else_.ty(),
        ) {
            let Type::Union { union_id } = then.ty() else {
                unreachable!("presence guard source")
            };
            let target = else_.ty();
            let arm = self.unions[union_id].arms[tag].clone();
            then = Expr::UnionNarrow {
                union_id: format!("u{union_id}"),
                tag,
                value: Box::new(then),
                r#type: arm,
                loc: self.loc(node.when_true()),
            };
            then = self.coerce(then, target.clone(), node.when_true())?;
            return Ok(Expr::Ternary {
                cond,
                then: Box::new(then),
                else_: Box::new(else_),
                r#type: target,
                loc: self.loc(node),
            });
        }

        // The checker often reports `any` for an inferred JavaScript
        // conditional even when an operand has a concrete declaration ABI.
        // Retain those owning layouts instead of erasing them back to Dyn.
        let mut arms = Vec::new();
        for ty in [then.ty(), else_.ty()] {
            match ty {
                Type::Union { union_id } => arms.extend(self.unions[union_id].arms.clone()),
                ty => arms.push(ty),
            }
        }
        let target = self.intern_union(arms).ok_or_else(|| {
            self.refuse(
                node,
                "inferred JavaScript conditional has no shared native representation",
            )
        })?;
        then = self.coerce(then, target.clone(), node.when_true())?;
        else_ = self.coerce(else_, target.clone(), node.when_false())?;
        Ok(Expr::Ternary {
            cond,
            then: Box::new(then),
            else_: Box::new(else_),
            r#type: target,
            loc: self.loc(node),
        })
    }

    pub(super) fn expected_expression(&mut self, node: Node, target: Type) -> Result<Expr, String> {
        if node.is_nil() {
            return Err("SCN9001: frontend received an absent expected-expression node".into());
        }
        let unreachable = {
            let checked = self.checker.get_type_at_location(node);
            self.checker.ty(checked).flags.intersects(TypeFlags::NEVER)
        };
        if !unreachable {
            return self.expected_expression_direct(node, target);
        }
        // Flow narrowing proved this operand unreachable (`never`), so its
        // owning storage need not convert statically to the expected view.
        // Keep the read and check it at runtime should control ever arrive.
        let restore = self.diagnostic_checkpoint();
        match self.expected_expression_direct(node, target.clone()) {
            Ok(value) => Ok(value),
            Err(error) => {
                restore(self);
                let Ok(value) = self.expression(node) else {
                    return Err(error);
                };
                let value = self.coerce(value, Type::Dyn, node)?;
                self.coerce(value, target, node).or(Err(error))
            }
        }
    }

    fn expected_expression_direct(&mut self, node: Node, target: Type) -> Result<Expr, String> {
        if std::env::var_os("SCRIPTC_TRACE_EXPRESSIONS").is_some() {
            eprintln!(
                "scriptc: lowering expected expression {:?} at {}:{}..{} as {:?}",
                node.kind(),
                self.file,
                node.pos(),
                node.end(),
                target
            );
        }
        let value = self.expected_expression_inner(node, target);
        if matches!(
            node.kind(),
            SyntaxKind::CallExpression | SyntaxKind::NewExpression
        ) && !matches!(&value, Ok(Expr::Intrinsic { .. } | Expr::BytesNew { .. }))
            && !matches!(&value, Ok(Expr::LibCall { r#fn, .. }) if r#fn == "buffer.alloc")
        {
            self.var_call_effects();
        }
        value
    }

    fn expected_expression_inner(&mut self, node: Node, target: Type) -> Result<Expr, String> {
        if target == Type::Dyn
            && matches!(node.kind(), SyntaxKind::AsExpression | SyntaxKind::TypeAssertionExpression)
            && matches!(node.expression().kind(), SyntaxKind::AsExpression | SyntaxKind::TypeAssertionExpression)
            && self.ty(node.expression())? == Type::Dyn
        {
            // `value as unknown as T` does not perform a runtime cast. When
            // the receiving ABI already owns a dynamic value, do not check T
            // and then erase it again: that would reject real values such as
            // undefined before the callee observes them.
            return self.expected_expression(node.expression().expression(), Type::Dyn);
        }
        if (target == Type::Dyn || matches!(target, Type::Generator { r#async: false, .. }))
            && let Some(Expr::MapIntrinsic {
                receiver,
                args,
                loc,
                ..
            }) = self.immediate_map_values_iterator(node)?
        {
            let iterator = Expr::MapIntrinsic {
                method: "valuesIteratorObject".into(),
                receiver,
                args,
                r#type: Type::Dyn,
                loc,
            };
            return self.coerce(iterator, target, node);
        }
        if node.kind() == SyntaxKind::NewExpression
            && let Some(value) = self.constructor_proxy_expected(node, &target)?
        {
            return Ok(value);
        }
        if node.kind() == SyntaxKind::Identifier
            && let Some(value) = self.native_namespace_record(node, &target)?
        {
            return Ok(value);
        }
        if node.kind() == SyntaxKind::AwaitExpression && self.is_async_function {
            // Awaited generic payloads frequently have no standalone checker
            // representation (`T`), while their surrounding field or call
            // already supplies a concrete native ABI. Lower the suspension
            // with that contextual result instead of asking `ty(node)` to
            // manufacture a layout for the type parameter first.
            return self.terminal_await(node, &target);
        }
        if let Type::Promise { inner } = &target
            && node.kind() == SyntaxKind::CallExpression
            && node.expression().kind() == SyntaxKind::ImportKeyword
            && let Some(value) = self.dynamic_import_call(node, Some(inner.as_ref()))?
        {
            return Ok(value);
        }
        if matches!(target, Type::Promise { .. })
            && let Some(value) = self.promise_new_expected(node, Some(target.clone()))?
        {
            return Ok(value);
        }
        if matches!(target, Type::Generator { r#async: false, .. }) {
            let value = self.expression(node)?;
            if let Type::Object { class_name } = value.ty() {
                let class = self
                    .classes
                    .definition_index_for_name(&class_name)
                    .ok_or_else(|| self.refuse(node, "iterator class layout is unavailable"))?;
                for name in ["next", "return", "throw"] {
                    if let Some((owner, method)) = self.classes.method_candidate(class, name) {
                        self.request_method(owner, name, method)?;
                    }
                }
            }
            return self.coerce(value, target, node);
        }
        if matches!(target, Type::F64 | Type::String | Type::Bool)
            && self.bytes_named_key_value(node, &mut HashSet::new())
        {
            return Err(self.refuse(
                node,
                "typed array named-key value requires an owning dynamic contract",
            ));
        }
        if target == Type::Dyn && node.kind() == SyntaxKind::Identifier {
            // An unknown-typed consumer receives the live value, not a
            // checker-only projection that can lose object identity or tags.
            let value = self.condition_value(node)?;
            // Dynamic callable properties expose the complete parameter and
            // result object surface. Install receiver-explicit symbol method
            // descriptors before the immutable coercion validator checks that
            // the signature is safe to box.
            self.materialize_erased_symbol_methods(&value.ty())?;
            return self.coerce(value, target, node);
        }
        if target == Type::Dyn
            && let Some(value) = self.array_method_value(node)?
        {
            return Ok(value);
        }
        if node.kind() == SyntaxKind::Identifier {
            let array_target = match &target {
                Type::Array { elem } if **elem != Type::Dyn => Some(target.clone()),
                Type::Union { union_id }
                    if self.unions[*union_id].arms.iter().all(|arm| {
                        matches!(arm, Type::Array { .. } | Type::Null | Type::Undefined)
                    }) =>
                {
                    let arrays = self.unions[*union_id]
                        .arms
                        .iter()
                        .filter(|arm| matches!(arm, Type::Array { elem } if **elem != Type::Dyn))
                        .cloned()
                        .collect::<Vec<_>>();
                    (arrays.len() == 1).then(|| arrays[0].clone())
                }
                _ => None,
            };
            let symbol = self.symbol(node);
            let source = self
                .bindings
                .get(&symbol)
                .or_else(|| self.module_bindings.get(&symbol))
                .or_else(|| self.outer.iter().rev().find_map(|scope| scope.get(&symbol)))
                .map(|local| local.r#type.clone());
            if let Some(array_target) = array_target {
                let erased = matches!(&source, Some(Type::Array { elem }) if **elem == Type::Dyn)
                    || source == Some(Type::Dyn);
                if erased {
                    let mut value = self.expression(node)?;
                    if !matches!(value.ty(), Type::Array { .. } | Type::Dyn) {
                        // A flow read can expose the owning slot through a
                        // narrowed union view; check it as the erased array.
                        value = self.coerce(value, Type::Dyn, node)?;
                    }
                    if value.ty() == Type::Dyn {
                        value = self.coerce(
                            value,
                            Type::Array {
                                elem: Box::new(Type::Dyn),
                            },
                            node,
                        )?;
                    }
                    let value = if value.ty() == array_target {
                        value
                    } else {
                        self.array_checked_projection(node, value, array_target)?
                    };
                    return self.coerce(value, target, node);
                }
            }
        }
        if node.kind() == SyntaxKind::CallExpression
            && target != Type::Dyn
            && !node.flags().intersects(NodeFlags::OPTIONAL_CHAIN)
            && let Some(value) = self.class_call_expected(node, target.clone())?
        {
            return self.coerce(value, target, node);
        }
        if node.kind() == SyntaxKind::CallExpression
            && target != Type::Dyn
            && !node.flags().intersects(NodeFlags::OPTIONAL_CHAIN)
        {
            let callee = receivers::reference_node(node.expression());
            if callee.kind() == SyntaxKind::Identifier {
                let symbol = self.symbol(callee);
                if let Some(source) = self.functions.source_node(symbol)
                    && parameter_abi::is_javascript(source)
                    && self.declared(source).is_none()
                    && let Some(signature) = self.request_function_context(
                        symbol,
                        node,
                        functions::UseKind::Call,
                        None,
                        Some(target.clone()),
                    )?
                {
                    let types = signature
                        .params
                        .iter()
                        .map(|param| param.r#type.clone())
                        .collect::<Vec<_>>();
                    let args = self.rest_call_arguments(node, &types, signature.rest)?;
                    let value = Expr::Call {
                        callee: signature.name,
                        args,
                        r#type: signature.return_type.clone(),
                        loc: self.loc(node),
                    };
                    return self.coerce(value, target, node);
                }
            }
        }
        if node.kind() == SyntaxKind::CallExpression
            && node.flags().intersects(NodeFlags::OPTIONAL_CHAIN)
        {
            let value = self.optional_access(node)?;
            return self.coerce(value, target, node);
        }
        if matches!(target, Type::Promise { .. })
            && node.kind() == SyntaxKind::CallExpression
            && let Some(value) = self.promise_call_expected(node, Some(target.clone()))?
        {
            return Ok(value);
        }
        if node.kind() == SyntaxKind::CallExpression {
            let member = node.expression();
            if member.kind() == SyntaxKind::PropertyAccessExpression
                && member.name().text() == "concat"
            {
                let arrays = match &target {
                    ty @ Type::Array { .. } => vec![ty.clone()],
                    Type::Union { union_id } => self.unions[*union_id]
                        .arms
                        .iter()
                        .filter(|arm| matches!(arm, Type::Array { .. }))
                        .cloned()
                        .collect::<Vec<_>>(),
                    _ => Vec::new(),
                };
                if arrays.len() == 1 {
                    let value = self.array_concat_expected(node, Some(arrays[0].clone()))?;
                    return self.coerce(value, target, node);
                }
            }
        }
        if let Some(value) = self.contextual_callable(node, &target)? {
            return Ok(value);
        }

        if node.kind() == SyntaxKind::NewExpression
            && let Type::Union { union_id } = &target
        {
            let arms = &self.unions[*union_id].arms;
            let maps = arms
                .iter()
                .filter(|arm| matches!(arm, Type::Map { .. }))
                .cloned()
                .collect::<Vec<_>>();
            if let [map] = maps.as_slice()
                && arms
                    .iter()
                    .all(|arm| matches!(arm, Type::Map { .. } | Type::Null | Type::Undefined))
            {
                let value = self.map_new_expected(node, Some(map.clone()))?;
                return self.coerce(value, target, node);
            }
        }

        if target == Type::Dyn
            && matches!(
                node.kind(),
                SyntaxKind::ObjectLiteralExpression | SyntaxKind::ArrayLiteralExpression
            )
        {
            return self.dynamic_literal(node);
        }
        if target == Type::Dyn
            && matches!(
                node.kind(),
                SyntaxKind::ArrowFunction
                    | SyntaxKind::FunctionExpression
                    | SyntaxKind::MethodDeclaration
            )
        {
            let value = self.closure(node, None)?;
            return self.coerce(value, target, node);
        }
        match node.kind() {
            SyntaxKind::CallExpression
                if matches!(target, Type::Array { .. }) && self.is_array_map(node) =>
            {
                self.array_map(node, Some(target))
            }
            SyntaxKind::AsExpression | SyntaxKind::TypeAssertionExpression => {
                if matches!(
                    node.expression().kind(),
                    SyntaxKind::AsExpression | SyntaxKind::TypeAssertionExpression
                ) && self.ty(node.expression())? == Type::Dyn
                {
                    let value = self.expression(node)?;
                    return self.coerce(value, target, node);
                }
                self.expected_expression(node.expression(), target)
            }
            SyntaxKind::NewExpression if matches!(target, Type::Map { .. }) => {
                self.map_new_expected(node, Some(target))
            }
            SyntaxKind::NewExpression if matches!(target, Type::Set { .. }) => {
                self.set_new(node, Some(target))
            }
            SyntaxKind::ArrayLiteralExpression => {
                if let Type::Record { shape_id } = &target
                    && self.records[*shape_id].tuple
                {
                    return self.tuple_literal(node, target);
                }
                let sequence = match &target {
                    Type::Array { .. } => target.clone(),
                    Type::Union { union_id } => {
                        let sequences = self.unions[*union_id]
                            .arms
                            .iter()
                            .filter(|t| matches!(t, Type::Array { .. }) || matches!(t, Type::Record { shape_id } if self.records[*shape_id].tuple))
                            .cloned()
                            .collect::<Vec<_>>();
                        if sequences.len() == 1 {
                            sequences[0].clone()
                        } else if node.elements().is_empty()
                            && !sequences.is_empty()
                            && sequences
                                .iter()
                                .all(|sequence| matches!(sequence, Type::Array { .. }))
                        {
                            // An empty literal carries no element whose ABI
                            // could distinguish the union arms. Materialize a
                            // concrete typed arm (prefer one over Array<Dyn>)
                            // and install the ordinary union tag afterward.
                            sequences
                                .iter()
                                .find(|sequence| {
                                    matches!(sequence, Type::Array { elem } if **elem != Type::Dyn)
                                })
                                .unwrap_or(&sequences[0])
                                .clone()
                        } else {
                            let spread_source = node
                                .elements()
                                .into_iter()
                                .find(|element| element.kind() == SyntaxKind::SpreadElement)
                                .and_then(|spread| self.ty(spread.expression()).ok());
                            if let Some(ref source) = spread_source
                                && let Some(sequence) =
                                    sequences.iter().find(|sequence| **sequence == *source)
                            {
                                sequence.clone()
                            } else {
                                return Err(self.refuse(
                                    node,
                                    &format!(
                                        "array literal needs one native sequence arm (target={target:?}, sequences={sequences:?}, spread={spread_source:?})"
                                    ),
                                ));
                            }
                        }
                    }
                    _ => return Err(self.refuse(node, "array literal needs a native array target")),
                };
                if matches!(sequence, Type::Record { .. }) {
                    let value = self.tuple_literal(node, sequence)?;
                    return self.coerce(value, target, node);
                }
                let array = sequence;
                let Type::Array { elem } = &array else {
                    unreachable!()
                };
                if matches!(target, Type::Array { .. })
                    && **elem != Type::Dyn
                    && (node.elements().iter().any(|element| {
                        self.array_asserted_live_element(element)
                    }) || (!node
                        .elements()
                        .iter()
                        .any(|element| element.kind() == SyntaxKind::SpreadElement)
                        && node
                            .elements()
                            .iter()
                            .any(|element| self.array_guarded_live_property(element))))
                {
                    // Keep live properties and asserted array slots in an
                    // owning dynamic array. TypeScript's non-null assertion
                    // does not turn a missing slot into a real element value.
                    let value = self.dynamic_literal(node)?;
                    return self.coerce(value, target, node);
                }
                if node
                    .elements()
                    .into_iter()
                    .any(|element| element.kind() == SyntaxKind::SpreadElement)
                {
                    let value = self.array_spread_literal(node, array)?;
                    return self.coerce(value, target, node);
                }
                let elems = node
                    .elements()
                    .into_iter()
                    .map(|n| self.expected_expression(n, (**elem).clone()))
                    .collect::<Result<Vec<_>, _>>()?;
                let value = Expr::ArrayLit {
                    elems,
                    r#type: array,
                    loc: self.loc(node),
                };
                self.coerce(value, target, node)
            }
            SyntaxKind::ArrowFunction
            | SyntaxKind::FunctionExpression
            | SyntaxKind::MethodDeclaration => {
                if let Type::Union { union_id } = target {
                    let functions = self.unions[union_id]
                        .arms
                        .iter()
                        .filter(|a| matches!(a, Type::Func { .. }))
                        .cloned()
                        .collect::<Vec<_>>();
                    let mut functions = functions;
                    functions.dedup();
                    // `let wrapper; wrapper = function onMessage(data, isBinary) {}`:
                    // a storage union of listener arities selects the arm that
                    // matches the literal's own parameter list.
                    let parameters = node.parameters().into_iter().collect::<Vec<_>>();
                    let arity_matches = (!parameters
                        .iter()
                        .any(|parameter| !parameter.dot_dot_dot_token().is_nil()))
                    .then(|| {
                        functions
                            .iter()
                            .filter(|function| {
                                matches!(function, Type::Func { params, rest: false, .. }
                                    if params.len() == parameters.len())
                            })
                            .cloned()
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default();
                    let selected = if functions.len() == 1 {
                        functions.first().cloned()
                    } else if let [arm] = arity_matches.as_slice() {
                        Some(arm.clone())
                    } else if let [arm] = arity_matches
                        .iter()
                        .filter(|function| matches!(function, Type::Func { ret, .. } if **ret == Type::Dyn))
                        .cloned()
                        .collect::<Vec<_>>()
                        .as_slice()
                        && node.kind() == SyntaxKind::FunctionExpression
                    {
                        // Same arity, one erased result (TypeScript's
                        // `__importStar` fallback beside a typed builtin): the
                        // owning dynamic result admits the literal's returns.
                        Some(arm.clone())
                    } else if node.kind() == SyntaxKind::ArrowFunction
                        && node.body().kind() != SyntaxKind::Block
                    {
                        let body = node.body();
                        let identity = body.kind() == SyntaxKind::Identifier
                            && node.parameters().into_iter().count() == 1
                            && node
                                .parameters()
                                .into_iter()
                                .next()
                                .is_some_and(|parameter| {
                                    parameter.name().kind() == SyntaxKind::Identifier
                                        && self.symbol(parameter.name()) == self.symbol(body)
                                });
                        let result = identity
                            .then_some(Type::Dyn)
                            .or_else(|| {
                                if body.kind() != SyntaxKind::CallExpression {
                                    return None;
                                }
                                let callee = receivers::reference_node(body.expression());
                                let symbol = self.symbol(callee);
                                (self.standard_bigint_value(callee)
                                    || callee.kind() == SyntaxKind::Identifier
                                        && callee.text() == "BigInt"
                                        && !self.bindings.contains_key(&symbol)
                                        && !self.module_bindings.contains_key(&symbol)
                                        && !self
                                            .outer
                                            .iter()
                                            .any(|scope| scope.contains_key(&symbol)))
                                .then_some(Type::Bigint)
                            })
                            .or_else(|| self.ty(body).ok().filter(|ty| *ty != Type::Dyn));
                        let exact = functions
                            .iter()
                            .filter(|function| {
                                matches!(function, Type::Func { ret, .. } if result.as_ref().is_some_and(|result| **ret == *result))
                            })
                            .cloned()
                            .collect::<Vec<_>>();
                        if exact.len() == 1 {
                            Some(exact[0].clone())
                        } else if exact.is_empty() {
                            let erased = functions
                                .iter()
                                .filter(|function| {
                                    matches!(function, Type::Func { ret, .. } if **ret == Type::Dyn)
                                })
                                .cloned()
                                .collect::<Vec<_>>();
                            (erased.len() == 1).then(|| erased[0].clone())
                        } else {
                            None
                        }
                    } else {
                        None
                    };
                    let Some(selected) = selected else {
                        return Err(self.refuse(
                            node,
                            &format!(
                                "callback union has no unique compatible function signature: {functions:?}; arms={:?}",
                                self.unions[union_id].arms
                            ),
                        ));
                    };
                    let value = self.closure(node, Some(selected))?;
                    self.coerce(value, Type::Union { union_id }, node)
                } else {
                    self.closure(node, Some(target))
                }
            }
            SyntaxKind::ObjectLiteralExpression if matches!(target, Type::Union { .. }) => {
                let Type::Union { union_id } = target else {
                    unreachable!();
                };
                if node
                    .properties()
                    .into_iter()
                    .filter(|property| property.kind() == SyntaxKind::SpreadAssignment)
                    .count()
                    > 1
                {
                    // Multiple correlated spread sources cannot be distributed
                    // independently without changing evaluation order. Build
                    // the ordinary object once, copying each source in source
                    // order, then install the checked union view over that same
                    // backing object.
                    let value = self.dynamic_literal(node)?;
                    return self.coerce(value, target, node);
                }
                let choice = self
                    .literal_choices
                    .get(&declarations::Key::of(node))
                    .cloned()
                    .or_else(|| self.contextual_union_literal(node));
                if let Some(choice) = self.object_union_presence_choice(node, union_id) {
                    let value = self.record_literal(node, choice)?;
                    return self.coerce(value, target, node);
                }
                if let Some(choice) = choice
                    && self.unions[union_id].arms.contains(&choice)
                {
                    let value = if matches!(choice, Type::Record { .. }) {
                        self.record_literal(node, choice)?
                    } else if choice == Type::Dyn {
                        // Generic JavaScript option objects often contribute a
                        // Dyn arm beside one or more closed specializations.
                        // Keep the literal's complete property store for that
                        // arm instead of asking record lowering to invent a
                        // closed layout for an erased checker choice.
                        self.dynamic_literal(node)?
                    } else {
                        return Err(self.refuse(
                            node,
                            "object literal union choice is not an object representation",
                        ));
                    };
                    return self.coerce(value, target, node);
                }
                // A single represented record arm is unambiguous (for example
                // Record | undefined). Multiple layouts need the checked choice.
                let matches = self.unions[union_id]
                    .arms
                    .iter()
                    .filter(|ty| matches!(ty, Type::Record { .. }))
                    .cloned()
                    .collect::<Vec<_>>();
                if matches.len() != 1 {
                    if let Some(value) = self.union_spread(node, target.clone())? {
                        return Ok(value);
                    }
                    if let Some(value) = self.object_literal_view_arm(node, union_id)? {
                        return Ok(value);
                    }
                    return Err(
                        self.refuse(
                            node,
                            &format!(
                                "object literal needs one assignable native union arm; represented arms: {:?}",
                                self.unions[union_id]
                                    .arms
                                    .iter()
                                    .filter_map(|arm| match arm {
                                        Type::Record { shape_id } => Some(
                                            self.records[*shape_id]
                                                .fields
                                                .iter()
                                                .map(|field| (&field.name, &field.r#type))
                                                .collect::<Vec<_>>(),
                                        ),
                                        _ => None,
                                    })
                                    .collect::<Vec<_>>()
                            ),
                        )
                    );
                }
                let value = self.record_literal(node, matches[0].clone())?;
                self.coerce(value, target, node)
            }
            SyntaxKind::ObjectLiteralExpression if matches!(target, Type::Record { .. }) => {
                self.record_literal(node, target)
            }
            SyntaxKind::ParenthesizedExpression | SyntaxKind::SatisfiesExpression => {
                self.expected_expression(node.expression(), target)
            }
            SyntaxKind::ConditionalExpression => {
                let value = self.condition_value(node.condition())?;
                if let Expr::BoolLit { value, .. } = value {
                    return self.expected_expression(
                        if value {
                            node.when_true()
                        } else {
                            node.when_false()
                        },
                        target,
                    );
                }
                let cond = Box::new(self.condition(value, node.condition())?);
                let before = self.var_defined.clone();
                if let Some(symbols) = self.guarded_vars(node.condition(), true) {
                    self.var_defined.extend(symbols);
                }
                let then = Box::new(self.expected_expression(node.when_true(), target.clone())?);
                let then_defined = self.var_defined.clone();
                self.var_defined = before;
                if let Some(symbols) = self.guarded_vars(node.condition(), false) {
                    self.var_defined.extend(symbols);
                }
                let else_ = Box::new(self.expected_expression(node.when_false(), target.clone())?);
                // Either arm can execute and can invalidate a captured slot.
                // Only facts surviving both paths remain available afterward.
                self.var_defined = then_defined
                    .intersection(&self.var_defined)
                    .copied()
                    .collect();
                Ok(Expr::Ternary {
                    cond,
                    then,
                    else_,
                    r#type: target,
                    loc: self.loc(node),
                })
            }
            _ => {
                let value = self.expression(node)?;
                if target == Type::Dyn
                    && let Type::Object { class_name } = value.ty()
                    && let Some(index) = self.classes.definition_index_for_name(&class_name)
                    && (self.classes.method_candidate(index, "next").is_some()
                        || self.classes.accessor(index, "next").is_some())
                {
                    for name in ["next", "return", "throw"] {
                        self.classes
                            .defer_dynamic_method_for_type(&value.ty(), name, &self.unions);
                        if let Some((owner, getter, _)) = self.classes.accessor(index, name)
                            && !getter.is_nil()
                        {
                            self.request_accessor(owner, name, false, getter)?;
                        }
                    }
                }
                if let Some(value) = self.array_to_tuple_projection(value.clone(), &target, node)? {
                    return Ok(value);
                }
                let array_target = match &target {
                    Type::Array { elem } if **elem != Type::Dyn => Some(target.clone()),
                    Type::Union { union_id } => {
                        let arrays = self.unions[*union_id]
                            .arms
                            .iter()
                            .filter(
                                |arm| matches!(arm, Type::Array { elem } if **elem != Type::Dyn),
                            )
                            .cloned()
                            .collect::<Vec<_>>();
                        (arrays.len() == 1).then(|| arrays[0].clone())
                    }
                    _ => None,
                };
                let asserted = {
                    let mut parent = node.parent();
                    while parent.kind() == SyntaxKind::ParenthesizedExpression {
                        parent = parent.parent();
                    }
                    matches!(
                        parent.kind(),
                        SyntaxKind::AsExpression | SyntaxKind::TypeAssertionExpression
                    )
                };
                let value = match (value.ty(), &array_target) {
                    (Type::Union { union_id }, Some(_)) if asserted => {
                        // `value as T[]` names the array arm the program
                        // relies on. Select it with a checked narrow; the
                        // element view below keeps the original array owner.
                        let arrays = self.unions[union_id]
                            .arms
                            .iter()
                            .enumerate()
                            .filter(|(_, arm)| matches!(arm, Type::Array { .. }))
                            .map(|(tag, arm)| (tag, arm.clone()))
                            .collect::<Vec<_>>();
                        if let [(tag, arm)] = arrays.as_slice() {
                            Expr::UnionNarrow {
                                union_id: format!("u{union_id}"),
                                tag: *tag,
                                value: Box::new(value),
                                r#type: arm.clone(),
                                loc: self.loc(node),
                            }
                        } else {
                            value
                        }
                    }
                    _ => value,
                };
                if value.ty() == target {
                    return Ok(value);
                }
                if let (Type::Array { elem: source_elem }, Some(array_target)) =
                    (value.ty(), array_target)
                    && let Type::Array { elem: target_elem } = &array_target
                    && source_elem.as_ref() != target_elem.as_ref()
                {
                    let value = self.array_checked_projection(node, value, array_target)?;
                    return self.coerce(value, target, node);
                }
                if let Some(narrowed) = self.guarded_truthy_return(node, &value) {
                    return self.coerce(narrowed, target, node);
                }
                if let Some(narrowed) = self.guarded_capture_argument(node, value.clone(), &target)
                {
                    return Ok(narrowed);
                }
                if let Some(narrowed) =
                    self.guarded_const_boolean_argument(node, value.clone(), &target)
                {
                    return Ok(narrowed);
                }
                if let Some(narrowed) = self.guarded_derived_argument(node, value.clone(), &target)
                {
                    return Ok(narrowed);
                }
                if let Some(narrowed) = self.filtered_literal_field_value(node, &value, &target) {
                    return Ok(narrowed);
                }
                if node.kind() == SyntaxKind::NonNullExpression
                    && let Type::Union { union_id } = value.ty()
                    && self.unions[union_id]
                        .arms
                        .iter()
                        .any(|arm| matches!(arm, Type::Null | Type::Undefined))
                    && !matches!(target, Type::Union { .. } | Type::Dyn)
                {
                    let operand = primitives::primitive_source(node.expression());
                    // `text.split("sep")[0]` with a non-empty literal
                    // separator and no limit always has a first element:
                    // String.prototype.split returns at least one substring.
                    let split_head = operand.kind() == SyntaxKind::ElementAccessExpression && {
                        let index = primitives::primitive_source(operand.argument_expression());
                        let call = primitives::primitive_source(operand.expression());
                        index.kind() == SyntaxKind::NumericLiteral
                            && index.text() == "0"
                            && call.kind() == SyntaxKind::CallExpression
                            && call.expression().kind() == SyntaxKind::PropertyAccessExpression
                            && call.expression().name().text() == "split"
                            && {
                                let args = call.arguments().into_iter().collect::<Vec<_>>();
                                matches!(args.as_slice(), [separator]
                                    if matches!(separator.kind(), SyntaxKind::StringLiteral | SyntaxKind::NoSubstitutionTemplateLiteral)
                                        && !separator.text().is_empty())
                            }
                            && {
                                let receiver = self
                                    .checker
                                    .get_type_at_location(call.expression().expression());
                                self.checker.ty(receiver).flags.intersects(TypeFlags::STRING_LIKE)
                            }
                    };
                    let proven = split_head
                        || operand.kind() == SyntaxKind::Identifier && {
                            let symbol = self.symbol(operand);
                            self.var_defined.contains(&symbol)
                        };
                    let present = self.unions[union_id]
                        .arms
                        .iter()
                        .enumerate()
                        .filter(|(_, arm)| !matches!(arm, Type::Null | Type::Undefined | Type::Void))
                        .map(|(tag, arm)| (tag, arm.clone()))
                        .collect::<Vec<_>>();
                    if proven && let [(tag, arm)] = present.as_slice() {
                        // A flow fact (for example an `every` presence guard)
                        // proved this binding present: select its only
                        // represented arm with a checked narrow.
                        let narrowed = Expr::UnionNarrow {
                            union_id: format!("u{union_id}"),
                            tag: *tag,
                            value: Box::new(value),
                            r#type: arm.clone(),
                            loc: self.loc(node),
                        };
                        return self.coerce(narrowed, target, node);
                    }
                    if matches!(
                        operand.kind(),
                        SyntaxKind::ElementAccessExpression | SyntaxKind::CallExpression
                    ) && present.len() == 1
                    {
                        // `items[i]!` / `map.get(key)!`: the program asserts an
                        // indexed or looked-up value is present. Keep the
                        // owning handle and check it at the assertion: a
                        // present value keeps its identity, while an absent
                        // one raises a catchable TypeError instead of
                        // continuing with a value its static type excludes.
                        let dynamic = self.coerce(value, Type::Dyn, node)?;
                        return self.coerce(dynamic, target, node);
                    }
                    // A TypeScript non-null assertion does not remove null or
                    // undefined at runtime. Only project the owning union when
                    // a flow proof above established the active arm; otherwise
                    // the generic ABI projection can panic on a valid JS value.
                    let arms = self.unions[union_id].arms.clone();
                    return Err(self.refuse(
                        node,
                        &format!(
                            "non-null assertion needs a proven native union arm (represented arms {arms:?}, target {target:?})"
                        ),
                    ));
                }
                self.coerce(value, target, node)
            }
        }
    }

    /// An object literal whose keys cover the required fields of exactly one
    /// best-matching record arm (for example a JavaScript producer that adds
    /// properties its declaration omits). Build the complete owning object and
    /// expose that arm as a view over the same store, so no property is lost.
    fn object_literal_view_arm(
        &mut self,
        node: Node,
        union_id: usize,
    ) -> Result<Option<Expr>, String> {
        let mut keys = Vec::new();
        for property in node.properties() {
            let name = property.name();
            let simple = matches!(
                property.kind(),
                SyntaxKind::PropertyAssignment | SyntaxKind::ShorthandPropertyAssignment
            ) && matches!(name.kind(), SyntaxKind::Identifier | SyntaxKind::StringLiteral);
            if !simple {
                return Ok(None);
            }
            keys.push(name.text().to_string());
        }
        let accepts_undefined = |ty: &Type| match ty {
            Type::Dyn | Type::Undefined => true,
            Type::Union { union_id } => self.unions[*union_id].arms.contains(&Type::Undefined),
            _ => false,
        };
        let mut ranked = Vec::new();
        for (tag, arm) in self.unions[union_id].arms.iter().enumerate() {
            let Type::Record { shape_id } = arm else {
                continue;
            };
            let record = &self.records[*shape_id];
            if record.tuple || record.index_value.is_some() || self.callables.contains_key(shape_id) {
                continue;
            }
            let required_present = record
                .fields
                .iter()
                .all(|field| keys.contains(&field.name) || accepts_undefined(&field.r#type));
            if !required_present {
                continue;
            }
            let covered = keys
                .iter()
                .filter(|key| record.fields.iter().any(|field| field.name == **key))
                .count();
            ranked.push((covered, tag, arm.clone()));
        }
        let Some(best) = ranked.iter().map(|(covered, _, _)| *covered).max() else {
            return Ok(None);
        };
        let best = ranked
            .into_iter()
            .filter(|(covered, _, _)| *covered == best)
            .collect::<Vec<_>>();
        let [(_, tag, arm)] = best.as_slice() else {
            return Ok(None);
        };
        let object = self.dynamic_literal(node)?;
        let Ok(view) = self.coerce(object, arm.clone(), node) else {
            return Ok(None);
        };
        Ok(Some(Expr::UnionWrap {
            union_id: format!("u{union_id}"),
            tag: *tag,
            value: Box::new(view),
            r#type: Type::Union { union_id },
            loc: self.loc(node),
        }))
    }

    fn object_union_presence_choice(&mut self, node: Node, union_id: usize) -> Option<Type> {
        let mut present = HashMap::new();
        let mut has_spread = false;
        for property in node.properties() {
            if property.kind() == SyntaxKind::SpreadAssignment {
                // Named properties can still identify a unique discriminated
                // arm when a later spread only supplies optional fields. The
                // selected record lowering validates the spread itself, so it
                // remains responsible for rejecting extra or incompatible
                // values instead of making arm selection depend on them.
                has_spread = true;
                if let Ok(source) = self.ty(property.expression()) {
                    let shapes = match source {
                        Type::Record { shape_id } => vec![shape_id],
                        Type::Union { union_id } => self.unions[union_id]
                            .arms
                            .iter()
                            .filter_map(|arm| match arm {
                                Type::Record { shape_id } => Some(*shape_id),
                                _ => None,
                            })
                            .collect(),
                        _ => Vec::new(),
                    };
                    for shape_id in shapes {
                        let record = self.records[shape_id].clone();
                        if !record.tuple
                            && record.index_value.is_none()
                            && !self.callables.contains_key(&shape_id)
                            && !self.enum_shape(shape_id)
                        {
                            for field in record.fields {
                                present.entry(field.name).or_insert(Some(field.r#type));
                            }
                        }
                    }
                }
                continue;
            }
            let name = self.data_property_name(property.name())?;
            let value = match property.kind() {
                SyntaxKind::PropertyAssignment => property.initializer(),
                SyntaxKind::ShorthandPropertyAssignment => property.name(),
                SyntaxKind::MethodDeclaration => property,
                _ => return None,
            };
            let mut ty = self.ty(value).ok();
            if value.kind() == SyntaxKind::ArrowFunction
                && value.body().kind() != SyntaxKind::Block
                && let Some(Type::Func { params, rest, .. }) = ty.clone()
            {
                let body = primitives::primitive_source(value.body());
                let ret = if body.kind() == SyntaxKind::CallExpression
                    && body.expression().kind() == SyntaxKind::Identifier
                    && matches!(body.expression().text(), "parseFloat" | "parseInt")
                {
                    Some(Type::F64)
                } else {
                    self.ty(value.body()).ok()
                };
                if let Some(ret) = ret {
                    ty = Some(Type::Func {
                        params,
                        ret: Box::new(ret),
                        rest,
                    });
                }
            }
            present.insert(name, ty);
        }
        if has_spread && present.is_empty() {
            return None;
        }
        let contains_undefined = |ty: &Type| match ty {
            Type::Dyn | Type::Undefined => true,
            Type::Union { union_id } => self.unions[*union_id]
                .arms
                .iter()
                .any(|arm| *arm == Type::Undefined),
            _ => false,
        };
        let mut scored = Vec::new();
        for arm in &self.unions[union_id].arms {
            let Type::Record { shape_id } = arm else {
                continue;
            };
            let record = &self.records[*shape_id];
            if record.tuple
                || record.index_value.is_some()
                || self.callables.contains_key(shape_id)
                || self.enum_shape(*shape_id)
                || present
                    .keys()
                    .any(|name| !record.fields.iter().any(|field| &field.name == name))
                || record.fields.iter().any(|field| {
                    !present.contains_key(&field.name) && !contains_undefined(&field.r#type)
                })
            {
                continue;
            }
            let mismatch_score = record
                .fields
                .iter()
                .filter_map(|field| {
                    let source = present.get(&field.name)?.as_ref()?;
                    Some(flow_shape_distance(
                        source,
                        &field.r#type,
                        &self.records,
                        &self.unions,
                        0,
                    ))
                })
                .sum::<usize>()
                + record
                    .fields
                    .iter()
                    .filter(|field| !present.contains_key(&field.name))
                    .count();
            scored.push((mismatch_score, arm.clone()));
        }
        scored.sort_by_key(|(score, _)| *score);
        let (best, choice) = scored.first()?.clone();
        (scored.iter().filter(|(score, _)| *score == best).count() == 1).then_some(choice)
    }

    pub(super) fn array_asserted_live_element(&mut self, node: Node) -> bool {
        if node.kind() != SyntaxKind::NonNullExpression {
            return false;
        }
        let access = primitives::primitive_source(node);
        access.kind() == SyntaxKind::ElementAccessExpression
            && matches!(self.ty(access.expression()), Ok(Type::Array { .. }))
    }

    pub(super) fn asserted_map_get(&mut self, node: Node) -> bool {
        if node.kind() != SyntaxKind::NonNullExpression {
            return false;
        }
        let call = primitives::primitive_source(node);
        if call.kind() != SyntaxKind::CallExpression || call.arguments().len() != 1 {
            return false;
        }
        let member = call.expression();
        member.kind() == SyntaxKind::PropertyAccessExpression
            && member.name().text() == "get"
            && matches!(self.ty(member.expression()), Ok(Type::Map { .. }))
    }

    fn asserted_optional_binding(&mut self, node: Node) -> bool {
        if node.kind() != SyntaxKind::NonNullExpression {
            return false;
        }
        let value = primitives::primitive_source(node);
        if value.kind() != SyntaxKind::Identifier {
            return false;
        }
        let Ok(local) = self.binding(value) else {
            return false;
        };
        matches!(local.r#type, Type::Union { union_id }
            if self.unions[union_id].arms.iter().any(|arm| matches!(arm, Type::Null | Type::Undefined)))
    }

    fn array_guarded_live_property(&mut self, node: Node) -> bool {
        let node = primitives::primitive_source(node);
        if node.kind() != SyntaxKind::ConditionalExpression {
            return false;
        }
        let condition = primitives::primitive_source(node.condition());
        if condition.kind() == SyntaxKind::CallExpression && condition.arguments().len() == 1 {
            let callee = condition.expression();
            if callee.kind() == SyntaxKind::PropertyAccessExpression {
                let owner = self.symbol(callee.expression());
                let member = self.symbol(callee.name());
                if self.primitive_symbol(owner, "Array", None)
                    && self.primitive_symbol(member, "isArray", Some("ArrayConstructor"))
                    && matches!(
                        primitives::primitive_source(node.when_false()).kind(),
                        SyntaxKind::PropertyAccessExpression | SyntaxKind::ElementAccessExpression
                    )
                {
                    return true;
                }
            }
        }
        self.array_guarded_live_property(node.when_true())
            || self.array_guarded_live_property(node.when_false())
    }

    pub(super) fn record_literal(&mut self, node: Node, target: Type) -> Result<Expr, String> {
        let properties = node.properties().into_iter().collect::<Vec<_>>();
        if target == Type::Dyn {
            // An erased generic option object deliberately has no closed
            // layout. Preserve its complete own-property store, including
            // spreads and later expandos, rather than forcing it through the
            // closed-record construction path.
            return self.dynamic_literal(node);
        }
        let Type::Record { shape_id } = target else {
            return Err(self.refuse(
                node,
                &format!("record literal needs a closed shape, got {target:?}"),
            ));
        };
        let indexed = self.records[shape_id].index_value.is_some();
        if !indexed
            && properties.iter().all(|property| {
                matches!(
                    property.kind(),
                    SyntaxKind::PropertyAssignment | SyntaxKind::ShorthandPropertyAssignment
                ) && self.data_property_name(property.name()).is_some()
            })
            && properties.iter().any(|property| {
                if property.kind() != SyntaxKind::PropertyAssignment {
                    return false;
                }
                let initializer = property.initializer();
                self.array_guarded_live_property(initializer)
                    || self.asserted_map_get(initializer)
                    || self.asserted_optional_binding(initializer)
                    || (initializer.kind() == SyntaxKind::NonNullExpression
                        && matches!(
                            primitives::primitive_source(initializer).kind(),
                            SyntaxKind::PropertyAccessExpression
                                | SyntaxKind::ElementAccessExpression
                        ))
            })
        {
            // A checker-refined branch can read a live field whose value is
            // outside its declared type. Build the owning object before
            // installing the contextual record view, so the guard and later
            // dynamic observations see the actual JavaScript value.
            let value = self.dynamic_literal(node)?;
            return self.coerce(value, target, node);
        }
        if std::env::var_os("SCRIPTC_TRACE_EXPRESSIONS").is_some() {
            eprintln!(
                "scriptc: lowering record literal r{shape_id} indexed={indexed} fields={:?}",
                self.records[shape_id]
                    .fields
                    .iter()
                    .map(|field| (&field.name, &field.r#type))
                    .collect::<Vec<_>>()
            );
        }
        if properties.iter().any(|property| {
            matches!(
                property.kind(),
                SyntaxKind::PropertyAssignment | SyntaxKind::MethodDeclaration
            ) && property.name().kind() == SyntaxKind::ComputedPropertyName
        }) {
            // Computed keys are runtime values, not closed-layout slots.
            // Preserve key-before-value evaluation, then check/project the
            // completed JavaScript object into its contextual record type.
            let value = self.dynamic_literal(node)?;
            return self.coerce(value, target, node);
        }
        if !indexed
            && parameter_abi::is_javascript(node)
            && properties.iter().all(|property| {
                matches!(
                    property.kind(),
                    SyntaxKind::PropertyAssignment
                        | SyntaxKind::ShorthandPropertyAssignment
                        | SyntaxKind::MethodDeclaration
                ) && self.data_property_name(property.name()).is_some()
            })
        {
            let source = self.complete_literal_record_type(node, shape_id, &properties)?;
            if source != target && self.call_record_storage(&source, &target) {
                // JavaScript inference can describe a field as a union of
                // narrow record projections while the live shorthand binding
                // owns their field-wise joined record. Publish a literal shape
                // with that actual ABI so nested object identity is retained.
                return self.record_literal_fields(node, source, properties);
            }
            if source != target
                && ir::record_views::dynamic_view_pairs(
                    &source,
                    &target,
                    &self.records,
                    &self.unions,
                )
                .is_some()
            {
                // JavaScript/JSDoc code can use null as the pre-installation
                // value of a property whose declared public view is a concrete
                // object. Own the real nullable storage, then expose the
                // declared view through the existing checked shared-record
                // projection. Reads after installation retain the nominal ABI;
                // premature reads fail instead of manufacturing an instance.
                let value = self.record_literal_fields(node, source, properties)?;
                return self.coerce(value, target, node);
            }
        }
        let record = &self.records[shape_id];
        let has_extra = record.index_value.is_none()
            && properties.iter().any(|property| {
                matches!(
                    property.kind(),
                    SyntaxKind::PropertyAssignment
                        | SyntaxKind::ShorthandPropertyAssignment
                        | SyntaxKind::MethodDeclaration
                ) && self
                    .data_property_name(property.name())
                    .is_some_and(|name| {
                        !(name == "__proto__" && property.kind() == SyntaxKind::PropertyAssignment)
                            && !record.fields.iter().any(|field| field.name == name)
                    })
            });
        if has_extra {
            if properties
                .iter()
                .any(|property| property.kind() == SyntaxKind::SpreadAssignment)
            {
                // A spread can contribute runtime-only keys, while explicit
                // fields outside the contextual width must remain observable.
                // Let the dynamic object own the complete insertion-ordered
                // surface, then attach the checked record view required by the
                // consumer instead of inventing an incomplete closed owner.
                let value = self.dynamic_literal(node)?;
                return self.coerce(value, target, node);
            }
            let checked = self.ty(node)?;
            let source = if checked != target
                && matches!(checked, Type::Record { .. })
                && ir::record_views::view_pairs(&checked, &target, &self.records, &self.unions)
                    .is_some()
            {
                checked.clone()
            } else {
                self.complete_literal_record_type(node, shape_id, &properties)?
            };
            if source != target
                && ir::record_views::view_pairs(&source, &target, &self.records, &self.unions)
                    .is_some()
            {
                // Keep every source property in its complete owning
                // layout, then project a view without dropping keys.
                let value = self.record_literal(node, source)?;
                return self.coerce(value, target, node);
            }
        }
        if let Some(source) = self.instance_preserving_literal_type(node, target.clone())? {
            // A class instance can satisfy a public structural interface, but
            // copying it into that record would lose identity and its methods.
            // Let the enclosing literal own the concrete class ABI.
            return self.record_literal_fields(node, source, properties);
        }
        if properties
            .iter()
            .any(|p| p.kind() == SyntaxKind::SpreadAssignment)
        {
            if properties.iter().any(|property| {
                matches!(
                    property.kind(),
                    SyntaxKind::GetAccessor | SyntaxKind::SetAccessor
                )
            }) {
                // Preserve the dynamic object's descriptors and insertion order
                // while attaching the context's checked record view.
                let value = self.dynamic_accessor_literal(node)?;
                return self.coerce(value, target, node);
            }
            if indexed {
                return self.construct_dictionary_spread(node, target, properties);
            }
            return self.construct_record(node, target, properties);
        }
        self.record_literal_fields(node, target, properties)
    }

    pub(super) fn instance_preserving_literal_type(
        &mut self,
        node: Node,
        target: Type,
    ) -> Result<Option<Type>, String> {
        let Type::Record { shape_id } = target else {
            return Ok(None);
        };
        let properties = node.properties().into_iter().collect::<Vec<_>>();
        if self.records[shape_id].index_value.is_some()
            || !properties.iter().all(|property| {
                matches!(
                    property.kind(),
                    SyntaxKind::PropertyAssignment
                        | SyntaxKind::ShorthandPropertyAssignment
                        | SyntaxKind::MethodDeclaration
                ) && self.data_property_name(property.name()).is_some()
            })
        {
            return Ok(None);
        }
        let candidate = properties.iter().any(|property| {
            let name = self.data_property_name(property.name());
            let value = match property.kind() {
                SyntaxKind::PropertyAssignment => property.initializer(),
                SyntaxKind::ShorthandPropertyAssignment => property.name(),
                _ => Node::default(),
            };
            !value.is_nil()
                && value.kind() == SyntaxKind::Identifier
                && name.is_some_and(|name| {
                    self.records[shape_id]
                        .fields
                        .iter()
                        .find(|field| field.name == name)
                        .is_some_and(|field| matches!(field.r#type, Type::Record { .. }))
                })
        });
        if !candidate {
            return Ok(None);
        }
        let source = self.complete_literal_record_type(node, shape_id, &properties)?;
        let preserves_instance = match &source {
            Type::Record {
                shape_id: source_id,
            } if *source_id != shape_id => self.records[*source_id].fields.iter().any(|field| {
                matches!(field.r#type, Type::Object { .. })
                    && self.records[shape_id]
                        .fields
                        .iter()
                        .find(|target| target.name == field.name)
                        .is_some_and(|target| matches!(target.r#type, Type::Record { .. }))
            }),
            _ => false,
        };
        Ok(preserves_instance.then_some(source))
    }

    /// Contextual typing may report an object literal as exactly its narrower
    /// consumer type, hiding own properties that JavaScript still creates.
    /// Build an owning literal layout for those properties before projecting a
    /// structural view to the consumer record.
    fn complete_literal_record_type(
        &mut self,
        node: Node,
        target_id: usize,
        properties: &[Node],
    ) -> Result<Type, String> {
        let target = self.records[target_id].clone();
        let mut fields = Vec::new();
        let mut declared_order = Vec::new();
        for property in properties {
            if !matches!(
                property.kind(),
                SyntaxKind::PropertyAssignment
                    | SyntaxKind::ShorthandPropertyAssignment
                    | SyntaxKind::MethodDeclaration
            ) {
                return Err(self.refuse(*property, "literal width source requires named fields"));
            }
            let name = self.data_property_name(property.name()).ok_or_else(|| {
                self.refuse(*property, "literal width source requires static keys")
            })?;
            if name == "__proto__" && property.kind() == SyntaxKind::PropertyAssignment {
                let initializer = primitives::primitive_source(property.initializer());
                if initializer.kind() != SyntaxKind::NullKeyword {
                    return Err(self.refuse(
                        *property,
                        "only null-prototype object dictionaries are ported",
                    ));
                }
                continue;
            }
            if fields.iter().any(|field: &ir::Field| field.name == name) {
                return Err(self.refuse(*property, "duplicate record properties are not ported"));
            }
            let value = match property.kind() {
                SyntaxKind::PropertyAssignment => property.initializer(),
                SyntaxKind::ShorthandPropertyAssignment => property.name(),
                SyntaxKind::MethodDeclaration => *property,
                _ => unreachable!(),
            };
            let ty = if let Some(field) = target.fields.iter().find(|field| field.name == name) {
                let source = primitives::primitive_source(value);
                let unit = if source.kind() == SyntaxKind::NullKeyword {
                    Some(Type::Null)
                } else if source.kind() == SyntaxKind::Identifier && source.text() == "undefined" {
                    Some(Type::Undefined)
                } else {
                    None
                };
                if let Some(unit) = unit
                    && !self.native_type_contains(&field.r#type, |ty| *ty == unit)
                {
                    self.intern_union(vec![field.r#type.clone(), unit])
                        .unwrap_or(Type::Dyn)
                } else if value.kind() == SyntaxKind::Identifier {
                    let symbol = self.symbol(value);
                    let bound = self
                        .bindings
                        .get(&symbol)
                        .or_else(|| self.module_bindings.get(&symbol))
                        .map(|local| local.r#type.clone());
                    let live = matches!(field.r#type, Type::Record { .. })
                        .then(|| self.expression(value).ok().map(|value| value.ty()))
                        .flatten();
                    let actual = live
                        .or_else(|| self.var_types.get(&symbol).cloned())
                        .or_else(|| self.planned_local_storage.get(&symbol).cloned())
                        .or(bound);
                    actual
                        .filter(|actual| {
                            self.call_record_storage(actual, &field.r#type)
                                || matches!(
                                    (actual, &field.r#type),
                                    (Type::Object { .. }, Type::Record { .. })
                                )
                        })
                        .unwrap_or_else(|| field.r#type.clone())
                } else {
                    field.r#type.clone()
                }
            } else {
                self.ty(value).map_err(|error| {
                    format!("{error}; while inferring extra literal field {name:?}")
                })?
            };
            declared_order.push(name.clone());
            fields.push(ir::Field { name, r#type: ty });
        }
        // A width-preserving owner must also contain the complete contextual
        // layout.  Missing optional fields are materialized as absent slots by
        // `record_literal_fields`; required ones retain its ordinary error.
        // Keeping only the explicit properties here creates a narrow record
        // which cannot be viewed as the contextual target at all.
        for field in &target.fields {
            if !fields.iter().any(|candidate| candidate.name == field.name) {
                fields.push(field.clone());
            }
        }
        for name in &target.declared_order {
            if !declared_order.contains(name) {
                declared_order.push(name.clone());
            }
        }
        fields.sort_by(|a, b| a.name.cmp(&b.name));
        if let Some(record) = self
            .records
            .iter()
            .find(|record| !record.tuple && record.index_value.is_none() && record.fields == fields)
        {
            return Ok(Type::Record {
                shape_id: record.id,
            });
        }
        let shape_id = self.records.len();
        self.records.push(ir::Record {
            id: shape_id,
            fields,
            declared_order,
            tuple: false,
            index_value: None,
        });
        let _ = node;
        Ok(Type::Record { shape_id })
    }

    pub(super) fn record_literal_fields(
        &mut self,
        node: Node,
        target: Type,
        properties: Vec<Node>,
    ) -> Result<Expr, String> {
        let Type::Record { shape_id } = target else {
            return Err(self.refuse(node, "record literal needs a closed shape"));
        };
        if self.callables.contains_key(&shape_id)
            || self.enum_shape(shape_id)
            || self.is_data_view(&Type::Record { shape_id })
        {
            return Err(self.refuse(
                node,
                "data literals cannot manufacture callable or enum namespace identities",
            ));
        }
        let record = self.records[shape_id].clone();
        if record.tuple {
            return Err(self.refuse(node, "object literals cannot initialize tuple layouts"));
        }
        if properties.iter().any(|property| {
            matches!(
                property.kind(),
                SyntaxKind::GetAccessor | SyntaxKind::SetAccessor
            )
        }) {
            for property in &properties {
                if !matches!(
                    property.kind(),
                    SyntaxKind::GetAccessor
                        | SyntaxKind::SetAccessor
                        | SyntaxKind::PropertyAssignment
                        | SyntaxKind::ShorthandPropertyAssignment
                        | SyntaxKind::MethodDeclaration
                ) {
                    return Err(self.refuse(
                        *property,
                        "typed accessor literals support accessors and named data properties",
                    ));
                }
                let name = self.data_property_name(property.name()).ok_or_else(|| {
                    self.refuse(
                        *property,
                        "typed accessor literals require named properties",
                    )
                })?;
                if !record.fields.iter().any(|field| field.name == name)
                    && record.index_value.is_none()
                {
                    return Err(self.refuse(
                        *property,
                        &format!("record width projection does not define {name:?}"),
                    ));
                }
            }
            let value = self.dynamic_accessor_literal(node)?;
            return self.coerce(value, Type::Record { shape_id }, node);
        }
        let mut seen = HashSet::new();
        let mut fields = Vec::new();
        let mut null_prototype = false;
        for property in properties {
            if !matches!(
                property.kind(),
                SyntaxKind::PropertyAssignment
                    | SyntaxKind::ShorthandPropertyAssignment
                    | SyntaxKind::MethodDeclaration
            ) || self.data_property_name(property.name()).is_none()
            {
                return Err(self.refuse(property, "only named data properties are ported"));
            }
            let name = self.data_property_name(property.name()).unwrap();
            // __proto__ in colon notation sets a prototype, not an own slot.
            if name == "__proto__" && property.kind() == SyntaxKind::PropertyAssignment {
                let initializer = primitives::primitive_source(property.initializer());
                if initializer.kind() != SyntaxKind::NullKeyword
                    || record.tuple
                    || (record.index_value.is_some() && !record.fields.is_empty())
                {
                    return Err(self.refuse(
                        property,
                        "only null-prototype object dictionaries are ported",
                    ));
                }
                null_prototype = true;
                continue;
            }
            let field = record.fields.iter().find(|f| f.name == name);
            let target = field
                .map(|f| f.r#type.clone())
                .or_else(|| record.index_value.clone())
                .ok_or_else(|| {
                    let fields = record
                        .fields
                        .iter()
                        .map(|field| field.name.as_str())
                        .collect::<Vec<_>>()
                        .join(", ");
                    self.refuse(
                        property,
                        &format!(
                            "record width projection is not ported: r{shape_id} owns [{fields}] but the literal also defines {name:?}"
                        ),
                    )
                })?;
            if !seen.insert(name.clone()) {
                return Err(self.refuse(property, "duplicate record properties are not ported"));
            }
            let value = self
                .object_property_value(property, target.clone())
                .map_err(|error| {
                    format!(
                        "{error}; while initializing record r{shape_id} field {name:?} as {target:?}"
                    )
                })?;
            fields.push(ir::FieldInit {
                name,
                value,
                absent: false,
                overflow: field.is_none(),
            });
        }
        for field in &record.fields {
            if !seen.contains(&field.name) {
                let value = Expr::UnitLit {
                    unit: "undefined",
                    r#type: Type::Undefined,
                    loc: self.loc(node),
                };
                let value = self
                    .coerce(value, field.r#type.clone(), node)
                    .map_err(|error| {
                        format!(
                            "{error}; while representing absent field {:?} in record r{shape_id}",
                            field.name
                        )
                    })?;
                fields.push(ir::FieldInit {
                    name: field.name.clone(),
                    value,
                    absent: true,
                    overflow: false,
                });
            }
        }
        Ok(Expr::RecordLit {
            fields,
            null_prototype,
            r#type: target,
            loc: self.loc(node),
        })
    }

    pub(super) fn record_get(&mut self, node: Node) -> Result<Expr, String> {
        // `if (timer.unref && typeof timer.unref === 'function')`: a native
        // timer handle always owns its methods, so the read is truthy in a
        // pure condition position (never materialized as a stored value).
        if self.timer_callable_value(node) {
            let parent = node.parent();
            let condition = match parent.kind() {
                SyntaxKind::BinaryExpression => {
                    parent.left() == node
                        && matches!(
                            parent.operator_token().kind(),
                            SyntaxKind::AmpersandAmpersandToken | SyntaxKind::BarBarToken
                        )
                }
                SyntaxKind::PrefixUnaryExpression => parent.operator() == SyntaxKind::ExclamationToken,
                SyntaxKind::IfStatement | SyntaxKind::WhileStatement => parent.expression() == node,
                SyntaxKind::ConditionalExpression => parent.condition() == node,
                _ => false,
            };
            if condition {
                return Ok(Expr::BoolLit {
                    value: true,
                    r#type: Type::Bool,
                    loc: self.loc(node),
                });
            }
        }
        // `(error as { code?: string }).code`: the assertion has no runtime
        // effect, so an erased receiver (often a class instance such as an
        // Error) is read as an ordinary property, then checked as its view.
        let mut asserted = node.expression();
        while asserted.kind() == SyntaxKind::ParenthesizedExpression {
            asserted = asserted.expression();
        }
        if matches!(
            asserted.kind(),
            SyntaxKind::AsExpression | SyntaxKind::TypeAssertionExpression
        ) && self.ty(asserted.expression()).ok() == Some(Type::Dyn)
            && node.name().kind() == SyntaxKind::Identifier
        {
            let receiver = self.expression(asserted.expression())?;
            let receiver = self.coerce(receiver, Type::Dyn, asserted.expression())?;
            let key = Expr::StrLit {
                value: node.name().text().to_string(),
                r#type: Type::String,
                loc: self.loc(node.name()),
            };
            let value = self.dynamic_get(node, receiver, key);
            return match self.ty(node) {
                Ok(Type::Dyn) | Err(_) => Ok(value),
                Ok(view) => self.coerce(value, view, node),
            };
        }
        // `Error.prepareStackTrace` is declared as a method but is absent by
        // default (V8 hook). Read the live slot without its declared ABI.
        if node.name().text() == "prepareStackTrace"
            && node.expression().kind() == SyntaxKind::Identifier
            && {
                let symbol = self.symbol(node.expression());
                self.primitive_symbol(symbol, "Error", None)
            }
        {
            let receiver = self.expression(node.expression())?;
            let receiver = self.coerce(receiver, Type::Dyn, node.expression())?;
            let key = Expr::StrLit {
                value: "prepareStackTrace".into(),
                r#type: Type::String,
                loc: self.loc(node.name()),
            };
            return Ok(self.dynamic_get(node, receiver, key));
        }
        if let Some(value) = self.class_static_get(node)? {
            return Ok(value);
        }
        if let Some(value) = self.class_static_method_value(node)? {
            return Ok(value);
        }
        let obj = if node.expression().kind() == SyntaxKind::SuperKeyword {
            self.static_super_receiver(node)?
        } else {
            self.expression(node.expression())?
        };
        let obj = self.live_member_receiver(node.expression(), obj);
        let obj = if obj.ty() == Type::Caught {
            // Catch bindings retain the runtime's complete thrown value. A
            // property read observes that native value just like an `any`
            // receiver instead of demanding a statically closed record.
            Expr::CaughtToDyn {
                value: Box::new(obj),
                r#type: Type::Dyn,
                loc: self.loc(node.expression()),
            }
        } else {
            obj
        };
        let obj = if matches!(obj.ty(), Type::Union { .. }) {
            // Property access is a flow-sensitive boundary. In particular,
            // a switch over a discriminant gives each case a concrete record
            // view even though the lexical cell keeps its owning tagged union.
            // Select that arm before requiring a field common to every arm.
            self.narrowed(obj, node.expression())?
        } else {
            obj
        };
        if obj.ty() == Type::Dyn || matches!(obj.ty(), Type::Func { .. } | Type::Classval { .. }) {
            let parent = node.parent();
            if obj.ty() == Type::Dyn
                && !(parent.kind() == SyntaxKind::CallExpression && parent.expression() == node)
            {
                self.classes
                    .note_dynamic_method_extraction(node.name().text());
            }
            if matches!(obj.ty(), Type::Func { .. } | Type::Classval { .. }) {
                self.function_data_key(node, node.name().text())?;
            }
            let class = matches!(obj.ty(), Type::Classval { .. });
            let obj = self.class_data_receiver(obj, node.name().text(), node)?;
            if let Expr::DynFrom { value: source, .. } = &obj {
                self.classes.defer_dynamic_method_for_type(
                    &source.ty(),
                    node.name().text(),
                    &self.unions,
                );
            }
            let key = Expr::StrLit {
                value: node.name().text().into(),
                r#type: Type::String,
                loc: self.loc(node),
            };
            let value = self.dynamic_get(node, obj, key);
            return if class {
                if self.static_forward_read(node) {
                    return Err(self.refuse(
                        node,
                        "static field read before initialization needs an undefined-aware contract",
                    ));
                }
                let ty = self.ty(node).or_else(|error| {
                    let checked = self.checker.get_type_at_location(node);
                    if self
                        .checker
                        .get_signatures_of_type(
                            checked,
                            source_frontend::prelude::SignatureKind::CALL,
                        )
                        .is_empty()
                    {
                        Err(error)
                    } else {
                        // Callable data attached to a class value has a
                        // shared property store even when its inferred JS
                        // signature has no fixed native layout.
                        Ok(Type::Dyn)
                    }
                })?;
                let finite_constructors = matches!(ty, Type::Union { union_id }
                    if self.unions[union_id].arms.len() >= 2
                        && self.unions[union_id].arms.iter().all(|arm| matches!(arm, Type::Classval { .. })));
                if !finite_constructors
                    && self.native_type_contains(&ty, |part| matches!(part, Type::Classval { .. }))
                {
                    return Err(self.refuse(node, "mutable class constructor properties require dynamic construction identity"));
                }
                self.coerce(value, ty, node)
            } else {
                Ok(value)
            };
        }
        if self.array_view(&obj.ty()) && node.name().text() == "length" {
            return self.array_length(node, obj);
        }
        if matches!(obj.ty(), Type::Union { .. }) {
            if self.nullable_record(&obj.ty()).is_some() {
                return self.nullable_record_get(node, obj);
            }
            self.classes
                .defer_dynamic_method_for_type(&obj.ty(), node.name().text(), &self.unions);
            return self.union_record_get(node, obj, node.name().text());
        }
        if matches!(obj.ty(), Type::Map { .. }) && node.name().text() == "size" {
            return self.map_intrinsic(node, obj, "size", vec![]);
        }
        if matches!(obj.ty(), Type::Set { .. }) && node.name().text() == "size" {
            return self.set_intrinsic(node, obj, "size", vec![]);
        }
        // Unchecked JavaScript can read a member its primitive view does not
        // declare (`entry.getFileName` where the checker says string). That
        // read is an ordinary property lookup on the boxed primitive.
        if matches!(obj.ty(), Type::String | Type::F64 | Type::Bool)
            && parameter_abi::is_javascript(node)
            && self.symbol(node.name()) == 0
        {
            let receiver = self.coerce(obj, Type::Dyn, node.expression())?;
            let key = Expr::StrLit {
                value: node.name().text().to_string(),
                r#type: Type::String,
                loc: self.loc(node.name()),
            };
            return Ok(self.dynamic_get(node, receiver, key));
        }
        let Type::Record { shape_id } = obj.ty() else {
            let checked = self.ty(node.expression()).ok();
            let alias_source = if node.expression().kind() == SyntaxKind::Identifier {
                let symbol = self.symbol(node.expression());
                let declaration = (symbol != 0)
                    .then(|| {
                        self.checker
                            .sym(source_frontend::prelude::SymbolId(symbol))
                            .value_declaration
                    })
                    .filter(|declaration| {
                        !declaration.is_nil()
                            && declaration.kind() == SyntaxKind::VariableDeclaration
                    });
                declaration.and_then(|declaration| {
                    let initial = receivers::reference_node(declaration.initializer());
                    if initial.is_nil() || initial.kind() != SyntaxKind::Identifier {
                        return None;
                    }
                    let source = self.symbol(initial);
                    self.bindings
                        .get(&source)
                        .or_else(|| self.module_bindings.get(&source))
                        .or_else(|| self.outer.iter().rev().find_map(|scope| scope.get(&source)))
                        .map(|local| format!("{}: {:?}", initial.text(), local.r#type))
                })
            } else {
                None
            };
            let storage_detail = if node.expression().kind() == SyntaxKind::Identifier {
                let symbol = self.symbol(node.expression());
                let declaration = (symbol != 0)
                    .then(|| {
                        self.checker
                            .sym(source_frontend::prelude::SymbolId(symbol))
                            .value_declaration
                    })
                    .filter(|declaration| !declaration.is_nil());
                let binding = self
                    .bindings
                    .get(&symbol)
                    .or_else(|| self.outer.iter().rev().find_map(|scope| scope.get(&symbol)))
                    .map(|local| local.r#type.clone());
                let planned = self.planned_local_storage.get(&symbol).cloned();
                let owned = self.var_types.get(&symbol).cloned();
                let initializer = declaration
                    .map(|declaration| declaration.initializer())
                    .filter(|initializer| !initializer.is_nil());
                let initializer_view =
                    initializer.and_then(|initializer| self.ty(initializer).ok());
                Some(format!(
                    "symbol={symbol}, binding={:?}, planned={:?}, owned={:?}, declaration={:?}, initializer={:?}/{:?}, initializer_view={:?}",
                    binding,
                    planned,
                    owned,
                    declaration.map(Node::kind),
                    initializer.map(Node::kind),
                    initializer.map(|initializer| initializer.text().to_string()),
                    initializer_view,
                ))
            } else {
                None
            };
            return Err(self.refuse(
                node,
                &format!(
                    "property receiver has no closed record representation: {:?}; checker view: {:?}; receiver: {}; alias source: {:?}; storage: {:?}",
                    obj.ty(),
                    checked,
                    node.expression().text(),
                    alias_source,
                    storage_detail,
                ),
            ));
        };
        if self.records[shape_id].tuple && node.name().text() == "length" {
            let helper =
                helpers::Helper::new("tuple_length", vec![obj.ty()], Type::F64, self.loc(node));
            let mut function = helper.function;
            function.body.push(Stmt::Return {
                value: Some(Expr::NumLit {
                    value: self.records[shape_id].fields.len() as f64,
                    spelling: None,
                    r#type: Type::F64,
                    loc: self.loc(node),
                }),
                loc: self.loc(node),
            });
            let callee = self.install_helper(function);
            return Ok(Expr::Call {
                callee,
                args: vec![obj],
                r#type: Type::F64,
                loc: self.loc(node),
            });
        }
        let field = self.records[shape_id]
            .fields
            .iter()
            .find(|f| f.name == node.name().text())
            .cloned();
        let Some(field) = field else {
            if self.records[shape_id].index_value.is_some() {
                let key = Expr::StrLit {
                    value: node.name().text().into(),
                    r#type: Type::String,
                    loc: self.loc(node),
                };
                return self.dictionary_get(node, obj, key);
            }
            let shape = &self.records[shape_id];
            if shape.tuple || self.enum_shape(shape_id) || self.callables.contains_key(&shape_id) {
                return Err(self.refuse(node, "unknown native record field"));
            }
            let obj = self.coerce(obj, Type::Dyn, node)?;
            let key = Expr::StrLit {
                value: node.name().text().into(),
                r#type: Type::String,
                loc: self.loc(node),
            };
            return Ok(self.dynamic_get(node, obj, key));
        };
        if std::env::var_os("SCRIPTC_TRACE_CALL_TARGETS").is_some()
            && node.parent().kind() == SyntaxKind::CallExpression
        {
            eprintln!(
                "scriptc: record call field r{} {} type={:?} callable={:?}",
                shape_id,
                field.name,
                field.r#type,
                match &field.r#type {
                    Type::Record { shape_id } => self.callables.get(shape_id),
                    _ => None,
                }
            );
        }
        let value = Expr::RecordGet {
            obj: Box::new(obj),
            shape_id: format!("r{shape_id}"),
            field: field.name.clone(),
            r#type: field.r#type.clone(),
            loc: self.loc(node),
        };
        let owning_call_argument = node.parent().kind() == SyntaxKind::CallExpression
            && node
                .parent()
                .arguments()
                .into_iter()
                .any(|argument| argument == node)
            && matches!(value.ty(), Type::Union { .. })
            && self.planned_argument_type(node).as_ref() == Some(&value.ty());
        let callable_value = match value.ty() {
            Type::Func { .. } | Type::Dyn => true,
            Type::Record { shape_id } => self.callables.contains_key(&shape_id),
            _ => false,
        };
        let callable_without_checker_view = callable_value && self.ty(node).is_err();
        if owning_call_argument
            || callable_without_checker_view
            || (self.planned_field_read(node) && !self.directly_truthy_selected_property(node))
            || (parameter_abi::is_javascript(node)
                && matches!(value.ty(), Type::Func { .. })
                && self
                    .ty(node)
                    .is_ok_and(|ty| matches!(ty, Type::Func { .. })))
        {
            Ok(value)
        } else {
            self.narrowed(value, node)
        }
    }

    pub(super) fn record_set(&mut self, node: Node) -> Result<Stmt, String> {
        self.guard_raw_json_write(node)?;
        let member = node.left();
        if member.name().text() == "__proto__" {
            return Err(self.refuse(member, "ordinary prototype writes are not ported"));
        }
        let obj = self.expression(member.expression())?;
        let obj = self.live_member_receiver(member.expression(), obj);
        if self.nullable_record(&obj.ty()).is_some() {
            return self.nullable_record_set(node, obj);
        }
        if let Type::Union { union_id } = obj.ty()
            && self.unions[union_id].arms.iter().all(|arm| {
                matches!(arm, Type::Record { shape_id }
                    if !self.records[*shape_id].tuple
                        && (self.records[*shape_id].index_value.is_none()
                            || self.records[*shape_id].fields.is_empty()))
            })
        {
            // Plain record views share one owning property store. A write to
            // a field not common to every checker arm still mutates that same
            // JavaScript object; perform it through the erased view and let
            // later typed reads validate their requested field ABI.
            let obj = self.coerce(obj, Type::Dyn, member.expression())?;
            let key = Expr::StrLit {
                value: member.name().text().into(),
                r#type: Type::String,
                loc: self.loc(member),
            };
            return self.dynamic_property_set(node, obj, key);
        }
        if member.name().text() == "length" {
            let array = match obj.ty() {
                Type::Array { .. } => Some(obj.clone()),
                Type::Union { union_id } => {
                    let arrays = self.unions[union_id]
                        .arms
                        .iter()
                        .filter(|arm| matches!(arm, Type::Array { .. }))
                        .cloned()
                        .collect::<Vec<_>>();
                    let only_array_or_absent = self.unions[union_id].arms.iter().all(|arm| {
                        matches!(arm, Type::Array { .. } | Type::Null | Type::Undefined)
                    });
                    if only_array_or_absent {
                        if let [target] = arrays.as_slice() {
                            let erased =
                                self.coerce(obj.clone(), Type::Dyn, member.expression())?;
                            Some(self.coerce(erased, target.clone(), member.expression())?)
                        } else {
                            None
                        }
                    } else {
                        None
                    }
                }
                _ => None,
            };
            if let Some(array) = array {
                let length = self.expected_expression(node.right(), Type::F64)?;
                return Ok(self.source_array_set_length(node, array, length));
            }
        }
        if let Type::Object { class_name } = obj.ty() {
            let field = member.name().text().to_string();
            let storage = self
                .ensure_contract_field(&class_name, &field, member)?
                .ok_or_else(|| self.refuse(member, "class assignment field is not represented"))?;
            let value = self.expected_expression(node.right(), storage)?;
            return Ok(Stmt::FieldSet {
                obj,
                class_name,
                field,
                value,
                loc: self.loc(node),
            });
        }
        if obj.ty() == Type::Dyn
            || matches!(obj.ty(), Type::Func { .. })
            || matches!(obj.ty(), Type::Classval { .. })
            || matches!(obj.ty(), Type::Array { elem } if *elem == Type::Dyn)
        {
            if matches!(obj.ty(), Type::Func { .. } | Type::Classval { .. }) {
                self.function_data_key(member, member.name().text())?;
            }
            let obj = self.class_data_receiver(obj, member.name().text(), node)?;
            let key = Expr::StrLit {
                value: member.name().text().into(),
                r#type: Type::String,
                loc: self.loc(member),
            };
            return self.dynamic_property_set(node, obj, key);
        }
        let actual = obj.ty();
        let Type::Record { shape_id } = actual else {
            let detail = if let Type::Union { union_id } = actual {
                format!(
                    "Union {{ union_id: {union_id}, arms: {:?} }}",
                    self.unions[union_id].arms
                )
            } else {
                format!("{actual:?}")
            };
            return Err(self.refuse(
                node,
                &format!("property assignment requires a closed record, got {detail}"),
            ));
        };
        let field = self.records[shape_id]
            .fields
            .iter()
            .find(|f| f.name == member.name().text())
            .cloned();
        let Some(field) = field else {
            if self.records[shape_id].index_value.is_some() {
                return self.dictionary_set_value(node, obj);
            }
            let shape = &self.records[shape_id];
            if shape.tuple || self.enum_shape(shape_id) || self.callables.contains_key(&shape_id) {
                return Err(self.refuse(member, "unknown native record field"));
            }
            let obj = self.coerce(obj, Type::Dyn, member)?;
            let key = Expr::StrLit {
                value: member.name().text().into(),
                r#type: Type::String,
                loc: self.loc(member),
            };
            return self.dynamic_property_set(node, obj, key);
        };
        if !receivers::strict(node) {
            let obj = self.coerce(obj, Type::Dyn, member)?;
            let key = Expr::StrLit {
                value: field.name,
                r#type: Type::String,
                loc: self.loc(member),
            };
            return self.dynamic_property_set(node, obj, key);
        }
        let value = self.expected_expression(node.right(), field.r#type)?;
        Ok(Stmt::RecordSet {
            obj,
            shape_id: format!("r{shape_id}"),
            field: field.name,
            value,
            loc: self.loc(node),
        })
    }

    pub(super) fn dynamic_property_set(
        &mut self,
        node: Node,
        obj: Expr,
        key: Expr,
    ) -> Result<Stmt, String> {
        if matches!(&key, Expr::StrLit { value, .. } if value == "__proto__") {
            return Err(self.refuse(node, "dynamic prototype writes are not ported"));
        }
        let value = self.expected_expression(node.right(), Type::Dyn)?;
        self.checked_dynamic_property_set(node, obj, key, value)
    }

    pub(super) fn binary(&mut self, node: Node, op: &str) -> Result<Expr, String> {
        if matches!(op, "===" | "!==")
            && let Some(direct) = self.direct_entry_comparison(node)
        {
            return Ok(Expr::BoolLit {
                value: if op == "!==" { !direct } else { direct },
                r#type: Type::Bool,
                loc: self.loc(node),
            });
        }
        if matches!(op, "==" | "!=") {
            for (value, unit) in [(node.left(), node.right()), (node.right(), node.left())] {
                if primitives::primitive_source(unit).kind() == SyntaxKind::NullKeyword {
                    // Standard String prototype methods are present in every
                    // supported native runtime. Prove the common feature-test
                    // shape directly instead of fabricating an extracted
                    // method value whose JavaScript `this` ABI is not ported.
                    // Writes to the standard prototype remain an explicit
                    // boundary, so an accepted program cannot invalidate this
                    // result before the comparison executes.
                    if self.standard_string_prototype_member(value) {
                        return Ok(Expr::BoolLit {
                            value: op == "!=",
                            r#type: Type::Bool,
                            loc: self.loc(node),
                        });
                    }
                    // Nullish equality does not invoke ToPrimitive. Observe
                    // the live owning tag once, including a stale checker view.
                    let value = self.condition_value(value)?;
                    let value = self.primitive_capture(value, node)?;
                    return Ok(Expr::DynTest {
                        value: Box::new(self.coerce(value, Type::Dyn, node)?),
                        test: "nullish".into(),
                        negated: op == "!=",
                        r#type: Type::Bool,
                        loc: self.loc(node),
                    });
                }
            }
        }
        if matches!(op, "<" | "<=" | ">" | ">=") {
            return self.relational(node, op);
        }
        if op == "in" {
            return self.object_presence(node);
        }
        if matches!(op, "&&" | "||" | "??") {
            return self.logical(node, op);
        }
        if matches!(op, "===" | "!==" | "==" | "!=") {
            let negated = matches!(op, "!==" | "!=");
            for (test, kind) in [(node.left(), node.right()), (node.right(), node.left())] {
                if test.kind() == SyntaxKind::TypeOfExpression
                    && kind.kind() == SyntaxKind::StringLiteral
                {
                    let operand = primitives::primitive_source(test.expression());
                    if operand.kind() == SyntaxKind::Identifier
                        && matches!(operand.text(), "globalThis" | "global")
                    {
                        let equal = kind.text() == "object";
                        return Ok(Expr::BoolLit {
                            value: if negated { !equal } else { equal },
                            r#type: Type::Bool,
                            loc: self.loc(node),
                        });
                    }
                    if operand.kind() == SyntaxKind::Identifier
                        && self.commonjs_binding(operand).is_some()
                    {
                        let equal = kind.text() == "object";
                        return Ok(Expr::BoolLit {
                            value: if negated { !equal } else { equal },
                            r#type: Type::Bool,
                            loc: self.loc(node),
                        });
                    }
                    if self
                        .native_namespace(operand)
                        .is_some_and(|module| matches!(module, "Bun" | "process"))
                    {
                        let equal = kind.text() == "object";
                        return Ok(Expr::BoolLit {
                            value: if negated { !equal } else { equal },
                            r#type: Type::Bool,
                            loc: self.loc(node),
                        });
                    }
                    if self.standard_performance_value(operand) {
                        let equal = kind.text() == "object";
                        return Ok(Expr::BoolLit {
                            value: if negated { !equal } else { equal },
                            r#type: Type::Bool,
                            loc: self.loc(node),
                        });
                    }
                    if self.standard_buffer_value(test.expression())
                        || self.standard_bigint_value(test.expression())
                        || self.standard_constructor_typeof(test.expression())
                        || self.native_callable_value(test.expression())
                    {
                        let equal = kind.text() == "function";
                        return Ok(Expr::BoolLit {
                            value: if negated { !equal } else { equal },
                            r#type: Type::Bool,
                            loc: self.loc(node),
                        });
                    }
                    if self.unavailable_ambient_typeof(test.expression()) {
                        let equal = kind.text() == "undefined";
                        return Ok(Expr::BoolLit {
                            value: if negated { !equal } else { equal },
                            r#type: Type::Bool,
                            loc: self.loc(node),
                        });
                    }
                    let value = self.condition_value(test.expression())?;
                    if value.ty() == Type::Dyn
                        && matches!(
                            kind.text(),
                            "bigint"
                                | "number"
                                | "string"
                                | "boolean"
                                | "symbol"
                                | "undefined"
                                | "object"
                                | "function"
                        )
                    {
                        return Ok(Expr::DynTest {
                            value: Box::new(value),
                            test: kind.text().into(),
                            negated,
                            r#type: Type::Bool,
                            loc: self.loc(node),
                        });
                    }
                }
            }
        }
        // Equality observes the live cell, including tags changed by a call
        // or a previous loop iteration. A checker projection can be stale.
        let mut left = if matches!(op, "===" | "!==") {
            self.condition_value(node.left())?
        } else {
            self.expression(node.left())?
        };
        let mut right = if matches!(op, "===" | "!==") {
            self.condition_value(node.right())?
        } else {
            self.expression(node.right())?
        };
        if matches!(op, "==" | "!=") && (left.ty() == Type::Dyn || right.ty() == Type::Dyn) {
            return Ok(Expr::DynLooseEq {
                left: Box::new(self.coerce(left, Type::Dyn, node.left())?),
                right: Box::new(self.coerce(right, Type::Dyn, node.right())?),
                negated: op == "!=",
                r#type: Type::Bool,
                loc: self.loc(node),
            });
        }
        if op == "+" && (left.ty() == Type::String || right.ty() == Type::String) {
            return self.string_addition(left, right, node);
        }
        if matches!(op, "+" | "-" | "*" | "/" | "%" | "**" | "&" | "|" | "^" | "<<" | ">>" | ">>>")
            && left.ty() == Type::F64 && right.ty() == Type::F64
        {
            // Typed views can hold values outside the checker projection,
            // including an asserted destructuring result that is undefined.
            // JS numeric operators convert the owning value rather than first
            // requiring the static numeric payload.
            let raw_left = self.raw_record_field(&left, node.left())
                .or_else(|| self.raw_array_element(&left, node.left()))
                .or_else(|| self.raw_primitive_projection(&left));
            let raw_right = self.raw_record_field(&right, node.right())
                .or_else(|| self.raw_array_element(&right, node.right()))
                .or_else(|| self.raw_primitive_projection(&right));
            if raw_left.is_some() || raw_right.is_some() {
                return self.numeric_binary(raw_left.unwrap_or(left), raw_right.unwrap_or(right), op, node);
            }
        }
        if matches!(op, "===" | "!==")
            && self.is_data_view(&left.ty())
            && self.is_data_view(&right.ty())
        {
            let boxed_view = |value, site| Expr::DynFrom {
                value: Box::new(self.data_view_storage(site, value)),
                r#type: Type::Dyn,
                loc: self.loc(site),
            };
            return Ok(Expr::DynScalarEq {
                left: Box::new(boxed_view(left, node.left())),
                right: Box::new(boxed_view(right, node.right())),
                negated: op == "!==",
                r#type: Type::Bool,
                loc: self.loc(node),
            });
        }
        if matches!(op, "===" | "!==")
            && let (Type::Map { key: left_key, .. }, Type::Map { key: right_key, .. }) =
                (left.ty(), right.ty())
            && left_key == right_key
        {
            let same = Expr::LibCall {
                r#fn: "map.sameIdentity".into(),
                args: vec![left, right],
                r#type: Type::Bool,
                loc: self.loc(node),
            };
            return if op == "!==" {
                Ok(Expr::Unary {
                    op: "!".into(),
                    operand: Box::new(same),
                    r#type: Type::Bool,
                    loc: self.loc(node),
                })
            } else {
                Ok(same)
            };
        }
        let data_records = |ty: Type| {
            let arms = match ty.clone() {
                Type::Union { union_id } => self.unions[union_id].arms.clone(),
                ty => vec![ty],
            };
            !ir::contains_set(&ty, &self.records, &self.unions) && arms.iter().all(|ty| matches!(ty, Type::Record { shape_id } if !self.records[*shape_id].tuple && self.records[*shape_id].index_value.is_none() && !self.records[*shape_id].fields.iter().any(|f| f.name == callables::CALL_FIELD)))
        };
        if matches!(op, "===" | "!==")
            && left.ty() == right.ty()
            && matches!(left.ty(), Type::Record { .. })
            && data_records(left.ty())
        {
            // Compare the owning record handles directly. Dynamic boxing can
            // copy records in a backend and would change object identity.
            let union = self.intern_union(vec![left.ty(), Type::Undefined]).unwrap();
            let Type::Union { union_id } = union else {
                unreachable!()
            };
            return Ok(Expr::UnionEq {
                union_id: format!("u{union_id}"),
                negated: op == "!==",
                same_value: false,
                left: Box::new(self.coerce(left, union.clone(), node.left())?),
                right: Box::new(self.coerce(right, union, node.right())?),
                r#type: Type::Bool,
                loc: self.loc(node),
            });
        }
        if matches!(op, "===" | "!==") && data_records(left.ty()) && data_records(right.ty()) {
            return Ok(Expr::DynScalarEq {
                left: Box::new(self.coerce(left, Type::Dyn, node.left())?),
                right: Box::new(self.coerce(right, Type::Dyn, node.right())?),
                negated: op == "!==",
                r#type: Type::Bool,
                loc: self.loc(node),
            });
        }
        if matches!(op, "===" | "!==")
            && let (Type::Classval { .. }, Type::Classval { .. }) = (left.ty(), right.ty())
        {
            // A class layout can have multiple runtime identities when it is
            // produced by a factory. Compare the owning values after both TDZ
            // checks instead of folding equal Classval layouts to `true`.
            let mut helper = helpers::Helper::new(
                "class_identity_equal",
                vec![left.ty(), right.ty()],
                Type::Bool,
                self.loc(node),
            );
            helper.function.body.push(Stmt::Return {
                value: Some(Expr::Bin {
                    op: if op == "!==" { "!==" } else { "===" }.into(),
                    left: Box::new(helper.read(&helper.param(0))),
                    right: Box::new(helper.read(&helper.param(1))),
                    r#type: Type::Bool,
                    loc: helper.loc(),
                }),
                loc: helper.loc(),
            });
            let callee = self.install_helper(helper.function);
            return Ok(Expr::Call {
                callee,
                args: vec![left, right],
                r#type: Type::Bool,
                loc: self.loc(node),
            });
        }
        if matches!(op, "===" | "!==") && (left.ty() == Type::Dyn || right.ty() == Type::Dyn) {
            return Ok(Expr::DynScalarEq {
                left: Box::new(self.coerce(left, Type::Dyn, node.left())?),
                right: Box::new(self.coerce(right, Type::Dyn, node.right())?),
                negated: op == "!==",
                r#type: Type::Bool,
                loc: self.loc(node),
            });
        }
        if matches!(op, "===" | "!==")
            && matches!(left.ty(), Type::Func { .. })
            && matches!(right.ty(), Type::Func { .. })
            && left.ty() != right.ty()
        {
            // Function identity is independent of the native call signature.
            // Use the owning callable identity when no shared typed ABI exists.
            return Ok(Expr::DynScalarEq {
                left: Box::new(self.coerce(left, Type::Dyn, node.left())?),
                right: Box::new(self.coerce(right, Type::Dyn, node.right())?),
                negated: op == "!==",
                r#type: Type::Bool,
                loc: self.loc(node),
            });
        }
        if matches!(op, "===" | "!==") {
            if matches!(left.ty(), Type::Func { .. }) {
                right = self.callable_body(right, node.right())?;
            } else if matches!(right.ty(), Type::Func { .. }) {
                left = self.callable_body(left, node.left())?;
            }
            if matches!(left.ty(), Type::Func { .. })
                && matches!(right.ty(), Type::Func { .. })
                && left.ty() != right.ty()
            {
                // Extracting a callable-record body can reveal a function ABI
                // only after the first direct-function comparison above. Its
                // object identity is still shared with the record facade, so
                // compare the owning callable values instead of attempting an
                // arity coercion solely for strict equality.
                return Ok(Expr::DynScalarEq {
                    left: Box::new(self.coerce(left, Type::Dyn, node.left())?),
                    right: Box::new(self.coerce(right, Type::Dyn, node.right())?),
                    negated: op == "!==",
                    r#type: Type::Bool,
                    loc: self.loc(node),
                });
            }
        }
        if matches!(op, "===" | "!==") {
            // Shared IR binary equality is numeric/reference-layout-specific.
            // Regex identity already has a portable union equality contract.
            if left.ty() == right.ty()
                && matches!(
                    left.ty(),
                    Type::Regex | Type::Symbol | Type::Classval { .. }
                )
            {
                let union = self.intern_union(vec![left.ty(), Type::Undefined]).unwrap();
                let Type::Union { union_id } = union else {
                    unreachable!()
                };
                return Ok(Expr::UnionEq {
                    union_id: format!("u{union_id}"),
                    negated: op == "!==",
                    same_value: false,
                    left: Box::new(self.coerce(left, union.clone(), node.left())?),
                    right: Box::new(self.coerce(right, union, node.right())?),
                    r#type: Type::Bool,
                    loc: self.loc(node),
                });
            }
            if matches!(left.ty(), Type::Object { .. })
                && matches!(right.ty(), Type::Object { .. })
                && left.ty() != right.ty()
            {
                let (Type::Object { class_name: a }, Type::Object { class_name: b }) =
                    (left.ty(), right.ty())
                else {
                    unreachable!()
                };
                let common = self.classes.layouts.iter().flatten().find(|class| {
                    self.classes.subclass(&a, &class.name) && self.classes.subclass(&b, &class.name)
                });
                if let Some(common) = common {
                    let root = Type::Object {
                        class_name: common.name.clone(),
                    };
                    left = self.coerce(left, root.clone(), node.left())?;
                    right = self.coerce(right, root, node.right())?;
                } else {
                    return Ok(Expr::DynScalarEq {
                        left: Box::new(self.coerce(left, Type::Dyn, node.left())?),
                        right: Box::new(self.coerce(right, Type::Dyn, node.right())?),
                        negated: op == "!==",
                        r#type: Type::Bool,
                        loc: self.loc(node),
                    });
                }
            }
            if matches!(left, Expr::UnitLit { .. }) && matches!(right, Expr::UnitLit { .. }) {
                return Ok(Expr::BoolLit {
                    value: (left.ty() == right.ty()) != (op == "!=="),
                    r#type: Type::Bool,
                    loc: self.loc(node),
                });
            }
            // Only unit comparisons can become tag tests: comparing two
            // payload values requires JS equality, not tag equality.
            let mut test = None;
            for (value, unit) in [(&left, &right), (&right, &left)] {
                if let Type::Union { union_id } = value.ty()
                    && matches!(unit, Expr::UnitLit { .. })
                    && let Some(tag) = self.unions[union_id]
                        .arms
                        .iter()
                        .position(|a| *a == unit.ty())
                {
                    test = Some((union_id, tag));
                }
            }
            if let Some((union_id, tag)) = test {
                return Ok(Expr::UnionIsTag {
                    union_id: format!("u{union_id}"),
                    tag,
                    negated: op == "!==",
                    value: Box::new(if matches!(left, Expr::UnitLit { .. }) {
                        right
                    } else {
                        left
                    }),
                    r#type: Type::Bool,
                    loc: self.loc(node),
                });
            }
            for (value, unit) in [(left.clone(), &right), (right.clone(), &left)] {
                if let Type::Union { union_id } = value.ty()
                    && matches!(unit, Expr::UnitLit { .. })
                    && !self.unions[union_id].arms.contains(&unit.ty())
                {
                    // The owning union proves this strict comparison cannot
                    // match, but the value expression must still run once.
                    return Ok(Expr::Sequence {
                        stmts: vec![Stmt::Expression {
                            expr: value,
                            loc: self.loc(node),
                        }],
                        result: Box::new(Expr::BoolLit {
                            value: op == "!==",
                            r#type: Type::Bool,
                            loc: self.loc(node),
                        }),
                        r#type: Type::Bool,
                        loc: self.loc(node),
                    });
                }
            }
            if (matches!(left, Expr::UnitLit { .. }) || matches!(right, Expr::UnitLit { .. }))
                && !matches!(left.ty(), Type::Union { .. })
                && !matches!(right.ty(), Type::Union { .. })
            {
                let union = self
                    .intern_union(vec![left.ty(), right.ty()])
                    .ok_or_else(|| {
                        self.refuse(node, "unit comparison has no native representation")
                    })?;
                let Type::Union { union_id } = union else {
                    unreachable!()
                };
                return Ok(Expr::UnionEq {
                    union_id: format!("u{union_id}"),
                    negated: op == "!==",
                    same_value: false,
                    left: Box::new(self.coerce(left, union.clone(), node.left())?),
                    right: Box::new(self.coerce(right, union, node.right())?),
                    r#type: Type::Bool,
                    loc: self.loc(node),
                });
            }
            if matches!(left.ty(), Type::Union { .. })
                && matches!(right.ty(), Type::Union { .. })
                && left.ty() != right.ty()
                && self.dynamic_erasure_reason(&left.ty()).is_none()
                && self.dynamic_erasure_reason(&right.ty()).is_none()
            {
                // Equality observes both complete domains. Projecting one
                // operand into the other's union could discard a live tag.
                return Ok(Expr::DynScalarEq {
                    left: Box::new(self.coerce(left, Type::Dyn, node.left())?),
                    right: Box::new(self.coerce(right, Type::Dyn, node.right())?),
                    negated: op == "!==",
                    r#type: Type::Bool,
                    loc: self.loc(node),
                });
            }
            let scalar_arms = |ty: Type| -> Option<Vec<Type>> {
                let arms = match ty {
                    Type::Union { union_id } => self.unions[union_id].arms.clone(),
                    ty => vec![ty],
                };
                arms.iter()
                    .all(|arm| {
                        matches!(
                            arm,
                            Type::F64
                                | Type::Bigint
                                | Type::String
                                | Type::Bool
                                | Type::Symbol
                                | Type::Null
                                | Type::Undefined
                        )
                    })
                    .then_some(arms)
            };
            if let (Some(left_arms), Some(right_arms)) =
                (scalar_arms(left.ty()), scalar_arms(right.ty()))
                && !left_arms.iter().any(|left| right_arms.contains(left))
            {
                // Strict equality between disjoint scalar domains is known,
                // but both operands still evaluate exactly once and in source
                // order. This commonly follows closed-world narrowing of an
                // `unknown` parameter to string|undefined before `=== true`.
                return Ok(Expr::Sequence {
                    stmts: vec![
                        Stmt::Expression {
                            expr: left,
                            loc: self.loc(node.left()),
                        },
                        Stmt::Expression {
                            expr: right,
                            loc: self.loc(node.right()),
                        },
                    ],
                    result: Box::new(Expr::BoolLit {
                        value: op == "!==",
                        r#type: Type::Bool,
                        loc: self.loc(node),
                    }),
                    r#type: Type::Bool,
                    loc: self.loc(node),
                });
            }
            let union = if matches!(left.ty(), Type::Union { .. }) {
                left.ty()
            } else {
                right.ty()
            };
            if let Type::Union { union_id } = union {
                let left = self.coerce(left, union.clone(), node.left())?;
                let right = self.coerce(right, union, node.right())?;
                return Ok(Expr::UnionEq {
                    union_id: format!("u{union_id}"),
                    negated: op == "!==",
                    same_value: false,
                    left: Box::new(left),
                    right: Box::new(right),
                    r#type: Type::Bool,
                    loc: self.loc(node),
                });
            }
        }
        if matches!(op, "&" | "|" | "^" | "<<" | ">>" | ">>>")
            && (left.ty() != Type::F64 || right.ty() != Type::F64)
        {
            return self.numeric_binary(left, right, op, node);
        }
        if left.ty() == Type::Bigint && right.ty() == Type::Bigint {
            if matches!(op, "===" | "!==") {
                return Ok(Expr::DynScalarEq {
                    left: Box::new(self.coerce(left, Type::Dyn, node.left())?),
                    right: Box::new(self.coerce(right, Type::Dyn, node.right())?),
                    negated: op == "!==",
                    r#type: Type::Bool,
                    loc: self.loc(node),
                });
            }
            let operation = match op {
                "+" => "add",
                "-" => "sub",
                "*" => "mul",
                "/" => "div",
                "%" => "rem",
                "**" => "pow",
                _ => return Err(self.refuse(node, "BigInt operator is not ported")),
            };
            self.ensure_exception_classes(node)?;
            return Ok(self.bigint_operation(
                &format!("bigint.{operation}"),
                vec![left, right],
                node,
            ));
        }
        if matches!(op, "+" | "-" | "*" | "/" | "%" | "**")
            && (left.ty() != Type::F64 || right.ty() != Type::F64)
        {
            return self.numeric_binary(left, right, op, node);
        }
        let supported = if matches!(op, "===" | "!==") {
            left.ty() == right.ty()
                && matches!(
                    left.ty(),
                    Type::F64
                        | Type::String
                        | Type::Bool
                        | Type::Null
                        | Type::Undefined
                        | Type::Record { .. }
                        | Type::Func { .. }
                        | Type::Array { .. }
                        | Type::Map { .. }
                        | Type::Set { .. }
                        | Type::Object { .. }
                        | Type::Regex
                        | Type::Bytes { .. }
                        | Type::Promise { .. }
                        | Type::CryptoSign
                        | Type::Child
                )
        } else {
            left.ty() == Type::F64 && right.ty() == Type::F64
        };
        if !supported {
            return Err(self.refuse(node, "binary operand coercion is not ported"));
        }
        if left.ty() == Type::String {
            return Ok(Expr::StrEq {
                negated: op == "!==",
                left: Box::new(left),
                right: Box::new(right),
                r#type: Type::Bool,
                loc: self.loc(node),
            });
        }
        Ok(Expr::Bin {
            op: op.into(),
            left: Box::new(left),
            right: Box::new(right),
            r#type: if matches!(
                op,
                "+" | "-" | "*" | "/" | "%" | "**" | "&" | "|" | "^" | "<<" | ">>" | ">>>"
            ) {
                Type::F64
            } else {
                Type::Bool
            },
            loc: self.loc(node),
        })
    }
}
