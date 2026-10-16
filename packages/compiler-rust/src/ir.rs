//! The first native subset of the existing scriptc IR v13 wire contract.
use serde::Serialize;
use std::collections::HashMap;

pub const VERSION: u32 = 13;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Type {
    F64,
    String,
    Bool,
    Void,
}

#[derive(Clone, Debug, Serialize)]
pub struct Loc {
    pub file: String,
    pub start: i32,
    pub end: i32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Module {
    pub ir_version: u32,
    pub source_file: String,
    pub functions: Vec<Function>,
    pub entry: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Function {
    pub name: String,
    pub params: Vec<Local>,
    pub return_type: Type,
    pub locals: Vec<Local>,
    pub body: Vec<Stmt>,
    pub loc: Loc,
}

#[derive(Clone, Debug, Serialize)]
pub struct Local {
    pub id: String,
    pub name: String,
    pub r#type: Type,
    pub mutable: bool,
}

#[derive(Debug, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Expr {
    NumLit {
        #[serde(serialize_with = "number")]
        value: f64,
        #[serde(skip_serializing_if = "Option::is_none")]
        spelling: Option<String>,
        r#type: Type,
        loc: Loc,
    },
    StrLit {
        value: String,
        r#type: Type,
        loc: Loc,
    },
    BoolLit {
        value: bool,
        r#type: Type,
        loc: Loc,
    },
    VarRef {
        local_id: String,
        r#type: Type,
        loc: Loc,
    },
    Bin {
        op: String,
        left: Box<Expr>,
        right: Box<Expr>,
        r#type: Type,
        loc: Loc,
    },
    Unary {
        op: String,
        operand: Box<Expr>,
        r#type: Type,
        loc: Loc,
    },
    Intrinsic {
        name: String,
        args: Vec<Expr>,
        r#type: Type,
        loc: Loc,
    },
}

impl Expr {
    pub fn ty(&self) -> Type {
        match self {
            Self::NumLit { r#type, .. }
            | Self::StrLit { r#type, .. }
            | Self::BoolLit { r#type, .. }
            | Self::VarRef { r#type, .. }
            | Self::Bin { r#type, .. }
            | Self::Unary { r#type, .. }
            | Self::Intrinsic { r#type, .. } => *r#type,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Stmt {
    VarDecl {
        local_id: String,
        init: Expr,
        loc: Loc,
    },
    Assign {
        local_id: String,
        value: Expr,
        loc: Loc,
    },
    #[serde(rename = "exprStmt")]
    Expression {
        expr: Expr,
        loc: Loc,
    },
    If {
        cond: Expr,
        then: Vec<Stmt>,
        #[serde(rename = "else_")]
        else_: Option<Vec<Stmt>>,
        loc: Loc,
    },
    Block {
        body: Vec<Stmt>,
        loc: Loc,
    },
}

fn number<S: serde::Serializer>(value: &f64, serializer: S) -> Result<S::Ok, S::Error> {
    use serde::ser::SerializeMap;
    let tag = if value.is_nan() {
        Some("nan")
    } else if *value == f64::INFINITY {
        Some("inf")
    } else if *value == f64::NEG_INFINITY {
        Some("-inf")
    } else if *value == 0.0 && value.is_sign_negative() {
        Some("-0")
    } else {
        None
    };
    if let Some(tag) = tag {
        let mut map = serializer.serialize_map(Some(1))?;
        map.serialize_entry("$nonfinite", tag)?;
        map.end()
    } else {
        serializer.serialize_f64(*value)
    }
}

/// Validate the supported subset before either serialization or emission.
/// Branches receive independent initialization facts; declarations are lexical.
pub fn validate(module: &Module) -> Result<(), String> {
    if module.ir_version != VERSION || module.functions.len() != 1 {
        return Err("invalid native module/version".into());
    }
    let f = &module.functions[0];
    if f.name != module.entry || f.return_type != Type::Void || !f.params.is_empty() {
        return Err("invalid native entry".into());
    }
    let mut locals = HashMap::new();
    for local in &f.locals {
        if local.r#type == Type::Void || locals.insert(local.id.as_str(), local).is_some() {
            return Err("duplicate/void local".into());
        }
    }
    fn expr(
        e: &Expr,
        locals: &HashMap<&str, &Local>,
        initialized: &std::collections::HashSet<String>,
    ) -> Result<(), String> {
        match e {
            Expr::NumLit {
                r#type: Type::F64, ..
            }
            | Expr::StrLit {
                r#type: Type::String,
                ..
            }
            | Expr::BoolLit {
                r#type: Type::Bool, ..
            } => Ok(()),
            Expr::VarRef {
                local_id, r#type, ..
            } if initialized.contains(local_id)
                && locals
                    .get(local_id.as_str())
                    .is_some_and(|l| l.r#type == *r#type) =>
            {
                Ok(())
            }
            Expr::Bin {
                op,
                left,
                right,
                r#type,
                ..
            } => {
                expr(left, locals, initialized)?;
                expr(right, locals, initialized)?;
                let result = match op.as_str() {
                    "+" | "-" | "*" | "/" | "%" | "**" => Type::F64,
                    "<" | "<=" | ">" | ">=" | "===" | "!==" => Type::Bool,
                    _ => return Err("invalid numeric operator".into()),
                };
                if left.ty() != Type::F64 || right.ty() != Type::F64 || *r#type != result {
                    return Err("invalid numeric binary types".into());
                }
                Ok(())
            }
            Expr::Unary {
                op,
                operand,
                r#type,
                ..
            } => {
                expr(operand, locals, initialized)?;
                if (op == "-" && operand.ty() == Type::F64 && *r#type == Type::F64)
                    || (op == "!" && operand.ty() == Type::Bool && *r#type == Type::Bool)
                {
                    Ok(())
                } else {
                    Err("invalid unary types".into())
                }
            }
            Expr::Intrinsic {
                name,
                args,
                r#type: Type::Void,
                ..
            } if name == "console.log" || name == "console.error" => {
                for arg in args {
                    expr(arg, locals, initialized)?;
                    if arg.ty() == Type::Void {
                        return Err("void console argument".into());
                    }
                }
                Ok(())
            }
            _ => Err("invalid native expression".into()),
        }
    }
    fn body(
        stmts: &[Stmt],
        locals: &HashMap<&str, &Local>,
        initialized: &mut std::collections::HashSet<String>,
    ) -> Result<(), String> {
        for stmt in stmts {
            match stmt {
                Stmt::VarDecl { local_id, init, .. } => {
                    expr(init, locals, initialized)?;
                    if initialized.contains(local_id)
                        || !locals
                            .get(local_id.as_str())
                            .is_some_and(|l| l.r#type == init.ty())
                    {
                        return Err("invalid initialization".into());
                    }
                    initialized.insert(local_id.clone());
                }
                Stmt::Assign {
                    local_id, value, ..
                } => {
                    expr(value, locals, initialized)?;
                    if !initialized.contains(local_id)
                        || !locals
                            .get(local_id.as_str())
                            .is_some_and(|l| l.mutable && l.r#type == value.ty())
                    {
                        return Err("invalid assignment".into());
                    }
                }
                Stmt::Expression { expr: value, .. } => expr(value, locals, initialized)?,
                Stmt::If {
                    cond, then, else_, ..
                } => {
                    expr(cond, locals, initialized)?;
                    if cond.ty() != Type::Bool {
                        return Err("non-boolean condition".into());
                    }
                    body(then, locals, &mut initialized.clone())?;
                    if let Some(other) = else_ {
                        body(other, locals, &mut initialized.clone())?;
                    }
                }
                Stmt::Block { body: stmts, .. } => body(stmts, locals, &mut initialized.clone())?,
            }
        }
        Ok(())
    }
    body(&f.body, &locals, &mut Default::default())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn special_numbers_keep_the_existing_ir_encoding() {
        let loc = Loc {
            file: "fixture.ts".into(),
            start: 0,
            end: 1,
        };
        for (value, tag) in [
            (f64::NAN, "nan"),
            (f64::INFINITY, "inf"),
            (f64::NEG_INFINITY, "-inf"),
            (-0.0, "-0"),
        ] {
            let e = Expr::NumLit {
                value,
                spelling: None,
                r#type: Type::F64,
                loc: loc.clone(),
            };
            assert_eq!(serde_json::to_value(e).unwrap()["value"]["$nonfinite"], tag);
        }
    }
    #[test]
    fn validator_rejects_reads_before_initialization() {
        let loc = Loc {
            file: "fixture.ts".into(),
            start: 0,
            end: 1,
        };
        let m = Module {
            ir_version: VERSION,
            source_file: loc.file.clone(),
            entry: "main".into(),
            functions: vec![Function {
                name: "main".into(),
                params: vec![],
                return_type: Type::Void,
                locals: vec![Local {
                    id: "v0".into(),
                    name: "x".into(),
                    r#type: Type::F64,
                    mutable: false,
                }],
                body: vec![Stmt::Expression {
                    expr: Expr::VarRef {
                        local_id: "v0".into(),
                        r#type: Type::F64,
                        loc: loc.clone(),
                    },
                    loc: loc.clone(),
                }],
                loc,
            }],
        };
        assert!(validate(&m).is_err());
    }
}
