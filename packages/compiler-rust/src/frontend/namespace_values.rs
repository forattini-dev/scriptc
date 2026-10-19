//! Owning module identities; export reads stay in the live module binding table.
//! The portable object ABI is a private zero-field capsule, never an export snapshot.
use super::*;

#[derive(Default)]
pub(super) struct NamespaceValues {
    paths: HashMap<String, usize>,
    slots: Vec<ir::Global>,
    pub layouts: Vec<ir::Class>,
}
impl Lowerer<'_> {
    pub(super) fn namespace_value_type(&mut self, id: TypeId) -> Option<Type> {
        let symbol = self.checker.ty(id).symbol();
        if symbol.0 == 0 {
            return None;
        }
        let declaration = self.checker.sym(symbol).value_declaration;
        if declaration.is_nil() || declaration.kind() != SyntaxKind::SourceFile {
            return None;
        }
        let path = source_file_info(declaration).file_name.to_string();
        if is_declaration(&path) || commonjs::is_module(declaration) {
            return None;
        }
        if let Some(index) = self.namespace_values.paths.get(&path) {
            return Some(self.namespace_values.slots[*index].r#type.clone());
        }
        let index = self.namespace_values.slots.len();
        let class_name = format!("native_namespace_{index}");
        let ty = Type::Object {
            class_name: class_name.clone(),
        };
        let loc = Loc {
            file: path.clone(),
            start: 0,
            end: 0,
        };
        let slot = ir::Global {
            id: format!("%g.namespace.{index}"),
            name: path.clone(),
            r#type: ty.clone(),
            mutable: false,
        };
        self.globals.push(slot.clone());
        self.namespace_values.slots.push(slot);
        self.namespace_values.paths.insert(path, index);
        self.namespace_values.layouts.push(ir::Class {
            name: class_name.clone(),
            js_name: "ModuleNamespace".into(),
            runtime: false,
            base: None,
            fields: vec![],
            methods: vec![],
            method_names: vec![],
            loc: loc.clone(),
        });
        let constructor = helpers::Helper::new(
            &format!("%{class_name}.constructor"),
            vec![ty.clone()],
            Type::Void,
            loc,
        );
        // Constructor names are part of the existing portable class ABI.
        self.lifted.push(constructor.function);
        Some(ty)
    }

    pub(super) fn namespace_capsule(&self, ty: &Type) -> bool {
        matches!(ty, Type::Object { class_name } if self.namespace_values.layouts.iter().any(|c| c.name == *class_name))
    }

    pub(super) fn contains_namespace(&self, ty: &Type) -> bool {
        self.native_type_contains(ty, |ty| self.namespace_capsule(ty))
    }

    pub(super) fn namespace_reference(&mut self, node: Node) -> Result<Option<Expr>, String> {
        if node.kind() != SyntaxKind::Identifier
            || !self.module_namespace(node)
            || self.native_namespace(node).is_some()
        {
            return Ok(None);
        }
        let id = self.checker.get_type_at_location(node);
        let Some(ty) = self.namespace_value_type(id) else {
            return Ok(None);
        };
        let slot = self
            .namespace_values
            .slots
            .iter()
            .find(|slot| slot.r#type == ty)
            .unwrap();
        Ok(Some(Expr::VarRef {
            local_id: slot.id.clone(),
            r#type: ty,
            loc: self.loc(node),
        }))
    }

    pub(super) fn namespace_property(&mut self, node: Node) -> Result<Option<Expr>, String> {
        if node.kind() != SyntaxKind::PropertyAccessExpression
            || self.module_namespace(node.expression())
        {
            return Ok(None);
        }
        let id = self.checker.get_type_at_location(node.expression());
        if self.namespace_value_type(id).is_none() {
            return Ok(None);
        }
        let receiver = self.expression(node.expression())?;
        if !self.namespace_capsule(&receiver.ty()) {
            return Err(self.refuse(
                node,
                "module namespace receiver needs a non-null native identity",
            ));
        }
        // The property symbol resolves to its actual export (including reexports).
        // Evaluate the receiver first; only then read the current global/function binding.
        let value = self.expression(node.name())?;
        let ty = value.ty();
        let symbol = self.symbol(node.name());
        let mut helper = helpers::Helper::new(
            &format!("namespace_read_{symbol}"),
            vec![receiver.ty()],
            ty.clone(),
            self.loc(node),
        );
        helper.function.body.push(Stmt::Return {
            value: Some(value),
            loc: self.loc(node),
        });
        let callee = self.install_helper(helper.function);
        Ok(Some(Expr::Call {
            callee,
            args: vec![receiver],
            r#type: ty,
            loc: self.loc(node),
        }))
    }

    pub(super) fn namespace_call(&mut self, node: Node) -> Result<Option<Expr>, String> {
        let member = node.expression();
        if member.kind() != SyntaxKind::PropertyAccessExpression
            || self.module_namespace(member.expression())
        {
            return Ok(None);
        }
        let id = self.checker.get_type_at_location(member.expression());
        if self.namespace_value_type(id).is_none() {
            return Ok(None);
        }
        self.call_value(node).map(Some)
    }

    pub(super) fn namespace_prelude(&self) -> Vec<Stmt> {
        self.namespace_values
            .slots
            .iter()
            .map(|slot| {
                let Type::Object { class_name } = &slot.r#type else {
                    unreachable!()
                };
                let loc = self
                    .namespace_values
                    .layouts
                    .iter()
                    .find(|c| c.name == *class_name)
                    .unwrap()
                    .loc
                    .clone();
                Stmt::Assign {
                    local_id: slot.id.clone(),
                    initializes_global: true,
                    value: Expr::New {
                        class_name: class_name.clone(),
                        args: vec![],
                        r#type: slot.r#type.clone(),
                        loc: loc.clone(),
                    },
                    loc,
                }
            })
            .collect()
    }
}
