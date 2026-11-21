//! Native erasure for unknown payloads and polymorphic JavaScript boundaries.
use super::*;

impl Lowerer<'_> {
    pub(super) fn accessor_literal_source(&mut self, node: Node, seen: &mut HashSet<u32>) -> bool {
        let node = receivers::reference_node(node);
        if node.kind() == SyntaxKind::ObjectLiteralExpression {
            return node.properties().into_iter().any(|property| {
                matches!(
                    property.kind(),
                    SyntaxKind::GetAccessor | SyntaxKind::SetAccessor
                )
            });
        }
        if node.kind() != SyntaxKind::Identifier {
            return false;
        }
        let symbol = self.symbol(node);
        if symbol == 0 || !seen.insert(symbol) {
            return false;
        }
        let declaration = self
            .checker
            .sym(source_frontend::prelude::SymbolId(symbol))
            .value_declaration;
        !declaration.is_nil()
            && declaration.kind() == SyntaxKind::VariableDeclaration
            && !declaration.initializer().is_nil()
            && self.accessor_literal_source(declaration.initializer(), seen)
    }
    pub(super) fn dynamic_assign_fresh(
        &mut self,
        node: Node,
        target: Node,
        source: Node,
    ) -> Result<Expr, String> {
        let target_value = self.dynamic_literal(target)?;
        let source_value = self.expected_expression(source, Type::Dyn)?;
        self.dynamic_assign_values(node, target_value, source_value)
    }
    pub(super) fn dynamic_assign_values(
        &mut self,
        node: Node,
        target_value: Expr,
        source_value: Expr,
    ) -> Result<Expr, String> {
        let target_type = target_value.ty();
        let mut stmts = Vec::new();
        let target = self.update_temp(target_value, &mut stmts, node);
        let source = self.update_temp(source_value, &mut stmts, node);
        let object = if target_type == Type::Dyn {
            target.clone()
        } else if matches!(target_type, Type::Record { .. }) {
            Expr::LibCall {
                r#fn: "record.mutableDynView".into(),
                args: vec![target.clone()],
                r#type: Type::Dyn,
                loc: self.loc(node),
            }
        } else {
            Expr::DynFrom {
                value: Box::new(target.clone()),
                r#type: Type::Dyn,
                loc: self.loc(node),
            }
        };
        stmts.push(Stmt::Expression {
            expr: Expr::LibCall {
                r#fn: "dyn.objectAssignCopy".into(),
                args: vec![object, source],
                r#type: Type::Void,
                loc: self.loc(node),
            },
            loc: self.loc(node),
        });
        Ok(Expr::Sequence {
            stmts,
            result: Box::new(target),
            r#type: target_type,
            loc: self.loc(node),
        })
    }
    pub(super) fn dynamic_literal(&mut self, node: Node) -> Result<Expr, String> {
        let loc = self.loc(node);
        if node.kind() == SyntaxKind::ArrayLiteralExpression {
            if node
                .elements()
                .into_iter()
                .any(|element| element.kind() == SyntaxKind::SpreadElement)
            {
                let array = self.array_spread_literal(
                    node,
                    Type::Array {
                        elem: Box::new(Type::Dyn),
                    },
                )?;
                return self.coerce(array, Type::Dyn, node);
            }
            let elems = node
                .elements()
                .into_iter()
                .map(|n| self.expected_expression(n, Type::Dyn))
                .collect::<Result<Vec<_>, _>>()?;
            return Ok(Expr::DynArrLit {
                elems,
                r#type: Type::Dyn,
                loc,
            });
        }
        if node.properties().into_iter().any(|property| {
            property.kind() == SyntaxKind::PropertyAssignment
                && self.data_property_name(property.name()).as_deref() == Some("__proto__")
        }) {
            return self.dynamic_null_prototype_literal(node);
        }
        if node.properties().into_iter().any(|property| {
            matches!(
                property.kind(),
                SyntaxKind::GetAccessor | SyntaxKind::SetAccessor
            )
        }) {
            return self.dynamic_accessor_literal(node);
        }
        if node
            .properties()
            .into_iter()
            .any(|property| property.kind() == SyntaxKind::SpreadAssignment)
        {
            return self.dynamic_spread_literal(node);
        }
        let mut fields = Vec::new();
        let mut names = HashSet::new();
        for property in node.properties() {
            if !matches!(
                property.kind(),
                SyntaxKind::PropertyAssignment
                    | SyntaxKind::ShorthandPropertyAssignment
                    | SyntaxKind::MethodDeclaration
            ) || (property.name().kind() != SyntaxKind::ComputedPropertyName
                && self.data_property_name(property.name()).is_none())
                || (property.name().kind() != SyntaxKind::ComputedPropertyName
                    && property.name().text() == "__proto__"
                    && property.kind() == SyntaxKind::PropertyAssignment)
            {
                return Err(self.refuse(
                    property,
                    "native value objects require data properties with represented keys",
                ));
            }
            let property_name = property.name().text().to_string();
            let key = if property.name().kind() == SyntaxKind::ComputedPropertyName {
                self.dynamic_property_key_expression(property.name().expression())?
            } else {
                let name = self.data_property_name(property.name()).unwrap();
                if !names.insert(name.clone()) {
                    return Err(self.refuse(
                        property,
                        "duplicate native value object properties are not ported",
                    ));
                }
                Expr::StrLit {
                    value: name,
                    r#type: Type::String,
                    loc: self.loc(property),
                }
            };
            let value = self
                .object_property_value(property, Type::Dyn)
                .map_err(|error| {
                    format!("{error}; while erasing dynamic property {property_name:?}")
                })?;
            fields.push(ir::DynamicField { key, value });
        }
        Ok(Expr::DynObjLit {
            fields,
            r#type: Type::Dyn,
            loc,
        })
    }

    fn dynamic_null_prototype_literal(&mut self, node: Node) -> Result<Expr, String> {
        let target = self.construction_local(Type::Dyn, false);
        let mut stmts = vec![Stmt::VarDecl {
            local_id: target.id.clone(),
            init: Expr::Intrinsic {
                name: "object.createNull".into(),
                args: vec![],
                r#type: Type::Dyn,
                loc: self.loc(node),
            },
            loc: self.loc(node),
        }];
        let mut names = HashSet::new();
        let mut saw_prototype = false;
        for property in node.properties() {
            if property.kind() == SyntaxKind::PropertyAssignment
                && self.data_property_name(property.name()).as_deref() == Some("__proto__")
            {
                if saw_prototype || property.initializer().kind() != SyntaxKind::NullKeyword {
                    return Err(self.refuse(
                        property,
                        "dynamic object prototype setters require one literal null value",
                    ));
                }
                saw_prototype = true;
                continue;
            }
            if !matches!(
                property.kind(),
                SyntaxKind::PropertyAssignment
                    | SyntaxKind::ShorthandPropertyAssignment
                    | SyntaxKind::MethodDeclaration
            ) {
                return Err(self.refuse(
                    property,
                    "null-prototype dynamic objects require ordinary data properties",
                ));
            }
            let key = if property.name().kind() == SyntaxKind::ComputedPropertyName {
                self.dynamic_property_key_expression(property.name().expression())?
            } else {
                let name = self.data_property_name(property.name()).ok_or_else(|| {
                    self.refuse(
                        property,
                        "native object keys must be represented property keys",
                    )
                })?;
                if !names.insert(name.clone()) {
                    return Err(self.refuse(
                        property,
                        "duplicate native value object properties are not ported",
                    ));
                }
                Expr::StrLit {
                    value: name,
                    r#type: Type::String,
                    loc: self.loc(property),
                }
            };
            let value = self.object_property_value(property, Type::Dyn)?;
            stmts.push(self.checked_dynamic_property_set(
                property,
                self.construction_read(&target, property),
                key,
                value,
            )?);
        }
        Ok(Expr::Sequence {
            stmts,
            result: Box::new(self.construction_read(&target, node)),
            r#type: Type::Dyn,
            loc: self.loc(node),
        })
    }

    pub(super) fn dynamic_accessor_literal(&mut self, node: Node) -> Result<Expr, String> {
        let object = self.construction_local(Type::Dyn, false);
        let mut statements = vec![Stmt::VarDecl {
            local_id: object.id.clone(),
            init: Expr::DynObjLit {
                fields: vec![],
                r#type: Type::Dyn,
                loc: self.loc(node),
            },
            loc: self.loc(node),
        }];
        let mut names = HashMap::<String, u8>::new();
        for property in node.properties() {
            if property.kind() == SyntaxKind::SpreadAssignment {
                self.append_dynamic_spread(&mut statements, &object, property)?;
                continue;
            }
            if !matches!(
                property.kind(),
                SyntaxKind::GetAccessor
                    | SyntaxKind::SetAccessor
                    | SyntaxKind::PropertyAssignment
                    | SyntaxKind::ShorthandPropertyAssignment
                    | SyntaxKind::MethodDeclaration
            ) {
                return Err(self.refuse(property, "accessor literals with spreads are not ported"));
            }
            let name = self.data_property_name(property.name()).ok_or_else(|| {
                self.refuse(
                    property,
                    "accessor literals require named string properties",
                )
            })?;
            let kind = match property.kind() {
                SyntaxKind::GetAccessor => 1,
                SyntaxKind::SetAccessor => 2,
                _ => 4,
            };
            let seen = names.entry(name.clone()).or_default();
            if *seen & kind != 0 || (*seen != 0 && (kind == 4 || *seen & 4 != 0)) {
                return Err(self.refuse(
                    property,
                    "duplicate accessor literal properties are not ported",
                ));
            }
            *seen |= kind;
            let key = Expr::StrLit {
                value: name.clone(),
                r#type: Type::String,
                loc: self.loc(property),
            };
            let receiver = self.construction_read(&object, property);
            let operation = match property.kind() {
                SyntaxKind::GetAccessor => {
                    let signature = Type::Func {
                        rest: false,
                        params: vec![],
                        ret: Box::new(Type::Dyn),
                    };
                    let getter = self.closure(property, Some(signature))?;
                    Expr::LibCall {
                        r#fn: "dyn.defineOrdinaryGetter".into(),
                        args: vec![
                            receiver,
                            self.coerce(key, Type::Dyn, property)?,
                            self.coerce(getter, Type::Dyn, property)?,
                            self.coerce(
                                Expr::BoolLit {
                                    value: true,
                                    r#type: Type::Bool,
                                    loc: self.loc(property),
                                },
                                Type::Dyn,
                                property,
                            )?,
                            self.coerce(
                                Expr::BoolLit {
                                    value: true,
                                    r#type: Type::Bool,
                                    loc: self.loc(property),
                                },
                                Type::Dyn,
                                property,
                            )?,
                        ],
                        r#type: Type::Dyn,
                        loc: self.loc(property),
                    }
                }
                SyntaxKind::SetAccessor => {
                    let signature = Type::Func {
                        rest: false,
                        params: vec![Type::Dyn],
                        ret: Box::new(Type::Void),
                    };
                    let setter = self.closure(property, Some(signature))?;
                    Expr::LibCall {
                        r#fn: "dyn.defineOrdinarySetter".into(),
                        args: vec![
                            receiver,
                            self.coerce(key, Type::Dyn, property)?,
                            self.coerce(setter, Type::Dyn, property)?,
                            self.coerce(
                                Expr::BoolLit {
                                    value: true,
                                    r#type: Type::Bool,
                                    loc: self.loc(property),
                                },
                                Type::Dyn,
                                property,
                            )?,
                            self.coerce(
                                Expr::BoolLit {
                                    value: true,
                                    r#type: Type::Bool,
                                    loc: self.loc(property),
                                },
                                Type::Dyn,
                                property,
                            )?,
                        ],
                        r#type: Type::Dyn,
                        loc: self.loc(property),
                    }
                }
                SyntaxKind::PropertyAssignment
                | SyntaxKind::ShorthandPropertyAssignment
                | SyntaxKind::MethodDeclaration
                    if name != "__proto__" =>
                {
                    let value = self.object_property_value(property, Type::Dyn)?;
                    Expr::LibCall {
                        r#fn: "record.setOwn".into(),
                        args: vec![receiver, key, value],
                        r#type: Type::Void,
                        loc: self.loc(property),
                    }
                }
                _ => {
                    return Err(self.refuse(
                        property,
                        "accessor literals with spreads or prototype setters are not ported",
                    ));
                }
            };
            statements.push(Stmt::Expression {
                expr: operation,
                loc: self.loc(property),
            });
        }
        Ok(Expr::Sequence {
            stmts: statements,
            result: Box::new(self.construction_read(&object, node)),
            r#type: Type::Dyn,
            loc: self.loc(node),
        })
    }
    pub(super) fn dynamic_get(&self, node: Node, value: Expr, key: Expr) -> Expr {
        Expr::DynKeyGet {
            value: Box::new(value),
            key: Box::new(key),
            r#type: Type::Dyn,
            loc: self.loc(node),
        }
    }

    fn append_dynamic_spread(
        &mut self,
        stmts: &mut Vec<Stmt>,
        target: &Local,
        property: Node,
    ) -> Result<(), String> {
        let source_node = property.expression();
        let source_value = self.expression(source_node)?;
        let source_value = self.coerce(source_value, Type::Dyn, source_node)?;
        let source = self.construction_local(Type::Dyn, false);
        let keys = self.construction_local(Type::Dyn, false);
        let index = self.construction_local(Type::F64, true);
        let key = self.construction_local(Type::String, false);
        stmts.push(Stmt::VarDecl {
            local_id: source.id.clone(),
            init: source_value,
            loc: self.loc(property),
        });
        let source_read = || self.construction_read(&source, property);
        let keys_read = || self.construction_read(&keys, property);
        let index_read = || self.construction_read(&index, property);
        let key_read = || self.construction_read(&key, property);
        let key_value = self.dynamic_get(
            property,
            keys_read(),
            Expr::ToString {
                operand: Box::new(index_read()),
                r#type: Type::String,
                loc: self.loc(property),
            },
        );
        let length = self.dynamic_get(
            property,
            keys_read(),
            Expr::StrLit {
                value: "length".into(),
                r#type: Type::String,
                loc: self.loc(property),
            },
        );
        let copy = Expr::LibCall {
            r#fn: "record.setOwn".into(),
            args: vec![
                self.construction_read(&target, property),
                key_read(),
                self.dynamic_get(property, source_read(), key_read()),
            ],
            r#type: Type::Void,
            loc: self.loc(property),
        };
        let loop_body = vec![
            Stmt::VarDecl {
                local_id: key.id.clone(),
                init: self.coerce(key_value, Type::String, property)?,
                loc: self.loc(property),
            },
            Stmt::Expression {
                expr: copy,
                loc: self.loc(property),
            },
            Stmt::Assign {
                local_id: index.id.clone(),
                value: Expr::Bin {
                    op: "+".into(),
                    left: Box::new(index_read()),
                    right: Box::new(Expr::NumLit {
                        value: 1.0,
                        spelling: None,
                        r#type: Type::F64,
                        loc: self.loc(property),
                    }),
                    r#type: Type::F64,
                    loc: self.loc(property),
                },
                initializes_global: false,
                loc: self.loc(property),
            },
        ];
        let copy_body = vec![
            Stmt::VarDecl {
                local_id: keys.id.clone(),
                init: Expr::LibCall {
                    r#fn: "dyn.objKeys".into(),
                    args: vec![source_read()],
                    r#type: Type::Dyn,
                    loc: self.loc(property),
                },
                loc: self.loc(property),
            },
            Stmt::VarDecl {
                local_id: index.id.clone(),
                init: Expr::NumLit {
                    value: 0.0,
                    spelling: None,
                    r#type: Type::F64,
                    loc: self.loc(property),
                },
                loc: self.loc(property),
            },
            Stmt::While {
                cond: Expr::Bin {
                    op: "<".into(),
                    left: Box::new(index_read()),
                    right: Box::new(self.coerce(length, Type::F64, property)?),
                    r#type: Type::Bool,
                    loc: self.loc(property),
                },
                body: loop_body,
                loc: self.loc(property),
            },
            Stmt::Expression {
                expr: Expr::LibCall {
                    r#fn: "dyn.copyEnumerableSymbols".into(),
                    args: vec![self.construction_read(&target, property), source_read()],
                    r#type: Type::Void,
                    loc: self.loc(property),
                },
                loc: self.loc(property),
            },
        ];
        stmts.push(Stmt::If {
            cond: Expr::DynTest {
                value: Box::new(source_read()),
                test: "nullish".into(),
                negated: true,
                r#type: Type::Bool,
                loc: self.loc(property),
            },
            then: copy_body,
            else_: None,
            loc: self.loc(property),
        });
        Ok(())
    }

    fn dynamic_spread_literal(&mut self, node: Node) -> Result<Expr, String> {
        let target = self.construction_local(Type::Dyn, false);
        let mut stmts = vec![Stmt::VarDecl {
            local_id: target.id.clone(),
            init: Expr::DynObjLit {
                fields: vec![],
                r#type: Type::Dyn,
                loc: self.loc(node),
            },
            loc: self.loc(node),
        }];
        for property in node.properties() {
            if property.kind() == SyntaxKind::SpreadAssignment {
                self.append_dynamic_spread(&mut stmts, &target, property)?;
                continue;
            }
            if !matches!(
                property.kind(),
                SyntaxKind::PropertyAssignment
                    | SyntaxKind::ShorthandPropertyAssignment
                    | SyntaxKind::MethodDeclaration
            ) {
                return Err(self.refuse(
                    property,
                    "native value objects require plain named data properties",
                ));
            }
            let key = if property.name().kind() == SyntaxKind::ComputedPropertyName {
                self.dynamic_property_key_expression(property.name().expression())?
            } else {
                let name = self.data_property_name(property.name()).ok_or_else(|| {
                    self.refuse(
                        property,
                        "native object keys must be represented property keys",
                    )
                })?;
                if name == "__proto__" && property.kind() == SyntaxKind::PropertyAssignment {
                    return Err(self.refuse(property, "object prototype setters are not ported"));
                }
                Expr::StrLit {
                    value: name,
                    r#type: Type::String,
                    loc: self.loc(property),
                }
            };
            let value = self.object_property_value(property, Type::Dyn)?;
            stmts.push(self.checked_dynamic_property_set(
                property,
                self.construction_read(&target, property),
                key,
                value,
            )?);
        }
        Ok(Expr::Sequence {
            stmts,
            result: Box::new(self.construction_read(&target, node)),
            r#type: Type::Dyn,
            loc: self.loc(node),
        })
    }
}
