//! Lexical data-record bindings retain the source store and evaluate it once.
use super::*;

pub(super) fn names(name: Node, out: &mut Vec<Node>) {
    if name.kind() == SyntaxKind::Identifier {
        out.push(name);
    } else if matches!(
        name.kind(),
        SyntaxKind::ObjectBindingPattern | SyntaxKind::ArrayBindingPattern
    ) {
        for element in name.elements() {
            if element.kind() == SyntaxKind::BindingElement {
                names(element.name(), out);
            }
        }
    }
}

impl Lowerer<'_> {
    pub(super) fn object_binding_declaration(
        &mut self,
        declaration: Node,
        mutable: bool,
        module: bool,
    ) -> Result<Vec<Stmt>, String> {
        if declaration.initializer().is_nil() || !declaration.type_().is_nil() {
            return Err(self.refuse(
                declaration,
                "object bindings require an inferred initialized native data record",
            ));
        }
        let elements = declaration
            .name()
            .elements()
            .into_iter()
            .collect::<Vec<_>>();
        // Validate the entire pattern before lowering any initializer or binding.
        for element in &elements {
            if element.name().kind() != SyntaxKind::Identifier
                || !element.dot_dot_dot_token().is_nil()
                || !element.initializer().is_nil()
                || (!element.property_name().is_nil()
                    && self.data_property_name(element.property_name()).is_none())
            {
                return Err(self.refuse(
                    *element,
                    "nested, default, rest and computed object bindings are not ported",
                ));
            }
        }
        let init = self.expression(declaration.initializer())?;
        let Type::Record { shape_id } = init.ty() else {
            return Err(self.refuse(
                declaration,
                "object bindings require a native data record; dynamic and primitive sources are not ported",
            ));
        };
        let shape = self.records[shape_id].clone();
        if shape.tuple || self.callables.contains_key(&shape_id) || self.enum_shape(shape_id) {
            return Err(self.refuse(
                declaration,
                "tuple, callable and enum bindings require their native member contracts",
            ));
        }
        let source = Local {
            id: format!("binding_source{}", self.locals.len()),
            name: "object binding source".into(),
            r#type: init.ty(),
            mutable: false,
            boxed: false,
        };
        self.locals.push(source.clone());
        let mut body = vec![Stmt::VarDecl {
            local_id: source.id.clone(),
            init,
            loc: self.loc(declaration),
        }];
        for element in elements {
            let name = element.name();
            let key = if element.property_name().is_nil() {
                name.text().to_string()
            } else {
                self.data_property_name(element.property_name()).unwrap()
            };
            let obj = Expr::VarRef {
                local_id: source.id.clone(),
                r#type: source.r#type.clone(),
                loc: self.loc(element),
            };
            // Use the field's owning ABI, never a checker-only projection that
            // could drop undefined or substitute a different callable wrapper.
            let value = if let Some(field) = shape.fields.iter().find(|field| field.name == key) {
                Expr::RecordGet {
                    obj: Box::new(obj),
                    shape_id: format!("r{shape_id}"),
                    field: key,
                    r#type: field.r#type.clone(),
                    loc: self.loc(element),
                }
            } else {
                self.dictionary_get(
                    element,
                    obj,
                    Expr::StrLit {
                        value: key,
                        r#type: Type::String,
                        loc: self.loc(element),
                    },
                )?
            };
            let ty = value.ty();
            let symbol = self.symbol(name);
            if self.optional_storage(&ty) {
                self.var_types.insert(symbol, ty.clone());
                self.var_assignment_fact(symbol, &value);
            }
            if module {
                let local = self.module_binding(name, ty, mutable);
                if local.r#type != value.ty() {
                    return Err(self.refuse(
                        element,
                        "module object binding layout differs from its field",
                    ));
                }
                body.push(Stmt::Assign {
                    local_id: local.id,
                    initializes_global: true,
                    value,
                    loc: self.loc(element),
                });
            } else {
                let local = Local {
                    id: format!("v{}", self.locals.len()),
                    name: name.text().into(),
                    r#type: ty,
                    mutable,
                    boxed: false,
                };
                self.locals.push(local.clone());
                self.bindings.insert(symbol, local.clone());
                body.push(Stmt::VarDecl {
                    local_id: local.id,
                    init: value,
                    loc: self.loc(element),
                });
            }
        }
        Ok(body)
    }
}
