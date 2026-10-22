//! Shared contracts for normalized string operations in the native pipeline.
//! Arguments are evaluated before conversion, including unused extra arguments.
use crate::ir::Type;

#[derive(Clone, Copy)]
pub enum Argument {
    Number(f64),
    Text(&'static str),
}

impl Argument {
    pub fn ty(self) -> Type {
        match self {
            Self::Number(_) => Type::F64,
            Self::Text(_) => Type::String,
        }
    }
}

pub struct StringBuiltin {
    pub method: &'static str,
    pub runtime: &'static str,
    pub args: &'static [Argument],
    pub result: Type,
}

use Argument::{Number as N, Text as S};
use Type::{Bool, F64, String as Text};
pub const OPERATIONS: &[StringBuiltin] = &[
    StringBuiltin {
        method: "length",
        runtime: "string_len",
        args: &[],
        result: F64,
    },
    StringBuiltin {
        method: "repeat",
        runtime: "string_repeat",
        args: &[N(f64::NAN)],
        result: Text,
    },
    StringBuiltin {
        method: "slice",
        runtime: "string_slice",
        args: &[N(0.0), N(f64::INFINITY)],
        result: Text,
    },
    StringBuiltin {
        method: "substring",
        runtime: "string_substring",
        args: &[N(0.0), N(f64::INFINITY)],
        result: Text,
    },
    StringBuiltin {
        method: "charAt",
        runtime: "string_char_at",
        args: &[N(0.0)],
        result: Text,
    },
    StringBuiltin {
        method: "charCodeAt",
        runtime: "string_char_code_at",
        args: &[N(0.0)],
        result: F64,
    },
    StringBuiltin {
        method: "indexOf",
        runtime: "string_index_of",
        args: &[S("undefined"), N(0.0)],
        result: F64,
    },
    StringBuiltin {
        method: "includes",
        runtime: "string_includes",
        args: &[S("undefined"), N(0.0)],
        result: Bool,
    },
    StringBuiltin {
        method: "startsWith",
        runtime: "string_starts_with",
        args: &[S("undefined"), N(0.0)],
        result: Bool,
    },
    StringBuiltin {
        method: "endsWith",
        runtime: "string_ends_with",
        args: &[S("undefined"), N(f64::INFINITY)],
        result: Bool,
    },
    StringBuiltin {
        method: "trim",
        runtime: "string_trim",
        args: &[],
        result: Text,
    },
    StringBuiltin {
        method: "trimStart",
        runtime: "string_trim_start",
        args: &[],
        result: Text,
    },
    StringBuiltin {
        method: "trimEnd",
        runtime: "string_trim_end",
        args: &[],
        result: Text,
    },
    StringBuiltin {
        method: "toLowerCase",
        runtime: "string_to_lower_case",
        args: &[],
        result: Text,
    },
    StringBuiltin {
        method: "toUpperCase",
        runtime: "string_to_upper_case",
        args: &[],
        result: Text,
    },
    StringBuiltin {
        method: "isWellFormed",
        runtime: "string_is_well_formed",
        args: &[],
        result: Bool,
    },
    StringBuiltin {
        method: "toWellFormed",
        runtime: "string_to_well_formed",
        args: &[],
        result: Text,
    },
    StringBuiltin {
        method: "padStart",
        runtime: "string_pad_start",
        args: &[N(0.0), S(" ")],
        result: Text,
    },
    StringBuiltin {
        method: "padEnd",
        runtime: "string_pad_end",
        args: &[N(0.0), S(" ")],
        result: Text,
    },
    StringBuiltin {
        method: "replace",
        runtime: "string_replace",
        args: &[S("undefined"), S("undefined")],
        result: Text,
    },
    StringBuiltin {
        method: "replaceAll",
        runtime: "string_replace_all",
        args: &[S("undefined"), S("undefined")],
        result: Text,
    },
];

pub fn by_method(method: &str) -> Option<&'static StringBuiltin> {
    OPERATIONS
        .iter()
        .find(|operation| operation.method == method)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn contracts_are_unique_and_preserve_optional_argument_defaults() {
        let names: std::collections::HashSet<_> = OPERATIONS.iter().map(|v| v.method).collect();
        assert_eq!(names.len(), OPERATIONS.len());
        assert!(matches!(by_method("slice").unwrap().args[1], N(n) if n == f64::INFINITY));
        assert!(matches!(by_method("repeat").unwrap().args[0], N(n) if n.is_nan()));
        assert!(by_method("at").is_none()); // undefined results need a different ABI.
    }
}
