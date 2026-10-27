//! Typed maps, string-indexed records and owning data-property lookups.
use super::*;
use source_frontend::prelude::get_source_file_of_node;

impl Lowerer<'_> {
    pub(super) fn map_type(&mut self, id: TypeId) -> Option<Type> {
        let symbol = self.checker.ty(id).symbol();
        if symbol.0 == 0 {
            return None;
        }
        let symbol = self.checker.sym(symbol);
        if !matches!(symbol.name.as_ref(), "Map" | "ReadonlyMap") {
            return None;
        }
        // Recognize the standard library declaration, not a user's same-named class.
        if !symbol.declarations.iter().any(|node| {
            !node.is_nil()
                && source_file_info(get_source_file_of_node(*node))
                    .file_name
                    .ends_with("/lib.es2015.collection.d.ts")
        }) {
            return None;
        }
        let args = self.checker.get_type_arguments(id).to_vec();
        if args.len() != 2 {
            return None;
        }
        let key = self.type_id(args[0])?;
        // IR v13 stores BigInt keys through its owning scalar value ABI.
        // Numeric-value equality remains exact; no f64 key projection occurs.
        let key = if key == Type::Bigint { Type::Dyn } else { key };
        let mut value = self.type_id(args[1])?;
        // The portable Map ABI accepts owning union values, but not a bare
        // bytes slot. Keep u8 payloads typed and traced in the same optional
        // union needed by Map.get; an absent entry still has no stored value.
        if matches!(value, Type::Bytes { .. }) {
            value = self.intern_union(vec![value, Type::Undefined])?;
        }
        if !matches!(key, Type::String | Type::F64 | Type::Dyn)
            || matches!(
                value,
                Type::Void
                    | Type::Null
                    | Type::Undefined
                    | Type::Func { .. }
                    | Type::Map { .. }
                    | Type::Stats
            )
        {
            return None;
        }
        Some(Type::Map {
            key: Box::new(key),
            value: Box::new(value),
        })
    }

    fn lookup_type(&mut self, value: Type, node: Node) -> Result<Type, String> {
        let mut arms = match value {
            Type::Union { union_id } => self.unions[union_id].arms.clone(),
            value => vec![value],
        };
        arms.push(Type::Undefined);
        self.intern_union(arms)
            .ok_or_else(|| self.refuse(node, "lookup result has no undefined representation"))
    }

    pub(super) fn map_new(&mut self, node: Node) -> Result<Expr, String> {
        self.map_new_expected(node, None)
    }

    pub(super) fn map_new_expected(
        &mut self,
        node: Node,
        expected: Option<Type>,
    ) -> Result<Expr, String> {
        let ty = if let Some(ty) = expected {
            ty
        } else {
            self.ty(node)?
        };
        let Type::Map { key, value } = &ty else {
            return Err(self.refuse(node, "only native Map construction is ported"));
        };
        // A structural return type alone cannot prove which constructor ran.
        let symbol = self.symbol(node.expression());
        if symbol == 0
            || self
                .checker
                .sym(source_frontend::prelude::SymbolId(symbol))
                .name
                .as_ref()
                != "Map"
            || self.bindings.contains_key(&symbol)
            || !self
                .checker
                .sym(source_frontend::prelude::SymbolId(symbol))
                .declarations
                .iter()
                .any(|node| {
                    !node.is_nil()
                        && source_file_info(get_source_file_of_node(*node))
                            .file_name
                            .ends_with("/lib.es2015.collection.d.ts")
                })
        {
            return Err(self.refuse(node, "Map constructor must be the standard library value"));
        }
        let arguments = node.arguments().into_iter().collect::<Vec<_>>();
        if arguments.len() > 1 {
            return Err(self.refuse(node, "Map constructor arity is not ported"));
        }
        let mut seed = Vec::new();
        if let Some(argument) = arguments.first() {
            if argument.kind() != SyntaxKind::ArrayLiteralExpression {
                let entries = self.expression(*argument)?;
                return self.map_from_array(node, entries, ty);
            }
            for pair in argument.elements() {
                if pair.kind() != SyntaxKind::ArrayLiteralExpression {
                    let pair = self
                        .intern_tuple(vec![(**key).clone(), (**value).clone()])
                        .ok_or_else(|| self.refuse(pair, "Map entry layout is not ported"))?;
                    let entries = self.expected_expression(
                        *argument,
                        Type::Array {
                            elem: Box::new(pair),
                        },
                    )?;
                    return self.map_from_array(node, entries, ty);
                }
                let elements = pair.elements().into_iter().collect::<Vec<_>>();
                if pair.kind() != SyntaxKind::ArrayLiteralExpression || elements.len() != 2 {
                    return Err(
                        self.refuse(pair, "Map seed entry must be a key/value pair literal")
                    );
                }
                seed.push(ir::MapEntry {
                    key: self.expected_expression(elements[0], (**key).clone())?,
                    value: self.expected_expression(elements[1], (**value).clone())?,
                });
            }
        }
        Ok(Expr::MapNew {
            seed,
            r#type: ty,
            loc: self.loc(node),
        })
    }

    pub(super) fn map_intrinsic(
        &mut self,
        node: Node,
        receiver: Expr,
        method: &str,
        arguments: Vec<Node>,
    ) -> Result<Expr, String> {
        let Type::Map { key, value } = receiver.ty() else {
            return Err(self.refuse(node, "non-Map receiver"));
        };
        let (types, result) = match method {
            "get" => (vec![*key], self.lookup_type(*value, node)?),
            "has" | "delete" => (vec![*key], Type::Bool),
            "size" => (vec![], Type::F64),
            // IR set returns void; JavaScript chaining remains explicitly refused.
            "set" => (vec![*key, *value], Type::Void),
            "clear" => (vec![], Type::Void),
            _ => return Err(self.refuse(node, "Map method is not ported")),
        };
        if types.len() != arguments.len() {
            return Err(self.refuse(node, "Map method arity is not ported"));
        }
        let args = arguments
            .into_iter()
            .zip(types)
            .map(|(node, ty)| self.expected_expression(node, ty))
            .collect::<Result<Vec<_>, _>>()?;
        Ok(Expr::MapIntrinsic {
            method: method.into(),
            receiver: Box::new(receiver),
            args,
            r#type: result,
            loc: self.loc(node),
        })
    }

    pub(super) fn dictionary_get(
        &mut self,
        node: Node,
        obj: Expr,
        key: Expr,
    ) -> Result<Expr, String> {
        let Type::Record { shape_id } = obj.ty() else {
            return Err(self.refuse(node, "indexed access needs a native dictionary"));
        };
        if self.records[shape_id].index_value.is_none() {
            if self.records[shape_id].tuple
                || self.callables.contains_key(&shape_id)
                || self.enum_shape(shape_id)
            {
                return Err(self.refuse(
                    node,
                    "computed tuple, callable and enum reads require their native member contracts",
                ));
            }
            if let Expr::StrLit { value: name, .. } = &key
                && let Some(field) = self.records[shape_id]
                    .fields
                    .iter()
                    .find(|f| f.name == *name)
                    .cloned()
            {
                let value = Expr::RecordGet {
                    obj: Box::new(obj),
                    shape_id: format!("r{shape_id}"),
                    field: field.name,
                    r#type: field.r#type,
                    loc: self.loc(node),
                };
                return if self.planned_field_read(node) {
                    Ok(value)
                } else {
                    self.narrowed(value, node)
                };
            }
            // A shape describes typed views of known fields, not a whitelist
            // for JavaScript property reads. Keep the original owning store so
            // computed keys observe aliases, extra properties and absence.
            let obj = self.coerce(obj, Type::Dyn, node)?;
            let value = self.dynamic_get(node, obj, key);
            return self.narrowed(value, node);
        }
        let value = self.records[shape_id]
            .index_value
            .clone()
            .ok_or_else(|| self.refuse(node, "indexed access needs a string index signature"))?;
        if key.ty() != Type::String {
            return Err(self.refuse(node, "dictionary key must be a string"));
        }
        let ty = self.lookup_type(value, node)?;
        let value = Expr::RecordKeyGet {
            obj: Box::new(obj),
            shape_id: format!("r{shape_id}"),
            key: Box::new(key),
            overflow_only: true,
            r#type: ty,
            loc: self.loc(node),
        };
        // An index signature describes stored values, not key presence. The
        // checker can omit undefined when noUncheckedIndexedAccess is false.
        // Preserve the lookup tag until a source guard proves its payload.
        Ok(value)
    }

    pub(super) fn dictionary_set(&mut self, node: Node) -> Result<Stmt, String> {
        self.guard_raw_json_write(node)?;
        let member = node.left();
        let obj = self.expression(member.expression())?;
        self.dictionary_set_value(node, obj)
    }

    pub(super) fn dictionary_set_value(&mut self, node: Node, obj: Expr) -> Result<Stmt, String> {
        let member = node.left();
        if let Type::Array { elem } = obj.ty()
            && *elem != Type::Dyn
        {
            // Named properties require a separate array property store. Admit
            // proven ordinary indices while retaining an explicit boundary.
            let index = self.expected_expression(member.argument_expression(), Type::F64)?;
            if !matches!(&index, Expr::NumLit { value, .. } if value.is_finite() && *value >= 0.0 && *value < 4_294_967_295.0 && value.trunc() == *value)
            {
                return Err(self.refuse(member, "array writes require a constant ordinary array index; dynamic keys are not ported"));
            }
            let value = self.expected_expression(node.right(), *elem)?;
            return Ok(Stmt::ArraySet {
                arr: obj,
                index,
                value,
                loc: self.loc(node),
            });
        }
        if matches!(obj.ty(), Type::Bytes { .. }) {
            let expr = self.bytes_assignment_value(node, obj, None)?;
            return Ok(Stmt::Expression {
                expr,
                loc: self.loc(node),
            });
        }
        if obj.ty() == Type::Dyn
            || matches!(obj.ty(), Type::Func { .. })
            || matches!(obj.ty(), Type::Array { elem } if *elem == Type::Dyn)
        {
            if matches!(obj.ty(), Type::Func { .. }) {
                self.function_member_key(member)?;
            }
            let obj = self.coerce(obj, Type::Dyn, member)?;
            let key = self.property_key_expression(member.argument_expression())?;
            return self.dynamic_property_set(node, obj, key);
        }
        let Type::Record { shape_id } = obj.ty() else {
            return Err(self.refuse(member, "indexed writes need a native dictionary"));
        };
        if self.enum_shape(shape_id) {
            return Err(self.refuse(
                member,
                "enum namespace mutation outside its initializer is not ported",
            ));
        }
        if self.records[shape_id].index_value.is_none() {
            let name = self.literal_property_key(member.argument_expression());
            if name.is_none()
                && !self.records[shape_id].tuple
                && !self.callables.contains_key(&shape_id)
                && self.records[shape_id]
                    .fields
                    .iter()
                    .all(|field| field.r#type == Type::Dyn)
            {
                let key = self.property_key_expression(member.argument_expression())?;
                let obj = self.coerce(obj, Type::Dyn, member)?;
                return self.dynamic_property_set(node, obj, key);
            }
            let name = name.ok_or_else(|| {
                self.refuse(
                    member,
                    "computed record writes require owning dynamic field slots",
                )
            })?;
            if name == "__proto__" {
                return Err(self.refuse(member, "ordinary prototype writes are not ported"));
            }
            let field = self.records[shape_id]
                .fields
                .iter()
                .find(|f| f.name == name)
                .cloned()
                .ok_or_else(|| self.refuse(member, "unknown native record field"))?;
            let value = self.expected_expression(node.right(), field.r#type)?;
            return Ok(Stmt::RecordSet {
                obj,
                shape_id: format!("r{shape_id}"),
                field: field.name,
                value,
                loc: self.loc(node),
            });
        }
        let value_type = self.records[shape_id]
            .index_value
            .clone()
            .ok_or_else(|| self.refuse(member, "indexed writes need a string index signature"))?;
        let key = if member.kind() == SyntaxKind::PropertyAccessExpression {
            Expr::StrLit {
                value: member.name().text().into(),
                r#type: Type::String,
                loc: self.loc(member),
            }
        } else {
            self.property_key_expression(member.argument_expression())?
        };
        let value = self.expected_expression(node.right(), value_type)?;
        if matches!(&key, Expr::StrLit { value, .. } if value == "__proto__") {
            return Err(self.refuse(member, "dictionary prototype setters are not ported"));
        }
        Ok(Stmt::RecordKeySet {
            obj,
            shape_id: format!("r{shape_id}"),
            key,
            value,
            overflow_only: true,
            loc: self.loc(node),
        })
    }
}
