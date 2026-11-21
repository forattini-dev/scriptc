//! Flat sequence patterns share owning iterator snapshots across source contexts.
use super::*;

impl Lowerer<'_> {
    fn object_pattern_record_type(&mut self, pattern: Node) -> Result<Type, String> {
        let mut fields = pattern
            .elements()
            .into_iter()
            .map(|element| {
                let name = if element.property_name().is_nil() {
                    element.name().text().to_string()
                } else {
                    self.data_property_name(element.property_name())
                        .ok_or_else(|| {
                            self.refuse(element, "computed object binding name is not ported")
                        })?
                };
                let r#type = if element.name().kind() == SyntaxKind::ObjectBindingPattern {
                    self.object_pattern_record_type(element.name())?
                } else {
                    self.storage_type(element.name())?
                };
                Ok(ir::Field { name, r#type })
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
        Ok(Type::Record { shape_id })
    }

    fn contextual_array_pattern_type(&mut self, pattern: Node) -> Result<Option<Type>, String> {
        let mut elements = Vec::new();
        for element in pattern.elements() {
            if bindings::omitted(element)
                || !element.dot_dot_dot_token().is_nil()
                || !element.initializer().is_nil()
            {
                return Ok(None);
            }
            let ty = match element.name().kind() {
                SyntaxKind::Identifier => self.storage_type(element.name())?,
                SyntaxKind::ObjectBindingPattern => {
                    self.object_pattern_record_type(element.name())?
                }
                SyntaxKind::ArrayBindingPattern => {
                    let Some(ty) = self.contextual_array_pattern_type(element.name())? else {
                        return Ok(None);
                    };
                    ty
                }
                _ => return Ok(None),
            };
            elements.push(ty);
        }
        Ok(self.intern_tuple(elements))
    }

    pub(super) fn validate_array_pattern(&self, pattern: Node) -> Result<(), String> {
        let elements = pattern.elements();
        for (index, element) in elements.iter().enumerate() {
            if bindings::omitted(element) {
                continue;
            }
            if element.kind() != SyntaxKind::BindingElement
                || !matches!(
                    element.name().kind(),
                    SyntaxKind::Identifier
                        | SyntaxKind::ArrayBindingPattern
                        | SyntaxKind::ObjectBindingPattern
                )
                || (!element.initializer().is_nil()
                    && element.name().kind() != SyntaxKind::Identifier)
                || !element.property_name().is_nil()
                || (!element.dot_dot_dot_token().is_nil() && index + 1 != elements.len())
                || (!element.dot_dot_dot_token().is_nil() && !element.initializer().is_nil())
            {
                return Err(self.refuse(
                    element,
                    "nested, default and non-terminal rest array bindings are not ported",
                ));
            }
            if element.name().kind() == SyntaxKind::ArrayBindingPattern {
                if !element.dot_dot_dot_token().is_nil() {
                    return Err(self.refuse(
                        element,
                        "rest bindings cannot directly contain a nested array pattern",
                    ));
                }
                self.validate_array_pattern(element.name())?;
            } else if element.name().kind() == SyntaxKind::ObjectBindingPattern {
                if !element.dot_dot_dot_token().is_nil() {
                    return Err(self.refuse(
                        element,
                        "rest bindings cannot directly contain a nested object pattern",
                    ));
                }
                self.validate_object_binding_pattern(element.name(), false)?;
            }
        }
        Ok(())
    }

    fn bind_sequence_element_value(
        &mut self,
        element: Node,
        value: Expr,
        source_type: Type,
        mutable: bool,
        module: bool,
    ) -> Result<Vec<Stmt>, String> {
        let name = element.name();
        if name.kind() == SyntaxKind::ArrayBindingPattern {
            return self.bind_sequence_pattern_value(
                name,
                (value, source_type),
                mutable,
                module,
                None,
            );
        }
        if name.kind() == SyntaxKind::ObjectBindingPattern {
            let value = self.coerce(value, source_type, element)?;
            return self.object_binding_value(name, value, mutable, module, element);
        }
        let value = self.coerce(value, source_type, element)?;
        if element.initializer().is_nil() {
            return self
                .publish_binding(name, value, mutable, module, element)
                .map(|statement| vec![statement]);
        }
        if module {
            return Err(self.refuse(
                element,
                "module array bindings with defaults are not ported",
            ));
        }

        // Snapshot the iterator slot exactly once. The shared parameter path
        // performs JavaScript's lazy, undefined-only default and exposes prior
        // bindings to the initializer without exposing later bindings.
        let formal = Param {
            local_id: format!("v{}", self.locals.len()),
            name: name.text().into(),
            r#type: value.ty(),
        };
        let mut body = vec![Stmt::VarDecl {
            local_id: formal.local_id.clone(),
            init: value,
            loc: self.loc(element),
        }];
        body.extend(self.bind_parameter(Some(element), &formal)?);
        let symbol = self.symbol(name);
        if !mutable {
            let incoming = self
                .bindings
                .get(&symbol)
                .cloned()
                .ok_or_else(|| self.refuse(element, "default binding has no native storage"))?;
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
        Ok(body)
    }

    pub(super) fn validate_array_parameter(&self, node: Node) -> Result<(), String> {
        if !node.initializer().is_nil() {
            return Err(self.refuse(node, "array parameter defaults are not ported"));
        }
        self.validate_array_pattern(node.name())
    }

    pub(super) fn array_binding_declaration(
        &mut self,
        node: Node,
        mutable: bool,
        module: bool,
    ) -> Result<Vec<Stmt>, String> {
        self.validate_array_pattern(node.name())?;
        if node.initializer().is_nil() || !node.type_().is_nil() {
            return Err(self.refuse(
                node,
                "array declarations require an inferred initialized sequence",
            ));
        }
        let contextual = if node.initializer().kind() == SyntaxKind::AwaitExpression {
            self.contextual_array_pattern_type(node.name())?
        } else {
            None
        };
        let init = if let Some(target) = contextual {
            self.expected_expression(node.initializer(), target)?
        } else if node.initializer().kind() == SyntaxKind::ArrayLiteralExpression
            && node.initializer().elements().is_empty()
        {
            Expr::DynArrLit {
                elems: vec![],
                r#type: Type::Dyn,
                loc: self.loc(node.initializer()),
            }
        } else {
            self.primitive_operand(node.initializer())?
        };
        let spelling = match node.initializer().kind() {
            SyntaxKind::Identifier => Some(node.initializer().text().to_string()),
            SyntaxKind::NullKeyword => Some("null".into()),
            SyntaxKind::TrueKeyword => Some("true".into()),
            SyntaxKind::FalseKeyword => Some("false".into()),
            SyntaxKind::BigIntLiteral => Some("(intermediate value)".into()),
            _ => None,
        };
        // A known source function can intentionally publish Dyn even when
        // TypeScript inferred a more specific array from an unchecked JS
        // implementation. The IR ABI is authoritative at that boundary;
        // destructured slots acquire checked views only when consumed.
        let erased_call = matches!(
            &init,
            Expr::Call {
                r#type: Type::Dyn,
                ..
            }
        );
        let source_type = if init.ty() == Type::Dyn && !erased_call {
            self.ty(node.initializer())
                .ok()
                .filter(|ty| matches!(ty, Type::Array { .. }))
                .unwrap_or(Type::Dyn)
        } else {
            init.ty()
        };
        self.bind_sequence_pattern_value(
            node.name(),
            (init, source_type),
            mutable,
            module,
            spelling,
        )
    }

    pub(super) fn bind_sequence_pattern(
        &mut self,
        pattern: Node,
        init: Expr,
        mutable: bool,
        module: bool,
        spelling: Option<String>,
    ) -> Result<Vec<Stmt>, String> {
        let source_type = init.ty();
        self.bind_sequence_pattern_value(pattern, (init, source_type), mutable, module, spelling)
    }

    /// Sequence binding checks the iterator and each extracted slot. Retain
    /// an existing source layout for slot storage without casting an erased
    /// element back into an aggregate before destructuring it.
    pub(super) fn bind_sequence_pattern_value(
        &mut self,
        pattern: Node,
        source: (Expr, Type),
        mutable: bool,
        module: bool,
        spelling: Option<String>,
    ) -> Result<Vec<Stmt>, String> {
        let (init, source_type) = source;
        self.validate_array_pattern(pattern)?;
        let elements = pattern.elements();
        let has_rest = elements.last().is_some_and(|element| {
            !bindings::omitted(element) && !element.dot_dot_dot_token().is_nil()
        });
        let rest_array_source = match &source_type {
            Type::Array { .. } | Type::Dyn => true,
            Type::Union { union_id } => {
                let arms = &self.unions[*union_id].arms;
                arms.iter().any(|arm| matches!(arm, Type::Array { .. }))
                    && arms
                        .iter()
                        .all(|arm| matches!(arm, Type::Array { .. } | Type::Null | Type::Undefined))
            }
            _ => false,
        };
        if has_rest && (module || !rest_array_source) {
            return Err(self.refuse(
                pattern,
                "array rest bindings require a local standard array source",
            ));
        }
        self.ensure_exception_classes(pattern)?;
        let direct_collection_source = match &source_type {
            Type::Map { .. } | Type::Set { .. } => true,
            Type::Union { union_id } => self.unions[*union_id]
                .arms
                .iter()
                .any(|arm| matches!(arm, Type::Map { .. } | Type::Set { .. })),
            _ => false,
        };
        if direct_collection_source {
            return Err(self.refuse(pattern, "array bindings currently require standard arrays, tuples, bytes or strings; Map/Set iterators are not ported"));
        }
        // Compiler-owned tuples (notably heterogeneous Promise.all results)
        // already have a fixed native layout. Read their slots directly
        // instead of erasing the tuple to Dyn and going through the iterator
        // ABI. This is required when a slot is a module namespace, whose
        // descriptor and live-binding contract deliberately forbid erasure.
        if let Type::Record { shape_id } = &source_type
            && self.records[*shape_id].tuple
            && !has_rest
        {
            let shape_id = *shape_id;
            let tuple = self.records[shape_id].clone();
            let source_type = Type::Record { shape_id };
            let init = if init.ty() == source_type {
                init
            } else {
                // A callback/rest/erased boundary can preserve the checked
                // tuple layout while publishing the live value as Dyn. Attach
                // the shared checked view before storing it in the typed
                // construction local; RecordGet below then reads the same
                // identity with a validator-sound ABI.
                self.coerce(init, source_type.clone(), pattern)?
            };
            let source = self.construction_local(source_type, false);
            let mut body = vec![Stmt::VarDecl {
                local_id: source.id.clone(),
                init,
                loc: self.loc(pattern),
            }];
            for (index, element) in elements.iter().enumerate() {
                if bindings::omitted(element) {
                    continue;
                }
                let key = index.to_string();
                let field = tuple
                    .fields
                    .iter()
                    .find(|field| field.name == key)
                    .ok_or_else(|| {
                        self.refuse(element, "tuple binding position is outside its layout")
                    })?;
                let value = Expr::RecordGet {
                    obj: Box::new(self.construction_read(&source, element)),
                    shape_id: format!("r{shape_id}"),
                    field: key,
                    r#type: field.r#type.clone(),
                    loc: self.loc(element),
                };
                body.extend(self.bind_sequence_element_value(
                    element,
                    value,
                    field.r#type.clone(),
                    mutable,
                    module,
                )?);
            }
            return Ok(body);
        }
        let value = self.coerce(init, Type::Dyn, pattern)?;
        let source = self.construction_local(Type::Dyn, false);
        let mut body = vec![Stmt::VarDecl {
            local_id: source.id.clone(),
            init: value,
            loc: self.loc(pattern),
        }];
        if let Some(spelling) = spelling {
            // V8 names an identifier RHS in this lexical error. The iterator
            // operation owns the context-free error used by callee patterns.
            let iterable = ["array", "string", "bytes", "map", "set"]
                .into_iter()
                .map(|test| Expr::DynTest {
                    value: Box::new(self.construction_read(&source, pattern)),
                    test: test.into(),
                    negated: false,
                    r#type: Type::Bool,
                    loc: self.loc(pattern),
                })
                .reduce(|left, right| Expr::Logical {
                    op: "||".into(),
                    left: Box::new(left),
                    right: Box::new(right),
                    r#type: Type::Bool,
                    loc: self.loc(pattern),
                })
                .unwrap();
            body.push(Stmt::If {
                cond: Expr::Unary {
                    op: "!".into(),
                    operand: Box::new(iterable),
                    r#type: Type::Bool,
                    loc: self.loc(pattern),
                },
                then: vec![Stmt::Throw {
                    value: Expr::LibCall {
                        r#fn: "error.new".into(),
                        args: vec![Expr::StrLit {
                            value: format!("{spelling} is not iterable"),
                            r#type: Type::String,
                            loc: self.loc(pattern),
                        }],
                        r#type: Type::Object {
                            class_name: "%TypeError".into(),
                        },
                        loc: self.loc(pattern),
                    },
                    loc: self.loc(pattern),
                }],
                else_: None,
                loc: self.loc(pattern),
            });
        }
        let items = self.construction_local(Type::Dyn, false);
        body.push(Stmt::VarDecl {
            local_id: items.id.clone(),
            init: Expr::DynIterN {
                value: Box::new(self.construction_read(&source, pattern)),
                count: elements.len() - usize::from(has_rest),
                r#type: Type::Dyn,
                loc: self.loc(pattern),
            },
            loc: self.loc(pattern),
        });
        for (index, element) in pattern.elements().iter().enumerate() {
            if bindings::omitted(element) {
                continue;
            }
            if !element.dot_dot_dot_token().is_nil() {
                let result_type = match &source_type {
                    Type::Array { elem } => Type::Array { elem: elem.clone() },
                    Type::Dyn => Type::Array {
                        elem: Box::new(Type::Dyn),
                    },
                    Type::Union { .. } => Type::Array {
                        elem: Box::new(Type::Dyn),
                    },
                    _ => unreachable!("validated array rest source"),
                };
                let value = self.sequence_array_rest(
                    self.construction_read(&source, element),
                    index,
                    element,
                    result_type,
                )?;
                body.push(self.publish_binding(element.name(), value, mutable, module, element)?);
                continue;
            }
            let value = self.dynamic_get(
                element,
                self.construction_read(&items, element),
                Expr::StrLit {
                    value: index.to_string(),
                    r#type: Type::String,
                    loc: self.loc(element),
                },
            );
            let symbol = self.symbol(element.name());
            let ty = if module {
                self.module_bindings
                    .get(&symbol)
                    .map(|local| local.r#type.clone())
            } else {
                None
            };
            let ty = match ty {
                Some(ty) => ty,
                None => self.sequence_slot_type(&source_type, index, element)?,
            };
            body.extend(self.bind_sequence_element_value(element, value, ty, mutable, module)?);
        }
        Ok(body)
    }

    /// An array iterator reads every index, including holes as undefined. A
    /// slice would incorrectly preserve holes, so build a fresh dense array.
    pub(super) fn sequence_array_rest(
        &mut self,
        source: Expr,
        start: usize,
        node: Node,
        result_type: Type,
    ) -> Result<Expr, String> {
        let Type::Array { elem } = &result_type else {
            unreachable!("array rest result type")
        };
        let storage_type = if matches!(
            elem.as_ref(),
            Type::F64 | Type::String | Type::Bool | Type::Bigint | Type::Symbol
        ) {
            // Iteration visits holes as undefined even when the checker calls
            // this a number[] or string[]. Keep a dense owning array of the
            // actual values, then attach the contextual element view below.
            Type::Array { elem: Box::new(Type::Dyn) }
        } else {
            result_type.clone()
        };
        let Type::Array { elem } = &storage_type else { unreachable!() };
        let element_type = (**elem).clone();
        let mut helper = helpers::Helper::new(
            "sequence_array_rest",
            vec![Type::Dyn, Type::F64],
            storage_type.clone(),
            self.loc(node),
        );
        let input = helper.param(0);
        let index = helper.local("iterator index", Type::F64, true);
        let output = helper.local("rest array", storage_type.clone(), false);
        helper.declare(&index, helper.read(&helper.param(1)));
        helper.declare(
            &output,
            Expr::ArrayLit {
                elems: vec![],
                r#type: storage_type.clone(),
                loc: helper.loc(),
            },
        );
        let length = self.dynamic_get(
            node,
            helper.read(&input),
            Expr::StrLit {
                value: "length".into(),
                r#type: Type::String,
                loc: helper.loc(),
            },
        );
        let length = self.coerce(length, Type::F64, node)?;
        let key = Expr::ToString {
            operand: Box::new(helper.read(&index)),
            r#type: Type::String,
            loc: helper.loc(),
        };
        let value = self.dynamic_get(node, helper.read(&input), key);
        let value = self.coerce(value, element_type, node)?;
        helper.function.body.push(Stmt::While {
            cond: helper.less(&index, length),
            body: vec![
                Stmt::Expression {
                    expr: Expr::ArrayIntrinsic {
                        method: "push".into(),
                        receiver: Box::new(helper.read(&output)),
                        args: vec![value],
                        r#type: Type::F64,
                        loc: helper.loc(),
                    },
                    loc: helper.loc(),
                },
                helper.advance(&index),
            ],
            loc: helper.loc(),
        });
        let callee = self.install_helper(helper.finish(&output));
        let value = Expr::Call {
            callee,
            args: vec![
                source,
                Expr::NumLit {
                    value: start as f64,
                    spelling: None,
                    r#type: Type::F64,
                    loc: self.loc(node),
                },
            ],
            r#type: storage_type.clone(),
            loc: self.loc(node),
        };
        if storage_type != result_type {
            self.array_checked_projection(node, value, result_type)
        } else {
            Ok(value)
        }
    }

    pub(super) fn sequence_slot_type(
        &mut self,
        source: &Type,
        index: usize,
        node: Node,
    ) -> Result<Type, String> {
        if let Type::Record { shape_id } = source
            && self.records[*shape_id].tuple
        {
            return self.records[*shape_id]
                .fields
                .iter()
                .find(|field| field.name == index.to_string())
                .map(|field| field.r#type.clone())
                .ok_or_else(|| self.refuse(node, "tuple binding position is outside its layout"));
        }
        let element = match source {
            Type::Array { elem } => (**elem).clone(),
            Type::String => Type::String,
            Type::Bytes { .. } => Type::F64,
            _ => Type::Dyn,
        };
        self.undefined_storage_type(element, node)
    }
}
