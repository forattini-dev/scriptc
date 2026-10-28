//! Distribute a leading record spread by owned IR layout, before publishing it.
use super::*;

impl Lowerer<'_> {
    pub(super) fn union_spread(
        &mut self,
        node: Node,
        target: Type,
    ) -> Result<Option<Expr>, String> {
        let properties = node.properties().into_iter().collect::<Vec<_>>();
        let Some(first) = properties.first() else {
            return Ok(None);
        };
        if first.kind() != SyntaxKind::SpreadAssignment {
            return Ok(None);
        }
        // Prefix effects and multiple correlated sources need their own plan.
        // Never move an effect across a source evaluation to select a layout.
        let mut written = HashSet::new();
        for property in &properties[1..] {
            if !matches!(
                property.kind(),
                SyntaxKind::PropertyAssignment | SyntaxKind::ShorthandPropertyAssignment
            ) {
                return Err(self.refuse(
                    *property,
                    "union spread requires trailing named data properties",
                ));
            }
            let name = self
                .data_property_name(property.name())
                .ok_or_else(|| self.refuse(*property, "union spread requires static data keys"))?;
            if name == "__proto__" && property.kind() == SyntaxKind::PropertyAssignment {
                return Err(self.refuse(*property, "object prototype setters are not ported"));
            }
            written.insert(name);
        }
        let source = first.expression();
        let value = self.expression(source)?;
        let inputs = match value.ty() {
            Type::Union { union_id } => self.unions[union_id].arms.clone(),
            ty @ Type::Record { .. } => vec![ty],
            _ => {
                return Err(self.refuse(source, "union spread requires closed record alternatives"));
            }
        };
        let Type::Union {
            union_id: output_id,
        } = target
        else {
            unreachable!()
        };
        let outputs = self.unions[output_id].arms.clone();
        let mut projections = Vec::new();
        for input in &inputs {
            let Type::Record { shape_id } = input else {
                return Err(self.refuse(source, "union spread requires closed record alternatives"));
            };
            if self.is_data_view(input) {
                return Err(self.refuse(source, "DataView own-key projection is not ported"));
            }
            let record = &self.records[*shape_id];
            let choices = outputs.iter().filter(|output| {
                let Type::Record { shape_id } = output else { return false };
                let result = &self.records[*shape_id];
                !result.tuple && result.index_value.is_none()
                    && record.fields.iter().all(|field| result.fields.contains(field))
                    && written.iter().all(|name| result.fields.iter().any(|f| f.name == *name))
                    && result.fields.iter().all(|field| {
                        record.fields.iter().any(|f| f.name == field.name)
                            || written.contains(&field.name)
                            || matches!(&field.r#type, Type::Union { union_id } if self.unions[*union_id].arms.contains(&Type::Undefined))
                    })
            }).cloned().collect::<Vec<_>>();
            // Literal domains may collapse to the same native input shape.
            // Select only an unambiguous structural projection; never guess a
            // target tag from checker arm order or erased literal values.
            if choices.len() != 1 {
                return Err(self.refuse(
                    node,
                    "union spread needs one lossless target layout per source arm",
                ));
            }
            projections.push(choices[0].clone());
        }
        let local = self.construction_local(value.ty(), false);
        let before = self.var_defined.clone();
        let mut after: Option<HashSet<u32>> = None;
        let mut branches = Vec::new();
        for (tag, (input, output)) in inputs.iter().zip(projections).enumerate() {
            self.var_defined = before.clone();
            let narrowed = match local.r#type {
                Type::Union { union_id } => Expr::UnionNarrow {
                    union_id: format!("u{union_id}"),
                    tag,
                    value: Box::new(self.construction_read(&local, source)),
                    r#type: input.clone(),
                    loc: self.loc(source),
                },
                _ => self.construction_read(&local, source),
            };
            let result = self.construct_record_from(
                node,
                output,
                properties[1..].to_vec(),
                Some((source, narrowed)),
            )?;
            branches.push(self.coerce(result, target.clone(), node)?);
            after = Some(match after {
                Some(previous) => previous.intersection(&self.var_defined).copied().collect(),
                None => self.var_defined.clone(),
            });
        }
        self.var_defined = after.unwrap_or(before);
        let mut result = branches.pop().unwrap();
        while let Some(then) = branches.pop() {
            let Type::Union { union_id } = local.r#type else {
                unreachable!()
            };
            result = Expr::Ternary {
                cond: Box::new(Expr::UnionIsTag {
                    union_id: format!("u{union_id}"),
                    tag: branches.len(),
                    negated: false,
                    value: Box::new(self.construction_read(&local, source)),
                    r#type: Type::Bool,
                    loc: self.loc(source),
                }),
                then: Box::new(then),
                else_: Box::new(result),
                r#type: target.clone(),
                loc: self.loc(node),
            };
        }
        Ok(Some(Expr::Sequence {
            stmts: vec![Stmt::VarDecl {
                local_id: local.id,
                init: value,
                loc: self.loc(source),
            }],
            result: Box::new(result),
            r#type: target,
            loc: self.loc(node),
        }))
    }
}
