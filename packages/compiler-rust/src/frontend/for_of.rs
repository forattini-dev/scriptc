//! Standard owning sequences lower to portable loops with fresh lexical cells.
use super::*;
use helpers::Helper;

fn read(local: &Local, loc: &Loc) -> Expr {
    Expr::VarRef {
        local_id: local.id.clone(),
        r#type: local.r#type.clone(),
        loc: loc.clone(),
    }
}
fn number(value: f64, loc: &Loc) -> Expr {
    Expr::NumLit {
        value,
        spelling: None,
        r#type: Type::F64,
        loc: loc.clone(),
    }
}
fn binary(op: &str, left: Expr, right: Expr, loc: &Loc) -> Expr {
    Expr::Bin {
        op: op.into(),
        left: Box::new(left),
        right: Box::new(right),
        r#type: if op == "+" { Type::F64 } else { Type::Bool },
        loc: loc.clone(),
    }
}

impl Lowerer<'_> {
    fn iteration_local(&mut self, name: &str, ty: Type, mutable: bool) -> Local {
        let local = Local {
            id: format!("v{}", self.locals.len()),
            name: name.into(),
            r#type: ty,
            mutable,
            boxed: false,
        };
        self.locals.push(local.clone());
        local
    }

    pub(super) fn for_of_statement(&mut self, node: Node) -> Result<Vec<Stmt>, String> {
        if !node.await_modifier().is_nil() {
            return Err(self.refuse(node, "for-await iteration is not ported"));
        }
        let head = node.initializer();
        if head.kind() != SyntaxKind::VariableDeclarationList
            || !head.flags().intersects(NodeFlags::LET | NodeFlags::CONST)
        {
            return Err(self.refuse(head, "for-of requires a lexical let/const binding; var and assignment heads are not ported"));
        }
        let declarations = head.declarations().nodes().into_iter().collect::<Vec<_>>();
        if declarations.len() != 1
            || !matches!(
                declarations[0].name().kind(),
                SyntaxKind::Identifier | SyntaxKind::ArrayBindingPattern
            )
            || !declarations[0].initializer().is_nil()
            || !declarations[0].type_().is_nil()
        {
            return Err(self.refuse(
                head,
                "for-of requires one identifier or flat array binding; object heads are not ported",
            ));
        }
        let declaration = declarations[0];
        if declaration.name().kind() == SyntaxKind::ArrayBindingPattern {
            self.validate_array_pattern(declaration.name())?;
        }
        let loc = self.loc(node);
        let value = self.primitive_operand(node.expression())?;
        if matches!(value.ty(), Type::Dyn | Type::Union { .. }) {
            return self.erased_for_of(node, declaration, head, value);
        }
        let (element, length) = match value.ty() {
            Type::Array { elem } => (*elem, None),
            Type::Bytes { .. } => (Type::F64, None),
            Type::String => (Type::String, None),
            Type::Record { shape_id } if self.records[shape_id].tuple => {
                let fields = self.records[shape_id].fields.clone();
                if fields.is_empty() {
                    return Err(self.refuse(node, "empty-tuple for-of needs an unreachable binding contract"));
                }
                let types = fields.iter().map(|field| field.r#type.clone()).collect::<Vec<_>>();
                let element = self.intern_union(types).ok_or_else(|| self.refuse(node, "tuple iteration elements have no shared native value contract"))?;
                (element, Some(fields.len()))
            }
            _ => return Err(self.refuse(node.expression(), "for-of requires a standard array, tuple, typed array or string; custom iterators are not ported")),
        };
        let source = self.iteration_local("iteration source", value.ty(), false);
        let index = self.iteration_local("iteration index", Type::F64, true);
        let mut outer = vec![
            Stmt::VarDecl {
                local_id: source.id.clone(),
                init: value,
                loc: loc.clone(),
            },
            Stmt::VarDecl {
                local_id: index.id.clone(),
                init: number(0.0, &loc),
                loc: loc.clone(),
            },
        ];
        let saved_bindings = self.bindings.clone();
        let saved_var_types = self.var_types.clone();
        self.var_defined.clear();
        let mut step = number(1.0, &loc);
        let item = match source.r#type {
            Type::String => {
                step = self.string_iteration_width(read(&source, &loc), read(&index, &loc), node);
                Expr::StringIntrinsic {
                    method: "slice".into(),
                    receiver: Box::new(read(&source, &loc)),
                    args: vec![
                        read(&index, &loc),
                        binary("+", read(&index, &loc), step.clone(), &loc),
                    ],
                    r#type: Type::String,
                    loc: loc.clone(),
                }
            }
            Type::Record { shape_id } => {
                let fields = self.records[shape_id].fields.clone();
                let mut item = None;
                for field in fields {
                    let slot = Expr::RecordGet {
                        obj: Box::new(read(&source, &loc)),
                        shape_id: format!("r{shape_id}"),
                        field: field.name.clone(),
                        r#type: field.r#type,
                        loc: loc.clone(),
                    };
                    let slot = self.coerce(slot, element.clone(), node)?;
                    item = Some(match item {
                        None => slot,
                        Some(other) => Expr::Ternary {
                            cond: Box::new(binary(
                                "===",
                                read(&index, &loc),
                                number(field.name.parse().unwrap(), &loc),
                                &loc,
                            )),
                            then: Box::new(slot),
                            else_: Box::new(other),
                            r#type: element.clone(),
                            loc: loc.clone(),
                        },
                    });
                }
                item.expect("non-empty tuple")
            }
            Type::Bytes { .. } => self.bytes_operation(
                node,
                read(&source, &loc),
                "get",
                vec![read(&index, &loc)],
                Type::F64,
            ),
            _ => {
                let object = self.coerce(read(&source, &loc), Type::Dyn, node)?;
                let key = Expr::ToString {
                    operand: Box::new(read(&index, &loc)),
                    r#type: Type::String,
                    loc: loc.clone(),
                };
                let item = self.dynamic_get(node, object, key);
                self.coerce(item, element.clone(), node)?
            }
        };
        let mut body = if declaration.name().kind() == SyntaxKind::ArrayBindingPattern {
            self.bind_sequence_pattern(
                declaration.name(),
                item,
                !head.flags().intersects(NodeFlags::CONST),
                false,
                None,
            )?
        } else {
            let binding = self.iteration_local(
                declaration.name().text(),
                element.clone(),
                !head.flags().intersects(NodeFlags::CONST),
            );
            let symbol = self.symbol(declaration.name());
            self.bindings.insert(symbol, binding.clone());
            if self.optional_storage(&element) {
                self.var_types.insert(symbol, element);
            }
            vec![Stmt::VarDecl {
                local_id: binding.id,
                init: item,
                loc: loc.clone(),
            }]
        };
        // Fresh head cells execute inside each iteration, before advancing.
        body.push(Stmt::Assign {
            local_id: index.id.clone(),
            value: binary("+", read(&index, &loc), step, &loc),
            initializes_global: false,
            loc: loc.clone(),
        });
        body.extend(self.statement(node.statement())?);
        let length = match length {
            Some(length) => number(length as f64, &loc),
            None if source.r#type == Type::String => Expr::StringIntrinsic {
                method: "length".into(),
                receiver: Box::new(read(&source, &loc)),
                args: vec![],
                r#type: Type::F64,
                loc: loc.clone(),
            },
            None if matches!(source.r#type, Type::Bytes { .. }) => Expr::BytesIntrinsic {
                method: "length".into(),
                receiver: Box::new(read(&source, &loc)),
                args: vec![],
                r#type: Type::F64,
                loc: loc.clone(),
            },
            None => Expr::ArrayIntrinsic {
                method: "length".into(),
                receiver: Box::new(read(&source, &loc)),
                args: vec![],
                r#type: Type::F64,
                loc: loc.clone(),
            },
        };
        outer.push(Stmt::While {
            cond: binary("<", read(&index, &loc), length, &loc),
            body,
            loc: loc.clone(),
        });
        self.bindings = saved_bindings;
        self.var_types = saved_var_types;
        self.var_defined.clear();
        Ok(vec![Stmt::Block { body: outer, loc }])
    }

    /// Keep the owning source and live cursor in the enclosing loop. Standard
    /// sequences have no user close hook; the body retains its own completions.
    fn erased_for_of(
        &mut self,
        node: Node,
        declaration: Node,
        head: Node,
        value: Expr,
    ) -> Result<Vec<Stmt>, String> {
        if self.native_type_contains(&value.ty(), |ty| {
            matches!(ty, Type::Map { .. } | Type::Set { .. })
        }) {
            return Err(self.refuse(node.expression(), "Map/Set for-of iterators are not ported"));
        }
        let loc = self.loc(node);
        let value = self.coerce(value, Type::Dyn, node)?;
        let source = self.iteration_local("iteration source", Type::Dyn, false);
        let index = self.iteration_local("iteration index", Type::F64, true);
        let mut outer = vec![
            Stmt::VarDecl {
                local_id: source.id.clone(),
                init: value,
                loc: loc.clone(),
            },
            // Validate the source even when it is empty. No prefix of the input
            // is materialized: subsequent reads observe live array mutations.
            Stmt::Expression {
                expr: Expr::DynIterN {
                    value: Box::new(read(&source, &loc)),
                    count: 0,
                    r#type: Type::Dyn,
                    loc: loc.clone(),
                },
                loc: loc.clone(),
            },
            Stmt::VarDecl {
                local_id: index.id.clone(),
                init: number(0.0, &loc),
                loc: loc.clone(),
            },
        ];
        let is_string = Expr::DynTest {
            value: Box::new(read(&source, &loc)),
            test: "string".into(),
            negated: false,
            r#type: Type::Bool,
            loc: loc.clone(),
        };
        let string = Expr::DynCheck {
            value: Box::new(read(&source, &loc)),
            r#type: Type::String,
            loc: loc.clone(),
        };
        let width = self.string_iteration_width(string.clone(), read(&index, &loc), node);
        let step = Expr::Ternary {
            cond: Box::new(is_string.clone()),
            then: Box::new(width.clone()),
            else_: Box::new(number(1.0, &loc)),
            r#type: Type::F64,
            loc: loc.clone(),
        };
        let text = Expr::StringIntrinsic {
            method: "slice".into(),
            receiver: Box::new(string),
            args: vec![
                read(&index, &loc),
                binary("+", read(&index, &loc), width, &loc),
            ],
            r#type: Type::String,
            loc: loc.clone(),
        };
        let key = Expr::ToString {
            operand: Box::new(read(&index, &loc)),
            r#type: Type::String,
            loc: loc.clone(),
        };
        let item = Expr::Ternary {
            cond: Box::new(is_string),
            then: Box::new(self.coerce(text, Type::Dyn, node)?),
            else_: Box::new(self.dynamic_get(node, read(&source, &loc), key)),
            r#type: Type::Dyn,
            loc: loc.clone(),
        };
        let saved_bindings = self.bindings.clone();
        let saved_var_types = self.var_types.clone();
        self.var_defined.clear();
        let mut body = if declaration.name().kind() == SyntaxKind::ArrayBindingPattern {
            self.bind_sequence_pattern(
                declaration.name(),
                item,
                !head.flags().intersects(NodeFlags::CONST),
                false,
                None,
            )?
        } else {
            let binding = self.iteration_local(
                declaration.name().text(),
                Type::Dyn,
                !head.flags().intersects(NodeFlags::CONST),
            );
            let symbol = self.symbol(declaration.name());
            self.bindings.insert(symbol, binding.clone());
            self.var_types.insert(symbol, Type::Dyn);
            vec![Stmt::VarDecl {
                local_id: binding.id,
                init: item,
                loc: loc.clone(),
            }]
        };
        body.push(Stmt::Assign {
            local_id: index.id.clone(),
            value: binary("+", read(&index, &loc), step, &loc),
            initializes_global: false,
            loc: loc.clone(),
        });
        body.extend(self.statement(node.statement())?);
        let length = self.dynamic_get(
            node,
            read(&source, &loc),
            Expr::StrLit {
                value: "length".into(),
                r#type: Type::String,
                loc: loc.clone(),
            },
        );
        let length = self.coerce(length, Type::F64, node)?;
        outer.push(Stmt::While {
            cond: binary("<", read(&index, &loc), length, &loc),
            body,
            loc: loc.clone(),
        });
        self.bindings = saved_bindings;
        self.var_types = saved_var_types;
        self.var_defined.clear();
        Ok(vec![Stmt::Block { body: outer, loc }])
    }

    fn string_iteration_width(&mut self, value: Expr, index: Expr, node: Node) -> Expr {
        let mut helper = Helper::new(
            "string_iteration_width",
            vec![Type::String, Type::F64],
            Type::F64,
            self.loc(node),
        );
        let loc = helper.loc();
        let code = |index| Expr::StringIntrinsic {
            method: "charCodeAt".into(),
            receiver: Box::new(helper.read(&helper.param(0))),
            args: vec![index],
            r#type: Type::F64,
            loc: loc.clone(),
        };
        let first = code(helper.read(&helper.param(1)));
        let second = code(binary(
            "+",
            helper.read(&helper.param(1)),
            number(1.0, &loc),
            &loc,
        ));
        let range = |value: Expr, low, high| Expr::Logical {
            op: "&&".into(),
            left: Box::new(binary(">=", value.clone(), number(low, &loc), &loc)),
            right: Box::new(binary("<=", value, number(high, &loc), &loc)),
            r#type: Type::Bool,
            loc: loc.clone(),
        };
        let pair = Expr::Logical {
            op: "&&".into(),
            left: Box::new(range(first, 55296.0, 56319.0)),
            right: Box::new(range(second, 56320.0, 57343.0)),
            r#type: Type::Bool,
            loc: loc.clone(),
        };
        helper.function.body.push(Stmt::Return {
            value: Some(Expr::Ternary {
                cond: Box::new(pair),
                then: Box::new(number(2.0, &loc)),
                else_: Box::new(number(1.0, &loc)),
                r#type: Type::F64,
                loc: loc.clone(),
            }),
            loc,
        });
        Expr::Call {
            callee: self.install_helper(helper.function),
            args: vec![value, index],
            r#type: Type::F64,
            loc: self.loc(node),
        }
    }
}
