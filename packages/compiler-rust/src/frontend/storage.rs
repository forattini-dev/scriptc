//! Program storage is separate from function locals and lexical captures.
use super::*;

impl Lowerer<'_> {
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
                        let storage = if sequence {
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
                            self.storage_type(name)
                        };
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
        });
        self.module_bindings.insert(symbol, binding.clone());
        binding
    }
}
