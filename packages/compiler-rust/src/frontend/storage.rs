//! Program storage is separate from function locals and lexical captures.
use super::*;

impl Lowerer<'_> {
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
                    let name = declaration.name();
                    let symbol = self.symbol(name);
                    if self.native_namespaces.contains_key(&symbol) {
                        continue;
                    }
                    if name.kind() != SyntaxKind::Identifier {
                        continue;
                    }
                    // An untyped JavaScript initializer can provide a more
                    // precise native contract when lowered at its source site.
                    if let Ok(mut ty) = self.storage_type(name) {
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
                        self.module_binding(name, ty, !list.flags().intersects(NodeFlags::CONST));
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
