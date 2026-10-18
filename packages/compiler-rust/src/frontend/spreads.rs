//! Inline data spreads use portable expression sequences and typed writes.
use super::*;

impl Lowerer<'_> {
    pub(super) fn record_spread_literal(
        &mut self,
        node: Node,
        target: Type,
        properties: Vec<Node>,
    ) -> Result<Expr, String> {
        let Type::Record { shape_id } = target else {
            return Err(self.refuse(node, "object spread needs a closed record target"));
        };
        if self.records[shape_id].index_value.is_some() {
            return Err(self.refuse(node, "indexed object spreads are not ported"));
        }
        let first = properties
            .iter()
            .position(|p| p.kind() == SyntaxKind::SpreadAssignment)
            .unwrap();
        for field in &self.records[shape_id].fields {
            let optional = matches!(field.r#type, Type::Undefined)
                || matches!(field.r#type, Type::Union { union_id } if self.unions[union_id].arms.contains(&Type::Undefined));
            if !optional
                && !properties[..first].iter().any(|p| {
                    self.data_property_name(p.name()).as_deref() == Some(field.name.as_str())
                })
            {
                return Err(self.refuse(
                    node,
                    "required record fields must be initialized before the first object spread",
                ));
            }
        }
        // The initial record must already satisfy its required slots. Later
        // writes can add optional slots or overwrite existing required slots.
        // This avoids exposing an uninitialized value through a typed handle.
        let init =
            self.record_literal_fields(node, target.clone(), properties[..first].to_vec())?;
        let local = Local {
            id: format!("spread{}", self.locals.len()),
            name: "object spread result".into(),
            r#type: target.clone(),
            mutable: false,
            boxed: false,
        };
        self.locals.push(local.clone());
        let mut stmts = vec![Stmt::VarDecl {
            local_id: local.id.clone(),
            init,
            loc: self.loc(node),
        }];
        for property in properties.into_iter().skip(first) {
            stmts.extend(self.spread_property(property, &local, shape_id)?);
        }
        Ok(Expr::Sequence {
            stmts,
            result: Box::new(self.spread_read(&local, node)),
            r#type: target,
            loc: self.loc(node),
        })
    }

    fn spread_read(&self, local: &Local, node: Node) -> Expr {
        Expr::VarRef {
            local_id: local.id.clone(),
            r#type: local.r#type.clone(),
            loc: self.loc(node),
        }
    }

    fn spread_property(
        &mut self,
        property: Node,
        local: &Local,
        shape_id: usize,
    ) -> Result<Vec<Stmt>, String> {
        if property.kind() == SyntaxKind::SpreadAssignment {
            return self.spread_source(property.expression(), local, shape_id);
        }
        if !matches!(
            property.kind(),
            SyntaxKind::PropertyAssignment | SyntaxKind::ShorthandPropertyAssignment
        ) {
            return Err(self.refuse(property, "object spread requires named data properties"));
        }
        let name = self
            .data_property_name(property.name())
            .ok_or_else(|| self.refuse(property, "computed spread properties are not ported"))?;
        if name == "__proto__" && property.kind() == SyntaxKind::PropertyAssignment {
            return Err(self.refuse(property, "object prototype setters are not ported"));
        }
        let field = self.records[shape_id]
            .fields
            .iter()
            .find(|f| f.name == name)
            .cloned()
            .ok_or_else(|| self.refuse(property, "object spread width projection is not ported"))?;
        let source = if property.kind() == SyntaxKind::ShorthandPropertyAssignment {
            property.name()
        } else {
            property.initializer()
        };
        let value = self.expected_expression(source, field.r#type)?;
        Ok(vec![Stmt::RecordSet {
            obj: self.spread_read(local, property),
            shape_id: format!("r{shape_id}"),
            field: name,
            value,
            loc: self.loc(property),
        }])
    }

    fn spread_source(
        &mut self,
        source: Node,
        local: &Local,
        shape_id: usize,
    ) -> Result<Vec<Stmt>, String> {
        match source.kind() {
            SyntaxKind::ParenthesizedExpression => {
                self.spread_source(source.expression(), local, shape_id)
            }
            SyntaxKind::ObjectLiteralExpression => {
                let mut body = Vec::new();
                for property in source.properties() {
                    body.extend(self.spread_property(property, local, shape_id)?);
                }
                Ok(body)
            }
            SyntaxKind::ConditionalExpression => {
                let value = self.condition_value(source.condition())?;
                let cond = self.condition(value, source.condition())?;
                let before = self.var_defined.clone();
                if let Some(symbol) = self.guarded_var(source.condition(), true) {
                    self.var_defined.insert(symbol);
                }
                let then = self.spread_source(source.when_true(), local, shape_id)?;
                let then_defined = self.var_defined.clone();
                self.var_defined = before;
                if let Some(symbol) = self.guarded_var(source.condition(), false) {
                    self.var_defined.insert(symbol);
                }
                let other = self.spread_source(source.when_false(), local, shape_id)?;
                self.var_defined = then_defined
                    .intersection(&self.var_defined)
                    .copied()
                    .collect();
                Ok(vec![Stmt::If {
                    cond,
                    then,
                    else_: Some(other),
                    loc: self.loc(source),
                }])
            }
            _ => Err(self.refuse(
                source,
                "only inline data literals and conditional object spreads are ported",
            )),
        }
    }
}
