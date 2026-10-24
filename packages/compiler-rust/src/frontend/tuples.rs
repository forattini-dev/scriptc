//! Fixed required tuples reuse the IR's positional record layout.
use super::*;
use helpers::Helper;
use source_frontend::flags::ElementFlags;
use source_frontend::prelude::SignatureKind;

impl Lowerer<'_> {
    /// A method declaration can widen a builtin's input contract without adding
    /// an own property. Keep the tuple's existing positional storage and aliases.
    /// Data properties, optional methods and other intersections need a separate
    /// runtime representation; they must not disappear into this static view.
    pub(super) fn tuple_intersection_type(&mut self, id: TypeId) -> Option<Type> {
        let parts = self.checker.ty(id).types().to_vec();
        let mut tuple = None;
        for part in parts {
            if self.checker.is_tuple_type(part) {
                if tuple.is_some()
                    || !self
                        .checker
                        .ty(self.checker.ty(part).target())
                        .as_tuple_type()
                        .readonly
                {
                    return None;
                }
                tuple = Some(part);
                continue;
            }
            if !self.checker.get_index_infos_of_type(part).is_empty()
                || !self
                    .checker
                    .get_signatures_of_type(part, SignatureKind::CALL)
                    .is_empty()
                || !self
                    .checker
                    .get_signatures_of_type(part, SignatureKind::CONSTRUCT)
                    .is_empty()
            {
                return None;
            }
            let properties = self.checker.get_properties_of_type(part).to_vec();
            if properties.len() != 1 {
                return None;
            }
            let property = self.checker.sym(properties[0]);
            if property.name.as_ref() != "includes"
                || property
                    .flags
                    .intersects(SymbolFlags::OPTIONAL | SymbolFlags::ACCESSOR)
                || property.declarations.is_empty()
                || !property
                    .declarations
                    .iter()
                    .all(|decl| decl.kind() == SyntaxKind::MethodSignature)
            {
                return None;
            }
            let method = self.checker.get_type_of_symbol(properties[0]);
            for signature in self
                .checker
                .get_signatures_of_type(method, SignatureKind::CALL)
            {
                if !self.checker.sig(signature).type_parameters.is_empty() {
                    return None;
                }
                let result = self.checker.get_return_type_of_signature(signature);
                if !self.checker.ty(result).flags.intersects(TypeFlags::BOOLEAN) {
                    return None;
                }
            }
        }
        self.tuple_type(tuple?)
    }

    pub(super) fn tuple_type(&mut self, id: TypeId) -> Option<Type> {
        let target = self.checker.ty(id).target();
        if self
            .checker
            .ty(target)
            .as_tuple_type()
            .combined_flags
            .intersects(ElementFlags::NON_REQUIRED)
        {
            return None;
        }
        let source = self.checker.get_type_arguments(id).to_vec();
        let elements = source
            .into_iter()
            .map(|element| self.type_id(element))
            .collect::<Option<Vec<_>>>()?;
        self.intern_tuple(elements)
    }

    pub(super) fn intern_tuple(&mut self, elements: Vec<Type>) -> Option<Type> {
        if elements.iter().any(|ty| {
            matches!(
                ty,
                Type::Void | Type::Null | Type::Undefined | Type::Func { .. }
            )
        }) {
            return None;
        }
        let order = (0..elements.len())
            .map(|i| i.to_string())
            .collect::<Vec<_>>();
        let mut fields = order
            .iter()
            .cloned()
            .zip(elements)
            .map(|(name, r#type)| ir::Field { name, r#type })
            .collect::<Vec<_>>();
        fields.sort_by(|a, b| a.name.cmp(&b.name));
        if let Some(record) = self.records.iter().find(|r| r.tuple && r.fields == fields) {
            return Some(Type::Record {
                shape_id: record.id,
            });
        }
        let shape_id = self.records.len();
        self.records.push(ir::Record {
            id: shape_id,
            fields,
            declared_order: order,
            tuple: true,
            index_value: None,
        });
        Some(Type::Record { shape_id })
    }

    pub(super) fn tuple_literal(&mut self, node: Node, target: Type) -> Result<Expr, String> {
        let Type::Record { shape_id } = target else {
            unreachable!()
        };
        let record = self.records[shape_id].clone();
        let nodes = node.elements().into_iter().collect::<Vec<_>>();
        if !record.tuple || nodes.len() != record.fields.len() {
            return Err(self.refuse(node, "tuple literal arity differs from its layout"));
        }
        let fields = nodes
            .into_iter()
            .enumerate()
            .map(|(index, node)| {
                let name = index.to_string();
                let field = record.fields.iter().find(|f| f.name == name).unwrap();
                Ok(ir::FieldInit {
                    name,
                    value: self.expected_expression(node, field.r#type.clone())?,
                    absent: false,
                    overflow: false,
                })
            })
            .collect::<Result<Vec<_>, String>>()?;
        Ok(Expr::RecordLit {
            fields,
            r#type: target,
            loc: self.loc(node),
        })
    }

    pub(super) fn tuple_get(&mut self, node: Node, object: Expr) -> Result<Expr, String> {
        let Type::Record { shape_id } = object.ty() else {
            unreachable!()
        };
        let index = node.argument_expression();
        // Other key expressions may evaluate user code. Never erase them.
        if !matches!(
            index.kind(),
            SyntaxKind::NumericLiteral | SyntaxKind::StringLiteral
        ) {
            return Err(self.refuse(index, "tuple reads require a literal position"));
        }
        let field = self.records[shape_id]
            .fields
            .iter()
            .find(|f| f.name == index.text())
            .ok_or_else(|| self.refuse(index, "tuple position is outside its layout"))?;
        Ok(Expr::RecordGet {
            obj: Box::new(object),
            shape_id: format!("r{shape_id}"),
            field: field.name.clone(),
            r#type: field.r#type.clone(),
            loc: self.loc(node),
        })
    }

    pub(super) fn tuple_includes(&mut self, node: Node) -> Result<Expr, String> {
        let receiver = self.expression(node.expression().expression())?;
        let Type::Record { shape_id } = receiver.ty() else {
            unreachable!()
        };
        let mut values = vec![receiver];
        for argument in node.arguments() {
            if argument.kind() == SyntaxKind::SpreadElement {
                return Err(self.refuse(argument, "tuple.includes iterable spreads are not ported"));
            }
            // Type assertions are erased in JavaScript, including assertions on
            // fromIndex. Capture every argument before conversions or searching.
            let value = self.expression(primitives::primitive_source(argument))?;
            values.push(self.primitive_capture(value, argument)?);
        }
        if values.len() == 1 {
            let undefined = Expr::UnitLit {
                unit: "undefined",
                r#type: Type::Undefined,
                loc: self.loc(node),
            };
            values.push(self.primitive_capture(undefined, node)?);
        }
        let fields = self.records[shape_id].fields.clone();
        let mut arms = vec![Type::Undefined, Type::F64];
        for ty in fields
            .iter()
            .map(|f| f.r#type.clone())
            .chain([values[1].ty()])
        {
            let parts = match ty {
                Type::Union { union_id } => self.unions[union_id].arms.clone(),
                ty => vec![ty],
            };
            if parts.iter().any(|ty| {
                !matches!(
                    ty,
                    Type::F64
                        | Type::String
                        | Type::Bool
                        | Type::Symbol
                        | Type::Null
                        | Type::Undefined
                )
            }) {
                return Err(self.refuse(
                    node,
                    "tuple.includes requires represented scalar elements and search values",
                ));
            }
            arms.extend(parts);
        }
        let comparison = self.intern_union(arms).unwrap();
        // Even an empty tuple has a typed comparison domain for helper reuse.
        let Type::Union { union_id } = comparison else {
            return Err(self.refuse(node, "tuple.includes needs a scalar comparison domain"));
        };
        let mut helper = Helper::new(
            "tuple_includes",
            values.iter().map(Expr::ty).collect(),
            Type::Bool,
            self.loc(node),
        );
        let result = |value| Expr::BoolLit {
            value,
            r#type: Type::Bool,
            loc: helper.loc(),
        };
        if fields.is_empty() {
            helper.function.body.push(Stmt::Return {
                value: Some(result(false)),
                loc: helper.loc(),
            });
        } else {
            let offset = helper.local("offset", Type::F64, true);
            let source = if values.len() > 2 {
                self.primitive_number(helper.read(&helper.param(2)), node)?
            } else {
                helper.number(0.0)
            };
            helper.declare(
                &offset,
                Expr::LibCall {
                    r#fn: "math.trunc".into(),
                    args: vec![source],
                    r#type: Type::F64,
                    loc: helper.loc(),
                },
            );
            let loc = helper.loc();
            let binary = |op: &str, left: Expr, right: Expr, ty: Type| {
                if matches!(op, "&&" | "||") {
                    Expr::Logical {
                        op: op.into(),
                        left: Box::new(left),
                        right: Box::new(right),
                        r#type: ty,
                        loc: loc.clone(),
                    }
                } else {
                    Expr::Bin {
                        op: op.into(),
                        left: Box::new(left),
                        right: Box::new(right),
                        r#type: ty,
                        loc: loc.clone(),
                    }
                }
            };
            helper.function.body.push(Stmt::If {
                cond: binary(
                    "!==",
                    helper.read(&offset),
                    helper.read(&offset),
                    Type::Bool,
                ),
                then: vec![Stmt::Assign {
                    local_id: offset.id.clone(),
                    value: helper.number(0.0),
                    initializes_global: false,
                    loc: helper.loc(),
                }],
                else_: None,
                loc: helper.loc(),
            });
            helper.function.body.push(Stmt::If {
                cond: binary("<", helper.read(&offset), helper.number(0.0), Type::Bool),
                then: vec![Stmt::Assign {
                    local_id: offset.id.clone(),
                    value: binary(
                        "+",
                        helper.number(fields.len() as f64),
                        helper.read(&offset),
                        Type::F64,
                    ),
                    initializes_global: false,
                    loc: helper.loc(),
                }],
                else_: None,
                loc: helper.loc(),
            });
            let search = helper.local("search", comparison.clone(), false);
            let scalar_view = |value: Expr| {
                if matches!(value.ty(), Type::Union { .. }) && value.ty() != comparison {
                    let value = self.coerce(value, Type::Dyn, node)?;
                    self.coerce(value, comparison.clone(), node)
                } else {
                    self.coerce(value, comparison.clone(), node)
                }
            };
            helper.declare(&search, scalar_view(helper.read(&helper.param(1)))?);
            let number_tag = self.unions[union_id]
                .arms
                .iter()
                .position(|ty| *ty == Type::F64)
                .unwrap();
            for index in 0..fields.len() {
                let name = index.to_string();
                let field = fields
                    .iter()
                    .find(|field| field.name == name)
                    .expect("required tuple position");
                let item = Expr::RecordGet {
                    obj: Box::new(helper.read(&helper.param(0))),
                    shape_id: format!("r{shape_id}"),
                    field: name,
                    r#type: field.r#type.clone(),
                    loc: helper.loc(),
                };
                let item = scalar_view(item)?;
                let equality = Expr::UnionEq {
                    union_id: format!("u{union_id}"),
                    negated: false,
                    same_value: false,
                    left: Box::new(item.clone()),
                    right: Box::new(helper.read(&search)),
                    r#type: Type::Bool,
                    loc: helper.loc(),
                };
                let is_nan = |value: Expr| {
                    let number = Expr::UnionNarrow {
                        union_id: format!("u{union_id}"),
                        tag: number_tag,
                        value: Box::new(value.clone()),
                        r#type: Type::F64,
                        loc: helper.loc(),
                    };
                    let numeric = Expr::UnionIsTag {
                        union_id: format!("u{union_id}"),
                        tag: number_tag,
                        value: Box::new(value),
                        negated: false,
                        r#type: Type::Bool,
                        loc: helper.loc(),
                    };
                    binary(
                        "&&",
                        numeric,
                        binary("!==", number.clone(), number, Type::Bool),
                        Type::Bool,
                    )
                };
                // Strict equality covers both signs of zero; add the NaN pair
                // using guarded numeric projections in the existing shared IR.
                let equal = binary(
                    "||",
                    equality,
                    binary("&&", is_nan(item), is_nan(helper.read(&search)), Type::Bool),
                    Type::Bool,
                );
                helper.function.body.push(Stmt::If {
                    cond: binary(
                        "&&",
                        binary(
                            ">=",
                            helper.number(index as f64),
                            helper.read(&offset),
                            Type::Bool,
                        ),
                        equal,
                        Type::Bool,
                    ),
                    then: vec![Stmt::Return {
                        value: Some(Expr::BoolLit {
                            value: true,
                            r#type: Type::Bool,
                            loc: helper.loc(),
                        }),
                        loc: helper.loc(),
                    }],
                    else_: None,
                    loc: helper.loc(),
                });
            }
            helper.function.body.push(Stmt::Return {
                value: Some(Expr::BoolLit {
                    value: false,
                    r#type: Type::Bool,
                    loc: helper.loc(),
                }),
                loc: helper.loc(),
            });
        }
        let callee = self.install_helper(helper.function);
        Ok(Expr::Call {
            callee,
            args: values,
            r#type: Type::Bool,
            loc: self.loc(node),
        })
    }
}
