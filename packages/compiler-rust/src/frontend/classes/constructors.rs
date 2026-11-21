//! Constructor ABIs, super calls and instance initialization order.
use super::*;

fn forwarded_super_arguments(ctor: Node) -> bool {
    let Some(first) = ctor.body().statements().into_iter().next() else {
        return false;
    };
    if first.kind() != SyntaxKind::ExpressionStatement {
        return false;
    }
    let call = first.expression();
    if call.kind() != SyntaxKind::CallExpression
        || call.expression().kind() != SyntaxKind::SuperKeyword
    {
        return false;
    }
    let arguments = call.arguments().into_iter().collect::<Vec<_>>();
    let [spread] = arguments.as_slice() else {
        return false;
    };
    spread.kind() == SyntaxKind::SpreadElement
        && spread.expression().kind() == SyntaxKind::Identifier
        && spread.expression().text() == "arguments"
        && ctor.parameters().is_empty()
        // Any other read needs the arguments object itself.
        && parameters::arguments_reference_except(ctor, spread.expression()).is_none()
}

/// The `arguments` object a constructor must materialize. A parameterless
/// constructor that only forwards `super(...arguments)` adopts the base ABI.
pub(super) fn constructor_arguments_object(ctor: Node) -> Option<Node> {
    if forwarded_super_arguments(ctor) {
        None
    } else {
        parameters::arguments_reference(ctor)
    }
}

impl Lowerer<'_> {
    pub(super) fn request_constructor(&mut self, index: usize) -> Result<Vec<Param>, String> {
        self.layout_class(index)?;
        if let Some(params) = &self.classes.definitions[index].signature {
            return Ok(params.clone());
        }
        let definition = self.classes.definitions[index].clone();
        if let Some(name) = boxed::kind(&definition.name) {
            let params = vec![
                Param {
                    local_id: "p0".into(),
                    name: "this".into(),
                    r#type: self.classes.object(index),
                },
                Param {
                    local_id: "p1".into(),
                    name: "value".into(),
                    r#type: boxed::payload(name),
                },
            ];
            self.classes.definitions[index].signature = Some(params.clone());
            self.classes.pending.push_back(index);
            return Ok(params);
        }
        if definition.name.starts_with("native_builtin_Text")
            || definition.name == async_context::CLASS
            || definition.name == weak_maps::CLASS
            || definition.name == weak_sets::CLASS
            || definition.name == event_emitters::CLASS
            || definition.name == async_resources::CLASS
            || definition.name == dom_events::CLASS
            || definition.name == dom_events::TARGET_CLASS
            || definition.name == node_streams::TRANSFORM
            || definition.name == node_streams::DUPLEX
            || definition.name == node_streams::READABLE
            || definition.name == node_streams::WRITABLE
            || definition.name == node_console::CLASS
        {
            let mut params = vec![Param {
                local_id: "p0".into(),
                name: "this".into(),
                r#type: self.classes.object(index),
            }];
            if definition.name.ends_with("TextDecoder") {
                params.push(Param {
                    local_id: "p1".into(),
                    name: "fatal".into(),
                    r#type: Type::Bool,
                });
            }
            self.classes.definitions[index].signature = Some(params.clone());
            self.classes.pending.push_back(index);
            return Ok(params);
        }
        let constructors = definition
            .node
            .members()
            .into_iter()
            .filter(|m| m.kind() == SyntaxKind::Constructor)
            .collect::<Vec<_>>();
        if constructors.len() > 1 {
            return Err(self.refuse(definition.node, "constructor overloads are not ported"));
        }
        let mut params = vec![Param {
            local_id: "p0".into(),
            name: "this".into(),
            r#type: self.classes.object(index),
        }];
        if let Some(ctor) = constructors.first() {
            if ctor.body().is_nil() {
                return Err(self.refuse(*ctor, "constructor body is required"));
            }
            let constructor_params = ctor.parameters().into_iter().collect::<Vec<_>>();
            if constructor_params.is_empty()
                && definition.base.is_some()
                && forwarded_super_arguments(*ctor)
            {
                let base = self.request_constructor(definition.base.unwrap())?;
                params.extend(base.into_iter().skip(1));
            }
            if constructor_arguments_object(*ctor).is_some() {
                params.push(Param {
                    local_id: "p1".into(),
                    name: "arguments".into(),
                    r#type: Type::Array {
                        elem: Box::new(Type::Dyn),
                    },
                });
            }
            for (i, node) in constructor_params
                .iter()
                .copied()
                .enumerate()
                .filter(|_| constructor_arguments_object(*ctor).is_none())
            {
                let rest = !node.dot_dot_dot_token().is_nil();
                if !matches!(
                    node.name().kind(),
                    SyntaxKind::Identifier | SyntaxKind::ObjectBindingPattern
                ) || (rest
                    && (node.name().kind() != SyntaxKind::Identifier
                        || i + 1 != constructor_params.len()))
                    || (parameter_property(node) && node.name().kind() != SyntaxKind::Identifier)
                    || node
                        .modifiers()
                        .nodes()
                        .into_iter()
                        .any(|modifier| modifier.kind() == SyntaxKind::Decorator)
                {
                    return Err(self.refuse(
                        node,
                        "constructor rest must be one terminal identifier; decorated and binding-pattern properties are not ported",
                    ));
                }
                if node.name().kind() == SyntaxKind::ObjectBindingPattern {
                    self.validate_object_parameter(node)?;
                }
                let planned = if parameter_abi::is_javascript(node) && node.type_().is_nil() {
                    let symbol = self.parameter_symbol(node);
                    self.js_parameter_types.get(&symbol).cloned()
                } else {
                    None
                };
                let ty = if let Some(ty) = planned {
                    ty
                } else if let Some(hint) = self
                    .class_contract(definition.node)
                    .filter(|hint| hint.constructor_declared)
                {
                    // JavaScript declarations and demand-pruned CommonJS
                    // projections can expose fewer constructor parameters
                    // than the implementation receives. Keep every source
                    // parameter in the implementation ABI; use public types
                    // where present and an owning dynamic slot otherwise.
                    hint.params.get(i).cloned().flatten().unwrap_or(Type::Dyn)
                } else {
                    match self.storage_type(node.name()) {
                        Ok(ty) => ty,
                        Err(error) => self.class_callback_type(node.name()).ok_or(error)?,
                    }
                };
                params.push(Param {
                    local_id: format!("p{}", i + 1),
                    name: node.name().text().into(),
                    r#type: self.parameter_type(node, ty)?,
                });
            }
        } else if let Some(base) = definition.base {
            if self.classes.definitions[base].node.is_nil()
                && self.classes.definitions[base].name != event_emitters::CLASS
                && self.classes.definitions[base].name != async_resources::CLASS
                && self.classes.definitions[base].name != dom_events::CLASS
                && self.classes.definitions[base].name != dom_events::TARGET_CLASS
                && self.classes.definitions[base].name != node_streams::TRANSFORM
                && self.classes.definitions[base].name != node_streams::DUPLEX
                && self.classes.definitions[base].name != node_streams::READABLE
                && self.classes.definitions[base].name != node_streams::WRITABLE
            {
                let ty = self
                    .intern_union(vec![Type::String, Type::Undefined])
                    .unwrap();
                params.push(Param {
                    local_id: "p1".into(),
                    name: "message".into(),
                    r#type: ty,
                });
            } else {
                let base = self.request_constructor(base)?;
                params.extend(base.into_iter().skip(1));
            }
        }
        self.classes.definitions[index].signature = Some(params.clone());
        self.classes.pending.push_back(index);
        Ok(params)
    }

    fn super_arguments(
        &mut self,
        call: Node,
        types: &[Type],
    ) -> Result<(Vec<Expr>, Vec<Expr>), String> {
        let arguments = call.arguments().into_iter().collect::<Vec<_>>();
        if arguments.len() <= types.len()
            || arguments
                .iter()
                .any(|argument| argument.kind() == SyntaxKind::SpreadElement)
        {
            return Ok((self.call_arguments(call, types)?, Vec::new()));
        }
        let accepted = types
            .iter()
            .enumerate()
            .map(|(index, ty)| self.expected_call_argument(arguments[index], ty.clone(), false))
            .collect::<Result<Vec<_>, _>>()?;
        let ignored = arguments
            .iter()
            .skip(types.len())
            .map(|argument| self.expression(*argument))
            .collect::<Result<Vec<_>, _>>()?;
        Ok((accepted, ignored))
    }

    fn super_call(
        &mut self,
        index: usize,
        mut args: Vec<Expr>,
        ignored: Vec<Expr>,
        site: Node,
    ) -> Result<Stmt, String> {
        let base = self.classes.definitions[index].base.unwrap();
        let mut prefix = Vec::new();
        if !ignored.is_empty() {
            let mut captured = Vec::with_capacity(args.len());
            for argument in args {
                let local = self.construction_local(argument.ty(), false);
                prefix.push(Stmt::VarDecl {
                    local_id: local.id.clone(),
                    init: argument,
                    loc: self.loc(site),
                });
                captured.push(self.construction_read(&local, site));
            }
            args = captured;
            prefix.extend(ignored.into_iter().map(|expr| Stmt::Expression {
                expr,
                loc: self.loc(site),
            }));
        }
        let this_ty = self.classes.object(index);
        let obj = Expr::VarRef {
            local_id: "p0".into(),
            r#type: this_ty,
            loc: self.loc(site),
        };
        let obj = self.coerce(obj, self.classes.object(base), site)?;
        let expr = if matches!(
            self.classes.definitions[base].name.as_str(),
            event_emitters::CLASS
                | async_resources::CLASS
                | dom_events::CLASS
                | dom_events::TARGET_CLASS
                | node_streams::TRANSFORM
                | node_streams::DUPLEX
                | node_streams::READABLE
                | node_streams::WRITABLE
        ) {
            self.request_constructor(base)?;
            if !matches!(
                self.classes.definitions[base].name.as_str(),
                async_resources::CLASS
                    | dom_events::CLASS
                    | dom_events::TARGET_CLASS
                    | node_streams::TRANSFORM
                    | node_streams::DUPLEX
                    | node_streams::READABLE
                    | node_streams::WRITABLE
            ) && !args.is_empty()
            {
                return Err(
                    self.refuse(site, "Node event/stream constructor options are not ported")
                );
            }
            if matches!(
                self.classes.definitions[base].name.as_str(),
                node_streams::TRANSFORM
                    | node_streams::DUPLEX
                    | node_streams::READABLE
                    | node_streams::WRITABLE
            ) && args.len() > 1
            {
                return Err(self.refuse(
                    site,
                    "Node stream constructor accepts one native options value",
                ));
            }
            let call = Expr::Call {
                callee: format!("%{}.constructor", self.classes.definitions[base].name),
                args: vec![obj],
                r#type: Type::Void,
                loc: self.loc(site),
            };
            if args.is_empty() {
                call
            } else {
                Expr::Sequence {
                    stmts: args
                        .into_iter()
                        .map(|expr| Stmt::Expression {
                            expr,
                            loc: self.loc(site),
                        })
                        .collect(),
                    result: Box::new(call),
                    r#type: Type::Void,
                    loc: self.loc(site),
                }
            }
        } else if self.classes.definitions[base].node.is_nil() {
            if args.len() > 2 {
                return Err(self.refuse(site, "Error accepts message and optional cause options"));
            }
            let mut args = args.into_iter();
            let message = self.message_value(args.next(), site)?;
            if self.classes.definitions[base].name == "%DOMException" {
                let name = match args.next() {
                    None => Expr::StrLit {
                        value: "Error".into(),
                        r#type: Type::String,
                        loc: self.loc(site),
                    },
                    Some(value) if value.ty() == Type::Undefined => Expr::StrLit {
                        value: "Error".into(),
                        r#type: Type::String,
                        loc: self.loc(site),
                    },
                    Some(value) => self.message_value(Some(value), site)?,
                };
                return Ok(Stmt::Expression {
                    expr: Expr::LibCall {
                        r#fn: "error.domExceptionCtor".into(),
                        args: vec![obj, message, name],
                        r#type: Type::Void,
                        loc: self.loc(site),
                    },
                    loc: self.loc(site),
                });
            }
            let options = args
                .next()
                .map(|value| self.coerce(value, Type::Dyn, site))
                .transpose()?;
            Expr::LibCall {
                r#fn: "error.ctor".into(),
                args: std::iter::once(obj)
                    .chain(std::iter::once(message))
                    .chain(options)
                    .collect(),
                r#type: Type::Void,
                loc: self.loc(site),
            }
        } else {
            Expr::Call {
                callee: format!("%{}.constructor", self.classes.definitions[base].name),
                args: std::iter::once(obj).chain(args).collect(),
                r#type: Type::Void,
                loc: self.loc(site),
            }
        };
        let expr = if prefix.is_empty() {
            expr
        } else {
            Expr::Sequence {
                stmts: prefix,
                result: Box::new(expr),
                r#type: Type::Void,
                loc: self.loc(site),
            }
        };
        Ok(Stmt::Expression {
            expr,
            loc: self.loc(site),
        })
    }

    fn initialize_fields(&mut self, index: usize) -> Result<Vec<Stmt>, String> {
        let mut body = self.initialize_private_methods(index)?;
        for field in self.classes.definitions[index].node.members() {
            if field.kind() != SyntaxKind::PropertyDeclaration
                || field.modifier_flags().intersects(ModifierFlags::STATIC)
                || field.modifier_flags().intersects(ModifierFlags::ABSTRACT)
            {
                continue;
            }
            if field.modifier_flags().intersects(ModifierFlags::AMBIENT) {
                continue;
            }
            if field.name().kind() == SyntaxKind::PrivateIdentifier {
                body.push(self.initialize_private_field(field)?);
                continue;
            }
            if field.name().kind() == SyntaxKind::ComputedPropertyName {
                let key = field.name().expression();
                if self.class_symbol_key(key).is_none() {
                    return Err(
                        self.refuse(field, "computed class field needs a stable symbol key")
                    );
                }
                let object = self.this_expression(field)?;
                let object = self.coerce(object, Type::Dyn, field)?;
                let key = self.expression(key)?;
                let value = if field.initializer().is_nil() {
                    Expr::UnitLit {
                        unit: "undefined",
                        r#type: Type::Undefined,
                        loc: self.loc(field),
                    }
                } else {
                    self.expression(field.initializer())?
                };
                let value = self.coerce(value, Type::Dyn, field)?;
                body.push(self.checked_dynamic_property_set(field, object, key, value)?);
                continue;
            }
            let class_name = self.classes.definitions[index].name.clone();
            let ty = self.field_type(&class_name, field.name().text()).unwrap();
            let value = if field.initializer().is_nil() {
                self.coerce(
                    Expr::UnitLit {
                        unit: "undefined",
                        r#type: Type::Undefined,
                        loc: self.loc(field),
                    },
                    ty,
                    field,
                )?
            } else {
                let initializer = receivers::reference_node(field.initializer());
                if matches!(
                    initializer.kind(),
                    SyntaxKind::PropertyAccessExpression | SyntaxKind::ElementAccessExpression
                ) && initializer.expression().kind() == SyntaxKind::ThisKeyword
                {
                    let value = self.expression(initializer)?;
                    // A field can observe a later field or a parameter property
                    // before its assignment. When the destination admits the
                    // actual owning slot, do not invent a presence proof from
                    // the checker's declared scalar type.
                    if let Expr::UnionNarrow { value: source, .. } = &value
                        && matches!(source.as_ref(), Expr::FieldGet { .. })
                        && let Ok(value) = self.coerce(source.as_ref().clone(), ty.clone(), field)
                    {
                        value
                    } else {
                        self.coerce(value, ty, field)?
                    }
                } else {
                    self.expected_expression(field.initializer(), ty)?
                }
            };
            body.push(Stmt::FieldSet {
                obj: self.this_expression(field)?,
                class_name,
                field: field.name().text().into(),
                value,
                loc: self.loc(field),
            });
        }
        Ok(body)
    }

    fn initialize_parameter_properties(
        &mut self,
        index: usize,
        ctor: Node,
    ) -> Result<Vec<Stmt>, String> {
        let class_name = self.classes.definitions[index].name.clone();
        ctor.parameters()
            .into_iter()
            .filter(|param| parameter_property(*param))
            .map(|param| {
                let field = param.name().text().to_string();
                let ty = self.field_type(&class_name, &field).unwrap();
                // Defaults and pre-super assignments belong to the live local,
                // not the immutable incoming ABI slot. TS access modifiers do
                // not turn these ordinary own properties into private slots.
                let symbol = self.parameter_symbol(param);
                let local = self.resolve_binding(symbol, param.name())?;
                let value = Expr::VarRef {
                    local_id: local.id,
                    r#type: local.r#type,
                    loc: self.loc(param),
                };
                let value = self.coerce(value, ty, param)?;
                Ok(Stmt::FieldSet {
                    obj: self.this_expression(param)?,
                    class_name: class_name.clone(),
                    field,
                    value,
                    loc: self.loc(param),
                })
            })
            .collect()
    }

    pub(in crate::frontend) fn lower_constructor(
        &mut self,
        index: usize,
    ) -> Result<Function, String> {
        let definition = self.classes.definitions[index].clone();
        if let Some(name) = boxed::kind(&definition.name) {
            return self.boxed_constructor(index, name);
        }
        if definition.name == weak_sets::CLASS {
            return Ok(self.weak_set_constructor(index));
        }
        if definition.name.starts_with("native_builtin_Text")
            || definition.name == async_context::CLASS
            || definition.name == weak_maps::CLASS
            || definition.name == event_emitters::CLASS
            || definition.name == async_resources::CLASS
            || definition.name == dom_events::CLASS
            || definition.name == dom_events::TARGET_CLASS
            || definition.name == node_streams::TRANSFORM
            || definition.name == node_streams::DUPLEX
            || definition.name == node_streams::READABLE
            || definition.name == node_streams::WRITABLE
            || definition.name == node_console::CLASS
        {
            let mut params = vec![self.classes.object(index)];
            if definition.name.ends_with("TextDecoder") {
                params.push(Type::Bool);
                params.push(Type::F64);
            }
            let mut function = helpers::Helper::new(
                &format!("%{}.constructor", definition.name),
                params,
                Type::Void,
                self.classes.layouts[index].as_ref().unwrap().loc.clone(),
            )
            .function;
            function.name = format!("%{}.constructor", definition.name);
            if definition.name.ends_with("TextDecoder") {
                function.body.push(Stmt::FieldSet {
                    obj: Expr::VarRef {
                        local_id: "p0".into(),
                        r#type: self.classes.object(index),
                        loc: function.loc.clone(),
                    },
                    class_name: definition.name.clone(),
                    field: codecs::TEXT_DECODER_FATAL.into(),
                    value: Expr::DynFrom {
                        value: Box::new(Expr::VarRef {
                            local_id: "p1".into(),
                            r#type: Type::Bool,
                            loc: function.loc.clone(),
                        }),
                        r#type: Type::Dyn,
                        loc: function.loc.clone(),
                    },
                    loc: function.loc.clone(),
                });
                function.body.push(Stmt::FieldSet {
                    obj: Expr::VarRef {
                        local_id: "p0".into(),
                        r#type: self.classes.object(index),
                        loc: function.loc.clone(),
                    },
                    class_name: definition.name.clone(),
                    field: codecs::TEXT_DECODER_ENCODING.into(),
                    value: Expr::DynFrom {
                        value: Box::new(Expr::VarRef {
                            local_id: "p2".into(),
                            r#type: Type::F64,
                            loc: function.loc.clone(),
                        }),
                        r#type: Type::Dyn,
                        loc: function.loc.clone(),
                    },
                    loc: function.loc.clone(),
                });
                function.body.push(Stmt::FieldSet {
                    obj: Expr::VarRef {
                        local_id: "p0".into(),
                        r#type: self.classes.object(index),
                        loc: function.loc.clone(),
                    },
                    class_name: definition.name.clone(),
                    field: codecs::TEXT_DECODER_HANDLE.into(),
                    value: Expr::DynFrom {
                        value: Box::new(Expr::LibCall {
                            r#fn: "text.decoderNew".into(),
                            args: vec![],
                            r#type: Type::F64,
                            loc: function.loc.clone(),
                        }),
                        r#type: Type::Dyn,
                        loc: function.loc.clone(),
                    },
                    loc: function.loc.clone(),
                });
            }
            if definition.name == async_context::CLASS {
                function.body.push(Stmt::FieldSet {
                    obj: Expr::VarRef {
                        local_id: "p0".into(),
                        r#type: self.classes.object(index),
                        loc: function.loc.clone(),
                    },
                    class_name: definition.name.clone(),
                    field: async_context::HANDLE.into(),
                    value: Expr::DynFrom {
                        value: Box::new(Expr::LibCall {
                            r#fn: "als.new".into(),
                            args: vec![],
                            r#type: Type::F64,
                            loc: function.loc.clone(),
                        }),
                        r#type: Type::Dyn,
                        loc: function.loc.clone(),
                    },
                    loc: function.loc.clone(),
                });
            }
            return Ok(function);
        }
        self.file = definition.file.clone();
        self.locals.clear();
        self.bindings.clear();
        self.captures.clear();
        self.instance_this = None;
        self.return_type = Some(Type::Void);
        self.var_types = self.module_vars.clone();
        self.var_defined.clear();
        let mut params = definition.signature.clone().unwrap();
        self.bind_parameter(None, &params[0])?;
        let this = self.locals[0].clone();
        for (symbol, _, ty) in &definition.captures {
            let param = Param {
                local_id: format!("p{}", params.len()),
                name: format!("class capture {}", params.len()),
                r#type: ty.clone(),
            };
            let local = Local {
                id: param.local_id.clone(),
                name: param.name.clone(),
                r#type: param.r#type.clone(),
                mutable: self.mutable_lexical_binding(*symbol),
                boxed: false,
            };
            self.locals.push(local.clone());
            self.bindings.insert(*symbol, local);
            params.push(param);
        }
        let ctor = definition
            .node
            .members()
            .into_iter()
            .find(|m| m.kind() == SyntaxKind::Constructor);
        let base = definition.base;
        let mut body = Vec::new();
        // Base fields run before parameter defaults. Derived fields run after
        // the successful super call, before the following body statement.
        if base.is_none() {
            self.instance_this = Some(this.clone());
            body.extend(self.initialize_fields(index)?);
        }
        if let Some(ctor) = ctor {
            if forwarded_super_arguments(ctor) {
                let inherited = definition.signature.as_ref().unwrap().len();
                for param in params.iter().take(inherited).skip(1) {
                    self.bind_parameter(None, param)?;
                }
            }
            fn has_return(node: Node) -> bool {
                if node.kind() == SyntaxKind::ReturnStatement {
                    return true;
                }
                if matches!(
                    node.kind(),
                    SyntaxKind::FunctionDeclaration
                        | SyntaxKind::FunctionExpression
                        | SyntaxKind::ArrowFunction
                        | SyntaxKind::ClassDeclaration
                        | SyntaxKind::ClassExpression
                ) {
                    return false;
                }
                let mut found = false;
                node.for_each_child(&mut |child| {
                    found |= has_return(child);
                    found
                });
                found
            }
            fn has_value_return(node: Node) -> bool {
                if node.kind() == SyntaxKind::ReturnStatement {
                    return !node.expression().is_nil();
                }
                if matches!(
                    node.kind(),
                    SyntaxKind::FunctionDeclaration
                        | SyntaxKind::FunctionExpression
                        | SyntaxKind::ArrowFunction
                        | SyntaxKind::ClassDeclaration
                        | SyntaxKind::ClassExpression
                ) {
                    return false;
                }
                let mut found = false;
                node.for_each_child(&mut |child| {
                    found |= has_value_return(child);
                    found
                });
                found
            }
            fn return_count(node: Node) -> usize {
                if node.kind() == SyntaxKind::ReturnStatement {
                    return 1;
                }
                if matches!(
                    node.kind(),
                    SyntaxKind::FunctionDeclaration
                        | SyntaxKind::FunctionExpression
                        | SyntaxKind::ArrowFunction
                        | SyntaxKind::ClassDeclaration
                        | SyntaxKind::ClassExpression
                ) {
                    return 0;
                }
                let mut count = 0;
                node.for_each_child(&mut |child| {
                    count += return_count(child);
                    false
                });
                count
            }
            fn lexical_super_call(statement: Node, source: &str) -> Option<Node> {
                if statement.is_nil() {
                    return None;
                }
                let start = statement.pos().max(0) as usize;
                let end = statement.end().max(0) as usize;
                let mut raw = source.get(start..end).unwrap_or("").trim_start();
                loop {
                    if let Some(comment) = raw.strip_prefix("//") {
                        raw = comment
                            .find('\n')
                            .map(|end| &comment[end + 1..])
                            .unwrap_or("")
                            .trim_start();
                        continue;
                    }
                    if let Some(comment) = raw.strip_prefix("/*") {
                        raw = comment
                            .find("*/")
                            .map(|end| &comment[end + 2..])
                            .unwrap_or("")
                            .trim_start();
                        continue;
                    }
                    break;
                }
                if !raw.starts_with("super") {
                    return None;
                }
                // A constructor statement whose source starts with the
                // reserved `super` token can only be the direct call we seek.
                // Store nodes are assigned in post-order, so the root
                // expression is the slot immediately before its expression
                // statement. Avoid the generic expression dispatcher here:
                // for a missing optional arm it asks goport for the nil node's
                // kind before reaching the frozen child column.
                statement.0.checked_sub(1).map(Node).and_then(Node::get)
            }
            fn redundant_prototype_repair(declaration: Node, branch: Node) -> bool {
                if declaration.kind() != SyntaxKind::VariableStatement
                    || branch.kind() != SyntaxKind::IfStatement
                {
                    return false;
                }
                let declarations = declaration
                    .declaration_list()
                    .declarations()
                    .nodes()
                    .into_iter()
                    .collect::<Vec<_>>();
                let [binding] = declarations.as_slice() else {
                    return false;
                };
                let name = binding.name();
                let initializer = binding.initializer();
                if name.kind() != SyntaxKind::Identifier
                    || initializer.kind() != SyntaxKind::PropertyAccessExpression
                    || initializer.name().text() != "prototype"
                {
                    return false;
                }
                let new_target = initializer.expression();
                if new_target.kind() != SyntaxKind::MetaProperty
                    || new_target.keyword_token() != SyntaxKind::NewKeyword
                    || new_target.name().text() != "target"
                {
                    return false;
                }
                let condition = branch.expression();
                if condition.kind() != SyntaxKind::PropertyAccessExpression
                    || condition.expression().kind() != SyntaxKind::Identifier
                    || condition.expression().text() != "Object"
                    || condition.name().text() != "setPrototypeOf"
                {
                    return false;
                }
                if branch.then_statement().kind() != SyntaxKind::Block
                    || branch.else_statement().kind() != SyntaxKind::Block
                {
                    return false;
                }
                let then_statements = branch
                    .then_statement()
                    .statements()
                    .into_iter()
                    .collect::<Vec<_>>();
                let else_statements = branch
                    .else_statement()
                    .statements()
                    .into_iter()
                    .collect::<Vec<_>>();
                let ([then_statement], [else_statement]) =
                    (then_statements.as_slice(), else_statements.as_slice())
                else {
                    return false;
                };
                if then_statement.kind() != SyntaxKind::ExpressionStatement
                    || else_statement.kind() != SyntaxKind::ExpressionStatement
                {
                    return false;
                }
                let call = then_statement.expression();
                if call.kind() != SyntaxKind::CallExpression {
                    return false;
                }
                let arguments = call.arguments().into_iter().collect::<Vec<_>>();
                let [receiver, proto] = arguments.as_slice() else {
                    return false;
                };
                let callee = call.expression();
                if callee.kind() != SyntaxKind::PropertyAccessExpression
                    || callee.expression().kind() != SyntaxKind::Identifier
                    || callee.expression().text() != "Object"
                    || callee.name().text() != "setPrototypeOf"
                    || receiver.kind() != SyntaxKind::ThisKeyword
                    || proto.kind() != SyntaxKind::Identifier
                    || proto.text() != name.text()
                {
                    return false;
                }
                let assignment = else_statement.expression();
                if assignment.kind() != SyntaxKind::BinaryExpression {
                    return false;
                }
                let left = assignment.left();
                let right = assignment.right();
                assignment.operator_token().kind() == SyntaxKind::EqualsToken
                    && left.kind() == SyntaxKind::PropertyAccessExpression
                    && left.expression().kind() == SyntaxKind::ThisKeyword
                    && left.name().text() == "__proto__"
                    && right.kind() == SyntaxKind::Identifier
                    && right.text() == name.text()
            }
            fn mentions_identifier(node: Node, name: &str) -> bool {
                if node.kind() == SyntaxKind::Identifier && node.text() == name {
                    return true;
                }
                let mut found = false;
                node.for_each_child(&mut |child| {
                    found |= mentions_identifier(child, name);
                    found
                });
                found
            }
            let source =
                source_frontend::ast::source_file_text(program::get_source_file(&definition.file));
            let statements = ctor.body().statements().into_iter().collect::<Vec<_>>();
            let prototype_repair = source
                .contains("__proto__")
                .then(|| {
                    statements
                        .windows(2)
                        .enumerate()
                        .find_map(|(position, pair)| {
                            // The repair branch reads and mutates `this`, which is
                            // only legal after successful base construction in a
                            // derived constructor. Avoid probing every preceding
                            // statement merely to rediscover that source invariant.
                            if !redundant_prototype_repair(pair[0], pair[1]) {
                                return None;
                            }
                            let object = pair[1].expression().expression();
                            if !self.standard_object(object) {
                                return None;
                            }
                            let binding = pair[0]
                                .declaration_list()
                                .declarations()
                                .nodes()
                                .first()
                                .unwrap();
                            let name = binding.name().text();
                            (!statements[position + 2..]
                                .iter()
                                .any(|statement| mentions_identifier(*statement, name)))
                            .then_some(position)
                        })
                })
                .flatten();
            // A WebIDL fast path commonly constructs the base in a leading
            // branch and returns, then constructs it on the ordinary path.
            // Recognize only that closed shape. Source prefilters and direct
            // statement roots keep optional goport sentinels out of the scan.
            let branching_super = (base.is_some()
                && source.contains("super")
                && source.contains("return")
                && return_count(ctor.body()) == 1)
                .then(|| {
                    statements
                        .iter()
                        .enumerate()
                        .find_map(|(position, branch)| {
                            if branch.kind() != SyntaxKind::IfStatement
                                || !branch.else_statement().is_nil()
                                || branch.then_statement().kind() != SyntaxKind::Block
                            {
                                return None;
                            }
                            let then_statements = branch
                                .then_statement()
                                .statements()
                                .into_iter()
                                .collect::<Vec<_>>();
                            let (Some(first), Some(last)) =
                                (then_statements.first(), then_statements.last())
                            else {
                                return None;
                            };
                            if last.kind() != SyntaxKind::ReturnStatement
                                || !last.expression().is_nil()
                            {
                                return None;
                            }
                            let then_call = lexical_super_call(*first, &source)?;
                            if then_call.kind() != SyntaxKind::CallExpression
                                || then_call.expression().kind() != SyntaxKind::SuperKeyword
                            {
                                return None;
                            }
                            let (else_position, else_call) =
                                statements.iter().enumerate().skip(position + 1).find_map(
                                    |(candidate_position, statement)| {
                                        let call = lexical_super_call(*statement, &source)?;
                                        (call.kind() == SyntaxKind::CallExpression
                                            && call.expression().kind() == SyntaxKind::SuperKeyword)
                                            .then_some((candidate_position, call))
                                    },
                                )?;
                            if statements[position + 1..else_position]
                                .iter()
                                .any(|statement| has_return(*statement))
                            {
                                return None;
                            }
                            Some((
                                position,
                                *branch,
                                then_call,
                                then_statements,
                                else_position,
                                else_call,
                            ))
                        })
                })
                .flatten();
            let unconditional_super_position = base.and_then(|_| {
                statements
                    .iter()
                    .enumerate()
                    .find_map(|(position, statement)| {
                        let call = lexical_super_call(*statement, &source)?;
                        (call.kind() == SyntaxKind::CallExpression
                            && call.expression().kind() == SyntaxKind::SuperKeyword)
                            .then_some(position)
                    })
            });
            let returns_after_unconditional_super =
                unconditional_super_position.is_some_and(|position| {
                    !statements
                        .iter()
                        .take(position + 1)
                        .any(|statement| has_return(*statement))
                });
            if has_value_return(ctor.body())
                || (base.is_some()
                    && has_return(ctor.body())
                    && branching_super.is_none()
                    && !returns_after_unconditional_super)
            {
                return Err(self.refuse(ctor, "constructor early returns are not ported"));
            }
            if let Some(arguments) = constructor_arguments_object(ctor) {
                let incoming = params
                    .get(1)
                    .ok_or_else(|| self.refuse(ctor, "arguments object has no native transport"))?
                    .clone();
                body.extend(self.bind_parameter(None, &incoming)?);
                let symbol = self.symbol(arguments);
                if symbol != 0 {
                    let local = self
                        .locals
                        .last()
                        .expect("arguments transport local")
                        .clone();
                    self.bindings.insert(symbol, local);
                }
                let nodes = ctor.parameters().into_iter().collect::<Vec<_>>();
                body.extend(self.bind_erased_rest_formals(&nodes, &incoming)?);
            } else {
                for (node, param) in ctor.parameters().into_iter().zip(params.iter().skip(1)) {
                    body.extend(self.bind_parameter(Some(node), param)?);
                }
            }
            if base.is_none() {
                body.extend(self.initialize_parameter_properties(index, ctor)?);
            }
            body.extend(self.hoist_local_vars(ctor.body())?);
            // Closures in the constructor may capture a `const` declared
            // later in its body (the binding cell exists before initializing).
            body.extend(self.hoist_forward_closures(ctor.body())?);
            if let Some((position, branch, then_call, then_statements, else_position, else_call)) =
                branching_super
            {
                let base = base.ok_or_else(|| {
                    self.refuse(branch, "conditional super requires a derived class")
                })?;
                for statement in statements.iter().take(position) {
                    body.extend(self.statement(*statement)?);
                }
                let condition_value = self.condition_value(branch.expression())?;
                let condition = self.condition(condition_value, branch.expression())?;
                let before = self.var_defined.clone();
                if let Some(symbols) = self.guarded_vars(branch.expression(), true) {
                    self.var_defined.extend(symbols);
                }

                let (then_args, then_ignored) = if self.classes.definitions[base].node.is_nil() {
                    (
                        then_call
                            .arguments()
                            .into_iter()
                            .map(|argument| self.expression(argument))
                            .collect::<Result<Vec<_>, _>>()?,
                        Vec::new(),
                    )
                } else {
                    let types = self
                        .request_constructor(base)?
                        .into_iter()
                        .skip(1)
                        .map(|param| param.r#type)
                        .collect::<Vec<_>>();
                    self.super_arguments(then_call, &types)?
                };
                let mut then = vec![self.super_call(index, then_args, then_ignored, then_call)?];
                self.instance_this = Some(this.clone());
                then.extend(self.initialize_fields(index)?);
                then.extend(self.initialize_parameter_properties(index, ctor)?);
                for statement in then_statements.iter().skip(1) {
                    then.extend(self.statement(*statement)?);
                }
                let then_defined = self.var_defined.clone();

                self.instance_this = None;
                self.var_defined = before;
                if let Some(symbols) = self.guarded_vars(branch.expression(), false) {
                    self.var_defined.extend(symbols);
                }
                let mut else_ = Vec::new();
                for statement in statements.iter().take(else_position).skip(position + 1) {
                    else_.extend(self.statement(*statement)?);
                }
                let (else_args, else_ignored) = if self.classes.definitions[base].node.is_nil() {
                    (
                        else_call
                            .arguments()
                            .into_iter()
                            .map(|argument| self.expression(argument))
                            .collect::<Result<Vec<_>, _>>()?,
                        Vec::new(),
                    )
                } else {
                    let types = self
                        .request_constructor(base)?
                        .into_iter()
                        .skip(1)
                        .map(|param| param.r#type)
                        .collect::<Vec<_>>();
                    self.super_arguments(else_call, &types)?
                };
                else_.push(self.super_call(index, else_args, else_ignored, else_call)?);
                self.instance_this = Some(this.clone());
                else_.extend(self.initialize_fields(index)?);
                else_.extend(self.initialize_parameter_properties(index, ctor)?);
                for statement in statements.iter().skip(else_position + 1) {
                    else_.extend(self.statement(*statement)?);
                }
                let else_defined = self.var_defined.clone();
                self.var_defined = if !ir::falls_through(&then) {
                    else_defined
                } else if !ir::falls_through(&else_) {
                    then_defined
                } else {
                    then_defined.intersection(&else_defined).copied().collect()
                };
                body.push(Stmt::If {
                    cond: condition,
                    then,
                    else_: Some(else_),
                    loc: self.loc(branch),
                });
            } else {
                let mut super_seen = false;
                for (position, statement) in statements.into_iter().enumerate() {
                    if prototype_repair
                        .is_some_and(|start| position == start || position == start + 1)
                    {
                        // Native class construction already assigns new.target.prototype.
                        // Both legacy repair branches would set the same prototype.
                        continue;
                    }
                    if base.is_some()
                        && !super_seen
                        && statement.kind() == SyntaxKind::TryStatement
                        && statement.finally_block().is_nil()
                    {
                        let protected = statement
                            .try_block()
                            .statements()
                            .into_iter()
                            .collect::<Vec<_>>();
                        let super_sites = protected
                            .iter()
                            .enumerate()
                            .filter_map(|(position, statement)| {
                                lexical_super_call(*statement, &source).map(|call| (position, call))
                            })
                            .collect::<Vec<_>>();
                        if super_sites.len() == 1 {
                            let catch = statement.catch_clause();
                            if catch.is_nil() {
                                return Err(self.refuse(
                                    statement,
                                    "protected super construction requires a catch region",
                                ));
                            }
                            let base = base.ok_or_else(|| {
                                self.refuse(statement, "super requires a derived class")
                            })?;
                            let before = self.var_defined.clone();
                            let bindings = self.bindings.clone();
                            let mut try_body = Vec::new();
                            for (protected_position, protected_statement) in
                                protected.into_iter().enumerate()
                            {
                                if protected_position != super_sites[0].0 {
                                    try_body.extend(self.statement(protected_statement)?);
                                    continue;
                                }
                                let call = super_sites[0].1;
                                let (args, ignored) =
                                    if self.classes.definitions[base].node.is_nil() {
                                        (
                                            call.arguments()
                                                .into_iter()
                                                .map(|argument| self.expression(argument))
                                                .collect::<Result<Vec<_>, _>>()?,
                                            Vec::new(),
                                        )
                                    } else {
                                        let types = self
                                            .request_constructor(base)?
                                            .into_iter()
                                            .skip(1)
                                            .map(|parameter| parameter.r#type)
                                            .collect::<Vec<_>>();
                                        self.super_arguments(call, &types)?
                                    };
                                try_body.push(self.super_call(index, args, ignored, call)?);
                                self.instance_this = Some(this.clone());
                                try_body.extend(self.initialize_fields(index)?);
                                try_body.extend(self.initialize_parameter_properties(index, ctor)?);
                            }
                            let try_defined = self.var_defined.clone();
                            let region = self.finish_try_statement(
                                statement,
                                before,
                                bindings,
                                try_body,
                                try_defined,
                            )?;
                            let catch_returns = matches!(
                                region.first(),
                                Some(Stmt::TryCatch {
                                    catch_body: Some(body),
                                    ..
                                }) if ir::always_returns(body)
                            );
                            if !catch_returns {
                                return Err(self.refuse(
                                    catch,
                                    "catch around super must exit when construction fails",
                                ));
                            }
                            body.extend(region);
                            super_seen = true;
                            continue;
                        }
                    }
                    let call = if base.is_some() {
                        lexical_super_call(statement, &source).unwrap_or(Node::NIL)
                    } else {
                        Node::NIL
                    };
                    if !call.is_nil() {
                        if super_seen {
                            return Err(self.refuse(call, "multiple super calls are not ported"));
                        }
                        let base = base
                            .ok_or_else(|| self.refuse(call, "super requires a derived class"))?;
                        let (args, ignored) = if forwarded_super_arguments(ctor) {
                            (
                                params
                                    .iter()
                                    .take(definition.signature.as_ref().unwrap().len())
                                    .skip(1)
                                    .map(|param| Expr::VarRef {
                                        local_id: param.local_id.clone(),
                                        r#type: param.r#type.clone(),
                                        loc: self.loc(call),
                                    })
                                    .collect(),
                                Vec::new(),
                            )
                        } else if self.classes.definitions[base].node.is_nil() {
                            (
                                call.arguments()
                                    .into_iter()
                                    .map(|n| self.expression(n))
                                    .collect::<Result<Vec<_>, _>>()?,
                                Vec::new(),
                            )
                        } else {
                            let types = self
                                .request_constructor(base)?
                                .into_iter()
                                .skip(1)
                                .map(|p| p.r#type)
                                .collect::<Vec<_>>();
                            self.super_arguments(call, &types)?
                        };
                        body.push(self.super_call(index, args, ignored, call)?);
                        self.instance_this = Some(this.clone());
                        body.extend(self.initialize_fields(index)?);
                        body.extend(self.initialize_parameter_properties(index, ctor)?);
                        super_seen = true;
                    } else {
                        if statement.kind() == SyntaxKind::ReturnStatement {
                            if !statement.expression().is_nil() || (base.is_some() && !super_seen) {
                                return Err(self.refuse(
                                    statement,
                                    "constructor early returns are not ported",
                                ));
                            }
                        }
                        body.extend(self.statement(statement)?);
                    }
                }
                if base.is_some() && !super_seen {
                    return Err(
                        self.refuse(ctor, "constructor requires one unconditional super call")
                    );
                }
            }
        } else if let Some(base) = base {
            for param in params.iter().skip(1) {
                self.bind_parameter(None, param)?;
            }
            if !self.classes.definitions[base].node.is_nil() {
                self.request_constructor(base)?;
            }
            let args = params
                .iter()
                .skip(1)
                .map(|p| Expr::VarRef {
                    local_id: p.local_id.clone(),
                    r#type: p.r#type.clone(),
                    loc: self.loc(definition.node),
                })
                .collect();
            body.push(self.super_call(index, args, Vec::new(), definition.node)?);
            self.instance_this = Some(this);
            body.extend(self.initialize_fields(index)?);
        }
        self.instance_this = None;
        Ok(Function {
            is_async: false,
            generator: None,
            rest: false,
            name: format!("%{}.constructor", definition.name),
            params,
            captures: None,
            return_type: Type::Void,
            locals: std::mem::take(&mut self.locals),
            body,
            loc: self.loc(definition.node),
        })
    }
}
