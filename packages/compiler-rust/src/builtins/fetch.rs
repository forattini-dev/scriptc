use super::{Builtin, Implementation};
use crate::ir::Type;

pub fn internal() -> Vec<Builtin> {
    vec![
        Builtin {
            ir: "fetch.responseFromStream",
            args: vec![Type::Dyn],
            result: Type::Dyn,
            implementation: Implementation::Emitter("values"),
        },
        Builtin {
            ir: "fetch.responseNew",
            args: vec![Type::Dyn, Type::Dyn],
            result: Type::Dyn,
            implementation: Implementation::Emitter("values"),
        },
    ]
}
