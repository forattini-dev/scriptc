//! Flat sequence patterns share owning iterator snapshots across source contexts.
use super::*;

impl Lowerer<'_> {
    pub(super) fn validate_array_pattern(&self, pattern: Node) -> Result<(), String> {
        let elements = pattern.elements();
        for (index, element) in elements.iter().enumerate() {
            if bindings::omitted(element) {
                continue;
            }
            if element.kind() != SyntaxKind::BindingElement
                || element.name().kind() != SyntaxKind::Identifier
                || !element.initializer().is_nil()
                || !element.property_name().is_nil()
                || (!element.dot_dot_dot_token().is_nil() && index + 1 != elements.len())
            {
                return Err(self.refuse(
                    element,
                    "nested, default and non-terminal rest array bindings are not ported",
                ));
            }
        }
        Ok(())
    }

    pub(super) fn validate_array_parameter(&self, node: Node) -> Result<(), String> {
        if !node.initializer().is_nil() || !node.dot_dot_dot_token().is_nil() {
            return Err(self.refuse(
                node,
                "array parameter defaults and rest slots are not ported",
            ));
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
        let init = if node.initializer().kind() == SyntaxKind::ArrayLiteralExpression
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
        self.bind_sequence_pattern(node.name(), init, mutable, module, spelling)
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
        if has_rest && (module || !matches!(source_type, Type::Array { .. })) {
            return Err(self.refuse(
                pattern,
                "array rest bindings require a local standard array source",
            ));
        }
        self.ensure_exception_classes(pattern)?;
        if self.native_type_contains(&source_type, |ty| {
            matches!(ty, Type::Map { .. } | Type::Set { .. })
        }) {
            return Err(self.refuse(pattern, "array bindings currently require standard arrays, tuples, bytes or strings; Map/Set iterators are not ported"));
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
                let value = self.sequence_array_rest(
                    self.construction_read(&source, element),
                    index,
                    element,
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
            let value = self.coerce(value, ty, element)?;
            body.push(self.publish_binding(element.name(), value, mutable, module, element)?);
        }
        Ok(body)
    }

    /// An array iterator reads every index, including holes as undefined. A
    /// slice would incorrectly preserve holes, so build a fresh dense array.
    fn sequence_array_rest(
        &mut self,
        source: Expr,
        start: usize,
        node: Node,
    ) -> Result<Expr, String> {
        let result_type = Type::Array {
            elem: Box::new(Type::Dyn),
        };
        let mut helper = helpers::Helper::new(
            "sequence_array_rest",
            vec![Type::Dyn, Type::F64],
            result_type.clone(),
            self.loc(node),
        );
        let input = helper.param(0);
        let index = helper.local("iterator index", Type::F64, true);
        let output = helper.local("rest array", result_type.clone(), false);
        helper.declare(&index, helper.read(&helper.param(1)));
        helper.declare(
            &output,
            Expr::ArrayLit {
                elems: vec![],
                r#type: result_type.clone(),
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
        Ok(Expr::Call {
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
            r#type: result_type,
            loc: self.loc(node),
        })
    }

    pub(super) fn sequence_slot_type(
        &mut self,
        source: &Type,
        index: usize,
        node: Node,
    ) -> Result<Type, String> {
        let element = match source {
            Type::Array { elem } => (**elem).clone(),
            Type::String => Type::String,
            Type::Bytes { .. } => Type::F64,
            Type::Record { shape_id } if self.records[*shape_id].tuple => self.records[*shape_id]
                .fields
                .iter()
                .find(|field| field.name == index.to_string())
                .map(|field| field.r#type.clone())
                .unwrap_or(Type::Dyn),
            _ => Type::Dyn,
        };
        self.undefined_storage_type(element, node)
    }
}
