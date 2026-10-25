//! Relational operators observe operand values before primitive conversion.
use super::*;

impl Lowerer<'_> {
    pub(super) fn relational(&mut self, node: Node, op: &str) -> Result<Expr, String> {
        let left = self.condition_value(primitives::primitive_source(node.left()))?;
        let right = self.condition_value(primitives::primitive_source(node.right()))?;
        let loc = self.loc(node);
        if left.ty() == Type::F64 && right.ty() == Type::F64 {
            return Ok(Expr::Bin {
                op: op.into(),
                left: Box::new(left),
                right: Box::new(right),
                r#type: Type::Bool,
                loc,
            });
        }
        for ty in [left.ty(), right.ty()] {
            if self.native_type_contains(&ty, |ty| {
                !matches!(
                    ty,
                    Type::F64
                        | Type::String
                        | Type::Bool
                        | Type::Null
                        | Type::Undefined
                        | Type::Symbol
                        | Type::Dyn
                        | Type::Caught
                        | Type::Union { .. }
                )
            }) {
                return Err(self.refuse(
                    node,
                    "relational object ToPrimitive and BigInt are not ported",
                ));
            }
        }
        self.ensure_exception_classes(node)?;
        let capture = |value: Expr, site: Node| {
            if value.ty() == Type::Caught {
                Ok(Expr::CaughtToDyn {
                    value: Box::new(value),
                    r#type: Type::Dyn,
                    loc: self.loc(site),
                })
            } else {
                self.coerce(value, Type::Dyn, site)
            }
        };
        let compare = Expr::LibCall {
            r#fn: "dyn.compare".into(),
            args: vec![capture(left, node.left())?, capture(right, node.right())?],
            r#type: Type::F64,
            loc: loc.clone(),
        };
        Ok(Expr::Bin {
            op: op.into(),
            left: Box::new(compare),
            right: Box::new(Expr::NumLit {
                value: 0.0,
                spelling: None,
                r#type: Type::F64,
                loc: loc.clone(),
            }),
            r#type: Type::Bool,
            loc,
        })
    }
}
