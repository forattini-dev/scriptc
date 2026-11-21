//! Local, type-proven normalization while constructing IR. These rules must
//! retain evaluation count and order; owning container views are not scalars.
use super::{Expr, Type};

pub fn scalar_round_trip(value: Expr, target: &Type) -> Expr {
    match value {
        Expr::DynFrom {
            value,
            r#type: Type::Dyn,
            ..
        } if value.ty() == *target
            && matches!(
                target,
                Type::F64 | Type::Bool | Type::String | Type::Null | Type::Undefined
            ) =>
        {
            *value
        }
        value => value,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ir::Loc;

    fn boxed(ty: Type) -> Expr {
        let loc = Loc {
            file: "normalize.ts".into(),
            start: 0,
            end: 1,
        };
        Expr::DynFrom {
            value: Box::new(Expr::LibCall {
                r#fn: "effect".into(),
                args: vec![],
                r#type: ty,
                loc: loc.clone(),
            }),
            r#type: Type::Dyn,
            loc,
        }
    }

    #[test]
    fn scalar_round_trips_keep_the_single_effectful_operand() {
        for ty in [
            Type::F64,
            Type::Bool,
            Type::String,
            Type::Null,
            Type::Undefined,
        ] {
            let normalized = scalar_round_trip(boxed(ty.clone()), &ty);
            assert!(matches!(normalized, Expr::LibCall { ref r#fn, .. } if r#fn == "effect"));
            assert_eq!(normalized.ty(), ty);
        }
    }

    #[test]
    fn different_types_and_owning_views_keep_the_dynamic_boundary() {
        assert!(matches!(
            scalar_round_trip(boxed(Type::F64), &Type::String),
            Expr::DynFrom { .. }
        ));
        for ty in [
            Type::Array {
                elem: Box::new(Type::F64),
            },
            Type::Record { shape_id: 0 },
        ] {
            assert!(matches!(
                scalar_round_trip(boxed(ty.clone()), &ty),
                Expr::DynFrom { .. }
            ));
        }
    }
}
