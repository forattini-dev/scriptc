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
    pub params: Vec<Param>,
    pub return_type: Type,
    pub locals: Vec<Local>,
    pub body: Vec<Stmt>,
    pub loc: Loc,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Param {
    pub local_id: String,
    pub name: String,
    pub r#type: Type,
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
    Call {
        callee: String,
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
            | Self::Call { r#type, .. }
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
    Return {
        value: Option<Expr>,
        loc: Loc,
    },
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
    if module.ir_version != VERSION || module.functions.is_empty() {
        return Err("invalid native module/version".into());
    }
    let mut functions = HashMap::new();
    for function in &module.functions {
        if functions.insert(function.name.as_str(), function).is_some() {
            return Err("duplicate function".into());
        }
    }
    let entry = functions
        .get(module.entry.as_str())
        .ok_or("missing entry")?;
    if entry.return_type != Type::Void || !entry.params.is_empty() {
        return Err("invalid native entry".into());
    }
    for function in &module.functions {
        validate_function(function, &functions)?;
    }
    Ok(())
}

fn validate_function(f: &Function, functions: &HashMap<&str, &Function>) -> Result<(), String> {
    let mut locals = HashMap::new();
    for local in &f.locals {
        if local.r#type == Type::Void || locals.insert(local.id.as_str(), local).is_some() {
            return Err("duplicate/void local".into());
        }
    }
    let mut parameter_ids = std::collections::HashSet::new();
    for param in &f.params {
        if !parameter_ids.insert(&param.local_id)
            || !locals
                .get(param.local_id.as_str())
                .is_some_and(|local| local.r#type == param.r#type)
        {
            return Err("parameter requires a unique matching local".into());
        }
    }
    fn expr(
        e: &Expr,
        locals: &HashMap<&str, &Local>,
        initialized: &std::collections::HashSet<String>,
        functions: &HashMap<&str, &Function>,
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
                expr(left, locals, initialized, functions)?;
                expr(right, locals, initialized, functions)?;
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
                expr(operand, locals, initialized, functions)?;
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
                    expr(arg, locals, initialized, functions)?;
                    if arg.ty() == Type::Void {
                        return Err("void console argument".into());
                    }
                }
                Ok(())
            }
            Expr::Call {
                callee,
                args,
                r#type,
                ..
            } => {
                let target = functions.get(callee.as_str()).ok_or("unknown callee")?;
                if args.len() != target.params.len() || *r#type != target.return_type {
                    return Err("invalid call signature".into());
                }
                for (arg, param) in args.iter().zip(&target.params) {
                    expr(arg, locals, initialized, functions)?;
                    if arg.ty() != param.r#type {
                        return Err("invalid call argument".into());
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
        functions: &HashMap<&str, &Function>,
        return_type: Type,
    ) -> Result<(), String> {
        for stmt in stmts {
            match stmt {
                Stmt::VarDecl { local_id, init, .. } => {
                    expr(init, locals, initialized, functions)?;
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
                    expr(value, locals, initialized, functions)?;
                    if !initialized.contains(local_id)
                        || !locals
                            .get(local_id.as_str())
                            .is_some_and(|l| l.mutable && l.r#type == value.ty())
                    {
                        return Err("invalid assignment".into());
                    }
                }
                Stmt::Expression { expr: value, .. } => {
                    expr(value, locals, initialized, functions)?
                }
                Stmt::Return { value, .. } => {
                    if let Some(value) = value {
                        expr(value, locals, initialized, functions)?;
                    }
                    if value.as_ref().map_or(Type::Void, Expr::ty) != return_type {
                        return Err("invalid return type".into());
                    }
                }
                Stmt::If {
                    cond, then, else_, ..
                } => {
                    expr(cond, locals, initialized, functions)?;
                    if cond.ty() != Type::Bool {
                        return Err("non-boolean condition".into());
                    }
                    body(
                        then,
                        locals,
                        &mut initialized.clone(),
                        functions,
                        return_type,
                    )?;
                    if let Some(other) = else_ {
                        body(
                            other,
                            locals,
                            &mut initialized.clone(),
                            functions,
                            return_type,
                        )?;
                    }
                }
                Stmt::Block { body: stmts, .. } => body(
                    stmts,
                    locals,
                    &mut initialized.clone(),
                    functions,
                    return_type,
                )?,
            }
        }
        Ok(())
    }
    if f.return_type != Type::Void && !always_returns(&f.body) {
        return Err("non-void function can fall through".into());
    }
    let mut initialized = f.params.iter().map(|p| p.local_id.clone()).collect();
    body(&f.body, &locals, &mut initialized, functions, f.return_type)
}

pub fn always_returns(stmts: &[Stmt]) -> bool {
    stmts.iter().any(|stmt| match stmt {
        Stmt::Return { .. } => true,
        Stmt::Block { body, .. } => always_returns(body),
        Stmt::If {
            then,
            else_: Some(other),
            ..
        } => always_returns(then) && always_returns(other),
        _ => false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn callable_module() -> Module {
        let loc = Loc {
            file: "fixture.ts".into(),
            start: 0,
            end: 1,
        };
        Module {
            ir_version: VERSION,
            source_file: loc.file.clone(),
            entry: "__main".into(),
            functions: vec![
                Function {
                    name: "__main".into(),
                    params: vec![],
                    return_type: Type::Void,
                    locals: vec![],
                    loc: loc.clone(),
                    body: vec![Stmt::Expression {
                        expr: Expr::Call {
                            callee: "f0".into(),
                            args: vec![Expr::NumLit {
                                value: 1.0,
                                spelling: None,
                                r#type: Type::F64,
                                loc: loc.clone(),
                            }],
                            r#type: Type::F64,
                            loc: loc.clone(),
                        },
                        loc: loc.clone(),
                    }],
                },
                Function {
                    name: "f0".into(),
                    params: vec![Param {
                        local_id: "p0".into(),
                        name: "n".into(),
                        r#type: Type::F64,
                    }],
                    return_type: Type::F64,
                    locals: vec![Local {
                        id: "p0".into(),
                        name: "n".into(),
                        r#type: Type::F64,
                        mutable: true,
                    }],
                    body: vec![Stmt::Return {
                        value: Some(Expr::VarRef {
                            local_id: "p0".into(),
                            r#type: Type::F64,
                            loc: loc.clone(),
                        }),
                        loc: loc.clone(),
                    }],
                    loc,
                },
            ],
        }
    }

    #[test]
    fn parameters_require_the_existing_ir_locals_contract() {
        let mut module = callable_module();
        assert!(validate(&module).is_ok());
        module.functions[1].locals.clear();
        assert_eq!(
            validate(&module).unwrap_err(),
            "parameter requires a unique matching local"
        );
    }

    #[test]
    fn invalid_calls_and_returns_are_rejected_before_emission() {
        let mut module = callable_module();
        if let Stmt::Expression {
            expr: Expr::Call { args, .. },
            ..
        } = &mut module.functions[0].body[0]
        {
            args.clear();
        }
        assert_eq!(validate(&module).unwrap_err(), "invalid call signature");
        let mut module = callable_module();
        if let Stmt::Return { value, .. } = &mut module.functions[1].body[0] {
            *value = None;
        }
        assert_eq!(validate(&module).unwrap_err(), "invalid return type");
        module.functions[1].body.clear();
        assert_eq!(
            validate(&module).unwrap_err(),
            "non-void function can fall through"
        );
    }
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
