//! Logical operators select owning operand values through the portable IR.
use super::*;

impl Lowerer<'_> {
    pub(super) fn logical(&mut self, node: Node, op: &str) -> Result<Expr, String> {
        let left = self.condition_value(node.left())?;
        let before = self.var_defined.clone();
        let guard = (op != "??")
            .then(|| self.guarded_var(node.left(), op == "&&"))
            .flatten()
            .or_else(|| {
                let mut source = node.left();
                while source.kind() == SyntaxKind::ParenthesizedExpression {
                    source = source.expression();
                }
                if op == "&&" && source.kind() == SyntaxKind::Identifier {
                    let symbol = self.symbol(source);
                    self.var_types.contains_key(&symbol).then_some(symbol)
                } else {
                    None
                }
            });
        if let Some(symbol) = guard {
            self.var_defined.insert(symbol);
        }
        let right = self.expression(node.right());
        // The right side may not execute. Only facts true on both paths survive.
        self.var_defined = before.intersection(&self.var_defined).copied().collect();
        let right = right?;
        if op != "??" && left.ty() == Type::Bool && right.ty() == Type::Bool {
            return Ok(Expr::Logical {
                op: op.into(),
                left: Box::new(left),
                right: Box::new(right),
                r#type: Type::Bool,
                loc: self.loc(node),
            });
        }
        let left = self.logical_value(left, node.left());
        let right = self.logical_value(right, node.right());
        let result_type =
            if left.ty() == right.ty() && !matches!(left.ty(), Type::Null | Type::Undefined) {
                left.ty()
            } else {
                Type::Dyn
            };
        let left = self.coerce(left, result_type.clone(), node.left())?;
        let right = self.coerce(right, result_type.clone(), node.right())?;
        let local = Local {
            id: format!("logical{}", self.locals.len()),
            name: "logical left operand".into(),
            r#type: result_type.clone(),
            mutable: false,
            boxed: false,
        };
        self.locals.push(local.clone());
        let read = || Expr::VarRef {
            local_id: local.id.clone(),
            r#type: result_type.clone(),
            loc: self.loc(node.left()),
        };
        let cond = if op == "??" {
            Expr::DynTest {
                value: Box::new(self.coerce(read(), Type::Dyn, node.left())?),
                test: "nullish".into(),
                negated: false,
                r#type: Type::Bool,
                loc: self.loc(node.left()),
            }
        } else {
            self.condition(read(), node.left())?
        };
        let (then, else_) = if matches!(op, "&&" | "??") {
            (right, read())
        } else {
            (read(), right)
        };
        Ok(Expr::Sequence {
            stmts: vec![Stmt::VarDecl {
                local_id: local.id,
                init: left,
                loc: self.loc(node.left()),
            }],
            result: Box::new(Expr::Ternary {
                cond: Box::new(cond),
                then: Box::new(then),
                else_: Box::new(else_),
                r#type: result_type.clone(),
                loc: self.loc(node),
            }),
            r#type: result_type,
            loc: self.loc(node),
        })
    }

    fn logical_value(&self, value: Expr, node: Node) -> Expr {
        if value.ty() == Type::Caught {
            return Expr::CaughtToDyn {
                value: Box::new(value),
                r#type: Type::Dyn,
                loc: self.loc(node),
            };
        }
        if value.ty() != Type::Void {
            return value;
        }
        Expr::Sequence {
            stmts: vec![Stmt::Expression {
                expr: value,
                loc: self.loc(node),
            }],
            result: Box::new(Expr::DynFrom {
                value: Box::new(Expr::UnitLit {
                    unit: "undefined",
                    r#type: Type::Undefined,
                    loc: self.loc(node),
                }),
                r#type: Type::Dyn,
                loc: self.loc(node),
            }),
            r#type: Type::Dyn,
            loc: self.loc(node),
        }
    }
}
