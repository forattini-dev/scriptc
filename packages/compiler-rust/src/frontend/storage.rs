//! Program storage is separate from function locals and lexical captures.
use super::*;

impl Lowerer<'_> {
    pub(super) fn contextual_empty_object_is_open(
        &self,
        declaration: Node,
        storage: &Result<Type, String>,
    ) -> bool {
        if !parameter_abi::is_javascript(declaration)
            || declaration.initializer().is_nil()
            || declaration.initializer().kind() != SyntaxKind::ObjectLiteralExpression
            || !declaration.initializer().properties().is_empty()
        {
            return false;
        }
        matches!(storage,
            Ok(Type::Record { shape_id })
                if self.records[*shape_id].index_value.is_some()
                    || !self.records[*shape_id].fields.is_empty())
    }

    fn module_assignment_nodes(&mut self, node: Node, symbol: u32, out: &mut Vec<Node>) {
        if node.kind() == SyntaxKind::BinaryExpression
            && node.operator_token().kind() == SyntaxKind::EqualsToken
        {
            let left = primitives::primitive_source(node.left());
            if left.kind() == SyntaxKind::Identifier && self.symbol(left) == symbol {
                out.push(node.right());
            }
        }
        node.for_each_child(&mut |child| {
            self.module_assignment_nodes(child, symbol, out);
            false
        });
    }

    fn module_export_symbol(&mut self, file: Node, name: &str) -> Option<u32> {
        if file.symbol().0 == 0 {
            return None;
        }
        self.checker
            .get_exports_of_module_as_array(file.symbol())
            .into_iter()
            .find(|symbol| self.checker.sym(*symbol).name.as_ref() == name)
            .map(|symbol| symbol.0)
    }

    fn default_alias_target(&mut self, file: Node, name: &str) -> Option<u32> {
        let symbol = self.module_export_symbol(file, name)?;
        self.default_aliases.get(&symbol).copied()
    }

    fn add_default_alias(&mut self, symbol: u32, target: u32, site: Node) -> Result<bool, String> {
        if symbol == 0 {
            return Err(self.refuse(site, "default alias has no native binding"));
        }
        if let Some(previous) = self.default_aliases.get(&symbol) {
            if *previous != target {
                return Err(self.refuse(site, "ambiguous default export alias"));
            }
            return Ok(false);
        }
        self.default_aliases.insert(symbol, target);
        Ok(true)
    }

    fn local_import_default(&mut self, file: Node, name: &str) -> Option<u32> {
        for node in file.statements() {
            if node.kind() != SyntaxKind::ImportDeclaration {
                continue;
            }
            let clause = node.import_clause();
            if clause.is_nil() {
                continue;
            }
            let local = clause.name();
            if !local.is_nil() && local.text() == name {
                let symbol = self.checker.get_symbol_at_location(local, false).0;
                if let Some(target) = self.default_aliases.get(&symbol) {
                    return Some(*target);
                }
            }
            let named = clause.named_bindings();
            if !named.is_nil() && named.kind() == SyntaxKind::NamedImports {
                for item in named.elements() {
                    if !item.is_type_only() && item.name().text() == name {
                        let symbol = self.checker.get_symbol_at_location(item.name(), false).0;
                        if let Some(target) = self.default_aliases.get(&symbol) {
                            return Some(*target);
                        }
                    }
                }
            }
        }
        None
    }

    pub(super) fn inventory_default_exports(&mut self, files: &[Node]) -> Result<(), String> {
        for file in files {
            self.file = source_file_info(*file).file_name.to_string();
            for node in file.statements() {
                if node.kind() != SyntaxKind::ExportAssignment
                    || node.is_export_equals()
                    || self
                        .unobserved_default_exports
                        .contains(&declarations::Key::of(node))
                {
                    continue;
                }
                let symbol = self.module_export_symbol(*file, "default").ok_or_else(|| {
                    self.refuse(node, "default export has no native module binding")
                })?;
                let ty = self.ty(node.expression())?;
                let local = Local {
                    id: format!("%g.{}", self.globals.len()),
                    name: "default".into(),
                    r#type: ty,
                    mutable: false,
                    boxed: false,
                };
                self.globals.push(ir::Global {
                    id: local.id.clone(),
                    name: local.name.clone(),
                    r#type: local.r#type.clone(),
                    mutable: false,
                    loc: self.loc(node),
                });
                self.module_bindings.insert(symbol, local.clone());
                self.add_default_alias(symbol, symbol, node)?;
                self.default_exports
                    .insert(declarations::Key::of(node), local);
            }
        }
        if self.default_exports.is_empty() {
            return Ok(());
        }
        // Preserve the snapshot through import and named re-export aliases,
        // including cycles and chains spanning several modules.
        loop {
            let mut changed = false;
            for file in files {
                self.file = source_file_info(*file).file_name.to_string();
                for node in file.statements() {
                    if node.is_type_only()
                        || !matches!(
                            node.kind(),
                            SyntaxKind::ImportDeclaration | SyntaxKind::ExportDeclaration
                        )
                    {
                        continue;
                    }
                    let specifier = node.module_specifier();
                    let target = if specifier.is_nil() {
                        None
                    } else {
                        let symbol = self.checker.get_symbol_at_location(specifier, false);
                        if symbol.0 == 0 {
                            None
                        } else {
                            let target = self.checker.sym(symbol).value_declaration;
                            (!target.is_nil() && target.kind() == SyntaxKind::SourceFile)
                                .then_some(target)
                        }
                    };
                    if node.kind() == SyntaxKind::ImportDeclaration {
                        let Some(target) = target else { continue };
                        let clause = node.import_clause();
                        if clause.is_nil() || clause.is_type_only() {
                            continue;
                        }
                        if !clause.name().is_nil()
                            && let Some(default) = self.default_alias_target(target, "default")
                        {
                            let symbol =
                                self.checker.get_symbol_at_location(clause.name(), false).0;
                            changed |= self.add_default_alias(symbol, default, clause.name())?;
                        }
                        let named = clause.named_bindings();
                        if !named.is_nil() && named.kind() == SyntaxKind::NamedImports {
                            for item in named.elements() {
                                if item.is_type_only() {
                                    continue;
                                }
                                if let Some(default) = self.default_alias_target(
                                    target,
                                    item.property_name_or_name().text(),
                                ) {
                                    let symbol =
                                        self.checker.get_symbol_at_location(item.name(), false).0;
                                    changed |=
                                        self.add_default_alias(symbol, default, item.name())?;
                                }
                            }
                        }
                        continue;
                    }
                    let clause = node.export_clause();
                    if clause.is_nil() || clause.kind() != SyntaxKind::NamedExports {
                        continue;
                    }
                    for item in clause.elements() {
                        if item.is_type_only() {
                            continue;
                        }
                        let source = item.property_name_or_name();
                        let default = if let Some(target) = target {
                            self.default_alias_target(target, source.text())
                        } else {
                            let symbol = self.checker.get_symbol_at_location(source, false).0;
                            self.default_aliases
                                .get(&symbol)
                                .copied()
                                .or_else(|| self.local_import_default(*file, source.text()))
                        };
                        if let Some(default) = default {
                            let exported = self
                                .module_export_symbol(*file, item.name().text())
                                .ok_or_else(|| {
                                    self.refuse(item, "default re-export has no native binding")
                                })?;
                            changed |= self.add_default_alias(exported, default, item)?;
                        }
                    }
                }
            }
            if !changed {
                break;
            }
        }
        // Namespace re-exports need an owning namespace value in the export
        // table; do not silently turn its default snapshot into a live binding.
        for file in files {
            self.file = source_file_info(*file).file_name.to_string();
            for node in file.statements() {
                if node.kind() != SyntaxKind::ExportDeclaration || node.is_type_only() {
                    continue;
                }
                let clause = node.export_clause();
                if clause.is_nil() || clause.kind() == SyntaxKind::NamedExports {
                    continue;
                }
                let specifier = node.module_specifier();
                if specifier.is_nil() {
                    continue;
                }
                let symbol = self.checker.get_symbol_at_location(specifier, false);
                if symbol.0 == 0 {
                    continue;
                }
                let target = self.checker.sym(symbol).value_declaration;
                if !target.is_nil()
                    && target.kind() == SyntaxKind::SourceFile
                    && self.default_alias_target(target, "default").is_some()
                {
                    return Err(self.refuse(
                        node,
                        "namespace re-export of a default expression is not ported",
                    ));
                }
            }
        }
        Ok(())
    }

    pub(super) fn inventory_storage(&mut self, files: &[Node]) {
        for file in files {
            self.file = source_file_info(*file).file_name.to_string();
            let commonjs = self.commonjs_index(*file).is_some();
            for statement in file.statements() {
                if statement.kind() != SyntaxKind::VariableStatement {
                    continue;
                }
                let list = statement.declaration_list();
                if !list.flags().intersects(NodeFlags::LET | NodeFlags::CONST) {
                    continue;
                }
                for declaration in list.declarations().nodes() {
                    // Flat dynamic/primitive object bindings publish owning
                    // value snapshots. Plan their module cells before function
                    // bodies can capture a checker-only property projection.
                    let sequence = declaration.name().kind() == SyntaxKind::ArrayBindingPattern;
                    let sequence_source = if sequence && !declaration.initializer().is_nil() {
                        self.ty(declaration.initializer()).ok()
                    } else {
                        None
                    };
                    let dynamic_binding = declaration.name().kind()
                        == SyntaxKind::ObjectBindingPattern
                        && !declaration.initializer().is_nil()
                        && self
                            .ty(declaration.initializer())
                            .is_ok_and(|ty| !matches!(ty, Type::Record { .. }));
                    let mut names = Vec::new();
                    bindings::names(declaration.name(), &mut names);
                    for name in names {
                        let symbol = self.symbol(name);
                        if self.native_namespaces.contains_key(&symbol) {
                            continue;
                        }
                        if name.kind() != SyntaxKind::Identifier {
                            continue;
                        }
                        // An untyped JavaScript initializer can provide a more
                        // precise native contract when lowered at its source site.
                        let symbol_initializer = (name == declaration.name()
                            && !declaration.initializer().is_nil())
                        .then(|| self.symbol_initializer_storage(declaration.initializer()))
                        .flatten();
                        let planned_initializer_storage = (name == declaration.name()
                            && parameter_abi::is_javascript(declaration)
                            && declaration.type_().is_nil()
                            && !declaration.initializer().is_nil())
                        .then(|| self.planned_argument_type(declaration.initializer()))
                        .flatten();
                        let mut storage = if self
                            .commonjs
                            .native_declarations
                            .contains(&declarations::Key::of(declaration))
                        {
                            Ok(Type::Dyn)
                        } else if name == declaration.name()
                            && !declaration.initializer().is_nil()
                            && (self.inferred_nonnull_array_element(declaration)
                                || self.inferred_nonnull_array_removal(declaration)
                                || self.native_dynamic_result_call(declaration.initializer())
                                || self.owning_function_result_call(declaration.initializer())
                                || self.json_stringify_result(declaration.initializer())
                                || self
                                    .native_weak_reference_constructor(declaration.initializer())
                                || self
                                    .native_computed_symbol_result_call(declaration.initializer())
                                || self.timer_optional_method_value(declaration.initializer()))
                        {
                            Ok(Type::Dyn)
                        } else if let Some(symbol) = symbol_initializer {
                            Ok(symbol)
                        } else if sequence {
                            let position = declaration
                                .name()
                                .elements()
                                .iter()
                                .position(|element| !element.is_nil() && element.name() == name)
                                .unwrap_or(0);
                            self.sequence_slot_type(
                                sequence_source.as_ref().unwrap_or(&Type::Dyn),
                                position,
                                name,
                            )
                        } else if dynamic_binding {
                            Ok(Type::Dyn)
                        } else {
                            let storage = self.storage_type(name);
                            let storage = if name == declaration.name()
                                && self.contextual_empty_object_is_open(declaration, &storage)
                            {
                                Ok(Type::Dyn)
                            } else {
                                storage
                            };
                            let storage = if list.flags().intersects(NodeFlags::CONST)
                                && parameter_abi::is_javascript(declaration)
                                && declaration.type_().is_nil()
                                && !declaration.initializer().is_nil()
                                && declaration.initializer().kind()
                                    == SyntaxKind::ObjectLiteralExpression
                            {
                                match (&storage, self.ty(declaration.initializer())) {
                                    (Ok(inferred), Ok(actual))
                                        if self.call_record_storage(&actual, inferred) =>
                                    {
                                        // Module cells are inventoried before any
                                        // initializer is lowered so functions can
                                        // capture them. Keep the concrete owning
                                        // JavaScript literal ABI here just as local
                                        // declarations do during statement lowering;
                                        // the checker's broader structural record is
                                        // only a view (for example `{ props: any }`
                                        // over a literal whose `props` is `{}`).
                                        Ok(actual)
                                    }
                                    _ => storage,
                                }
                            } else {
                                storage
                            };
                            let storage = if matches!(&storage, Ok(Type::Dyn) | Err(_))
                                && let Some(planned) = planned_initializer_storage
                            {
                                Ok(planned)
                            } else {
                                storage
                            };
                            if commonjs && storage.is_err() && !declaration.initializer().is_nil() {
                                let initializer = declaration.initializer();
                                self.ty(initializer).or_else(|error| {
                                    // Checked CommonJS frequently exposes a heterogeneous
                                    // registry as an inferred array whose element union
                                    // contains open objects (for example parser tag tables).
                                    // The table itself still has a precise native container:
                                    // retain each entry as an owning JavaScript value rather
                                    // than rejecting the whole module during pre-inventory.
                                    let fallback = match initializer.kind() {
                                        SyntaxKind::ArrayLiteralExpression => Ok(Type::Array {
                                            elem: Box::new(Type::Dyn),
                                        }),
                                        // Heterogeneous CommonJS registries are
                                        // open owning objects. Their computed
                                        // reads and reflection already use the
                                        // dynamic object ABI.
                                        SyntaxKind::ObjectLiteralExpression => Ok(Type::Dyn),
                                        _ => Err(error),
                                    };
                                    fallback
                                })
                            } else {
                                storage
                            }
                        };
                        if name == declaration.name()
                            && storage.as_ref().is_ok_and(|ty| *ty != Type::Dyn)
                        {
                            let mut assignments = Vec::new();
                            self.module_assignment_nodes(*file, symbol, &mut assignments);
                            let mut arms = match storage.as_ref().unwrap().clone() {
                                Type::Union { union_id } => self.unions[union_id].arms.clone(),
                                ty => vec![ty],
                            };
                            for assignment in assignments {
                                if let Ok(ty) = self.ty(assignment) {
                                    match ty {
                                        Type::Union { union_id } => {
                                            arms.extend(self.unions[union_id].arms.clone())
                                        }
                                        ty => arms.push(ty),
                                    }
                                }
                            }
                            if let Some(widened) = self.intern_union(arms) {
                                storage = Ok(widened);
                            }
                        }
                        if name == declaration.name()
                            && !declaration.initializer().is_nil()
                            && (self
                                .javascript_prototype_value_candidate(declaration.initializer())
                                || self.dynamic_callable_initializer(declaration.initializer()))
                        {
                            storage = Ok(Type::Dyn);
                        }
                        if let Ok(mut ty) = storage {
                            if dynamic_binding || sequence {
                                self.var_types.insert(symbol, ty.clone());
                                self.var_defined.remove(&symbol);
                            }
                            if declaration.initializer().is_nil() {
                                let value_type = ty;
                                let Ok(storage) =
                                    self.undefined_storage_type(value_type.clone(), declaration)
                                else {
                                    continue;
                                };
                                // Functions must observe this module cell's actual
                                // layout even before its declaration executes.
                                self.module_vars.insert(symbol, value_type.clone());
                                self.var_types.insert(symbol, value_type);
                                ty = storage;
                            } else if self.optional_storage(&ty) {
                                // Initialized optional module cells can also be
                                // cleared by a call after checker flow narrows them.
                                self.module_vars.insert(symbol, ty.clone());
                                self.var_types.insert(symbol, ty.clone());
                            }
                            self.module_binding(
                                name,
                                ty,
                                !list.flags().intersects(NodeFlags::CONST),
                            );
                        }
                    }
                }
            }
        }
    }

    pub(super) fn module_binding(&mut self, name: Node, ty: Type, mutable: bool) -> Local {
        let symbol = self.symbol(name);
        if let Some(binding) = self.module_bindings.get(&symbol) {
            return binding.clone();
        }
        let binding = Local {
            id: format!("%g.{}", self.globals.len()),
            name: name.text().into(),
            r#type: ty,
            mutable,
            boxed: false,
        };
        self.globals.push(ir::Global {
            id: binding.id.clone(),
            name: binding.name.clone(),
            r#type: binding.r#type.clone(),
            mutable,
            loc: self.loc(name),
        });
        self.module_bindings.insert(symbol, binding.clone());
        binding
    }
}
