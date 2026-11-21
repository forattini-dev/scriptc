//! Lexical object bindings retain the owning source and evaluate it once.
use super::*;

pub(super) fn omitted(element: Node) -> bool {
    element.is_nil()
        || element.kind() == SyntaxKind::OmittedExpression
        || (element.kind() == SyntaxKind::BindingElement && element.name().is_nil())
}

pub(super) fn names(name: Node, out: &mut Vec<Node>) {
    if name.is_nil() {
        return;
    }
    if name.kind() == SyntaxKind::Identifier {
        out.push(name);
    } else if matches!(
        name.kind(),
        SyntaxKind::ObjectBindingPattern | SyntaxKind::ArrayBindingPattern
    ) {
        for element in name.elements() {
            if !element.is_nil() && element.kind() == SyntaxKind::BindingElement {
                names(element.name(), out);
            }
        }
    }
}

impl Lowerer<'_> {
    fn namespace_binding_snapshot(
        &mut self,
        pattern: Node,
        source: Node,
        receiver: Expr,
    ) -> Result<Expr, String> {
        let elements = pattern.elements().into_iter().collect::<Vec<_>>();
        if elements
            .iter()
            .any(|element| !element.dot_dot_dot_token().is_nil())
        {
            return Err(self.refuse(
                pattern,
                "module namespace rest bindings require complete export enumeration",
            ));
        }
        let source_type = self.checker.get_type_at_location(source);
        let properties = self.checker.get_properties_of_type(source_type).to_vec();
        let mut fields = Vec::with_capacity(elements.len());
        let mut values = Vec::with_capacity(elements.len());
        for element in elements {
            let export = if element.property_name().is_nil() {
                element.name().text().to_string()
            } else {
                self.data_property_name(element.property_name()).unwrap()
            };
            let Some(mut symbol) = properties
                .iter()
                .copied()
                .find(|symbol| self.checker.sym(*symbol).name.as_ref() == export)
            else {
                return Err(self.refuse(
                    element,
                    &format!("module namespace export {export:?} was not resolved"),
                ));
            };
            if self
                .checker
                .sym(symbol)
                .flags
                .intersects(SymbolFlags::ALIAS)
            {
                symbol = self.checker.get_aliased_symbol(symbol);
            }
            let declaration = self.checker.sym(symbol).value_declaration;
            let class =
                if !declaration.is_nil() && declaration.kind() == SyntaxKind::ClassDeclaration {
                    // Destructured namespace exports can be the first demand
                    // for a native class. Register its declaration identity
                    // before asking for the constructor value; otherwise the
                    // snapshot can read the destination binding while it is
                    // still in its TDZ.
                    if let Some(index) = self.class_symbol(declaration.name()) {
                        Some(self.class_ref(index, declaration.name(), None)?)
                    } else {
                        self.class_value(declaration.name())?
                    }
                } else {
                    None
                };
            let value = if let Some(value) = class {
                value
            } else if let Some(signature) =
                self.request_function(symbol.0, element, functions::UseKind::Value)?
            {
                let ty = Type::Func {
                    rest: signature.rest,
                    params: signature
                        .params
                        .iter()
                        .map(|parameter| parameter.r#type.clone())
                        .collect(),
                    ret: Box::new(signature.return_type.clone()),
                };
                Expr::Closure {
                    fn_name: signature.name,
                    captures: vec![],
                    r#type: ty,
                    loc: self.loc(element),
                }
            } else if !declaration.is_nil() {
                self.expression(declaration.name()).map_err(|error| {
                    format!("{error}; while reading module namespace export {export:?}")
                })?
            } else {
                return Err(self.refuse(
                    element,
                    "module namespace export has no native value declaration",
                ));
            };
            fields.push(ir::Field {
                name: export.clone(),
                r#type: value.ty(),
            });
            values.push(ir::FieldInit {
                name: export,
                value,
                absent: false,
                overflow: false,
            });
        }
        let declared_order = fields.iter().map(|field| field.name.clone()).collect();
        fields.sort_by(|left, right| left.name.cmp(&right.name));
        let shape_id = self.records.len();
        self.records.push(ir::Record {
            id: shape_id,
            fields,
            declared_order,
            tuple: false,
            index_value: None,
        });
        let record = Type::Record { shape_id };
        let mut helper = helpers::Helper::new(
            "namespace_binding_snapshot",
            vec![receiver.ty()],
            record.clone(),
            self.loc(pattern),
        );
        helper.function.body.push(Stmt::Return {
            value: Some(Expr::RecordLit {
                fields: values,
                null_prototype: false,
                r#type: record.clone(),
                loc: self.loc(pattern),
            }),
            loc: self.loc(pattern),
        });
        Ok(Expr::Call {
            callee: self.install_helper(helper.function),
            args: vec![receiver],
            r#type: record,
            loc: self.loc(pattern),
        })
    }

    pub(super) fn validate_object_binding_pattern(
        &self,
        pattern: Node,
        module: bool,
    ) -> Result<(), String> {
        let elements = pattern.elements().into_iter().collect::<Vec<_>>();
        let has_computed = elements.iter().any(|element| {
            !element.property_name().is_nil()
                && element.property_name().kind() == SyntaxKind::ComputedPropertyName
        });
        for (index, element) in elements.iter().enumerate() {
            let rest = !element.dot_dot_dot_token().is_nil();
            let name = element.name();
            let identifier = name.kind() == SyntaxKind::Identifier;
            let nested_object = name.kind() == SyntaxKind::ObjectBindingPattern;
            if (!identifier && !nested_object)
                || (rest
                    && (!identifier
                        || index + 1 != elements.len()
                        || !element.property_name().is_nil()
                        || !element.initializer().is_nil()))
                || (module && !element.initializer().is_nil())
                || (nested_object && !element.initializer().is_nil())
                || (!element.property_name().is_nil()
                    && element.property_name().kind() != SyntaxKind::ComputedPropertyName
                    && self.data_property_name(element.property_name()).is_none())
                || (has_computed && rest)
            {
                return Err(self.refuse(
                    *element,
                    "object bindings require named data bindings, nested object patterns without defaults, and a terminal rest",
                ));
            }
            if nested_object {
                self.validate_object_binding_pattern(name, module)?;
            }
        }
        Ok(())
    }

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
        // Validate the entire pattern before lowering any initializer or binding.
        self.validate_object_binding_pattern(declaration.name(), module)?;
        let initializer = declaration.initializer();
        let init = if initializer.kind() == SyntaxKind::ConditionalExpression {
            let inferred = self.ty(initializer)?;
            let elements = declaration
                .name()
                .elements()
                .into_iter()
                .collect::<Vec<_>>();
            let snapshot = self.contains_namespace(&inferred)
                && elements.iter().all(|element| {
                    element.kind() == SyntaxKind::BindingElement
                        && element.name().kind() == SyntaxKind::Identifier
                        && element.dot_dot_dot_token().is_nil()
                });
            if snapshot {
                // A conditional can select either a real module namespace or
                // an ordinary object. Destructuring observes only these named
                // properties, so give both arms one native snapshot layout
                // instead of pretending the object arm has namespace identity.
                let mut fields = elements
                    .iter()
                    .map(|element| {
                        let name = if element.property_name().is_nil() {
                            element.name().text().to_string()
                        } else {
                            self.data_property_name(element.property_name()).unwrap()
                        };
                        let mut ty = self.storage_type(element.name())?;
                        if let Type::Union { union_id } = ty {
                            let arms = &self.unions[union_id].arms;
                            let concrete = arms
                                .iter()
                                .filter(|arm| {
                                    matches!(arm, Type::Array { elem } if **elem != Type::Dyn)
                                })
                                .cloned()
                                .collect::<Vec<_>>();
                            if arms.iter().all(|arm| matches!(arm, Type::Array { .. }))
                                && concrete.len() == 1
                            {
                                // The object alternative commonly contributes
                                // never[]/Array<Dyn> beside a typed namespace
                                // export. Since that branch is an empty literal,
                                // both paths can share the concrete element ABI.
                                ty = concrete[0].clone();
                            }
                        }
                        Ok(ir::Field { name, r#type: ty })
                    })
                    .collect::<Result<Vec<_>, String>>()?;
                let declared_order = fields.iter().map(|field| field.name.clone()).collect();
                fields.sort_by(|left, right| left.name.cmp(&right.name));
                let shape_id = self.records.len();
                self.records.push(ir::Record {
                    id: shape_id,
                    fields,
                    declared_order,
                    tuple: false,
                    index_value: None,
                });
                self.expected_expression(initializer, Type::Record { shape_id })?
            } else {
                self.expression(initializer)?
            }
        } else {
            self.expression(initializer)?
        };
        let init = if self.namespace_capsule(&init.ty()) {
            self.namespace_binding_snapshot(declaration.name(), initializer, init)?
        } else {
            init
        };
        self.object_binding_value(declaration.name(), init, mutable, module, declaration)
    }

    pub(super) fn object_binding_value(
        &mut self,
        pattern: Node,
        init: Expr,
        mutable: bool,
        module: bool,
        owner: Node,
    ) -> Result<Vec<Stmt>, String> {
        let elements = pattern.elements().into_iter().collect::<Vec<_>>();
        let computed_binding = elements.iter().any(|element| {
            !element.property_name().is_nil()
                && element.property_name().kind() == SyntaxKind::ComputedPropertyName
        });
        let class_binding_receiver = if matches!(init.ty(), Type::Classval { .. })
            && owner.kind() == SyntaxKind::VariableDeclaration
        {
            let receiver = primitives::primitive_source(owner.initializer());
            (receiver.kind() == SyntaxKind::Identifier).then_some(receiver)
        } else {
            None
        };
        if self.is_data_view(&init.ty()) {
            return Err(self.refuse(owner, "DataView object bindings are not ported"));
        }
        let data_record_union = match init.ty() {
            Type::Union { union_id } => self.unions[union_id].arms.iter().all(|arm| {
                let Type::Record { shape_id } = arm else {
                    return false;
                };
                let shape = &self.records[*shape_id];
                !shape.tuple
                    && !self.callables.contains_key(shape_id)
                    && !self.enum_shape(*shape_id)
            }),
            _ => false,
        };
        let shape = if let Type::Record { shape_id } = init.ty() {
            let shape = self.records[shape_id].clone();
            if !computed_binding
                && (shape.tuple
                    || self.callables.contains_key(&shape_id)
                    || self.enum_shape(shape_id))
            {
                return Err(self.refuse(
                    owner,
                    "tuple, callable and enum bindings require their native member contracts",
                ));
            }
            Some(shape)
        } else {
            fn represented_binding_source(ty: &Type, unions: &[ir::Union]) -> bool {
                match ty {
                    Type::Union { union_id } => unions[*union_id]
                        .arms
                        .iter()
                        .all(|arm| represented_binding_source(arm, unions)),
                    Type::Dyn
                    | Type::Caught
                    | Type::F64
                    | Type::Bool
                    | Type::String
                    | Type::Bigint
                    | Type::Symbol
                    | Type::Null
                    | Type::Undefined
                    | Type::Object { .. }
                    | Type::Record { .. }
                    | Type::Array { .. }
                    | Type::Classval { .. } => true,
                    _ => false,
                }
            }
            if !data_record_union && !represented_binding_source(&init.ty(), &self.unions) {
                let receiver = match init.ty() {
                    Type::Union { union_id } => format!(
                        "Union {{ union_id: {union_id}, arms: {:?} }}",
                        self.unions[union_id].arms
                    ),
                    other => format!("{other:?}"),
                };
                return Err(self.refuse(
                    owner,
                    &format!(
                        "object bindings require native data records or represented dynamic/primitive sources; receiver is {receiver}",
                    ),
                ));
            }
            None
        };
        let shape = if computed_binding { None } else { shape };
        let init = if shape.is_none() {
            self.coerce(init, Type::Dyn, owner)?
        } else {
            init
        };
        let has_rest = elements
            .iter()
            .any(|element| !element.dot_dot_dot_token().is_nil());
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
            loc: self.loc(owner),
        }];
        if shape.is_none() {
            self.ensure_exception_classes(owner)?;
            // RequireObjectCoercible runs even for {}. Do not enumerate keys
            // or use the object-rest layout fence: primitives are valid here.
            body.push(Stmt::If {
                cond: Expr::DynTest {
                    value: Box::new(self.construction_read(&source, owner)),
                    test: "nullish".into(),
                    negated: false,
                    r#type: Type::Bool,
                    loc: self.loc(owner),
                },
                then: vec![Stmt::Throw {
                    value: Expr::LibCall {
                        r#fn: "error.new".into(),
                        args: vec![Expr::StrLit {
                            value: "Cannot destructure null or undefined".into(),
                            r#type: Type::String,
                            loc: self.loc(owner),
                        }],
                        r#type: Type::Object {
                            class_name: "%TypeError".into(),
                        },
                        loc: self.loc(owner),
                    },
                    loc: self.loc(owner),
                }],
                else_: None,
                loc: self.loc(owner),
            });
            if has_rest {
                body.push(Stmt::Expression {
                    expr: Expr::LibCall {
                        r#fn: "dyn.objectRestCheck".into(),
                        args: vec![self.construction_read(&source, owner)],
                        r#type: Type::Void,
                        loc: self.loc(owner),
                    },
                    loc: self.loc(owner),
                });
            }
        }
        let mut excluded = Vec::new();
        for element in elements {
            let name = element.name();
            if !element.dot_dot_dot_token().is_nil() {
                let target = if shape.is_none() {
                    Type::Dyn
                } else {
                    self.storage_type(name)?
                };
                let raw =
                    self.coerce(self.construction_read(&source, element), Type::Dyn, element)?;
                let value = self.object_parameter_rest(element, raw, &excluded, target)?;
                body.push(self.publish_binding(name, value, mutable, module, element)?);
                continue;
            }
            let computed_key = !element.property_name().is_nil()
                && element.property_name().kind() == SyntaxKind::ComputedPropertyName;
            let key = if computed_key {
                None
            } else if element.property_name().is_nil() {
                Some(name.text().to_string())
            } else {
                Some(self.data_property_name(element.property_name()).unwrap())
            };
            if let Some(key) = &key {
                excluded.push(key.clone());
            }
            let obj = Expr::VarRef {
                local_id: source.id.clone(),
                r#type: source.r#type.clone(),
                loc: self.loc(element),
            };
            // Use the field's owning ABI, never a checker-only projection that
            // could drop undefined or substitute a different callable wrapper.
            let value = if let Some(receiver) = class_binding_receiver
                && let Some(key) = &key
                && let Some(value) = self.class_static_method_named(receiver, key, element)?
            {
                value
            } else if let Some(shape) = &shape {
                let key = key.as_ref().unwrap();
                if let Some(field) = shape.fields.iter().find(|field| field.name == *key) {
                    Expr::RecordGet {
                        obj: Box::new(obj),
                        shape_id: format!("r{}", shape.id),
                        field: key.clone(),
                        r#type: field.r#type.clone(),
                        loc: self.loc(element),
                    }
                } else {
                    self.dictionary_get(
                        element,
                        obj,
                        Expr::StrLit {
                            value: key.clone(),
                            r#type: Type::String,
                            loc: self.loc(element),
                        },
                    )?
                }
            } else {
                let key = if computed_key {
                    self.dynamic_read_key_expression(element.property_name().expression())?
                } else {
                    Expr::StrLit {
                        value: key.unwrap(),
                        r#type: Type::String,
                        loc: self.loc(element),
                    }
                };
                self.dynamic_get(element, obj, key)
            };
            if name.kind() == SyntaxKind::ObjectBindingPattern {
                body.extend(self.object_binding_value(name, value, mutable, module, element)?);
            } else if element.initializer().is_nil() {
                body.push(self.publish_binding(name, value, mutable, module, element)?);
            } else {
                // Materialize the property exactly once before evaluating its
                // default. The shared formal-binding path supplies JS's lazy
                // undefined-only test and preserves earlier binding visibility.
                let formal = Param {
                    local_id: format!("v{}", self.locals.len()),
                    name: name.text().into(),
                    r#type: value.ty(),
                };
                body.push(Stmt::VarDecl {
                    local_id: formal.local_id.clone(),
                    init: value,
                    loc: self.loc(element),
                });
                body.extend(self.bind_parameter(Some(element), &formal)?);
                let symbol = self.symbol(name);
                if !mutable {
                    // Default parameters use a mutable incoming slot. A const
                    // binding needs its own immutable slot after that update.
                    let incoming = self.bindings.get(&symbol).cloned().ok_or_else(|| {
                        self.refuse(element, "default binding has no native storage")
                    })?;
                    let binding = Local {
                        id: format!("v{}", self.locals.len()),
                        name: name.text().into(),
                        r#type: incoming.r#type.clone(),
                        mutable: false,
                        boxed: false,
                    };
                    body.push(Stmt::VarDecl {
                        local_id: binding.id.clone(),
                        init: self.construction_read(&incoming, element),
                        loc: self.loc(element),
                    });
                    self.locals.push(binding.clone());
                    self.bindings.insert(symbol, binding);
                }
                if formal.r#type == Type::Dyn {
                    self.var_types.insert(symbol, Type::Dyn);
                    self.var_defined.remove(&symbol);
                }
            }
        }
        Ok(body)
    }
    pub(super) fn publish_binding(
        &mut self,
        name: Node,
        value: Expr,
        mutable: bool,
        module: bool,
        node: Node,
    ) -> Result<Stmt, String> {
        let symbol = self.symbol(name);
        if let Some(storage) = self.recursive_functions.get(&symbol).cloned()
            && let Some(local) = self.bindings.get(&symbol).cloned()
            && local.r#type == Type::Dyn
            && local.boxed
        {
            let value = self.coerce(value, storage, node)?;
            let value = self.coerce(value, Type::Dyn, node)?;
            if !mutable && let Some(binding) = self.bindings.get_mut(&symbol) {
                binding.mutable = false;
            }
            return Ok(Stmt::Assign {
                local_id: local.id,
                value,
                initializes_global: false,
                loc: self.loc(node),
            });
        }
        if module {
            let local = self.module_binding(name, value.ty(), mutable);
            // Inventory runs before lowering and can retain the checker's
            // structural view even when an assertion/satisfies wrapper lowers
            // the owning literal through Dyn. Publish a checked live view over
            // that same object rather than rejecting the module cell.
            let value = if local.r#type == value.ty() {
                value
            } else {
                self.coerce(value, local.r#type.clone(), node)?
            };
            if local.r#type == Type::Dyn {
                self.var_types.insert(symbol, Type::Dyn);
                self.var_defined.remove(&symbol);
            } else if self.presence_storage(&local.r#type) {
                self.var_types.insert(symbol, local.r#type.clone());
                self.var_assignment_fact(symbol, &value);
            }
            Ok(Stmt::Assign {
                local_id: local.id,
                initializes_global: true,
                value,
                loc: self.loc(node),
            })
        } else {
            let ty = value.ty();
            if ty == Type::Dyn {
                self.var_types.insert(symbol, Type::Dyn);
                self.var_defined.remove(&symbol);
            } else if self.presence_storage(&ty) {
                self.var_types.insert(symbol, ty.clone());
                self.var_assignment_fact(symbol, &value);
            }
            let local = Local {
                id: format!("v{}", self.locals.len()),
                name: name.text().into(),
                r#type: ty,
                mutable,
                boxed: false,
            };
            self.locals.push(local.clone());
            self.bindings.insert(symbol, local.clone());
            Ok(Stmt::VarDecl {
                local_id: local.id,
                init: value,
                loc: self.loc(node),
            })
        }
    }
}
