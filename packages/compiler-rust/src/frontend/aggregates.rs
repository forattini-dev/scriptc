//! Closed structural records and tagged native unions; no dynamic values.
use super::*;
use goport_core::prelude::{ObjectFlags, SignatureKind};

impl Lowerer<'_> {
    pub(super) fn aggregate_type(&mut self, id: TypeId) -> Option<Type> {
        let flags = self.checker.ty(id).flags;
        if flags.intersects(TypeFlags::NULL) {
            return Some(Type::Null);
        }
        if flags.intersects(TypeFlags::UNDEFINED) {
            return Some(Type::Undefined);
        }
        if let Some(cached) = self.types.get(&id) {
            return cached.clone();
        }
        self.types.insert(id, None);
        let result = self.aggregate_type_inner(id);
        self.types.insert(id, result.clone());
        result
    }

    fn aggregate_type_inner(&mut self, id: TypeId) -> Option<Type> {
        let flags = self.checker.ty(id).flags;
        if flags.intersects(TypeFlags::OBJECT)
            && !self
                .checker
                .get_signatures_of_type(id, SignatureKind::CALL)
                .is_empty()
        {
            return self.function_type(id);
        }
        if flags.intersects(TypeFlags::UNION) {
            let source = self.checker.ty(id).types().to_vec();
            let mut arms = Vec::new();
            for source in source {
                let arm = self.type_id(source)?;
                if let Type::Union { union_id } = arm {
                    arms.extend(self.unions[union_id].arms.clone());
                } else {
                    arms.push(arm);
                }
            }
            return self.intern_union(arms);
        }
        if !flags.intersects(TypeFlags::OBJECT)
            || self
                .checker
                .ty(id)
                .object_flags()
                .intersects(ObjectFlags::CLASS)
            || self.checker.is_tuple_type(id)
            || !self.checker.get_index_infos_of_type(id).is_empty()
            || !self
                .checker
                .get_signatures_of_type(id, SignatureKind::CALL)
                .is_empty()
            || !self
                .checker
                .get_signatures_of_type(id, SignatureKind::CONSTRUCT)
                .is_empty()
        {
            return None;
        }
        let properties = self.checker.get_properties_of_type(id).to_vec();
        let mut fields = Vec::new();
        for property in properties {
            let name = self.checker.sym(property).name.to_string();
            // Accessors/methods carry evaluation or receiver semantics that a
            // plain slot cannot preserve. Refuse them even if unused.
            if self
                .checker
                .sym(property)
                .flags
                .intersects(SymbolFlags::METHOD | SymbolFlags::ACCESSOR)
            {
                return None;
            }
            let source = self.checker.get_type_of_symbol(property);
            let mut ty = self.type_id(source)?;
            if self
                .checker
                .sym(property)
                .flags
                .intersects(SymbolFlags::OPTIONAL)
            {
                let mut arms = match ty {
                    Type::Union { union_id } => self.unions[union_id].arms.clone(),
                    _ => vec![ty],
                };
                arms.push(Type::Undefined);
                ty = self.intern_union(arms)?;
            }
            if matches!(ty, Type::Null | Type::Undefined | Type::Func { .. }) {
                return None;
            }
            fields.push(ir::Field { name, r#type: ty });
        }
        let declared_order = fields.iter().map(|f| f.name.clone()).collect();
        fields.sort_by(|a, b| a.name.cmp(&b.name));
        if let Some(record) = self.records.iter().find(|r| r.fields == fields) {
            return Some(Type::Record {
                shape_id: record.id,
            });
        }
        let shape_id = self.records.len();
        self.records.push(ir::Record {
            id: shape_id,
            fields,
            declared_order,
        });
        Some(Type::Record { shape_id })
    }

    fn intern_union(&mut self, mut arms: Vec<Type>) -> Option<Type> {
        arms.sort_by_key(|a| format!("{a:?}"));
        arms.dedup();
        if arms.len() == 1 {
            return Some(arms[0].clone());
        }
        if arms.is_empty()
            || arms
                .iter()
                .any(|a| matches!(a, Type::Void | Type::Array { .. } | Type::Func { .. }))
        {
            return None;
        }
        if let Some(union) = self.unions.iter().find(|u| u.arms == arms) {
            return Some(Type::Union { union_id: union.id });
        }
        let union_id = self.unions.len();
        self.unions.push(ir::Union { id: union_id, arms });
        Some(Type::Union { union_id })
    }

    pub(super) fn coerce(&self, value: Expr, target: Type, node: Node) -> Result<Expr, String> {
        if value.ty() == target {
            return Ok(value);
        }
        if let Type::Union { union_id } = target
            && let Some(tag) = self.unions[union_id]
                .arms
                .iter()
                .position(|a| *a == value.ty())
        {
            return Ok(Expr::UnionWrap {
                union_id: format!("u{union_id}"),
                tag,
                value: Box::new(value),
                r#type: target,
                loc: self.loc(node),
            });
        }
        Err(self.refuse(node, "native representation coercion is not ported"))
    }

    pub(super) fn narrowed(&mut self, value: Expr, node: Node) -> Result<Expr, String> {
        // A lowered value already carries a verified native representation.
        // Untyped JS doesn't supply additional control-flow evidence.
        if !matches!(value.ty(), Type::Union { .. }) || self.checker_any(node) {
            return Ok(value);
        }
        let target = self.ty(node)?;
        if value.ty() == target {
            return Ok(value);
        }
        // Unit values have no standalone IR storage. Keep the tagged value
        // for equality tests even when the checker already knows its tag.
        if matches!(target, Type::Null | Type::Undefined)
            && matches!(value.ty(), Type::Union { .. })
        {
            return Ok(value);
        }
        if let Type::Union { union_id } = value.ty()
            && let Some(tag) = self.unions[union_id].arms.iter().position(|a| *a == target)
        {
            return Ok(Expr::UnionNarrow {
                union_id: format!("u{union_id}"),
                tag,
                value: Box::new(value),
                r#type: target,
                loc: self.loc(node),
            });
        }
        // Literal domains widen to one primitive representation. Other
        // refinements need an explicit IR operation rather than a Rust cast.
        Err(self.refuse(node, "flow narrowing has no native projection"))
    }

    pub(super) fn expected_expression(&mut self, node: Node, target: Type) -> Result<Expr, String> {
        match node.kind() {
            SyntaxKind::ArrowFunction | SyntaxKind::FunctionExpression => {
                self.closure(node, Some(target))
            }
            SyntaxKind::ObjectLiteralExpression if matches!(target, Type::Union { .. }) => {
                let Type::Union { union_id } = target else {
                    unreachable!();
                };
                let source = self.checker.get_type_at_location(node);
                let arms = self.unions[union_id].arms.clone();
                let candidates = self
                    .types
                    .iter()
                    .filter_map(|(id, ty)| ty.clone().map(|ty| (*id, ty)))
                    .collect::<Vec<_>>();
                let mut matches = Vec::new();
                for arm in arms {
                    if matches!(arm, Type::Record { .. })
                        && candidates.iter().any(|(id, ty)| {
                            *ty == arm && self.checker.is_type_assignable_to(source, *id)
                        })
                    {
                        matches.push(arm);
                    }
                }
                if matches.is_empty() {
                    matches = self.unions[union_id]
                        .arms
                        .iter()
                        .filter(|ty| matches!(ty, Type::Record { .. }))
                        .cloned()
                        .collect();
                }
                if matches.len() != 1 {
                    return Err(
                        self.refuse(node, "object literal needs one assignable native union arm")
                    );
                }
                let value = self.record_literal(node, matches[0].clone())?;
                self.coerce(value, target, node)
            }
            SyntaxKind::ObjectLiteralExpression if matches!(target, Type::Record { .. }) => {
                self.record_literal(node, target)
            }
            SyntaxKind::ParenthesizedExpression => {
                self.expected_expression(node.expression(), target)
            }
            SyntaxKind::ConditionalExpression => {
                let cond = Box::new(self.expression(node.condition())?);
                if cond.ty() != Type::Bool {
                    return Err(self.refuse(node, "conditional truthiness is not ported"));
                }
                let then = Box::new(self.expected_expression(node.when_true(), target.clone())?);
                let else_ = Box::new(self.expected_expression(node.when_false(), target.clone())?);
                Ok(Expr::Ternary {
                    cond,
                    then,
                    else_,
                    r#type: target,
                    loc: self.loc(node),
                })
            }
            _ => {
                let value = self.expression(node)?;
                self.coerce(value, target, node)
            }
        }
    }

    pub(super) fn record_literal(&mut self, node: Node, target: Type) -> Result<Expr, String> {
        let Type::Record { shape_id } = target else {
            return Err(self.refuse(node, "record literal needs a closed shape"));
        };
        let record = self.records[shape_id].clone();
        let mut seen = HashSet::new();
        let mut fields = Vec::new();
        for property in node.properties() {
            if !matches!(
                property.kind(),
                SyntaxKind::PropertyAssignment | SyntaxKind::ShorthandPropertyAssignment
            ) || !matches!(
                property.name().kind(),
                SyntaxKind::Identifier | SyntaxKind::StringLiteral
            ) {
                return Err(self.refuse(property, "only named data properties are ported"));
            }
            let name = property.name().text().to_string();
            // __proto__ in colon notation sets a prototype, not an own slot.
            if name == "__proto__" && property.kind() == SyntaxKind::PropertyAssignment {
                return Err(self.refuse(property, "object prototype setters are not ported"));
            }
            let field = record
                .fields
                .iter()
                .find(|f| f.name == name)
                .ok_or_else(|| self.refuse(property, "record width projection is not ported"))?;
            if !seen.insert(name.clone()) {
                return Err(self.refuse(property, "duplicate record properties are not ported"));
            }
            let source = if property.kind() == SyntaxKind::ShorthandPropertyAssignment {
                property.name()
            } else {
                property.initializer()
            };
            let value = self.expected_expression(source, field.r#type.clone())?;
            fields.push(ir::FieldInit {
                name,
                value,
                absent: false,
            });
        }
        for field in &record.fields {
            if !seen.contains(&field.name) {
                let value = Expr::UnitLit {
                    unit: "undefined",
                    r#type: Type::Undefined,
                    loc: self.loc(node),
                };
                let value = self.coerce(value, field.r#type.clone(), node)?;
                fields.push(ir::FieldInit {
                    name: field.name.clone(),
                    value,
                    absent: true,
                });
            }
        }
        Ok(Expr::RecordLit {
            fields,
            r#type: target,
            loc: self.loc(node),
        })
    }

    pub(super) fn record_get(&mut self, node: Node) -> Result<Expr, String> {
        let obj = self.expression(node.expression())?;
        let Type::Record { shape_id } = obj.ty() else {
            return Err(self.refuse(
                node,
                "property receiver has no closed record representation",
            ));
        };
        let field = self.records[shape_id]
            .fields
            .iter()
            .find(|f| f.name == node.name().text())
            .ok_or_else(|| self.refuse(node, "unknown native record field"))?;
        let value = Expr::RecordGet {
            obj: Box::new(obj),
            shape_id: format!("r{shape_id}"),
            field: field.name.clone(),
            r#type: field.r#type.clone(),
            loc: self.loc(node),
        };
        self.narrowed(value, node)
    }

    pub(super) fn record_set(&mut self, node: Node) -> Result<Stmt, String> {
        let member = node.left();
        let obj = self.expression(member.expression())?;
        let Type::Record { shape_id } = obj.ty() else {
            return Err(self.refuse(node, "property assignment requires a closed record"));
        };
        let field = self.records[shape_id]
            .fields
            .iter()
            .find(|f| f.name == member.name().text())
            .cloned()
            .ok_or_else(|| self.refuse(member, "unknown native record field"))?;
        let value = self.expected_expression(node.right(), field.r#type)?;
        Ok(Stmt::RecordSet {
            obj,
            shape_id: format!("r{shape_id}"),
            field: field.name,
            value,
            loc: self.loc(node),
        })
    }

    pub(super) fn binary(&mut self, node: Node, op: &str) -> Result<Expr, String> {
        let left = self.expression(node.left())?;
        let right = self.expression(node.right())?;
        if matches!(op, "===" | "!==") {
            if matches!(left, Expr::UnitLit { .. }) && matches!(right, Expr::UnitLit { .. }) {
                return Ok(Expr::BoolLit {
                    value: (left.ty() == right.ty()) != (op == "!=="),
                    r#type: Type::Bool,
                    loc: self.loc(node),
                });
            }
            // Only unit comparisons can become tag tests: comparing two
            // payload values requires JS equality, not tag equality.
            let mut test = None;
            for (value, unit) in [(&left, &right), (&right, &left)] {
                if let Type::Union { union_id } = value.ty()
                    && matches!(unit, Expr::UnitLit { .. })
                    && let Some(tag) = self.unions[union_id]
                        .arms
                        .iter()
                        .position(|a| *a == unit.ty())
                {
                    test = Some((union_id, tag));
                }
            }
            if let Some((union_id, tag)) = test {
                return Ok(Expr::UnionIsTag {
                    union_id: format!("u{union_id}"),
                    tag,
                    negated: op == "!==",
                    value: Box::new(if matches!(left, Expr::UnitLit { .. }) {
                        right
                    } else {
                        left
                    }),
                    r#type: Type::Bool,
                    loc: self.loc(node),
                });
            }
            let union = if matches!(left.ty(), Type::Union { .. }) {
                left.ty()
            } else {
                right.ty()
            };
            if let Type::Union { union_id } = union {
                let left = self.coerce(left, union.clone(), node.left())?;
                let right = self.coerce(right, union, node.right())?;
                return Ok(Expr::UnionEq {
                    union_id: format!("u{union_id}"),
                    negated: op == "!==",
                    same_value: false,
                    left: Box::new(left),
                    right: Box::new(right),
                    r#type: Type::Bool,
                    loc: self.loc(node),
                });
            }
        }
        let supported = if matches!(op, "&&" | "||") {
            left.ty() == Type::Bool && right.ty() == Type::Bool
        } else if matches!(op, "===" | "!==") {
            left.ty() == right.ty()
                && matches!(
                    left.ty(),
                    Type::F64
                        | Type::String
                        | Type::Bool
                        | Type::Null
                        | Type::Undefined
                        | Type::Record { .. }
                        | Type::Func { .. }
                )
        } else {
            left.ty() == Type::F64 && right.ty() == Type::F64
        };
        if !supported {
            return Err(self.refuse(node, "binary operand coercion is not ported"));
        }
        if matches!(op, "&&" | "||") {
            return Ok(Expr::Logical {
                op: op.into(),
                left: Box::new(left),
                right: Box::new(right),
                r#type: Type::Bool,
                loc: self.loc(node),
            });
        }
        if left.ty() == Type::String {
            return Ok(Expr::StrEq {
                negated: op == "!==",
                left: Box::new(left),
                right: Box::new(right),
                r#type: Type::Bool,
                loc: self.loc(node),
            });
        }
        Ok(Expr::Bin {
            op: op.into(),
            left: Box::new(left),
            right: Box::new(right),
            r#type: if matches!(op, "+" | "-" | "*" | "/" | "%" | "**") {
                Type::F64
            } else {
                Type::Bool
            },
            loc: self.loc(node),
        })
    }
}
