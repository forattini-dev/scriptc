//! Resolve source union choices while their checker identities are valid.
use super::*;
use source_frontend::flags::ContextFlags;

impl Lowerer<'_> {
    pub(super) fn contextual_union_literal(&mut self, node: Node) -> Option<Type> {
        let context = self.checker.get_contextual_type(node, ContextFlags::NONE);
        if context.0 == 0 || !self.checker.ty(context).flags.intersects(TypeFlags::UNION) {
            return None;
        }
        let source = self.checker.get_type_at_location(node);
        let arms = self.checker.ty(context).types().to_vec();
        let mut choices = Vec::new();
        for arm in arms {
            if self.checker.is_type_assignable_to(source, arm)
                && let Some(ty @ Type::Record { .. }) = self.type_id(arm)
                && !choices.contains(&ty)
            {
                choices.push(ty);
            }
        }
        (choices.len() == 1).then(|| choices.remove(0))
    }

    pub(super) fn union_record_get(
        &mut self,
        node: Node,
        obj: Expr,
        name: &str,
    ) -> Result<Expr, String> {
        let Type::Union { union_id } = obj.ty() else {
            unreachable!()
        };
        let arms = self.unions[union_id].arms.clone();
        let mut fields = Vec::new();
        for arm in &arms {
            let field = self
                .records
                .iter()
                .find(|r| *arm == (Type::Record { shape_id: r.id }))
                .and_then(|r| r.fields.iter().find(|f| f.name == name))
                .cloned()
                .ok_or_else(|| {
                    self.refuse(node, "union member requires a common native record field")
                })?;
            fields.push(field);
        }
        let result = self
            .intern_union(fields.iter().map(|f| f.r#type.clone()).collect())
            .ok_or_else(|| self.refuse(node, "common union field has no native representation"))?;
        // The field is part of the operation identity. Two members can have
        // identical parameter/result types and still read different slots.
        let member = name
            .as_bytes()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>();
        let mut helper = helpers::Helper::new(
            &format!("union_member_{member}"),
            vec![obj.ty()],
            result.clone(),
            self.loc(node),
        );
        let input = helper.param(0);
        for (tag, (arm, field)) in arms.into_iter().zip(fields).enumerate() {
            let Type::Record { shape_id } = arm else {
                unreachable!()
            };
            let value = Expr::RecordGet {
                obj: Box::new(Expr::UnionNarrow {
                    union_id: format!("u{union_id}"),
                    tag,
                    value: Box::new(helper.read(&input)),
                    r#type: Type::Record { shape_id },
                    loc: helper.loc(),
                }),
                shape_id: format!("r{shape_id}"),
                field: field.name,
                r#type: field.r#type,
                loc: helper.loc(),
            };
            let value = self.coerce(value, result.clone(), node)?;
            if tag + 1 == self.unions[union_id].arms.len() {
                helper.function.body.push(Stmt::Return {
                    value: Some(value),
                    loc: helper.loc(),
                });
            } else {
                helper.function.body.push(Stmt::If {
                    cond: Expr::UnionIsTag {
                        union_id: format!("u{union_id}"),
                        tag,
                        negated: false,
                        value: Box::new(helper.read(&input)),
                        r#type: Type::Bool,
                        loc: helper.loc(),
                    },
                    then: vec![Stmt::Return {
                        value: Some(value),
                        loc: helper.loc(),
                    }],
                    else_: None,
                    loc: helper.loc(),
                });
            }
        }
        let callee = self.install_helper(helper.function);
        let value = Expr::Call {
            callee,
            args: vec![obj],
            r#type: result,
            loc: self.loc(node),
        };
        self.narrowed(value, node)
    }
}
