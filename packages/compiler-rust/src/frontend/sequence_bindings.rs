//! Flat sequence patterns share owning iterator snapshots across source contexts.
use super::*;

impl Lowerer<'_> {
    pub(super) fn validate_array_pattern(&self, pattern: Node) -> Result<(), String> {
        for element in pattern.elements() {
            if bindings::omitted(element) {
                continue;
            }
            if element.kind() != SyntaxKind::BindingElement
                || element.name().kind() != SyntaxKind::Identifier
                || !element.initializer().is_nil()
                || !element.dot_dot_dot_token().is_nil()
                || !element.property_name().is_nil()
            {
                return Err(self.refuse(
                    element,
                    "nested, default and rest array bindings are not ported",
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
        self.validate_array_pattern(pattern)?;
        self.ensure_exception_classes(pattern)?;
        if self.native_type_contains(&init.ty(), |ty| {
            matches!(ty, Type::Map { .. } | Type::Set { .. })
        }) {
            return Err(self.refuse(pattern, "array bindings currently require standard arrays, tuples, bytes or strings; Map/Set iterators are not ported"));
        }
        let source_type = init.ty();
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
                count: pattern.elements().len(),
                r#type: Type::Dyn,
                loc: self.loc(pattern),
            },
            loc: self.loc(pattern),
        });
        for (index, element) in pattern.elements().iter().enumerate() {
            if bindings::omitted(element) {
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
