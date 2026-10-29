//! Native erasure for unknown payloads and polymorphic JavaScript boundaries.
use super::*;

impl Lowerer<'_> {
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
            ) || self.data_property_name(property.name()).is_none()
                || (property.name().text() == "__proto__"
                    && property.kind() == SyntaxKind::PropertyAssignment)
            {
                return Err(self.refuse(
                    property,
                    "native value objects require plain named data properties",
                ));
            }
            let name = self.data_property_name(property.name()).unwrap();
            if !names.insert(name) {
                return Err(self.refuse(
                    property,
                    "duplicate native value object properties are not ported",
                ));
            }
            let key = Expr::StrLit {
                value: self.data_property_name(property.name()).unwrap(),
                r#type: Type::String,
                loc: self.loc(property),
            };
            let value = self.object_property_value(property, Type::Dyn)?;
            fields.push(ir::DynamicField { key, value });
        }
        Ok(Expr::DynObjLit {
            fields,
            r#type: Type::Dyn,
            loc,
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
            let name = self.data_property_name(property.name()).ok_or_else(|| {
                self.refuse(property, "computed native object keys are not ported")
            })?;
            if name == "__proto__" && property.kind() == SyntaxKind::PropertyAssignment {
                return Err(self.refuse(property, "object prototype setters are not ported"));
            }
            let value = self.object_property_value(property, Type::Dyn)?;
            stmts.push(Stmt::Expression {
                expr: Expr::LibCall {
                    r#fn: "record.setOwn".into(),
                    args: vec![
                        self.construction_read(&target, property),
                        Expr::StrLit {
                            value: name,
                            r#type: Type::String,
                            loc: self.loc(property),
                        },
                        value,
                    ],
                    r#type: Type::Void,
                    loc: self.loc(property),
                },
                loc: self.loc(property),
            });
        }
        Ok(Expr::Sequence {
            stmts,
            result: Box::new(self.construction_read(&target, node)),
            r#type: Type::Dyn,
            loc: self.loc(node),
        })
    }
}
