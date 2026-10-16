//! The first native subset of the existing scriptc IR v13 wire contract.
use serde::Serialize;
use std::collections::HashMap;

pub const VERSION: u32 = 13;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Type {
    F64,
    String,
    Bool,
    Void,
    Array {
        elem: &'static Type,
    },
    #[serde(rename = "nullT")]
    Null,
    #[serde(rename = "undefinedT")]
    Undefined,
    Record {
        #[serde(rename = "shapeId", serialize_with = "record_id")]
        shape_id: usize,
    },
    Union {
        #[serde(rename = "unionId", serialize_with = "serialize_union_id")]
        union_id: usize,
    },
}

fn record_id<S: serde::Serializer>(id: &usize, s: S) -> Result<S::Ok, S::Error> {
    s.serialize_str(&format!("r{id}"))
}
fn serialize_union_id<S: serde::Serializer>(id: &usize, s: S) -> Result<S::Ok, S::Error> {
    s.serialize_str(&format!("u{id}"))
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Field {
    pub name: String,
    pub r#type: Type,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Record {
    #[serde(serialize_with = "record_id")]
    pub id: usize,
    pub fields: Vec<Field>,
    pub declared_order: Vec<String>,
}
#[derive(Clone, Debug, Serialize)]
pub struct Union {
    #[serde(serialize_with = "serialize_union_id")]
    pub id: usize,
    pub arms: Vec<Type>,
}
#[derive(Debug, Serialize)]
pub struct FieldInit {
    pub name: String,
    pub value: Expr,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub absent: bool,
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
    pub records: Vec<Record>,
    pub unions: Vec<Union>,
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
    Logical {
        op: String,
        left: Box<Expr>,
        right: Box<Expr>,
        r#type: Type,
        loc: Loc,
    },
    StrEq {
        negated: bool,
        left: Box<Expr>,
        right: Box<Expr>,
        r#type: Type,
        loc: Loc,
    },
    UnionEq {
        union_id: String,
        negated: bool,
        same_value: bool,
        left: Box<Expr>,
        right: Box<Expr>,
        r#type: Type,
        loc: Loc,
    },
    UnitLit {
        unit: &'static str,
        r#type: Type,
        loc: Loc,
    },
    RecordLit {
        fields: Vec<FieldInit>,
        r#type: Type,
        loc: Loc,
    },
    RecordGet {
        obj: Box<Expr>,
        shape_id: String,
        field: String,
        r#type: Type,
        loc: Loc,
    },
    UnionWrap {
        union_id: String,
        tag: usize,
        value: Box<Expr>,
        r#type: Type,
        loc: Loc,
    },
    UnionNarrow {
        union_id: String,
        tag: usize,
        value: Box<Expr>,
        r#type: Type,
        loc: Loc,
    },
    UnionIsTag {
        union_id: String,
        tag: usize,
        negated: bool,
        value: Box<Expr>,
        r#type: Type,
        loc: Loc,
    },
    Ternary {
        cond: Box<Expr>,
        then: Box<Expr>,
        #[serde(rename = "else_")]
        else_: Box<Expr>,
        r#type: Type,
        loc: Loc,
    },
    ArrayLit {
        elems: Vec<Expr>,
        r#type: Type,
        loc: Loc,
    },
    LibCall {
        r#fn: String,
        args: Vec<Expr>,
        r#type: Type,
        loc: Loc,
    },
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
            Self::UnitLit { r#type, .. }
            | Self::Logical { r#type, .. }
            | Self::StrEq { r#type, .. }
            | Self::UnionEq { r#type, .. }
            | Self::RecordLit { r#type, .. }
            | Self::RecordGet { r#type, .. }
            | Self::UnionWrap { r#type, .. }
            | Self::UnionNarrow { r#type, .. }
            | Self::UnionIsTag { r#type, .. }
            | Self::Ternary { r#type, .. }
            | Self::NumLit { r#type, .. }
            | Self::StrLit { r#type, .. }
            | Self::BoolLit { r#type, .. }
            | Self::VarRef { r#type, .. }
            | Self::Bin { r#type, .. }
            | Self::Unary { r#type, .. }
            | Self::Call { r#type, .. }
            | Self::ArrayLit { r#type, .. }
            | Self::LibCall { r#type, .. }
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
    RecordSet {
        obj: Expr,
        shape_id: String,
        field: String,
        value: Expr,
        loc: Loc,
    },
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
    module.validate_layouts()?;
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
        validate_function(function, &functions, module)?;
    }
    Ok(())
}

impl Module {
    pub fn field(&self, ty: Type, name: &str) -> Option<&Field> {
        let Type::Record { shape_id } = ty else {
            return None;
        };
        self.records
            .get(shape_id)?
            .fields
            .iter()
            .find(|f| f.name == name)
    }
    fn valid_type(&self, ty: Type, active: &mut Vec<Type>) -> bool {
        if active.contains(&ty) {
            return false;
        }
        active.push(ty);
        let valid = match ty {
            Type::Void | Type::Null | Type::Undefined => false,
            Type::Array { elem } => matches!(elem, Type::F64 | Type::String | Type::Bool),
            Type::Record { shape_id } => self.records.get(shape_id).is_some_and(|r| {
                r.id == shape_id && r.fields.iter().all(|f| self.valid_type(f.r#type, active))
            }),
            Type::Union { union_id } => self.unions.get(union_id).is_some_and(|u| {
                u.id == union_id
                    && u.arms.len() >= 2
                    && u.arms.iter().all(|arm| {
                        matches!(arm, Type::Null | Type::Undefined)
                            || (!matches!(arm, Type::Union { .. } | Type::Array { .. })
                                && self.valid_type(*arm, active))
                    })
            }),
            _ => true,
        };
        active.pop();
        valid
    }
    fn validate_layouts(&self) -> Result<(), String> {
        for (id, r) in self.records.iter().enumerate() {
            let mut names = r.fields.iter().map(|f| f.name.as_str()).collect::<Vec<_>>();
            if r.id != id
                || !names.windows(2).all(|pair| pair[0] < pair[1])
                || !self.valid_type(Type::Record { shape_id: id }, &mut vec![])
            {
                return Err("invalid/recursive record layout".into());
            }
            names.sort_unstable();
            let mut order = r
                .declared_order
                .iter()
                .map(String::as_str)
                .collect::<Vec<_>>();
            order.sort_unstable();
            if names != order {
                return Err("invalid record declaration order".into());
            }
        }
        for (id, u) in self.unions.iter().enumerate() {
            let mut seen = std::collections::HashSet::new();
            if u.id != id
                || !u.arms.iter().all(|a| seen.insert(*a))
                || !self.valid_type(Type::Union { union_id: id }, &mut vec![])
            {
                return Err("invalid/recursive union layout".into());
            }
        }
        Ok(())
    }
}

fn validate_function(
    f: &Function,
    functions: &HashMap<&str, &Function>,
    module: &Module,
) -> Result<(), String> {
    if f.return_type != Type::Void && !module.valid_type(f.return_type, &mut vec![]) {
        return Err("invalid return layout".into());
    }
    let mut locals = HashMap::new();
    for local in &f.locals {
        let supported = module.valid_type(local.r#type, &mut vec![]);
        if !supported || locals.insert(local.id.as_str(), local).is_some() {
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
        module: &Module,
    ) -> Result<(), String> {
        match e {
            Expr::Logical {
                op,
                left,
                right,
                r#type: Type::Bool,
                ..
            } if op == "&&" || op == "||" => {
                expr(left, locals, initialized, functions, module)?;
                expr(right, locals, initialized, functions, module)?;
                if left.ty() != Type::Bool || right.ty() != Type::Bool {
                    return Err("invalid boolean logical operands".into());
                }
                Ok(())
            }
            Expr::StrEq {
                left,
                right,
                r#type: Type::Bool,
                ..
            } => {
                expr(left, locals, initialized, functions, module)?;
                expr(right, locals, initialized, functions, module)?;
                if left.ty() != Type::String || right.ty() != Type::String {
                    return Err("invalid string equality".into());
                }
                Ok(())
            }
            Expr::UnionEq {
                union_id,
                same_value: false,
                left,
                right,
                r#type: Type::Bool,
                ..
            } => {
                expr(left, locals, initialized, functions, module)?;
                expr(right, locals, initialized, functions, module)?;
                let Type::Union { union_id: id } = left.ty() else {
                    return Err("non-union equality".into());
                };
                if *union_id != format!("u{id}") || left.ty() != right.ty() {
                    return Err("invalid union equality".into());
                }
                Ok(())
            }
            Expr::RecordLit {
                fields,
                r#type: Type::Record { shape_id },
                ..
            } => {
                let record = module.records.get(*shape_id).ok_or("unknown record")?;
                let mut seen = std::collections::HashSet::new();
                if fields.len() != record.fields.len() {
                    return Err("incomplete record literal".into());
                }
                for f in fields {
                    expr(&f.value, locals, initialized, functions, module)?;
                    let field = module
                        .field(
                            Type::Record {
                                shape_id: *shape_id,
                            },
                            &f.name,
                        )
                        .ok_or("unknown record field")?;
                    if !seen.insert(&f.name) || field.r#type != f.value.ty() {
                        return Err("invalid record field initializer".into());
                    }
                    if f.absent
                        && !matches!(&f.value, Expr::UnionWrap { value, .. } if value.ty() == Type::Undefined)
                        && f.value.ty() != Type::Undefined
                    {
                        return Err("invalid absent field".into());
                    }
                }
                Ok(())
            }
            Expr::RecordGet {
                obj,
                shape_id,
                field,
                r#type,
                ..
            } => {
                expr(obj, locals, initialized, functions, module)?;
                let Type::Record { shape_id: id } = obj.ty() else {
                    return Err("non-record receiver".into());
                };
                if *shape_id != format!("r{id}")
                    || module.field(obj.ty(), field).map(|f| f.r#type) != Some(*r#type)
                {
                    return Err("invalid record read".into());
                }
                Ok(())
            }
            Expr::UnionWrap {
                union_id,
                tag,
                value,
                r#type,
                ..
            } => {
                if matches!(value.ty(), Type::Null | Type::Undefined) {
                    if !matches!(
                        value.as_ref(),
                        Expr::UnitLit {
                            unit: "null",
                            r#type: Type::Null,
                            ..
                        } | Expr::UnitLit {
                            unit: "undefined",
                            r#type: Type::Undefined,
                            ..
                        }
                    ) {
                        return Err("unit union payload must be a unit literal".into());
                    }
                } else {
                    expr(value, locals, initialized, functions, module)?;
                }
                let Type::Union { union_id: id } = r#type else {
                    return Err("non-union wrap".into());
                };
                let union = module.unions.get(*id).ok_or("unknown union")?;
                if *union_id != format!("u{id}") || union.arms.get(*tag) != Some(&value.ty()) {
                    return Err("invalid union wrap".into());
                }
                Ok(())
            }
            Expr::UnionNarrow {
                union_id,
                tag,
                value,
                r#type,
                ..
            }
            | Expr::UnionIsTag {
                union_id,
                tag,
                value,
                r#type,
                ..
            } => {
                expr(value, locals, initialized, functions, module)?;
                let Type::Union { union_id: id } = value.ty() else {
                    return Err("non-union extraction".into());
                };
                let union = module.unions.get(id).ok_or("unknown union")?;
                let arm = union.arms.get(*tag).ok_or("invalid union tag")?;
                if matches!(e, Expr::UnionNarrow { .. })
                    && matches!(arm, Type::Null | Type::Undefined)
                {
                    return Err("standalone unit narrowing".into());
                }
                if *union_id != format!("u{id}")
                    || *r#type
                        != if matches!(e, Expr::UnionIsTag { .. }) {
                            Type::Bool
                        } else {
                            *arm
                        }
                {
                    return Err("invalid union extraction type".into());
                }
                Ok(())
            }
            Expr::Ternary {
                cond,
                then,
                else_,
                r#type,
                ..
            } => {
                for value in [cond, then, else_] {
                    expr(value, locals, initialized, functions, module)?;
                }
                if cond.ty() != Type::Bool || then.ty() != *r#type || else_.ty() != *r#type {
                    return Err("invalid conditional types".into());
                }
                Ok(())
            }
            Expr::ArrayLit {
                elems,
                r#type: Type::Array { elem },
                ..
            } => {
                for value in elems {
                    expr(value, locals, initialized, functions, module)?;
                    if value.ty() != **elem {
                        return Err("invalid array element".into());
                    }
                }
                Ok(())
            }
            Expr::LibCall {
                r#fn, args, r#type, ..
            } => {
                let builtin = crate::builtins::by_ir(r#fn).ok_or("unknown native library call")?;
                if *r#type != builtin.result || args.len() != builtin.args.len() {
                    return Err("invalid native library signature".into());
                }
                for (arg, expected) in args.iter().zip(builtin.args) {
                    expr(arg, locals, initialized, functions, module)?;
                    if arg.ty() != *expected {
                        return Err("invalid native library argument".into());
                    }
                }
                Ok(())
            }
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
                expr(left, locals, initialized, functions, module)?;
                expr(right, locals, initialized, functions, module)?;
                let result = match op.as_str() {
                    "+" | "-" | "*" | "/" | "%" | "**" => Type::F64,
                    "<" | "<=" | ">" | ">=" | "===" | "!==" => Type::Bool,
                    _ => return Err("invalid numeric operator".into()),
                };
                let operands = if matches!(op.as_str(), "===" | "!==") {
                    left.ty() == right.ty()
                        && matches!(left.ty(), Type::F64 | Type::Bool | Type::Record { .. })
                } else {
                    left.ty() == Type::F64 && right.ty() == Type::F64
                };
                if !operands || *r#type != result {
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
                expr(operand, locals, initialized, functions, module)?;
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
                    expr(arg, locals, initialized, functions, module)?;
                    if !matches!(arg.ty(), Type::F64 | Type::String | Type::Bool) {
                        return Err("non-primitive console argument".into());
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
                    expr(arg, locals, initialized, functions, module)?;
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
        module: &Module,
    ) -> Result<(), String> {
        for stmt in stmts {
            match stmt {
                Stmt::RecordSet {
                    obj,
                    shape_id,
                    field,
                    value,
                    ..
                } => {
                    expr(obj, locals, initialized, functions, module)?;
                    expr(value, locals, initialized, functions, module)?;
                    let Type::Record { shape_id: id } = obj.ty() else {
                        return Err("non-record assignment".into());
                    };
                    if *shape_id != format!("r{id}")
                        || module.field(obj.ty(), field).map(|f| f.r#type) != Some(value.ty())
                    {
                        return Err("invalid record write".into());
                    }
                }
                Stmt::VarDecl { local_id, init, .. } => {
                    expr(init, locals, initialized, functions, module)?;
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
                    expr(value, locals, initialized, functions, module)?;
                    if !initialized.contains(local_id)
                        || !locals
                            .get(local_id.as_str())
                            .is_some_and(|l| l.mutable && l.r#type == value.ty())
                    {
                        return Err("invalid assignment".into());
                    }
                }
                Stmt::Expression { expr: value, .. } => {
                    expr(value, locals, initialized, functions, module)?
                }
                Stmt::Return { value, .. } => {
                    if let Some(value) = value {
                        expr(value, locals, initialized, functions, module)?;
                    }
                    if value.as_ref().map_or(Type::Void, Expr::ty) != return_type {
                        return Err("invalid return type".into());
                    }
                }
                Stmt::If {
                    cond, then, else_, ..
                } => {
                    expr(cond, locals, initialized, functions, module)?;
                    if cond.ty() != Type::Bool {
                        return Err("non-boolean condition".into());
                    }
                    body(
                        then,
                        locals,
                        &mut initialized.clone(),
                        functions,
                        return_type,
                        module,
                    )?;
                    if let Some(other) = else_ {
                        body(
                            other,
                            locals,
                            &mut initialized.clone(),
                            functions,
                            return_type,
                            module,
                        )?;
                    }
                }
                Stmt::Block { body: stmts, .. } => body(
                    stmts,
                    locals,
                    &mut initialized.clone(),
                    functions,
                    return_type,
                    module,
                )?,
            }
        }
        Ok(())
    }
    if f.return_type != Type::Void && !always_returns(&f.body) {
        return Err("non-void function can fall through".into());
    }
    let mut initialized = f.params.iter().map(|p| p.local_id.clone()).collect();
    body(
        &f.body,
        &locals,
        &mut initialized,
        functions,
        f.return_type,
        module,
    )
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

    fn record_module() -> Module {
        let mut m = callable_module();
        m.functions.truncate(1);
        m.records.push(Record {
            id: 0,
            fields: vec![Field {
                name: "count".into(),
                r#type: Type::F64,
            }],
            declared_order: vec!["count".into()],
        });
        let loc = m.functions[0].loc.clone();
        m.functions[0].body = vec![Stmt::Expression {
            expr: Expr::RecordLit {
                fields: vec![FieldInit {
                    name: "count".into(),
                    value: Expr::NumLit {
                        value: 1.0,
                        spelling: None,
                        r#type: Type::F64,
                        loc: loc.clone(),
                    },
                    absent: false,
                }],
                r#type: Type::Record { shape_id: 0 },
                loc: loc.clone(),
            },
            loc,
        }];
        m
    }

    #[test]
    fn malformed_record_layouts_and_initializers_are_rejected() {
        let mut m = record_module();
        assert!(validate(&m).is_ok());
        m.records[0].fields[0].r#type = Type::Record { shape_id: 0 };
        assert_eq!(validate(&m).unwrap_err(), "invalid/recursive record layout");
        let mut m = record_module();
        m.records[0].declared_order.clear();
        assert_eq!(
            validate(&m).unwrap_err(),
            "invalid record declaration order"
        );
        let mut m = record_module();
        if let Stmt::Expression {
            expr: Expr::RecordLit { fields, .. },
            ..
        } = &mut m.functions[0].body[0]
        {
            fields[0].name = "missing".into();
        }
        assert_eq!(validate(&m).unwrap_err(), "unknown record field");
        let mut m = record_module();
        if let Stmt::Expression {
            expr: Expr::RecordLit { fields, .. },
            ..
        } = &mut m.functions[0].body[0]
        {
            fields[0].absent = true;
        }
        assert_eq!(validate(&m).unwrap_err(), "invalid absent field");
    }

    #[test]
    fn union_payload_types_and_tags_are_validated() {
        let mut m = record_module();
        m.unions.push(Union {
            id: 0,
            arms: vec![Type::F64, Type::Null],
        });
        let loc = m.functions[0].loc.clone();
        let value = Expr::NumLit {
            value: 1.0,
            spelling: None,
            r#type: Type::F64,
            loc: loc.clone(),
        };
        m.functions[0].body = vec![Stmt::Expression {
            expr: Expr::UnionWrap {
                union_id: "u0".into(),
                tag: 0,
                value: Box::new(value),
                r#type: Type::Union { union_id: 0 },
                loc: loc.clone(),
            },
            loc,
        }];
        assert!(validate(&m).is_ok());
        if let Stmt::Expression {
            expr: Expr::UnionWrap { tag, .. },
            ..
        } = &mut m.functions[0].body[0]
        {
            *tag = 1;
        }
        assert_eq!(validate(&m).unwrap_err(), "invalid union wrap");
        m.unions[0].arms.push(Type::Null);
        assert_eq!(validate(&m).unwrap_err(), "invalid/recursive union layout");
    }

    #[test]
    fn unit_and_operator_nodes_follow_the_shared_wire_contract() {
        let mut m = record_module();
        let loc = m.functions[0].loc.clone();
        m.functions[0].body = vec![Stmt::Expression {
            expr: Expr::UnitLit {
                unit: "null",
                r#type: Type::Null,
                loc: loc.clone(),
            },
            loc: loc.clone(),
        }];
        assert_eq!(validate(&m).unwrap_err(), "invalid native expression");
        let make_bool = || {
            Box::new(Expr::BoolLit {
                value: true,
                r#type: Type::Bool,
                loc: loc.clone(),
            })
        };
        m.functions[0].body = vec![Stmt::Expression {
            expr: Expr::Bin {
                op: "&&".into(),
                left: make_bool(),
                right: make_bool(),
                r#type: Type::Bool,
                loc: loc.clone(),
            },
            loc,
        }];
        assert_eq!(validate(&m).unwrap_err(), "invalid numeric operator");
    }

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
            records: vec![],
            unions: vec![],
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
            records: vec![],
            unions: vec![],
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
