//! The first native subset of the existing scriptc IR v13 wire contract.
use serde::Serialize;
pub(crate) mod bigint;
mod child_process;
mod control_flow;
pub mod record_equivalence;
pub mod record_views;
pub(crate) mod regex_captures;
mod symbol_methods;
mod symbols;
mod walk;
use std::collections::HashMap;
pub use symbol_methods::{SymbolMethod, SymbolMethodKey};
pub(crate) use symbols::well_known_symbol;

pub const VERSION: u32 = 13;

/// Typed Sets have a portable reference ABI, but the shared dynamic value
/// contract cannot box them (including inside a composite or callback ABI).
pub fn contains_set(ty: &Type, records: &[Record], unions: &[Union]) -> bool {
    contains_type(ty, records, unions, |ty| matches!(ty, Type::Set { .. }))
}

pub fn contains_stats(ty: &Type, records: &[Record], unions: &[Union]) -> bool {
    contains_type(ty, records, unions, |ty| *ty == Type::Stats)
}

fn contains_type(
    ty: &Type,
    records: &[Record],
    unions: &[Union],
    predicate: fn(&Type) -> bool,
) -> bool {
    fn visit(
        ty: &Type,
        records: &[Record],
        unions: &[Union],
        seen: &mut std::collections::HashSet<Type>,
        predicate: fn(&Type) -> bool,
    ) -> bool {
        if !seen.insert(ty.clone()) {
            return false;
        }
        if predicate(ty) {
            return true;
        }
        match ty {
            Type::Array { elem } | Type::Set { elem } | Type::Promise { inner: elem } => {
                visit(elem, records, unions, seen, predicate)
            }
            Type::Map { key, value } => {
                visit(key, records, unions, seen, predicate)
                    || visit(value, records, unions, seen, predicate)
            }
            Type::Func { params, ret, .. } => {
                params
                    .iter()
                    .any(|t| visit(t, records, unions, seen, predicate))
                    || visit(ret, records, unions, seen, predicate)
            }
            Type::Record { shape_id } => records.get(*shape_id).is_some_and(|r| {
                r.fields
                    .iter()
                    .any(|f| visit(&f.r#type, records, unions, seen, predicate))
                    || r.index_value
                        .as_ref()
                        .is_some_and(|t| visit(t, records, unions, seen, predicate))
            }),
            Type::Union { union_id } => unions.get(*union_id).is_some_and(|u| {
                u.arms
                    .iter()
                    .any(|t| visit(t, records, unions, seen, predicate))
            }),
            _ => false,
        }
    }
    visit(
        ty,
        records,
        unions,
        &mut std::collections::HashSet::new(),
        predicate,
    )
}

#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Type {
    Func {
        #[serde(flatten, serialize_with = "serialize_function_rest")]
        rest: bool,
        params: Vec<Type>,
        ret: Box<Type>,
    },
    F64,
    Bigint,
    String,
    Bool,
    Regex,
    Symbol,
    Child,
    Stats,
    Bytes {
        elem: String,
    },
    // Owned native tagged value; never an embedded engine handle.
    Dyn,
    Caught,
    Object {
        #[serde(rename = "className")]
        class_name: String,
    },
    Classval {
        #[serde(rename = "className")]
        class_name: String,
    },
    Void,
    Array {
        elem: Box<Type>,
    },
    Set {
        elem: Box<Type>,
    },
    Promise {
        inner: Box<Type>,
    },
    Map {
        key: Box<Type>,
        value: Box<Type>,
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

impl Type {
    /// Element layouts with an owned SameValueZero identity contract.
    pub fn set_element(&self) -> bool {
        matches!(
            self,
            Self::String
                | Self::F64
                | Self::Symbol
                | Self::Dyn
                | Self::Record { .. }
                | Self::Func { .. }
        )
    }
    pub fn bytes() -> Self {
        Self::Bytes { elem: "u8".into() }
    }
}

fn serialize_function_rest<S: serde::Serializer>(
    rest: &bool,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    use serde::ser::SerializeMap;
    let mut map = serializer.serialize_map(Some(if *rest { 2 } else { 0 }))?;
    if *rest {
        map.serialize_entry("rest", &true)?;
        map.serialize_entry("restAbi", "array")?;
    }
    map.end()
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
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub tuple: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub index_value: Option<Type>,
}
#[derive(Clone, Debug, Serialize)]
pub struct Union {
    #[serde(serialize_with = "serialize_union_id")]
    pub id: usize,
    pub arms: Vec<Type>,
}
#[derive(Clone, Debug, Serialize)]
pub struct MapEntry {
    pub key: Expr,
    pub value: Expr,
}

#[derive(Clone, Debug, Serialize)]
pub struct DynamicField {
    pub key: Expr,
    pub value: Expr,
}

#[derive(Clone, Debug, Serialize)]
pub struct FieldInit {
    pub name: String,
    pub value: Expr,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub absent: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub overflow: bool,
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
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub globals: Vec<Global>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub classes: Vec<Class>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Class {
    pub name: String,
    pub js_name: String,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub runtime: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base: Option<String>,
    pub fields: Vec<Field>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub methods: Vec<String>,
    /// Full own non-data surface (methods/accessors), including undemanded bodies.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub method_names: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub symbol_methods: Vec<SymbolMethod>,
    pub loc: Loc,
}

/// Program-lifetime live bindings. Initialization is the first top-level
/// marked assignment in the entry function; all other assignments are writes.
#[derive(Clone, Debug, Serialize)]
pub struct Global {
    pub id: String,
    pub name: String,
    pub r#type: Type,
    pub mutable: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Function {
    #[serde(rename = "async", skip_serializing_if = "std::ops::Not::not")]
    pub is_async: bool,
    #[serde(skip)]
    pub rest: bool,
    pub name: String,
    pub params: Vec<Param>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub captures: Option<Vec<Param>>,
    pub return_type: Type,
    pub locals: Vec<Local>,
    pub body: Vec<Stmt>,
    pub loc: Loc,
}

impl Function {
    /// Caller-visible result; return statements inside an async body still use T.
    pub fn call_result(&self) -> Type {
        if self.is_async {
            Type::Promise {
                inner: Box::new(self.return_type.clone()),
            }
        } else {
            self.return_type.clone()
        }
    }
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
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub boxed: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Expr {
    #[serde(rename = "seqExpr")]
    Sequence {
        stmts: Vec<Stmt>,
        result: Box<Expr>,
        r#type: Type,
        loc: Loc,
    },
    CaughtToDyn {
        value: Box<Expr>,
        r#type: Type,
        loc: Loc,
    },
    CaughtNarrow {
        value: Box<Expr>,
        r#type: Type,
        loc: Loc,
    },
    CaughtTest {
        value: Box<Expr>,
        test: String,
        class_name: String,
        r#type: Type,
        loc: Loc,
    },
    DynFrom {
        value: Box<Expr>,
        r#type: Type,
        loc: Loc,
    },
    DynCheck {
        value: Box<Expr>,
        r#type: Type,
        loc: Loc,
    },
    DynObjLit {
        fields: Vec<DynamicField>,
        r#type: Type,
        loc: Loc,
    },
    DynArrLit {
        elems: Vec<Expr>,
        r#type: Type,
        loc: Loc,
    },
    DynKeyGet {
        value: Box<Expr>,
        key: Box<Expr>,
        r#type: Type,
        loc: Loc,
    },
    DynTest {
        value: Box<Expr>,
        test: String,
        #[serde(skip_serializing_if = "std::ops::Not::not")]
        negated: bool,
        r#type: Type,
        loc: Loc,
    },
    DynScalarEq {
        left: Box<Expr>,
        right: Box<Expr>,
        #[serde(skip_serializing_if = "std::ops::Not::not")]
        negated: bool,
        r#type: Type,
        loc: Loc,
    },
    DynInvoke {
        recv: Box<Expr>,
        method: String,
        callee_name: String,
        args: Vec<Expr>,
        r#type: Type,
        loc: Loc,
    },
    DynCall {
        callee: Box<Expr>,
        callee_name: String,
        args: Vec<Expr>,
        r#type: Type,
        loc: Loc,
    },
    ClassRef {
        class_name: String,
        r#type: Type,
        loc: Loc,
    },
    NewValue {
        callee: Box<Expr>,
        args: Vec<Expr>,
        r#type: Type,
        loc: Loc,
    },
    BytesNew {
        source: Option<Box<Expr>>,
        r#type: Type,
        loc: Loc,
    },
    BytesIntrinsic {
        method: String,
        receiver: Box<Expr>,
        args: Vec<Expr>,
        r#type: Type,
        loc: Loc,
    },
    RegexLit {
        pattern: String,
        flags: String,
        r#type: Type,
        loc: Loc,
    },
    RegexIntrinsic {
        method: String,
        receiver: Box<Expr>,
        args: Vec<Expr>,
        r#type: Type,
        loc: Loc,
    },
    // Retained shared-IR operation, also exercised by validator contract tests.
    #[allow(dead_code)]
    New {
        class_name: String,
        args: Vec<Expr>,
        r#type: Type,
        loc: Loc,
    },
    FieldGet {
        obj: Box<Expr>,
        class_name: String,
        field: String,
        r#type: Type,
        loc: Loc,
    },
    Upcast {
        value: Box<Expr>,
        r#type: Type,
        loc: Loc,
    },
    Downcast {
        value: Box<Expr>,
        r#type: Type,
        loc: Loc,
    },
    VirtualCall {
        class_name: String,
        method: String,
        args: Vec<Expr>,
        r#type: Type,
        loc: Loc,
    },
    InstanceOf {
        value: Box<Expr>,
        class_name: String,
        r#type: Type,
        loc: Loc,
    },
    ArrayGet {
        arr: Box<Expr>,
        index: Box<Expr>,
        r#type: Type,
        loc: Loc,
    },
    MapNew {
        seed: Vec<MapEntry>,
        r#type: Type,
        loc: Loc,
    },
    SetNew {
        #[serde(skip_serializing_if = "Option::is_none")]
        seed: Option<Box<Expr>>,
        r#type: Type,
        loc: Loc,
    },
    SetIntrinsic {
        method: String,
        receiver: Box<Expr>,
        args: Vec<Expr>,
        r#type: Type,
        loc: Loc,
    },
    MapIntrinsic {
        method: String,
        receiver: Box<Expr>,
        args: Vec<Expr>,
        r#type: Type,
        loc: Loc,
    },
    RecordKeyGet {
        obj: Box<Expr>,
        shape_id: String,
        key: Box<Expr>,
        overflow_only: bool,
        r#type: Type,
        loc: Loc,
    },
    #[serde(rename = "arrIntrinsic")]
    ArrayIntrinsic {
        method: String,
        receiver: Box<Expr>,
        args: Vec<Expr>,
        r#type: Type,
        loc: Loc,
    },
    Closure {
        fn_name: String,
        captures: Vec<String>,
        r#type: Type,
        loc: Loc,
    },
    CallValue {
        callee: Box<Expr>,
        args: Vec<Expr>,
        r#type: Type,
        loc: Loc,
    },
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
    #[serde(rename = "strIntrinsic")]
    StringIntrinsic {
        method: String,
        receiver: Box<Expr>,
        args: Vec<Expr>,
        r#type: Type,
        loc: Loc,
    },
    StrConcat {
        left: Box<Expr>,
        right: Box<Expr>,
        r#type: Type,
        loc: Loc,
    },
    ToString {
        operand: Box<Expr>,
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
            Self::CaughtToDyn { r#type, .. }
            | Self::CaughtNarrow { r#type, .. }
            | Self::CaughtTest { r#type, .. } => r#type.clone(),
            Self::DynFrom { r#type, .. }
            | Self::DynCheck { r#type, .. }
            | Self::DynObjLit { r#type, .. }
            | Self::DynArrLit { r#type, .. }
            | Self::DynKeyGet { r#type, .. }
            | Self::DynTest { r#type, .. }
            | Self::DynScalarEq { r#type, .. }
            | Self::DynInvoke { r#type, .. }
            | Self::DynCall { r#type, .. }
            | Self::BytesNew { r#type, .. }
            | Self::BytesIntrinsic { r#type, .. }
            | Self::RegexLit { r#type, .. }
            | Self::RegexIntrinsic { r#type, .. }
            | Self::New { r#type, .. }
            | Self::FieldGet { r#type, .. }
            | Self::Upcast { r#type, .. }
            | Self::Downcast { r#type, .. }
            | Self::VirtualCall { r#type, .. }
            | Self::InstanceOf { r#type, .. }
            | Self::ClassRef { r#type, .. }
            | Self::NewValue { r#type, .. }
            | Self::ArrayGet { r#type, .. }
            | Self::MapNew { r#type, .. }
            | Self::SetNew { r#type, .. }
            | Self::SetIntrinsic { r#type, .. }
            | Self::MapIntrinsic { r#type, .. }
            | Self::RecordKeyGet { r#type, .. }
            | Self::ArrayIntrinsic { r#type, .. }
            | Self::UnitLit { r#type, .. }
            | Self::Closure { r#type, .. }
            | Self::CallValue { r#type, .. }
            | Self::Logical { r#type, .. }
            | Self::StrEq { r#type, .. }
            | Self::StringIntrinsic { r#type, .. }
            | Self::StrConcat { r#type, .. }
            | Self::ToString { r#type, .. }
            | Self::UnionEq { r#type, .. }
            | Self::Sequence { r#type, .. }
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
            | Self::Intrinsic { r#type, .. } => r#type.clone(),
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Stmt {
    Break {
        loc: Loc,
    },
    Continue {
        loc: Loc,
    },
    Throw {
        value: Expr,
        loc: Loc,
    },
    TryCatch {
        try_body: Vec<Stmt>,
        catch_body: Option<Vec<Stmt>>,
        catch_local_id: Option<String>,
        finally_body: Option<Vec<Stmt>>,
        loc: Loc,
    },
    FieldSet {
        obj: Expr,
        class_name: String,
        field: String,
        value: Expr,
        loc: Loc,
    },
    While {
        cond: Expr,
        body: Vec<Stmt>,
        loc: Loc,
    },
    RecordKeySet {
        obj: Expr,
        shape_id: String,
        key: Expr,
        value: Expr,
        overflow_only: bool,
        loc: Loc,
    },
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
        #[serde(skip_serializing_if = "std::ops::Not::not")]
        initializes_global: bool,
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
        if function.name == module.entry && function.reads_receiver() {
            return Err("native entry cannot read a call receiver".into());
        }
        if functions.insert(function.name.as_str(), function).is_some() {
            return Err("duplicate function".into());
        }
    }
    for class in &module.classes {
        let mut names = std::collections::HashSet::new();
        for name in &class.method_names {
            if !names.insert(name)
                || class.runtime
                || name == "constructor"
                || name.starts_with('%')
                || name.contains(':')
            {
                return Err("invalid native method surface".into());
            }
        }
        names.clear();
        for name in &class.methods {
            let method = functions
                .get(format!("%{}.{name}", class.name).as_str())
                .ok_or("missing native method function")?;
            if !names.insert(name)
                || !class.method_names.contains(name)
                || class.runtime
                || name == "constructor"
                || name.starts_with('%')
                || name.contains(':')
                || method
                    .captures
                    .as_ref()
                    .is_some_and(|captures| !captures.is_empty())
                || method.params.first().map(|param| &param.r#type)
                    != Some(&Type::Object {
                        class_name: class.name.clone(),
                    })
            {
                return Err("invalid native method declaration/receiver".into());
            }
            if let Some(base) = class
                .base
                .as_ref()
                .and_then(|base| module.method(base, name))
                && (base.params.iter().skip(1).map(|p| &p.r#type).ne(method
                    .params
                    .iter()
                    .skip(1)
                    .map(|p| &p.r#type))
                    || base.call_result() != method.call_result())
            {
                return Err("incompatible native method override".into());
            }
        }
    }
    symbol_methods::validate(module, &functions)?;
    let entry = functions
        .get(module.entry.as_str())
        .ok_or("missing entry")?;
    if entry.is_async || entry.return_type != Type::Void || !entry.params.is_empty() {
        return Err("invalid native entry".into());
    }
    let mut global_ids = std::collections::HashSet::new();
    for global in &module.globals {
        if !global.id.starts_with("%g.")
            || !global_ids.insert(&global.id)
            || !module.valid_type(global.r#type.clone(), &mut vec![])
            || module.initializer(&global.id).is_none()
        {
            return Err("invalid global storage/initializer".into());
        }
    }
    for function in &module.functions {
        validate_function(function, &functions, module)?;
    }
    Ok(())
}

impl Module {
    pub fn method(&self, class: &str, name: &str) -> Option<&Function> {
        let mut class = self.class(class)?;
        for _ in 0..=self.classes.len() {
            if class.methods.iter().any(|method| method == name) {
                return self
                    .functions
                    .iter()
                    .find(|f| f.name == format!("%{}.{name}", class.name));
            }
            class = self.class(class.base.as_deref()?)?;
        }
        None
    }
    pub fn class(&self, name: &str) -> Option<&Class> {
        self.classes.iter().find(|class| class.name == name)
    }

    pub fn subclass(&self, child: &str, parent: &str) -> bool {
        let mut next = Some(child);
        for _ in 0..=self.classes.len() {
            let Some(name) = next else { return false };
            if name == parent {
                return self.class(name).is_some();
            }
            next = self.class(name).and_then(|class| class.base.as_deref());
        }
        false
    }
    pub fn global(&self, id: &str) -> Option<&Global> {
        self.globals.iter().find(|global| global.id == id)
    }

    pub fn initializer(&self, id: &str) -> Option<&Stmt> {
        self.functions
            .iter()
            .flat_map(|f| &f.body)
            .find(|stmt| matches!(stmt, Stmt::Assign { local_id, initializes_global: true, .. } if local_id == id))
    }

    pub fn initializes(&self, stmt: &Stmt, _function: &Function, id: &str) -> bool {
        self.initializer(id)
            .is_some_and(|first| std::ptr::eq(first, stmt))
    }
    fn lookup_result(&self, value: &Type, result: &Type) -> bool {
        if *value == Type::Dyn {
            return *result == Type::Dyn;
        }
        let Type::Union { union_id } = result else {
            return false;
        };
        let Some(result) = self.unions.get(*union_id) else {
            return false;
        };
        let mut arms = match value {
            Type::Union { union_id } => self.unions[*union_id].arms.clone(),
            value => vec![value.clone()],
        };
        arms.push(Type::Undefined);
        arms.sort_by_key(|a| format!("{a:?}"));
        arms.dedup();
        arms == result.arms
    }
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
        self.valid_type_cached(ty, active, &mut std::collections::HashSet::new())
    }

    fn valid_type_cached(
        &self,
        ty: Type,
        active: &mut Vec<Type>,
        proven: &mut std::collections::HashSet<Type>,
    ) -> bool {
        if proven.contains(&ty) {
            return true;
        }

        if let Some(first) = active.iter().position(|current| *current == ty) {
            // A recursive native layout must cross owning heap storage (or a
            // callable ABI). Union payloads alone would form an infinite Rust
            // value; records and arrays hold traced handles instead.
            return active[first..].iter().any(|edge| {
                matches!(
                    edge,
                    Type::Func { .. }
                        | Type::Record { .. }
                        | Type::Array { .. }
                        | Type::Map { .. }
                        | Type::Promise { .. }
                )
            });
        }
        let identity = ty.clone();
        active.push(ty.clone());
        let valid = match ty {
            Type::Object { class_name } => self.class(&class_name).is_some(),
            Type::Classval { class_name } => self.class(&class_name).is_some_and(|c| !c.runtime),
            Type::Func { params, ret, rest } => {
                (!rest
                    || params
                        .last()
                        .is_some_and(|p| matches!(p, Type::Array { .. })))
                    && params
                        .iter()
                        .all(|p| self.valid_type_cached(p.clone(), active, proven))
                    && (*ret == Type::Void || self.valid_type_cached(*ret, active, proven))
            }
            Type::Void | Type::Null | Type::Undefined | Type::Caught => false,
            Type::Array { elem } => {
                !matches!(*elem, Type::Func { .. } | Type::Stats)
                    && self.valid_type_cached(*elem, active, proven)
            }
            Type::Bytes { elem } => elem == "u8",
            Type::Promise { inner } => {
                *inner == Type::Void || self.valid_type_cached(*inner, active, proven)
            }
            Type::Set { elem } => {
                elem.set_element() && self.valid_type_cached(*elem, active, proven)
            }
            Type::Map { key, value } => {
                matches!(*key, Type::F64 | Type::String | Type::Dyn)
                    && !matches!(*value, Type::Func { .. } | Type::Map { .. } | Type::Stats)
                    && !matches!(*value, Type::Bytes { .. })
                    && self.valid_type_cached(*value, active, proven)
            }
            Type::Record { shape_id } => self.records.get(shape_id).is_some_and(|r| {
                r.id == shape_id
                    && r.index_value.as_ref().is_none_or(|v| {
                        r.fields.is_empty()
                            && !matches!(v, Type::Func { .. } | Type::Map { .. } | Type::Stats)
                            && self.valid_type_cached(v.clone(), active, proven)
                    })
                    && r.fields
                        .iter()
                        .all(|f| self.valid_type_cached(f.r#type.clone(), active, proven))
            }),
            Type::Union { union_id } => self.unions.get(union_id).is_some_and(|u| {
                u.id == union_id
                    && u.arms.len() >= 2
                    && (!u.arms.iter().any(|a| matches!(a, Type::Set { .. }))
                        || (u
                            .arms
                            .iter()
                            .filter(|a| matches!(a, Type::Set { .. }))
                            .count()
                            == 1
                            && u.arms.iter().all(|a| {
                                matches!(a, Type::Set { .. } | Type::Null | Type::Undefined)
                            })))
                    && u.arms
                        .iter()
                        .filter(|a| matches!(a, Type::Object { .. }))
                        .count()
                        <= 1
                    && u.arms.iter().all(|arm| {
                        matches!(arm, Type::Null | Type::Undefined)
                            || (!matches!(arm, Type::Union { .. } | Type::Map { .. } | Type::Stats)
                                && self.valid_type_cached(arm.clone(), active, proven))
                    })
            }),
            _ => true,
        };
        active.pop();
        if valid {
            proven.insert(identity);
        }
        valid
    }
    /// Runtime Error headers are inherited only along the Error chain.
    pub fn class_header_len(&self, class: &Class) -> usize {
        if self.subclass(&class.name, "%Error") {
            error_fields().len()
        } else {
            0
        }
    }

    fn validate_layouts(&self) -> Result<(), String> {
        let mut proven = std::collections::HashSet::new();
        let mut names = std::collections::HashSet::new();
        for class in &self.classes {
            if !names.insert(&class.name) {
                return Err("duplicate class".into());
            }
            let header = error_fields();
            let builtin = matches!(
                class.name.as_str(),
                "%Error" | "%TypeError" | "%RangeError" | "%SyntaxError"
            );
            let header_len = self.class_header_len(class);
            if (header_len != 0 && !class.fields.starts_with(&header)) || class.runtime != builtin
                || (class.name == "%Error" && class.base.is_some())
                || (builtin && class.name != "%Error" && class.base.as_deref() != Some("%Error"))
                || (builtin && class.fields.len() != header.len())
                || !class.fields.iter().skip(header_len).all(|field| field.r#type == Type::Dyn || matches!(&field.r#type, Type::Union { union_id } if self.unions.get(*union_id).is_some_and(|u| u.arms.contains(&Type::Undefined)))) {
                return Err("invalid native class/header/slot".into());
            }
            if let Some(base) = &class.base {
                let base = self.class(base).ok_or("unknown class base")?;
                if self.subclass(&base.name, &class.name) || !class.fields.starts_with(&base.fields)
                {
                    return Err("invalid class inheritance/prefix".into());
                }
            }
            let mut fields = std::collections::HashSet::new();
            for field in &class.fields {
                let mut current = Some(class);
                for _ in 0..=self.classes.len() {
                    let Some(owner) = current else { break };
                    if owner.method_names.contains(&field.name) {
                        return Err("native field shadows a method surface".into());
                    }
                    current = owner.base.as_deref().and_then(|base| self.class(base));
                }
            }
            if !class.fields.iter().enumerate().all(|(i, field)| {
                fields.insert(&field.name)
                    && (i < header_len
                        || (!field.name.starts_with('%')
                            && !matches!(field.r#type, Type::Func { .. })
                            && self.valid_type_cached(
                                field.r#type.clone(),
                                &mut vec![],
                                &mut proven,
                            )))
            }) {
                return Err("invalid class field layout".into());
            }
        }
        for (id, r) in self.records.iter().enumerate() {
            let mut names = r.fields.iter().map(|f| f.name.as_str()).collect::<Vec<_>>();
            if r.id != id
                || !names.windows(2).all(|pair| pair[0] < pair[1])
                || !self.valid_type_cached(Type::Record { shape_id: id }, &mut vec![], &mut proven)
            {
                return Err(format!("invalid/recursive record layout r{id}: {r:?}"));
            }
            if r.tuple
                && (r.index_value.is_some()
                    || (0..r.fields.len())
                        .any(|index| !names.contains(&index.to_string().as_str())))
            {
                return Err("invalid tuple positions".into());
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
                || !u.arms.iter().all(|a| seen.insert(a.clone()))
                || !self.valid_type_cached(Type::Union { union_id: id }, &mut vec![], &mut proven)
            {
                return Err("invalid/recursive union layout".into());
            }
        }
        Ok(())
    }
}

pub fn error_fields() -> Vec<Field> {
    [
        ("name", Type::String),
        ("message", Type::String),
        ("%code", Type::String),
        ("%hasCause", Type::Bool),
        ("%cause", Type::Dyn),
    ]
    .into_iter()
    .map(|(name, r#type)| Field {
        name: name.into(),
        r#type,
    })
    .collect()
}

fn validate_function(
    f: &Function,
    functions: &HashMap<&str, &Function>,
    module: &Module,
) -> Result<(), String> {
    if f.rest
        && !f
            .params
            .last()
            .is_some_and(|p| matches!(p.r#type, Type::Array { .. }))
    {
        return Err("rest function needs a trailing native array".into());
    }
    if f.is_async && matches!(f.return_type, Type::Promise { .. }) {
        return Err("nested async body Promise return requires adoption lowering".into());
    }
    if f.return_type != Type::Void && !module.valid_type(f.return_type.clone(), &mut vec![]) {
        return Err("invalid return layout".into());
    }
    let mut locals = HashMap::new();
    for local in &f.locals {
        let supported =
            local.r#type == Type::Caught || module.valid_type(local.r#type.clone(), &mut vec![]);
        if !supported
            || module.global(&local.id).is_some()
            || locals.insert(local.id.as_str(), local).is_some()
        {
            return Err("duplicate/void local".into());
        }
    }
    let mut parameter_ids = std::collections::HashSet::new();
    for param in f.params.iter().chain(f.captures.iter().flatten()) {
        if param.r#type == Type::Caught {
            return Err("caught slots cannot cross the function ABI".into());
        }
        if !parameter_ids.insert(&param.local_id)
            || !locals
                .get(param.local_id.as_str())
                .is_some_and(|local| local.r#type == param.r#type)
        {
            return Err("parameter requires a unique matching local".into());
        }
    }
    for capture in f.captures.iter().flatten() {
        if !locals[capture.local_id.as_str()].boxed {
            return Err("capture requires a boxed local".into());
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
            Expr::Sequence {
                stmts,
                result,
                r#type,
                ..
            } => {
                fn allowed(stmts: &[Stmt]) -> bool {
                    stmts.iter().all(|stmt| match stmt {
                        Stmt::VarDecl { .. } | Stmt::RecordSet { .. } | Stmt::Expression { .. } => {
                            true
                        }
                        Stmt::If { then, else_, .. } => {
                            allowed(then) && else_.as_ref().is_none_or(|other| allowed(other))
                        }
                        Stmt::Block { body, .. } => allowed(body),
                        Stmt::Assign {
                            initializes_global: false,
                            ..
                        } => true,
                        Stmt::While { body, .. } => allowed(body),
                        _ => false,
                    })
                }
                if !allowed(stmts) {
                    return Err("invalid expression sequence statement".into());
                }
                let mut scope = initialized.clone();
                body(
                    stmts,
                    locals,
                    &mut scope,
                    functions,
                    Type::Void,
                    module,
                    None,
                )?;
                expr(result, locals, &scope, functions, module)?;
                if result.ty() != *r#type {
                    return Err("invalid expression sequence result".into());
                }
                Ok(())
            }
            Expr::CaughtToDyn {
                value,
                r#type: Type::Dyn,
                ..
            } => {
                expr(value, locals, initialized, functions, module)?;
                if value.ty() != Type::Caught {
                    return Err("caught conversion needs caught storage".into());
                }
                Ok(())
            }
            Expr::CaughtNarrow { value, r#type, .. } => {
                expr(value, locals, initialized, functions, module)?;
                if value.ty() != Type::Caught
                    || !matches!(
                        r#type,
                        Type::F64 | Type::String | Type::Bool | Type::Object { .. }
                    )
                    || !module.valid_type(r#type.clone(), &mut vec![])
                {
                    return Err("invalid caught extraction".into());
                }
                Ok(())
            }
            Expr::CaughtTest {
                value,
                test,
                class_name,
                r#type: Type::Bool,
                ..
            } => {
                expr(value, locals, initialized, functions, module)?;
                if value.ty() != Type::Caught
                    || test != "instanceof"
                    || module.class(class_name).is_none()
                {
                    return Err("invalid caught hierarchy test".into());
                }
                Ok(())
            }
            Expr::DynFrom { value, r#type, .. } => {
                if contains_stats(&value.ty(), &module.records, &module.unions) {
                    return Err("Stats erasure is not in the shared native value contract".into());
                }
                if symbol_methods::contains_symbol_methods(&value.ty(), module) {
                    return Err(
                        "erasing symbol methods requires a native descriptor contract".into(),
                    );
                }
                if contains_set(&value.ty(), &module.records, &module.unions) {
                    return Err("Set erasure is not in the shared native value contract".into());
                }
                if let Expr::UnitLit { unit, r#type, .. } = &**value
                    && !matches!(
                        (*unit, r#type),
                        ("undefined", Type::Undefined) | ("null", Type::Null)
                    )
                {
                    return Err("invalid native boxed unit".into());
                }
                if !matches!(&**value, Expr::UnitLit { .. }) {
                    expr(value, locals, initialized, functions, module)?;
                }
                if *r#type == Type::Dyn && !matches!(value.ty(), Type::Void | Type::Caught) {
                    Ok(())
                } else {
                    Err("invalid native value boxing".into())
                }
            }
            Expr::DynCheck { value, r#type, .. } => {
                if contains_stats(r#type, &module.records, &module.unions) {
                    return Err(
                        "Stats extraction is not in the shared native value contract".into(),
                    );
                }
                expr(value, locals, initialized, functions, module)?;
                if value.ty() == Type::Dyn
                    && *r#type != Type::Dyn
                    && module.valid_type(r#type.clone(), &mut vec![])
                {
                    Ok(())
                } else {
                    Err("invalid native value check".into())
                }
            }
            Expr::DynObjLit { fields, r#type, .. } => {
                for f in fields {
                    expr(&f.key, locals, initialized, functions, module)?;
                    expr(&f.value, locals, initialized, functions, module)?;
                }
                if *r#type == Type::Dyn
                    && fields
                        .iter()
                        .all(|f| f.key.ty() == Type::String && f.value.ty() == Type::Dyn)
                {
                    Ok(())
                } else {
                    Err("invalid native object value".into())
                }
            }
            Expr::DynArrLit { elems, r#type, .. } => {
                for e in elems {
                    expr(e, locals, initialized, functions, module)?;
                }
                if *r#type == Type::Dyn && elems.iter().all(|e| e.ty() == Type::Dyn) {
                    Ok(())
                } else {
                    Err("invalid native array value".into())
                }
            }
            Expr::DynKeyGet {
                value, key, r#type, ..
            } => {
                expr(value, locals, initialized, functions, module)?;
                expr(key, locals, initialized, functions, module)?;
                if value.ty() == Type::Dyn && key.ty() == Type::String && *r#type == Type::Dyn {
                    Ok(())
                } else {
                    Err("invalid native value member read".into())
                }
            }
            Expr::DynTest {
                value,
                test,
                r#type,
                ..
            } => {
                expr(value, locals, initialized, functions, module)?;
                if value.ty() == Type::Dyn
                    && *r#type == Type::Bool
                    && matches!(
                        test.as_str(),
                        "bigint"
                            | "string"
                            | "symbol"
                            | "number"
                            | "boolean"
                            | "undefined"
                            | "null"
                            | "nullish"
                            | "object"
                            | "array"
                            | "function"
                            | "truthy"
                    )
                {
                    Ok(())
                } else {
                    Err("invalid native value test".into())
                }
            }
            Expr::DynScalarEq {
                left,
                right,
                r#type,
                ..
            } => {
                expr(left, locals, initialized, functions, module)?;
                expr(right, locals, initialized, functions, module)?;
                if left.ty() == Type::Dyn && right.ty() == Type::Dyn && *r#type == Type::Bool {
                    Ok(())
                } else {
                    Err("invalid native value equality".into())
                }
            }
            Expr::DynInvoke {
                recv, args, r#type, ..
            } => {
                expr(recv, locals, initialized, functions, module)?;
                for arg in args {
                    expr(arg, locals, initialized, functions, module)?;
                }
                if recv.ty() == Type::Dyn
                    && args.iter().all(|a| a.ty() == Type::Dyn)
                    && *r#type == Type::Dyn
                {
                    Ok(())
                } else {
                    Err("invalid native method invocation".into())
                }
            }
            Expr::DynCall {
                callee,
                args,
                r#type,
                ..
            } => {
                expr(callee, locals, initialized, functions, module)?;
                for arg in args {
                    expr(arg, locals, initialized, functions, module)?;
                }
                if callee.ty() == Type::Dyn
                    && args.iter().all(|a| a.ty() == Type::Dyn)
                    && *r#type == Type::Dyn
                {
                    Ok(())
                } else {
                    Err("invalid native value call".into())
                }
            }

            Expr::LibCall {
                r#fn, args, r#type, ..
            } if r#fn.starts_with("bigint.") => {
                for arg in args {
                    expr(arg, locals, initialized, functions, module)?;
                }
                let Some((types, result, _)) = bigint::signature(r#fn) else {
                    return Err("unknown BigInt operation".into());
                };
                if args.iter().map(Expr::ty).collect::<Vec<_>>() == types && *r#type == result {
                    Ok(())
                } else {
                    Err("invalid BigInt ABI".into())
                }
            }
            Expr::LibCall {
                r#fn, args, r#type, ..
            } if r#fn.starts_with("sym.")
                || matches!(r#fn.as_str(), "dyn.typeof" | "dyn.stringConstructor") =>
            {
                for arg in args {
                    expr(arg, locals, initialized, functions, module)?;
                }
                let arg_types = args.iter().map(Expr::ty).collect::<Vec<_>>();
                let valid = match r#fn.as_str() {
                    operation if well_known_symbol(operation).is_some() => {
                        arg_types.is_empty() && *r#type == Type::Symbol
                    }
                    "sym.newAnon" => arg_types.is_empty() && *r#type == Type::Symbol,
                    "sym.new" | "sym.for" => arg_types == [Type::String] && *r#type == Type::Symbol,
                    "sym.toString" => arg_types == [Type::Symbol] && *r#type == Type::String,
                    "dyn.typeof" | "dyn.stringConstructor" => {
                        arg_types == [Type::Dyn] && *r#type == Type::String
                    }
                    "sym.desc" | "sym.keyFor" => {
                        arg_types == [Type::Symbol]
                            && matches!(r#type, Type::Union { union_id } if module.unions.get(*union_id).is_some_and(|u| u.arms.len()==2 && u.arms.contains(&Type::String) && u.arms.contains(&Type::Undefined)))
                    }
                    _ => false,
                };
                if valid {
                    Ok(())
                } else {
                    Err("invalid native symbol/typeof operation".into())
                }
            }
            Expr::LibCall {
                r#fn, args, r#type, ..
            } if r#fn == "regex.new" => {
                for arg in args {
                    expr(arg, locals, initialized, functions, module)?;
                }
                if args.len() == 2
                    && args.iter().all(|a| a.ty() == Type::String)
                    && *r#type == Type::Regex
                {
                    Ok(())
                } else {
                    Err("invalid native regex constructor".into())
                }
            }
            Expr::BytesNew { source, r#type, .. } => {
                if *r#type != Type::bytes() {
                    return Err("invalid native bytes type".into());
                }
                if let Some(source) = source {
                    expr(source, locals, initialized, functions, module)?;
                    if source.ty() != Type::F64
                        && source.ty() != Type::bytes()
                        && source.ty()
                            != (Type::Array {
                                elem: Box::new(Type::F64),
                            })
                    {
                        return Err("invalid native bytes source".into());
                    }
                }
                Ok(())
            }
            Expr::BytesIntrinsic {
                method,
                receiver,
                args,
                r#type,
                ..
            } => {
                expr(receiver, locals, initialized, functions, module)?;
                for arg in args {
                    expr(arg, locals, initialized, functions, module)?;
                }
                let valid = receiver.ty() == Type::bytes()
                    && match method.as_str() {
                        "length" | "byteLength" | "byteOffset" => {
                            args.is_empty() && *r#type == Type::F64
                        }
                        "get" => {
                            args.len() == 1 && args[0].ty() == Type::F64 && *r#type == Type::F64
                        }
                        "join" => {
                            args.len() == 1
                                && args[0].ty() == Type::String
                                && *r#type == Type::String
                        }
                        "slice" | "subarray" => {
                            args.len() <= 2
                                && args.iter().all(|a| a.ty() == Type::F64)
                                && *r#type == Type::bytes()
                        }
                        "setFrom" => {
                            (args.len() == 1 || args.len() == 2)
                                && args[0].ty() == Type::bytes()
                                && args.get(1).is_none_or(|a| a.ty() == Type::F64)
                                && *r#type == Type::Void
                        }
                        _ => false,
                    };
                if valid {
                    Ok(())
                } else {
                    Err("invalid native bytes operation".into())
                }
            }
            Expr::RegexLit {
                flags,
                r#type: Type::Regex,
                ..
            } => {
                let mut seen = std::collections::HashSet::new();
                if flags
                    .chars()
                    .all(|f| "gimsuy".contains(f) && seen.insert(f))
                {
                    Ok(())
                } else {
                    Err("invalid native regex flags".into())
                }
            }
            Expr::RegexIntrinsic {
                method,
                receiver,
                args,
                r#type,
                ..
            } => {
                expr(receiver, locals, initialized, functions, module)?;
                for arg in args {
                    expr(arg, locals, initialized, functions, module)?;
                }
                let valid = if matches!(method.as_str(), "replace" | "replaceAll") {
                    receiver.ty() == Type::String
                        && args.len() == 2
                        && args[0].ty() == Type::Regex
                        && args[1].ty() == Type::String
                        && *r#type == Type::String
                } else {
                    receiver.ty() == Type::Regex
                        && match method.as_str() {
                            "test" => {
                                args.len() == 1
                                    && args[0].ty() == Type::String
                                    && *r#type == Type::Bool
                            }
                            "exec" => {
                                args.len() == 1
                                    && args[0].ty() == Type::String
                                    && regex_captures::exec_layout(module, r#type).is_some()
                            }
                            "source" | "flags" => args.is_empty() && *r#type == Type::String,
                            "lastIndex" => args.is_empty() && *r#type == Type::F64,
                            "setLastIndex" => {
                                args.len() == 1 && args[0].ty() == Type::F64 && *r#type == Type::F64
                            }
                            _ => false,
                        }
                };
                if valid {
                    Ok(())
                } else {
                    Err("invalid native regex operation".into())
                }
            }
            Expr::ClassRef {
                class_name, r#type, ..
            } => {
                let ctor = functions.get(format!("%{class_name}.constructor").as_str());
                if *r#type
                    != (Type::Classval {
                        class_name: class_name.clone(),
                    })
                    || !module
                        .class(class_name)
                        .is_some_and(|c| !c.runtime && !c.js_name.is_empty())
                    || !ctor.is_some_and(|f| {
                        !f.is_async
                            && f.return_type == Type::Void
                            && f.captures.is_none()
                            && f.params.first().map(|p| &p.r#type)
                                == Some(&Type::Object {
                                    class_name: class_name.clone(),
                                })
                    })
                {
                    return Err("invalid native class value".into());
                }
                Ok(())
            }
            Expr::New { args, r#type, .. } | Expr::NewValue { args, r#type, .. } => {
                let Type::Object { class_name } = r#type else {
                    return Err("native construction needs an object result".into());
                };
                match e {
                    Expr::New {
                        class_name: actual, ..
                    } if actual == class_name => {}
                    Expr::NewValue { callee, .. } => {
                        expr(callee, locals, initialized, functions, module)?;
                        if callee.ty()
                            != (Type::Classval {
                                class_name: class_name.clone(),
                            })
                        {
                            return Err("native constructor value has a different class".into());
                        }
                    }
                    _ => return Err("invalid native construction identity".into()),
                }
                let ctor = functions
                    .get(format!("%{class_name}.constructor").as_str())
                    .ok_or("missing native constructor")?;
                let object = Type::Object {
                    class_name: class_name.clone(),
                };
                if module.class(class_name).is_none()
                    || *r#type != object
                    || ctor.is_async
                    || ctor.return_type != Type::Void
                    || ctor.captures.is_some()
                    || ctor.params.len() != args.len() + 1
                    || ctor.params.first().map(|p| &p.r#type) != Some(&object)
                {
                    return Err("invalid native constructor ABI".into());
                }
                for (arg, param) in args.iter().zip(ctor.params.iter().skip(1)) {
                    expr(arg, locals, initialized, functions, module)?;
                    if arg.ty() != param.r#type {
                        return Err("invalid native constructor argument".into());
                    }
                }
                Ok(())
            }
            Expr::FieldGet {
                obj,
                class_name,
                field,
                r#type,
                ..
            } => {
                expr(obj, locals, initialized, functions, module)?;
                if matches!(field.as_str(), "%code" | "%hasCause" | "%cause")
                    || obj.ty()
                        != (Type::Object {
                            class_name: class_name.clone(),
                        })
                    || !module.class(class_name).is_some_and(|c| {
                        c.fields
                            .iter()
                            .any(|f| f.name == *field && f.r#type == *r#type)
                    })
                {
                    return Err("invalid native field read".into());
                }
                Ok(())
            }
            Expr::Upcast {
                value,
                r#type: Type::Object { class_name: parent },
                ..
            } => {
                expr(value, locals, initialized, functions, module)?;
                if !matches!(value.ty(), Type::Object { class_name: child } if child != *parent && module.subclass(&child, parent))
                {
                    return Err("invalid native upcast".into());
                }
                Ok(())
            }
            Expr::Downcast {
                value,
                r#type: Type::Object { class_name: child },
                ..
            } => {
                expr(value, locals, initialized, functions, module)?;
                if !matches!(value.ty(), Type::Object { class_name: parent } if parent != *child && module.subclass(child, &parent))
                {
                    return Err("invalid native downcast".into());
                }
                Ok(())
            }
            Expr::VirtualCall {
                class_name,
                method,
                args,
                r#type,
                ..
            } => {
                for arg in args {
                    expr(arg, locals, initialized, functions, module)?;
                }
                let target = module
                    .method(class_name, method)
                    .ok_or("unknown native virtual method")?;
                if args.first().map(Expr::ty)
                    != Some(Type::Object {
                        class_name: class_name.clone(),
                    })
                    || args.len() != target.params.len()
                    || *r#type != target.call_result()
                    || args.iter().skip(1).map(Expr::ty).ne(target
                        .params
                        .iter()
                        .skip(1)
                        .map(|p| p.r#type.clone()))
                    || !module.classes.iter().any(|c| {
                        c.name != *class_name
                            && module.subclass(&c.name, class_name)
                            && c.methods.contains(method)
                    })
                {
                    return Err("invalid native virtual call ABI/override".into());
                }
                Ok(())
            }
            Expr::InstanceOf {
                value,
                class_name,
                r#type: Type::Bool,
                ..
            } => {
                expr(value, locals, initialized, functions, module)?;
                if !matches!(value.ty(), Type::Object { .. }) || module.class(class_name).is_none()
                {
                    return Err("invalid native instanceof".into());
                }
                Ok(())
            }
            Expr::LibCall {
                r#fn, args, r#type, ..
            } if matches!(r#fn.as_str(), "dyn.classInstanceof" | "dyn.errInstanceof") => {
                for arg in args {
                    expr(arg, locals, initialized, functions, module)?;
                }
                if *r#type != Type::Bool
                    || args.len() != 2
                    || args[0].ty() != Type::Dyn
                    || !matches!(&args[1], Expr::StrLit { value, .. } if module.class(value).is_some() && (r#fn != "dyn.errInstanceof" || module.subclass(value, "%Error")))
                {
                    return Err("invalid native erased instanceof".into());
                }
                Ok(())
            }
            Expr::LibCall {
                r#fn, args, r#type, ..
            } if r#fn.starts_with("error.") => {
                for arg in args {
                    expr(arg, locals, initialized, functions, module)?;
                }
                let builtin = |ty: Type| matches!(ty, Type::Object { class_name } if matches!(class_name.as_str(), "%Error" | "%TypeError" | "%RangeError" | "%SyntaxError") && module.class(&class_name).is_some_and(|c| c.runtime));
                let valid = match r#fn.as_str() {
                    "error.new" => {
                        args.len() == 1 && args[0].ty() == Type::String && builtin(r#type.clone())
                    }
                    "error.ctor" => {
                        args.len() == 2
                            && builtin(args[0].ty())
                            && args[1].ty() == Type::String
                            && *r#type == Type::Void
                    }
                    "error.toString" => {
                        args.len() == 1
                            && args[0].ty()
                                == (Type::Object {
                                    class_name: "%Error".into(),
                                })
                            && *r#type == Type::String
                    }
                    _ => false,
                };
                if valid {
                    Ok(())
                } else {
                    Err("invalid native Error operation".into())
                }
            }
            Expr::ArrayGet {
                arr, index, r#type, ..
            } => {
                expr(arr, locals, initialized, functions, module)?;
                expr(index, locals, initialized, functions, module)?;
                if !matches!(arr.ty(), Type::Array { elem } if *elem == *r#type)
                    || index.ty() != Type::F64
                {
                    return Err("invalid array read".into());
                }
                Ok(())
            }
            Expr::MapNew {
                seed,
                r#type: Type::Map { key, value },
                ..
            } => {
                if !module.valid_type(e.ty(), &mut vec![]) {
                    return Err("invalid Map layout".into());
                }
                for pair in seed {
                    expr(&pair.key, locals, initialized, functions, module)?;
                    expr(&pair.value, locals, initialized, functions, module)?;
                    if pair.key.ty() != **key || pair.value.ty() != **value {
                        return Err("invalid Map seed".into());
                    }
                }
                Ok(())
            }
            Expr::MapIntrinsic {
                receiver,
                args,
                method,
                r#type,
                ..
            } => {
                expr(receiver, locals, initialized, functions, module)?;
                for arg in args {
                    expr(arg, locals, initialized, functions, module)?;
                }
                let Type::Map { key, value } = receiver.ty() else {
                    return Err("non-Map receiver".into());
                };
                let valid = match method.as_str() {
                    "get" => {
                        args.len() == 1
                            && args[0].ty() == *key
                            && module.lookup_result(&value, r#type)
                    }
                    "has" | "delete" => {
                        args.len() == 1 && args[0].ty() == *key && *r#type == Type::Bool
                    }
                    "set" => {
                        args.len() == 2
                            && args[0].ty() == *key
                            && args[1].ty() == *value
                            && *r#type == Type::Void
                    }
                    "size" => args.is_empty() && *r#type == Type::F64,
                    "clear" => args.is_empty() && *r#type == Type::Void,
                    _ => false,
                };
                if !valid {
                    return Err("invalid Map operation".into());
                }
                Ok(())
            }
            Expr::RecordKeyGet {
                obj,
                key,
                shape_id,
                overflow_only: true,
                r#type,
                ..
            } => {
                expr(obj, locals, initialized, functions, module)?;
                expr(key, locals, initialized, functions, module)?;
                let Type::Record { shape_id: id } = obj.ty() else {
                    return Err("non-record keyed read".into());
                };
                let value = module.records[id]
                    .index_value
                    .as_ref()
                    .ok_or("non-indexed keyed read")?;
                if *shape_id != format!("r{id}")
                    || key.ty() != Type::String
                    || !module.lookup_result(value, r#type)
                {
                    return Err("invalid keyed read".into());
                }
                Ok(())
            }
            Expr::SetNew { seed, r#type, .. } => {
                let Type::Set { elem } = r#type else {
                    return Err("non-Set construction".into());
                };
                if !elem.set_element() || !module.valid_type(r#type.clone(), &mut vec![]) {
                    return Err("invalid Set element type".into());
                }
                if let Some(seed) = seed {
                    expr(seed, locals, initialized, functions, module)?;
                    if seed.ty() != (Type::Array { elem: elem.clone() }) {
                        return Err("invalid Set seed".into());
                    }
                }
                Ok(())
            }
            Expr::SetIntrinsic {
                method,
                receiver,
                args,
                r#type,
                ..
            } => {
                expr(receiver, locals, initialized, functions, module)?;
                let Type::Set { elem } = receiver.ty() else {
                    return Err("non-Set receiver".into());
                };
                for arg in args {
                    expr(arg, locals, initialized, functions, module)?;
                }
                let (arity, result) = match method.as_str() {
                    "add" => (1, Type::Void),
                    "has" | "delete" => (1, Type::Bool),
                    "clear" => (0, Type::Void),
                    "size" => (0, Type::F64),
                    _ => return Err("invalid Set operation".into()),
                };
                if args.len() != arity || *r#type != result || args.iter().any(|a| a.ty() != *elem)
                {
                    return Err("invalid Set operation".into());
                }
                Ok(())
            }
            Expr::StringIntrinsic {
                method,
                receiver,
                args,
                r#type,
                ..
            } => {
                expr(receiver, locals, initialized, functions, module)?;
                for arg in args {
                    expr(arg, locals, initialized, functions, module)?;
                }
                let valid = crate::string_builtins::by_method(method).is_some_and(|operation| {
                    args.len() == operation.args.len()
                        && *r#type == operation.result
                        && args
                            .iter()
                            .zip(operation.args)
                            .all(|(value, argument)| value.ty() == argument.ty())
                });
                if receiver.ty() == Type::String && valid {
                    Ok(())
                } else {
                    Err("invalid native string operation".into())
                }
            }
            Expr::StrConcat {
                left,
                right,
                r#type,
                ..
            } => {
                expr(left, locals, initialized, functions, module)?;
                expr(right, locals, initialized, functions, module)?;
                if left.ty() != Type::String
                    || right.ty() != Type::String
                    || *r#type != Type::String
                {
                    return Err("invalid string concatenation".into());
                }
                Ok(())
            }
            Expr::ToString {
                operand, r#type, ..
            } => {
                expr(operand, locals, initialized, functions, module)?;
                if !matches!(
                    operand.ty(),
                    Type::F64 | Type::Bigint | Type::Bool | Type::Dyn
                ) || *r#type != Type::String
                {
                    return Err("invalid native string conversion".into());
                }
                Ok(())
            }
            Expr::ArrayIntrinsic {
                receiver,
                args,
                method,
                r#type,
                ..
            } => {
                expr(receiver, locals, initialized, functions, module)?;
                let Type::Array { elem } = receiver.ty() else {
                    return Err("non-array receiver".into());
                };
                for arg in args {
                    expr(arg, locals, initialized, functions, module)?;
                }
                let valid = match method.as_str() {
                    "length" => *r#type == Type::F64 && args.is_empty(),
                    "nextPresent" => {
                        *r#type == Type::F64 && args.len() == 1 && args[0].ty() == Type::F64
                    }
                    "slice" => {
                        *r#type == receiver.ty()
                            && args.len() <= 2
                            && args.iter().all(|arg| arg.ty() == Type::F64)
                    }
                    "push" => *r#type == Type::F64 && args.iter().all(|arg| arg.ty() == *elem),
                    "pop" => {
                        args.is_empty()
                            && match r#type {
                                Type::Union { union_id } => {
                                    module.unions.get(*union_id).is_some_and(|union| {
                                        union.arms.contains(&Type::Undefined)
                                            && if matches!(*elem, Type::Union { .. }) {
                                                *r#type == *elem
                                            } else {
                                                union.arms.len() == 2 && union.arms.contains(&elem)
                                            }
                                    })
                                }
                                _ => false,
                            }
                    }
                    _ => false,
                };
                if !valid {
                    return Err("invalid array operation".into());
                }
                Ok(())
            }
            Expr::Closure {
                fn_name,
                captures,
                r#type,
                ..
            } => {
                let target = functions
                    .get(fn_name.as_str())
                    .ok_or("unknown closure function")?;
                let expected = Type::Func {
                    rest: target.rest,
                    params: target.params.iter().map(|p| p.r#type.clone()).collect(),
                    ret: Box::new(target.call_result()),
                };
                let want = target.captures.as_deref().unwrap_or(&[]);
                if *r#type != expected || captures.len() != want.len() {
                    return Err("invalid closure signature".into());
                }
                for (id, want) in captures.iter().zip(want) {
                    if !initialized.contains(id)
                        || !locals
                            .get(id.as_str())
                            .is_some_and(|l| l.boxed && l.r#type == want.r#type)
                    {
                        return Err("invalid closure capture".into());
                    }
                }
                Ok(())
            }
            Expr::CallValue {
                callee,
                args,
                r#type,
                ..
            } => {
                expr(callee, locals, initialized, functions, module)?;
                let Type::Func { params, ret, .. } = callee.ty() else {
                    return Err("non-function indirect call".into());
                };
                if params.len() != args.len() || *r#type != *ret {
                    return Err("invalid indirect call signature".into());
                }
                for (arg, param) in args.iter().zip(params) {
                    expr(arg, locals, initialized, functions, module)?;
                    if arg.ty() != param {
                        return Err("invalid indirect call argument".into());
                    }
                }
                Ok(())
            }
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
                if fields.iter().filter(|f| !f.overflow).count() != record.fields.len() {
                    return Err("incomplete record literal".into());
                }
                for f in fields {
                    expr(&f.value, locals, initialized, functions, module)?;
                    if f.overflow {
                        if record.index_value.as_ref() != Some(&f.value.ty()) || f.absent {
                            return Err("invalid overflow initializer".into());
                        }
                        continue;
                    }
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
                    || module.field(obj.ty(), field).map(|f| f.r#type.clone())
                        != Some(r#type.clone())
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
                            arm.clone()
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
                if let Some(operation) = r#fn.strip_prefix("weakmap.") {
                    for (index, arg) in args.iter().enumerate() {
                        // Direct typed keys are opaque GC identities, never
                        // reflective mirrors. Validate the represented key.
                        if index == 1
                            && let Expr::DynFrom {
                                value,
                                r#type: Type::Dyn,
                                ..
                            } = arg
                            && matches!(value.ty(), Type::Object { .. })
                        {
                            expr(value, locals, initialized, functions, module)?;
                        } else {
                            expr(arg, locals, initialized, functions, module)?;
                        }
                    }
                    let expected = match operation {
                        "get" => Some((2, Type::Dyn)),
                        "has" | "delete" => Some((2, Type::Bool)),
                        "set" => Some((3, Type::Void)),
                        _ => None,
                    };
                    if !expected.is_some_and(|(arity, result)| args.len() == arity && *r#type == result && matches!(args[0].ty(), Type::Object { class_name } if class_name == "native_builtin_WeakMap") && args[1..].iter().all(|arg| arg.ty() == Type::Dyn)) { return Err("invalid native weak map operation".into()); }
                    return Ok(());
                }
                if matches!(r#fn.as_str(), "als.new" | "als.get" | "als.run") {
                    for arg in args {
                        expr(arg, locals, initialized, functions, module)?;
                    }
                    let valid = match r#fn.as_str() {
                        "als.new" => args.is_empty() && *r#type == Type::F64,
                        "als.get" => {
                            args.len() == 1 && args[0].ty() == Type::F64 && *r#type == Type::Dyn
                        }
                        "als.run" => {
                            args.len() == 4
                                && args[0].ty() == Type::F64
                                && args[1..].iter().all(|arg| arg.ty() == Type::Dyn)
                                && *r#type == Type::Dyn
                        }
                        _ => unreachable!(),
                    };
                    return if valid {
                        Ok(())
                    } else {
                        Err("invalid native async context operation".into())
                    };
                }
                if r#fn == "record.setOwn" {
                    for arg in args {
                        expr(arg, locals, initialized, functions, module)?;
                    }
                    return if args.len() == 3
                        && args[0].ty() == Type::Dyn
                        && args[1].ty() == Type::String
                        && args[2].ty() == Type::Dyn
                        && *r#type == Type::Void
                    {
                        Ok(())
                    } else {
                        Err("invalid native record own-value write".into())
                    };
                }
                if r#fn == "record.view" {
                    for arg in args {
                        expr(arg, locals, initialized, functions, module)?;
                    }
                    return if args.len() == 1
                        && record_views::view_pairs(
                            &args[0].ty(),
                            r#type,
                            &module.records,
                            &module.unions,
                        )
                        .is_some()
                    {
                        Ok(())
                    } else {
                        Err("invalid or ambiguous native record view".into())
                    };
                }
                if r#fn == "record.fromOwn" {
                    for arg in args {
                        expr(arg, locals, initialized, functions, module)?;
                    }
                    return if args.len() == 2
                        && args[0].ty() == *r#type
                        && args[1].ty() == Type::Dyn
                        && matches!(r#type, Type::Record{shape_id} if !module.records[*shape_id].tuple && module.records[*shape_id].index_value.is_none())
                    {
                        Ok(())
                    } else {
                        Err("invalid native record own-value construction".into())
                    };
                }
                if r#fn == "record.cloneOwn" {
                    for arg in args {
                        expr(arg, locals, initialized, functions, module)?;
                    }
                    let valid = args.len() == 2
                        && args[0].ty() == *r#type
                        && args[1].ty()
                            == (Type::Array {
                                elem: Box::new(Type::String),
                            })
                        && matches!(r#type, Type::Record { shape_id } if module.records.get(*shape_id).is_some_and(|r| !r.tuple && r.index_value.is_none()));
                    return if valid {
                        Ok(())
                    } else {
                        Err("invalid native record own-key construction".into())
                    };
                }
                if r#fn == "dyn.compare" {
                    for arg in args {
                        expr(arg, locals, initialized, functions, module)?;
                    }
                    return if args.len() == 2
                        && args.iter().all(|arg| arg.ty() == Type::Dyn)
                        && *r#type == Type::F64
                    {
                        Ok(())
                    } else {
                        Err("invalid native relational comparison".into())
                    };
                }
                if r#fn == "dyn.objectRestCheck" {
                    for arg in args {
                        expr(arg, locals, initialized, functions, module)?;
                    }
                    return if args.len() == 1 && args[0].ty() == Type::Dyn && *r#type == Type::Void
                    {
                        Ok(())
                    } else {
                        Err("invalid native object binding source check".into())
                    };
                }
                if matches!(r#fn.as_str(), "dyn.hasOwn" | "dyn.hasKey" | "dyn.objKeys") {
                    for arg in args {
                        expr(arg, locals, initialized, functions, module)?;
                    }
                    let valid = if r#fn != "dyn.objKeys" {
                        args.len() == 2
                            && args[0].ty() == Type::Dyn
                            && args[1].ty() == Type::String
                            && *r#type == Type::Bool
                    } else {
                        args.len() == 1 && args[0].ty() == Type::Dyn && *r#type == Type::Dyn
                    };
                    return if valid {
                        Ok(())
                    } else {
                        Err("invalid native own-key reflection".into())
                    };
                }
                if matches!(r#fn.as_str(), "buffer.fromStr" | "text.decode") {
                    for arg in args {
                        expr(arg, locals, initialized, functions, module)?;
                    }
                    let valid = if r#fn == "buffer.fromStr" {
                        args.len() == 2
                            && args.iter().all(|a| a.ty() == Type::String)
                            && *r#type == Type::bytes()
                    } else {
                        args.len() == 1 && args[0].ty() == Type::bytes() && *r#type == Type::String
                    };
                    return if valid {
                        Ok(())
                    } else {
                        Err("invalid native text codec operation".into())
                    };
                }
                if r#fn == "regex.replaceCaptures" {
                    for arg in args {
                        expr(arg, locals, initialized, functions, module)?;
                    }
                    return if args.iter().map(Expr::ty).collect::<Vec<_>>()
                        == [Type::String, Type::Regex, Type::Dyn, Type::Bool]
                        && *r#type == Type::String
                    {
                        Ok(())
                    } else {
                        Err("invalid native regex replacement callback".into())
                    };
                }
                if r#fn == "dyn.keyDelete" {
                    for arg in args {
                        expr(arg, locals, initialized, functions, module)?;
                    }
                    if args.len() != 3
                        || args[0].ty() != Type::Dyn
                        || args[1].ty() != Type::String
                        || args[2].ty() != Type::Bool
                        || *r#type != Type::Bool
                    {
                        return Err("invalid native dynamic property deletion".into());
                    }
                    return Ok(());
                }
                if r#fn == "dyn.keySet" {
                    for arg in args {
                        expr(arg, locals, initialized, functions, module)?;
                    }
                    if args.len() != 3
                        || args[0].ty() != Type::Dyn
                        || args[1].ty() != Type::String
                        || args[2].ty() != Type::Dyn
                        || *r#type != Type::Void
                    {
                        return Err("invalid native dynamic property write".into());
                    }
                    return Ok(());
                }
                if r#fn == "process.envGet" {
                    for arg in args {
                        expr(arg, locals, initialized, functions, module)?;
                    }
                    if args.len() != 1
                        || args[0].ty() != Type::String
                        || !module.lookup_result(&Type::String, r#type)
                    {
                        return Err("invalid native environment read".into());
                    }
                    return Ok(());
                }
                if let Some(valid) = child_process::signature(
                    r#fn,
                    &args.iter().map(Expr::ty).collect::<Vec<_>>(),
                    r#type,
                    module,
                ) {
                    for arg in args {
                        expr(arg, locals, initialized, functions, module)?;
                    }
                    return if valid {
                        Ok(())
                    } else {
                        Err("invalid native child process signature".into())
                    };
                }
                if matches!(
                    r#fn.as_str(),
                    "json.stringifyNative"
                        | "json.parseNative"
                        | "json.rawJSONNative"
                        | "json.isRawJSONNative"
                ) {
                    for arg in args {
                        expr(arg, locals, initialized, functions, module)?;
                    }
                    return if args.len() == 1
                        && args[0].ty()
                            == (Type::Array {
                                elem: Box::new(Type::Dyn),
                            })
                        && *r#type == Type::Dyn
                    {
                        Ok(())
                    } else {
                        Err("invalid native JSON function signature".into())
                    };
                }
                if r#fn == "dyn.this" {
                    return if args.is_empty() && *r#type == Type::Dyn {
                        Ok(())
                    } else {
                        Err("invalid native receiver signature".into())
                    };
                }
                let builtin = crate::builtins::by_ir(r#fn).ok_or("unknown native library call")?;
                if *r#type != builtin.result || args.len() != builtin.args.len() {
                    return Err("invalid native library signature".into());
                }
                for (arg, expected) in args.iter().zip(&builtin.args) {
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
            } if module.global(local_id).is_some_and(|g| g.r#type == *r#type)
                || (initialized.contains(local_id)
                    && locals
                        .get(local_id.as_str())
                        .is_some_and(|l| l.r#type == *r#type)) =>
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
                        && matches!(
                            left.ty(),
                            Type::F64
                                | Type::Bool
                                | Type::Record { .. }
                                | Type::Func { .. }
                                | Type::Array { .. }
                                | Type::Map { .. }
                                | Type::Set { .. }
                                | Type::Object { .. }
                                | Type::Bytes { .. }
                                | Type::Promise { .. }
                                | Type::Child
                        )
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
                r#type: Type::Promise { inner },
                ..
            } if name == "promise.resolve" => {
                for arg in args {
                    expr(arg, locals, initialized, functions, module)?;
                }
                if (args.is_empty() && **inner == Type::Void)
                    || (args.len() == 1 && args[0].ty() == **inner && **inner != Type::Void)
                {
                    Ok(())
                } else {
                    Err("invalid native Promise.resolve".into())
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
                if target.captures.is_some()
                    || args.len() != target.params.len()
                    || *r#type != target.call_result()
                {
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
        function: Option<&Function>,
    ) -> Result<(), String> {
        for stmt in stmts {
            match stmt {
                Stmt::Throw { value, .. } => {
                    expr(value, locals, initialized, functions, module)?;
                    if matches!(value.ty(), Type::Void) {
                        return Err("void throw payload".into());
                    }
                }
                Stmt::TryCatch {
                    try_body,
                    catch_body,
                    catch_local_id,
                    finally_body,
                    ..
                } => {
                    if catch_body.is_none() && (catch_local_id.is_some() || finally_body.is_none())
                    {
                        return Err("native try needs a handler or finalizer".into());
                    }
                    body(
                        try_body,
                        locals,
                        &mut initialized.clone(),
                        functions,
                        return_type.clone(),
                        module,
                        function,
                    )?;
                    if let Some(region) = catch_body {
                        let mut caught_initialized = initialized.clone();
                        if let Some(id) = catch_local_id
                            && (!locals
                                .get(id.as_str())
                                .is_some_and(|l| l.r#type == Type::Caught)
                                || !caught_initialized.insert(id.clone()))
                        {
                            return Err("catch binding needs a fresh caught local".into());
                        }
                        body(
                            region,
                            locals,
                            &mut caught_initialized,
                            functions,
                            return_type.clone(),
                            module,
                            function,
                        )?;
                    }
                    if let Some(region) = finally_body {
                        body(
                            region,
                            locals,
                            &mut initialized.clone(),
                            functions,
                            return_type.clone(),
                            module,
                            function,
                        )?;
                    }
                }
                Stmt::FieldSet {
                    obj,
                    class_name,
                    field,
                    value,
                    ..
                } => {
                    expr(obj, locals, initialized, functions, module)?;
                    expr(value, locals, initialized, functions, module)?;
                    if matches!(field.as_str(), "%code" | "%hasCause" | "%cause")
                        || obj.ty()
                            != (Type::Object {
                                class_name: class_name.clone(),
                            })
                        || !module.class(class_name).is_some_and(|c| {
                            c.fields
                                .iter()
                                .any(|f| f.name == *field && f.r#type == value.ty())
                        })
                    {
                        return Err("invalid native field write".into());
                    }
                }
                Stmt::RecordKeySet {
                    obj,
                    key,
                    value,
                    shape_id,
                    overflow_only: true,
                    ..
                } => {
                    expr(obj, locals, initialized, functions, module)?;
                    expr(key, locals, initialized, functions, module)?;
                    expr(value, locals, initialized, functions, module)?;
                    let Type::Record { shape_id: id } = obj.ty() else {
                        return Err("non-record keyed write".into());
                    };
                    if *shape_id != format!("r{id}")
                        || key.ty() != Type::String
                        || module.records[id].index_value.as_ref() != Some(&value.ty())
                    {
                        return Err("invalid keyed write".into());
                    }
                }
                Stmt::RecordKeySet { .. } => return Err("mixed keyed writes are not ported".into()),
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
                        || module.field(obj.ty(), field).map(|f| f.r#type.clone())
                            != Some(value.ty())
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
                    local_id,
                    value,
                    initializes_global,
                    ..
                } => {
                    expr(value, locals, initialized, functions, module)?;
                    if let Some(global) = module.global(local_id) {
                        if global.r#type != value.ty()
                            || (*initializes_global
                                && !function.is_some_and(|f| module.initializes(stmt, f, local_id)))
                            || (!global.mutable
                                && !function.is_some_and(|f| module.initializes(stmt, f, local_id)))
                        {
                            return Err("invalid global assignment".into());
                        }
                        continue;
                    }
                    if *initializes_global
                        || !initialized.contains(local_id)
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
                Stmt::Break { .. } | Stmt::Continue { .. } => {}
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
                        return_type.clone(),
                        module,
                        function,
                    )?;
                    if let Some(other) = else_ {
                        body(
                            other,
                            locals,
                            &mut initialized.clone(),
                            functions,
                            return_type.clone(),
                            module,
                            function,
                        )?;
                    }
                }
                Stmt::While {
                    cond, body: stmts, ..
                } => {
                    expr(cond, locals, initialized, functions, module)?;
                    if cond.ty() != Type::Bool {
                        return Err("non-boolean loop condition".into());
                    }
                    body(
                        stmts,
                        locals,
                        &mut initialized.clone(),
                        functions,
                        return_type.clone(),
                        module,
                        function,
                    )?;
                }
                Stmt::Block { body: stmts, .. } => body(
                    stmts,
                    locals,
                    &mut initialized.clone(),
                    functions,
                    return_type.clone(),
                    module,
                    function,
                )?,
            }
        }
        Ok(())
    }
    control_flow::validate_targets(&f.body, 0)?;
    if f.return_type != Type::Void && !always_returns(&f.body) {
        return Err("non-void function can fall through".into());
    }
    let mut initialized = f
        .params
        .iter()
        .chain(f.captures.iter().flatten())
        .map(|p| p.local_id.clone())
        .collect();
    body(
        &f.body,
        &locals,
        &mut initialized,
        functions,
        f.return_type.clone(),
        module,
        Some(f),
    )
}

pub fn always_returns(stmts: &[Stmt]) -> bool {
    control_flow::function_exits(stmts)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stats_library_calls_keep_nominal_layouts_and_fence_erasure() {
        let mut module = callable_module();
        module.functions.truncate(1);
        let loc = module.functions[0].loc.clone();
        let stat = Expr::LibCall {
            r#fn: "fs.statSync".into(),
            args: vec![Expr::StrLit {
                value: "path".into(),
                r#type: Type::String,
                loc: loc.clone(),
            }],
            r#type: Type::Stats,
            loc: loc.clone(),
        };
        module.functions[0].body = vec![Stmt::Expression {
            expr: Expr::LibCall {
                r#fn: "stats.size".into(),
                args: vec![stat.clone()],
                r#type: Type::F64,
                loc: loc.clone(),
            },
            loc: loc.clone(),
        }];
        assert!(validate(&module).is_ok());
        module.functions[0].body = vec![Stmt::Expression {
            expr: Expr::DynFrom {
                value: Box::new(stat),
                r#type: Type::Dyn,
                loc: loc.clone(),
            },
            loc: loc.clone(),
        }];
        assert_eq!(
            validate(&module).unwrap_err(),
            "Stats erasure is not in the shared native value contract"
        );
        module.functions[0].body = vec![Stmt::Expression {
            expr: Expr::LibCall {
                r#fn: "stats.size".into(),
                args: vec![Expr::StrLit {
                    value: "fake".into(),
                    r#type: Type::String,
                    loc: loc.clone(),
                }],
                r#type: Type::F64,
                loc: loc.clone(),
            },
            loc,
        }];
        assert!(validate(&module).is_err());
        let records = vec![Record {
            id: 0,
            fields: vec![Field {
                name: "snapshot".into(),
                r#type: Type::Stats,
            }],
            declared_order: vec!["snapshot".into()],
            tuple: false,
            index_value: None,
        }];
        assert!(contains_stats(&Type::Record { shape_id: 0 }, &records, &[]));
        assert!(!contains_set(&Type::Record { shape_id: 0 }, &records, &[]));
    }

    #[test]
    fn standard_primitives_validate_abi_and_visit_nested_operands() {
        let mut module = callable_module();
        module.functions.truncate(1);
        let loc = module.functions[0].loc.clone();
        let string = Expr::StrLit {
            value: "ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â°ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã¢â‚¬Â¹Ãƒâ€¦Ã¢â‚¬Å“ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬".into(),
            r#type: Type::String,
            loc: loc.clone(),
        };
        let number = Expr::NumLit {
            value: 2.0,
            spelling: None,
            r#type: Type::F64,
            loc: loc.clone(),
        };
        for (method, receiver, args, result, valid) in [
            (
                "repeat",
                string.clone(),
                vec![number.clone()],
                Type::String,
                true,
            ),
            ("repeat", string.clone(), vec![], Type::String, false),
            (
                "repeat",
                number.clone(),
                vec![number.clone()],
                Type::String,
                false,
            ),
            (
                "repeat",
                string.clone(),
                vec![string.clone()],
                Type::String,
                false,
            ),
            (
                "repeat",
                string.clone(),
                vec![number.clone()],
                Type::F64,
                false,
            ),
            ("length", string.clone(), vec![], Type::F64, true),
            (
                "length",
                string.clone(),
                vec![number.clone()],
                Type::F64,
                false,
            ),
            (
                "slice",
                string.clone(),
                vec![number.clone()],
                Type::String,
                false,
            ),
        ] {
            let value = Expr::StringIntrinsic {
                method: method.into(),
                receiver: Box::new(receiver),
                args,
                r#type: result,
                loc: loc.clone(),
            };
            module.functions[0].body = vec![Stmt::Expression {
                expr: value,
                loc: loc.clone(),
            }];
            assert_eq!(validate(&module).is_ok(), valid, "{method}");
            if valid {
                let wire = serde_json::to_value(&module).unwrap();
                assert_eq!(
                    wire["functions"][0]["body"][0]["expr"]["kind"],
                    "strIntrinsic"
                );
                let mut types = vec![];
                module.visit_expressions(&mut |e| types.push(e.ty()));
                assert_eq!(types.len(), if method == "repeat" { 3 } else { 2 });
            }
        }
        for (name, args, result, valid) in [
            ("math.floor", vec![number.clone()], Type::F64, true),
            ("math.floor", vec![string.clone()], Type::F64, false),
            ("math.floor", vec![], Type::F64, false),
            ("math.floor", vec![number.clone()], Type::String, false),
            ("math.minArr", vec![number.clone()], Type::F64, false),
            ("num.fromString", vec![string.clone()], Type::F64, true),
            (
                "num.parseInt",
                vec![string.clone(), number.clone()],
                Type::F64,
                true,
            ),
            (
                "num.parseInt",
                vec![number.clone(), number.clone()],
                Type::F64,
                false,
            ),
            ("num.parseInt", vec![string.clone()], Type::F64, false),
            (
                "num.parseInt",
                vec![string.clone(), number.clone()],
                Type::Bool,
                false,
            ),
            ("num.parseFloat", vec![string], Type::F64, true),
            ("num.parseFloat", vec![number], Type::F64, false),
        ] {
            module.functions[0].body = vec![Stmt::Expression {
                expr: Expr::LibCall {
                    r#fn: name.into(),
                    args,
                    r#type: result,
                    loc: loc.clone(),
                },
                loc: loc.clone(),
            }];
            assert_eq!(validate(&module).is_ok(), valid, "{name}");
        }
    }

    #[test]
    fn relational_comparison_validates_arity_payloads_and_result() {
        let mut module = callable_module();
        let loc = module.functions[0].loc.clone();
        let number = Expr::NumLit {
            value: 1.0,
            spelling: None,
            r#type: Type::F64,
            loc: loc.clone(),
        };
        let boxed = Expr::DynFrom {
            value: Box::new(number.clone()),
            r#type: Type::Dyn,
            loc: loc.clone(),
        };
        for (args, result, valid) in [
            (vec![boxed.clone(), boxed.clone()], Type::F64, true),
            (vec![], Type::F64, false),
            (vec![boxed.clone()], Type::F64, false),
            (
                vec![boxed.clone(), boxed.clone(), boxed.clone()],
                Type::F64,
                false,
            ),
            (vec![number, boxed.clone()], Type::F64, false),
            (vec![boxed.clone(), boxed], Type::Bool, false),
        ] {
            module.functions[0].body = vec![Stmt::Expression {
                expr: Expr::LibCall {
                    r#fn: "dyn.compare".into(),
                    args,
                    r#type: result,
                    loc: loc.clone(),
                },
                loc: loc.clone(),
            }];
            assert_eq!(validate(&module).is_ok(), valid);
        }
    }

    #[test]
    fn receiver_contract_validates_arity_result_and_entry_scope() {
        let mut module = callable_module();
        let loc = module.functions[0].loc.clone();
        for (args, ty, expected) in [
            (vec![], Type::Dyn, true),
            (vec![], Type::String, false),
            (
                vec![Expr::BoolLit {
                    value: true,
                    r#type: Type::Bool,
                    loc: loc.clone(),
                }],
                Type::Dyn,
                false,
            ),
        ] {
            module.functions[1].body.insert(
                0,
                Stmt::Expression {
                    expr: Expr::LibCall {
                        r#fn: "dyn.this".into(),
                        args,
                        r#type: ty,
                        loc: loc.clone(),
                    },
                    loc: loc.clone(),
                },
            );
            // The helper target may observe this; the module entry may not.
            assert_eq!(validate(&module).is_ok(), expected);
            module.functions[1].body.remove(0);
        }
        let entry = module
            .functions
            .iter_mut()
            .find(|f| f.name == module.entry)
            .unwrap();
        entry.body.insert(
            0,
            Stmt::Expression {
                expr: Expr::LibCall {
                    r#fn: "dyn.this".into(),
                    args: vec![],
                    r#type: Type::Dyn,
                    loc: loc.clone(),
                },
                loc,
            },
        );
        assert_eq!(
            validate(&module).unwrap_err(),
            "native entry cannot read a call receiver"
        );
    }

    #[test]
    fn json_function_contract_rejects_typed_or_malformed_argument_packs() {
        let mut module = callable_module();
        let loc = module.functions[0].loc.clone();
        for name in [
            "json.stringifyNative",
            "json.parseNative",
            "json.rawJSONNative",
            "json.isRawJSONNative",
        ] {
            for defect in ["none", "arity", "element", "result"] {
                let mut args = vec![Expr::ArrayLit {
                    elems: vec![],
                    r#type: Type::Array {
                        elem: Box::new(if defect == "element" {
                            Type::F64
                        } else {
                            Type::Dyn
                        }),
                    },
                    loc: loc.clone(),
                }];
                if defect == "arity" {
                    args.clear();
                }
                module.functions[0].body = vec![Stmt::Expression {
                    expr: Expr::LibCall {
                        r#fn: name.into(),
                        args,
                        r#type: if defect == "result" {
                            Type::String
                        } else {
                            Type::Dyn
                        },
                        loc: loc.clone(),
                    },
                    loc: loc.clone(),
                }];
                assert_eq!(
                    validate(&module).is_ok(),
                    defect == "none",
                    "{name}: {defect}"
                );
            }
        }
    }

    #[test]
    fn exec_file_contract_rejects_malformed_capture_and_handle_abis() {
        let mut module = callable_module();
        module.records.push(Record {
            id: 0,
            fields: vec![
                Field {
                    name: "stdout".into(),
                    r#type: Type::String,
                },
                Field {
                    name: "stderr".into(),
                    r#type: Type::String,
                },
            ],
            tuple: false,
            index_value: None,
            declared_order: vec![],
        });
        let args = [Type::Array {
            elem: Box::new(Type::Dyn),
        }];
        let promise = Type::Promise {
            inner: Box::new(Type::Record { shape_id: 0 }),
        };
        let check = |name, args: &[Type], result: &Type, module: &Module| {
            child_process::signature(name, args, result, module)
        };
        assert_eq!(
            check("cp.execFileNative", &args, &Type::Child, &module),
            Some(true)
        );
        assert_eq!(
            check("cp.execFilePromise", &args, &promise, &module),
            Some(true)
        );
        assert_eq!(
            check("cp.execFilePromise", &[], &promise, &module),
            Some(false)
        );
        assert_eq!(
            check("cp.execFilePromise", &args, &Type::Child, &module),
            Some(false)
        );
        assert_eq!(
            check(
                "cp.promiseChild",
                std::slice::from_ref(&promise),
                &Type::Child,
                &module
            ),
            Some(true)
        );
        assert_eq!(
            check("cp.promiseChild", &[Type::String], &Type::Child, &module),
            Some(false)
        );
        assert_eq!(
            check("child.killed", &[Type::Child], &Type::Bool, &module),
            Some(true)
        );
        assert_eq!(
            check("child.killed", &[Type::F64], &Type::Bool, &module),
            Some(false)
        );
        module.records[0].fields[1].r#type = Type::F64;
        assert_eq!(
            check("cp.execFilePromise", &args, &promise, &module),
            Some(false)
        );
        module.records[0].fields[1].r#type = Type::String;
        module.records[0].index_value = Some(Type::String);
        assert_eq!(
            check("cp.execFilePromise", &args, &promise, &module),
            Some(false)
        );
    }

    #[test]
    fn async_context_library_calls_preserve_handle_and_value_contracts() {
        let mut module = callable_module();
        let loc = module.functions[0].loc.clone();
        for operation in ["als.new", "als.get", "als.run"] {
            for defect in ["none", "arity", "result", "handle"] {
                if operation == "als.new" && defect == "handle" {
                    continue;
                }
                let number = || Expr::NumLit {
                    value: 1.0,
                    spelling: None,
                    r#type: Type::F64,
                    loc: loc.clone(),
                };
                let dynamic = || Expr::DynFrom {
                    value: Box::new(number()),
                    r#type: Type::Dyn,
                    loc: loc.clone(),
                };
                let mut args = match operation {
                    "als.new" => vec![],
                    "als.get" => vec![number()],
                    _ => vec![number(), dynamic(), dynamic(), dynamic()],
                };
                if defect == "arity" {
                    args.push(number());
                }
                if defect == "handle" {
                    args[0] = dynamic();
                }
                let result = if operation == "als.new" {
                    Type::F64
                } else {
                    Type::Dyn
                };
                let result = if defect == "result" {
                    Type::String
                } else {
                    result
                };
                module.functions[0].body = vec![Stmt::Expression {
                    expr: Expr::LibCall {
                        r#fn: operation.into(),
                        args,
                        r#type: result,
                        loc: loc.clone(),
                    },
                    loc: loc.clone(),
                }];
                assert_eq!(
                    validate(&module).is_ok(),
                    defect == "none",
                    "{operation}/{defect}: {:?}",
                    validate(&module)
                );
            }
        }
    }

    #[test]
    fn async_calls_and_closures_separate_body_and_caller_results() {
        let mut m = callable_module();
        m.functions[1].is_async = true;
        let promise = Type::Promise {
            inner: Box::new(Type::F64),
        };
        assert_eq!(m.functions[1].call_result(), promise);
        assert_eq!(validate(&m).unwrap_err(), "invalid call signature");
        let Stmt::Expression {
            expr: Expr::Call { r#type, .. },
            ..
        } = &mut m.functions[0].body[0]
        else {
            unreachable!()
        };
        *r#type = promise.clone();
        validate(&m).unwrap();
        let json = serde_json::to_value(&m).unwrap();
        assert_eq!(json["functions"][1]["async"], true);
        assert_eq!(json["functions"][1]["returnType"]["kind"], "f64");
        assert!(json["functions"][0].get("async").is_none());
        let loc = m.functions[0].loc.clone();
        m.functions[0].body = vec![Stmt::Expression {
            expr: Expr::Closure {
                fn_name: "f0".into(),
                captures: vec![],
                r#type: Type::Func {
                    rest: false,
                    params: vec![Type::F64],
                    ret: Box::new(promise),
                },
                loc: loc.clone(),
            },
            loc,
        }];
        validate(&m).unwrap();
        let Stmt::Expression {
            expr:
                Expr::Closure {
                    r#type: Type::Func { ret, .. },
                    ..
                },
            ..
        } = &mut m.functions[0].body[0]
        else {
            unreachable!()
        };
        **ret = Type::F64;
        assert_eq!(validate(&m).unwrap_err(), "invalid closure signature");
        m.functions[0].is_async = true;
        assert_eq!(validate(&m).unwrap_err(), "invalid native entry");
    }

    #[test]
    fn array_rest_closures_preserve_the_wire_abi_and_type_identity() {
        let mut m = callable_module();
        let loc = m.functions[0].loc.clone();
        let array = Type::Array {
            elem: Box::new(Type::F64),
        };
        m.functions[1].rest = true;
        m.functions[1].params[0].r#type = array.clone();
        m.functions[1].locals[0].r#type = array.clone();
        m.functions[1].return_type = array.clone();
        m.functions[1].body = vec![Stmt::Return {
            value: Some(Expr::VarRef {
                local_id: "p0".into(),
                r#type: array.clone(),
                loc: loc.clone(),
            }),
            loc: loc.clone(),
        }];
        let variadic = Type::Func {
            rest: true,
            params: vec![array.clone()],
            ret: Box::new(array.clone()),
        };
        let ordinary = Type::Func {
            rest: false,
            params: vec![array.clone()],
            ret: Box::new(array),
        };
        assert_ne!(variadic, ordinary);
        m.functions[0].body = vec![Stmt::Expression {
            expr: Expr::Closure {
                fn_name: "f0".into(),
                captures: vec![],
                r#type: variadic.clone(),
                loc: loc.clone(),
            },
            loc,
        }];
        validate(&m).unwrap();
        let wire = serde_json::to_value(&m).unwrap();
        let ty = &wire["functions"][0]["body"][0]["expr"]["type"];
        assert_eq!(ty["rest"], true);
        assert_eq!(ty["restAbi"], "array");
        assert!(wire["functions"][1].get("rest").is_none());
        let ordinary_wire = serde_json::to_value(&ordinary).unwrap();
        assert!(ordinary_wire.get("rest").is_none() && ordinary_wire.get("restAbi").is_none());
        if let Stmt::Expression {
            expr: Expr::Closure { r#type, .. },
            ..
        } = &mut m.functions[0].body[0]
        {
            *r#type = ordinary;
        }
        assert_eq!(validate(&m).unwrap_err(), "invalid closure signature");
    }

    #[test]
    fn array_rest_rejects_missing_or_untyped_pack_slots() {
        let mut m = callable_module();
        for params in [vec![], vec![Type::String]] {
            assert!(!m.valid_type(
                Type::Func {
                    rest: true,
                    params,
                    ret: Box::new(Type::String)
                },
                &mut vec![]
            ));
        }
        m.functions[0].body.clear();
        m.functions[1].rest = true;
        assert_eq!(
            validate(&m).unwrap_err(),
            "rest function needs a trailing native array"
        );
    }

    #[test]
    fn expression_sequences_validate_scope_results_and_control_flow() {
        for mode in ["valid", "return", "result", "branch", "escape"] {
            let mut m = callable_module();
            let loc = m.functions[0].loc.clone();
            let value = || Expr::NumLit {
                value: 1.0,
                spelling: None,
                r#type: Type::F64,
                loc: loc.clone(),
            };
            let read = || Expr::VarRef {
                local_id: "seq".into(),
                r#type: Type::F64,
                loc: loc.clone(),
            };
            m.functions[0].locals.push(Local {
                id: "seq".into(),
                name: "sequence temp".into(),
                r#type: Type::F64,
                mutable: false,
                boxed: false,
            });
            let declaration = Stmt::VarDecl {
                local_id: "seq".into(),
                init: value(),
                loc: loc.clone(),
            };
            let stmts = match mode {
                "return" => vec![Stmt::Return {
                    value: None,
                    loc: loc.clone(),
                }],
                "branch" => vec![Stmt::If {
                    cond: Expr::BoolLit {
                        value: true,
                        r#type: Type::Bool,
                        loc: loc.clone(),
                    },
                    then: vec![declaration],
                    else_: None,
                    loc: loc.clone(),
                }],
                _ => vec![declaration],
            };
            m.functions[0].body = vec![Stmt::Expression {
                expr: Expr::Sequence {
                    stmts,
                    result: Box::new(if mode == "return" { value() } else { read() }),
                    r#type: if mode == "result" {
                        Type::String
                    } else {
                        Type::F64
                    },
                    loc: loc.clone(),
                },
                loc: loc.clone(),
            }];
            if mode == "escape" {
                m.functions[0].body.push(Stmt::Expression {
                    expr: read(),
                    loc: loc.clone(),
                });
            }
            let result = validate(&m);
            if mode == "valid" {
                result.unwrap();
                let wire = serde_json::to_value(&m).unwrap();
                assert_eq!(wire["functions"][0]["body"][0]["expr"]["kind"], "seqExpr");
                let mut visits = 0;
                m.visit_expressions(&mut |_| visits += 1);
                assert!(visits >= 3);
            } else {
                let error = result.unwrap_err();
                assert!(
                    error.contains(if mode == "return" {
                        "sequence statement"
                    } else if mode == "result" {
                        "sequence result"
                    } else {
                        "invalid native expression"
                    }),
                    "{mode}: {error}"
                );
            }
        }
    }

    #[test]
    fn bigint_abi_checks_argument_and_result_layouts_before_emission() {
        let mut module = callable_module();
        let loc = module.functions[0].loc.clone();
        let literal = Expr::LibCall {
            r#fn: "bigint.parse".into(),
            args: vec![Expr::StrLit {
                value: "9007199254740993".into(),
                r#type: Type::String,
                loc: loc.clone(),
            }],
            r#type: Type::Bigint,
            loc: loc.clone(),
        };
        for defect in ["none", "argument", "arity", "result", "unknown"] {
            let mut args = vec![literal.clone()];
            if defect == "argument" {
                args[0] = Expr::NumLit {
                    value: 1.0,
                    spelling: None,
                    r#type: Type::F64,
                    loc: loc.clone(),
                };
            }
            if defect == "arity" {
                args.clear();
            }
            module.functions[0].body = vec![Stmt::Expression {
                expr: Expr::LibCall {
                    r#fn: if defect == "unknown" {
                        "bigint.unsupported"
                    } else {
                        "bigint.toString"
                    }
                    .into(),
                    args,
                    r#type: if defect == "result" {
                        Type::Bigint
                    } else {
                        Type::String
                    },
                    loc: loc.clone(),
                },
                loc: loc.clone(),
            }];
            assert_eq!(validate(&module).is_ok(), defect == "none", "{defect}");
        }
        assert_eq!(
            serde_json::to_value(Type::Bigint).unwrap()["kind"],
            "bigint"
        );
    }

    #[test]
    fn own_key_reflection_validates_the_portable_abi() {
        for (name, valid_args, valid_result) in [
            ("dyn.hasOwn", true, true),
            ("dyn.hasKey", true, true),
            ("dyn.hasKey", false, true),
            ("dyn.hasKey", true, false),
            ("dyn.objKeys", true, true),
            ("dyn.hasOwn", false, true),
            ("dyn.objKeys", true, false),
        ] {
            let mut m = callable_module();
            let loc = m.functions[0].loc.clone();
            let mut args = vec![Expr::DynObjLit {
                fields: vec![],
                r#type: Type::Dyn,
                loc: loc.clone(),
            }];
            if name != "dyn.objKeys" && valid_args {
                args.push(Expr::StrLit {
                    value: "key".into(),
                    r#type: Type::String,
                    loc: loc.clone(),
                });
            }
            m.functions[0].body = vec![Stmt::Expression {
                expr: Expr::LibCall {
                    r#fn: name.into(),
                    args,
                    r#type: if !valid_result {
                        Type::String
                    } else if name != "dyn.objKeys" {
                        Type::Bool
                    } else {
                        Type::Dyn
                    },
                    loc: loc.clone(),
                },
                loc,
            }];
            if valid_args && valid_result {
                validate(&m).unwrap();
            } else {
                assert_eq!(
                    validate(&m).unwrap_err(),
                    "invalid native own-key reflection"
                );
            }
        }
    }

    #[test]
    fn symbols_validate_owning_operands_results_and_wire_contract() {
        let mut m = callable_module();
        let loc = m.functions[0].loc.clone();
        m.unions.push(Union {
            id: 0,
            arms: vec![Type::String, Type::Undefined],
        });
        let fresh = || Expr::LibCall {
            r#fn: "sym.newAnon".into(),
            args: vec![],
            r#type: Type::Symbol,
            loc: loc.clone(),
        };
        m.functions[0].body = vec![Stmt::Expression {
            expr: Expr::LibCall {
                r#fn: "sym.desc".into(),
                args: vec![fresh()],
                r#type: Type::Union { union_id: 0 },
                loc: loc.clone(),
            },
            loc: loc.clone(),
        }];
        validate(&m).unwrap();
        let wire = serde_json::to_value(&m).unwrap();
        assert_eq!(
            wire["functions"][0]["body"][0]["expr"]["args"][0]["type"]["kind"],
            "symbol"
        );
        if let Stmt::Expression {
            expr: Expr::LibCall { r#type, .. },
            ..
        } = &mut m.functions[0].body[0]
        {
            *r#type = Type::String;
        }
        assert_eq!(
            validate(&m).unwrap_err(),
            "invalid native symbol/typeof operation"
        );
        m.functions[0].body = vec![Stmt::Expression {
            expr: Expr::LibCall {
                r#fn: "sym.newAnon".into(),
                args: vec![fresh()],
                r#type: Type::Symbol,
                loc: loc.clone(),
            },
            loc,
        }];
        assert_eq!(
            validate(&m).unwrap_err(),
            "invalid native symbol/typeof operation"
        );
    }

    #[test]
    fn well_known_symbol_operations_require_zero_arguments_and_symbol_results() {
        let mut module = callable_module();
        let loc = module.functions[0].loc.clone();
        for operation in [
            "sym.asyncIterator",
            "sym.hasInstance",
            "sym.isConcatSpreadable",
            "sym.iterator",
            "sym.match",
            "sym.matchAll",
            "sym.replace",
            "sym.search",
            "sym.species",
            "sym.split",
            "sym.toPrimitive",
            "sym.toStringTag",
            "sym.unscopables",
            "sym.dispose",
            "sym.asyncDispose",
        ] {
            for (args, result, valid) in [
                (vec![], Type::Symbol, true),
                (vec![], Type::String, false),
                (
                    vec![Expr::UnitLit {
                        unit: "undefined",
                        r#type: Type::Undefined,
                        loc: loc.clone(),
                    }],
                    Type::Symbol,
                    false,
                ),
            ] {
                module.functions[0].body = vec![Stmt::Expression {
                    expr: Expr::LibCall {
                        r#fn: operation.into(),
                        args,
                        r#type: result,
                        loc: loc.clone(),
                    },
                    loc: loc.clone(),
                }];
                assert_eq!(validate(&module).is_ok(), valid, "{operation}");
                if valid {
                    let wire = serde_json::to_value(&module).unwrap();
                    assert_eq!(wire["functions"][0]["body"][0]["expr"]["fn"], operation);
                }
            }
        }
        module.functions[0].body = vec![Stmt::Expression {
            expr: Expr::LibCall {
                r#fn: "sym.unknown".into(),
                args: vec![],
                r#type: Type::Symbol,
                loc: loc.clone(),
            },
            loc,
        }];
        assert!(validate(&module).is_err());
    }

    #[test]
    fn regex_contracts_validate_flags_operands_and_wire_names() {
        let mut m = callable_module();
        let loc = m.functions[0].loc.clone();
        let regex = || Expr::RegexLit {
            pattern: "x".into(),
            flags: "g".into(),
            r#type: Type::Regex,
            loc: loc.clone(),
        };
        let value = Expr::RegexIntrinsic {
            method: "test".into(),
            receiver: Box::new(regex()),
            args: vec![Expr::StrLit {
                value: "x".into(),
                r#type: Type::String,
                loc: loc.clone(),
            }],
            r#type: Type::Bool,
            loc: loc.clone(),
        };
        assert_eq!(
            serde_json::to_value(&value).unwrap()["kind"],
            "regexIntrinsic"
        );
        m.functions[0].body = vec![Stmt::Expression {
            expr: value,
            loc: loc.clone(),
        }];
        assert!(validate(&m).is_ok());
        if let Stmt::Expression {
            expr: Expr::RegexIntrinsic { r#type, .. },
            ..
        } = &mut m.functions[0].body[0]
        {
            *r#type = Type::F64;
        }
        assert_eq!(validate(&m).unwrap_err(), "invalid native regex operation");
        m.functions[0].body = vec![Stmt::Expression {
            expr: regex(),
            loc: loc.clone(),
        }];
        if let Stmt::Expression {
            expr: Expr::RegexLit { flags, .. },
            ..
        } = &mut m.functions[0].body[0]
        {
            *flags = "gg".into();
        }
        assert_eq!(validate(&m).unwrap_err(), "invalid native regex flags");
    }

    #[test]
    fn regex_replacement_contracts_reject_malformed_operands() {
        let mut module = callable_module();
        let loc = module.functions[0].loc.clone();
        let text = Expr::StrLit {
            value: "x".into(),
            r#type: Type::String,
            loc: loc.clone(),
        };
        let regex = Expr::RegexLit {
            pattern: "x".into(),
            flags: "g".into(),
            r#type: Type::Regex,
            loc: loc.clone(),
        };
        for method in ["replace", "replaceAll"] {
            for (receiver, args, result, valid) in [
                (
                    text.clone(),
                    vec![regex.clone(), text.clone()],
                    Type::String,
                    true,
                ),
                (
                    regex.clone(),
                    vec![regex.clone(), text.clone()],
                    Type::String,
                    false,
                ),
                (
                    text.clone(),
                    vec![text.clone(), regex.clone()],
                    Type::String,
                    false,
                ),
                (text.clone(), vec![regex.clone()], Type::String, false),
                (
                    text.clone(),
                    vec![regex.clone(), text.clone(), text.clone()],
                    Type::String,
                    false,
                ),
                (
                    text.clone(),
                    vec![regex.clone(), text.clone()],
                    Type::F64,
                    false,
                ),
            ] {
                module.functions[0].body = vec![Stmt::Expression {
                    expr: Expr::RegexIntrinsic {
                        method: method.into(),
                        receiver: Box::new(receiver),
                        args,
                        r#type: result,
                        loc: loc.clone(),
                    },
                    loc: loc.clone(),
                }];
                assert_eq!(validate(&module).is_ok(), valid, "{method}");
                if valid {
                    let wire = serde_json::to_value(&module).unwrap();
                    assert_eq!(wire["irVersion"], VERSION);
                    assert_eq!(
                        wire["functions"][0]["body"][0]["expr"]["kind"],
                        "regexIntrinsic"
                    );
                }
            }
        }
    }

    fn error_module() -> Module {
        let mut m = callable_module();
        let loc = m.functions[0].loc.clone();
        m.classes.push(Class {
            name: "%Error".into(),
            js_name: "Error".into(),
            runtime: true,
            base: None,
            fields: error_fields(),
            methods: vec![],
            symbol_methods: vec![],
            method_names: vec![],
            loc: loc.clone(),
        });
        m.classes.push(Class {
            name: "Detail".into(),
            js_name: "Detail".into(),
            runtime: false,
            base: Some("%Error".into()),
            fields: error_fields(),
            methods: vec![],
            symbol_methods: vec![],
            method_names: vec![],
            loc: loc.clone(),
        });
        m.functions[0].body = vec![Stmt::Expression {
            expr: Expr::FieldGet {
                obj: Box::new(Expr::LibCall {
                    r#fn: "error.new".into(),
                    args: vec![Expr::StrLit {
                        value: "message".into(),
                        r#type: Type::String,
                        loc: loc.clone(),
                    }],
                    r#type: Type::Object {
                        class_name: "%Error".into(),
                    },
                    loc: loc.clone(),
                }),
                class_name: "%Error".into(),
                field: "message".into(),
                r#type: Type::String,
                loc: loc.clone(),
            },
            loc,
        }];
        m
    }

    #[test]
    fn native_value_operations_validate_payloads_and_keep_the_shared_wire_contract() {
        let mut m = error_module();
        let loc = m.functions[0].loc.clone();
        let boxed = || Expr::DynFrom {
            value: Box::new(Expr::StrLit {
                value: "payload".into(),
                r#type: Type::String,
                loc: loc.clone(),
            }),
            r#type: Type::Dyn,
            loc: loc.clone(),
        };
        m.functions[0].body = vec![Stmt::Expression {
            expr: Expr::DynKeyGet {
                value: Box::new(boxed()),
                key: Box::new(Expr::StrLit {
                    value: "length".into(),
                    r#type: Type::String,
                    loc: loc.clone(),
                }),
                r#type: Type::Dyn,
                loc: loc.clone(),
            },
            loc: loc.clone(),
        }];
        assert!(validate(&m).is_ok());
        let wire = serde_json::to_value(&m).unwrap();
        assert_eq!(wire["functions"][0]["body"][0]["expr"]["kind"], "dynKeyGet");
        let Stmt::Expression {
            expr: Expr::DynKeyGet { key, .. },
            ..
        } = &mut m.functions[0].body[0]
        else {
            unreachable!()
        };
        **key = Expr::BoolLit {
            value: true,
            r#type: Type::Bool,
            loc: loc.clone(),
        };
        assert_eq!(
            validate(&m).unwrap_err(),
            "invalid native value member read"
        );
        m.functions[0].body = vec![Stmt::Expression {
            expr: Expr::DynFrom {
                value: Box::new(Expr::UnitLit {
                    unit: "null",
                    r#type: Type::Undefined,
                    loc: loc.clone(),
                }),
                r#type: Type::Dyn,
                loc: loc.clone(),
            },
            loc: loc.clone(),
        }];
        assert_eq!(validate(&m).unwrap_err(), "invalid native boxed unit");
        m.functions[0].body = vec![Stmt::Expression {
            expr: Expr::DynCall {
                callee: Box::new(boxed()),
                callee_name: "payload".into(),
                args: vec![Expr::BoolLit {
                    value: true,
                    r#type: Type::Bool,
                    loc: loc.clone(),
                }],
                r#type: Type::Dyn,
                loc: loc.clone(),
            },
            loc,
        }];
        assert_eq!(validate(&m).unwrap_err(), "invalid native value call");
    }

    #[test]
    fn array_brand_test_keeps_the_shared_dynamic_boolean_contract() {
        let mut module = error_module();
        let loc = module.functions[0].loc.clone();
        for (test, result, valid) in [
            ("array", Type::Bool, true),
            ("array", Type::String, false),
            ("unknown-brand", Type::Bool, false),
        ] {
            module.functions[0].body = vec![Stmt::Expression {
                expr: Expr::DynTest {
                    value: Box::new(Expr::DynObjLit {
                        fields: vec![],
                        r#type: Type::Dyn,
                        loc: loc.clone(),
                    }),
                    test: test.into(),
                    negated: true,
                    r#type: result,
                    loc: loc.clone(),
                },
                loc: loc.clone(),
            }];
            assert_eq!(validate(&module).is_ok(), valid);
            if valid {
                let wire = serde_json::to_value(&module).unwrap();
                assert_eq!(wire["functions"][0]["body"][0]["expr"]["test"], "array");
            }
        }
    }

    #[test]
    fn string_constructor_keeps_the_shared_dynamic_string_contract() {
        let mut module = error_module();
        let loc = module.functions[0].loc.clone();
        let value = Expr::DynObjLit {
            fields: vec![],
            r#type: Type::Dyn,
            loc: loc.clone(),
        };
        for (args, result, valid) in [
            (vec![value.clone()], Type::String, true),
            (vec![], Type::String, false),
            (vec![value.clone(), value.clone()], Type::String, false),
            (vec![value], Type::Bool, false),
            (
                vec![Expr::BoolLit {
                    value: true,
                    r#type: Type::Bool,
                    loc: loc.clone(),
                }],
                Type::String,
                false,
            ),
        ] {
            module.functions[0].body = vec![Stmt::Expression {
                expr: Expr::LibCall {
                    r#fn: "dyn.stringConstructor".into(),
                    args,
                    r#type: result,
                    loc: loc.clone(),
                },
                loc: loc.clone(),
            }];
            assert_eq!(validate(&module).is_ok(), valid);
        }
    }

    #[test]
    fn promise_resolve_validates_payloads_and_inventories_temporary_types() {
        let mut m = error_module();
        let loc = m.functions[0].loc.clone();
        let resolve = |inner, args| Expr::Intrinsic {
            name: "promise.resolve".into(),
            args,
            r#type: Type::Promise {
                inner: Box::new(inner),
            },
            loc: loc.clone(),
        };
        m.functions[0].body = vec![Stmt::Expression {
            expr: resolve(Type::Void, vec![]),
            loc: loc.clone(),
        }];
        validate(&m).unwrap();
        let array = Expr::ArrayLit {
            elems: vec![],
            r#type: Type::Array {
                elem: Box::new(Type::F64),
            },
            loc: loc.clone(),
        };
        m.functions[0].body = vec![Stmt::Expression {
            expr: resolve(array.ty(), vec![array]),
            loc: loc.clone(),
        }];
        validate(&m).unwrap();
        let mut inventory = Vec::new();
        m.visit_expressions(&mut |e| inventory.push(e.ty()));
        assert!(inventory.contains(&Type::Array {
            elem: Box::new(Type::F64)
        }));
        let wire = serde_json::to_value(&m).unwrap();
        assert_eq!(
            wire["functions"][0]["body"][0]["expr"]["type"]["kind"],
            "promise"
        );
        assert_eq!(
            wire["functions"][0]["body"][0]["expr"]["name"],
            "promise.resolve"
        );
        for (inner, args) in [
            (Type::F64, vec![]),
            (
                Type::Void,
                vec![Expr::NumLit {
                    value: 1.0,
                    spelling: None,
                    r#type: Type::F64,
                    loc: loc.clone(),
                }],
            ),
            (
                Type::String,
                vec![Expr::BoolLit {
                    value: true,
                    r#type: Type::Bool,
                    loc: loc.clone(),
                }],
            ),
        ] {
            m.functions[0].body = vec![Stmt::Expression {
                expr: resolve(inner, args),
                loc: loc.clone(),
            }];
            assert_eq!(validate(&m).unwrap_err(), "invalid native Promise.resolve");
        }
    }

    #[test]
    fn erased_map_invocation_validates_owned_receiver_and_arguments() {
        let mut m = error_module();
        let loc = m.functions[0].loc.clone();
        let value = || Expr::DynFrom {
            value: Box::new(Expr::UnitLit {
                unit: "undefined",
                r#type: Type::Undefined,
                loc: loc.clone(),
            }),
            r#type: Type::Dyn,
            loc: loc.clone(),
        };
        let invoke = || Expr::DynInvoke {
            recv: Box::new(value()),
            method: "get".into(),
            callee_name: "map.get".into(),
            args: vec![value()],
            r#type: Type::Dyn,
            loc: loc.clone(),
        };
        m.functions[0].body = vec![Stmt::Expression {
            expr: invoke(),
            loc: loc.clone(),
        }];
        validate(&m).unwrap();
        let wire = serde_json::to_value(&m).unwrap();
        assert_eq!(wire["functions"][0]["body"][0]["expr"]["kind"], "dynInvoke");
        assert_eq!(
            wire["functions"][0]["body"][0]["expr"]["calleeName"],
            "map.get"
        );
        for part in ["receiver", "argument", "result"] {
            let mut invalid = error_module();
            invalid.functions[0].body = vec![Stmt::Expression {
                expr: invoke(),
                loc: loc.clone(),
            }];
            let Stmt::Expression {
                expr: Expr::DynInvoke {
                    recv, args, r#type, ..
                },
                ..
            } = &mut invalid.functions[0].body[0]
            else {
                unreachable!()
            };
            match part {
                "receiver" => {
                    **recv = Expr::BoolLit {
                        value: true,
                        r#type: Type::Bool,
                        loc: loc.clone(),
                    }
                }
                "argument" => {
                    args[0] = Expr::BoolLit {
                        value: true,
                        r#type: Type::Bool,
                        loc: loc.clone(),
                    }
                }
                _ => *r#type = Type::Bool,
            }
            assert_eq!(
                validate(&invalid).unwrap_err(),
                "invalid native method invocation"
            );
        }
        m.functions[0].body = vec![Stmt::Expression {
            expr: Expr::MapNew {
                seed: vec![],
                r#type: Type::Map {
                    key: Box::new(Type::Dyn),
                    value: Box::new(Type::Dyn),
                },
                loc: loc.clone(),
            },
            loc,
        }];
        validate(&m).unwrap();
    }

    #[test]
    fn method_dispatch_validates_receivers_overrides_and_walks_arguments() {
        let mut m = callable_module();
        let loc = m.functions[0].loc.clone();
        let receiver = |name: &str| Type::Object {
            class_name: name.into(),
        };
        for (name, base) in [("Base", None), ("Child", Some("Base"))] {
            m.classes.push(Class {
                name: name.into(),
                js_name: name.into(),
                runtime: false,
                base: base.map(String::from),
                fields: vec![],
                methods: vec!["value".into()],
                symbol_methods: vec![],
                method_names: vec!["value".into()],
                loc: loc.clone(),
            });
            m.functions.push(Function {
                is_async: false,
                rest: false,
                name: format!("%{name}.value"),
                captures: None,
                params: vec![Param {
                    local_id: "p0".into(),
                    name: "this".into(),
                    r#type: receiver(name),
                }],
                locals: vec![Local {
                    id: "p0".into(),
                    name: "this".into(),
                    r#type: receiver(name),
                    mutable: false,
                    boxed: false,
                }],
                return_type: Type::F64,
                body: vec![Stmt::Return {
                    value: Some(Expr::NumLit {
                        value: 1.0,
                        spelling: None,
                        r#type: Type::F64,
                        loc: loc.clone(),
                    }),
                    loc: loc.clone(),
                }],
                loc: loc.clone(),
            });
        }
        m.functions.push(Function {
            is_async: false,
            rest: false,
            name: "dispatch".into(),
            captures: None,
            params: vec![Param {
                local_id: "p0".into(),
                name: "this".into(),
                r#type: receiver("Base"),
            }],
            locals: vec![Local {
                id: "p0".into(),
                name: "this".into(),
                r#type: receiver("Base"),
                mutable: false,
                boxed: false,
            }],
            return_type: Type::F64,
            body: vec![Stmt::Return {
                value: Some(Expr::VirtualCall {
                    class_name: "Base".into(),
                    method: "value".into(),
                    args: vec![Expr::VarRef {
                        local_id: "p0".into(),
                        r#type: receiver("Base"),
                        loc: loc.clone(),
                    }],
                    r#type: Type::F64,
                    loc: loc.clone(),
                }),
                loc: loc.clone(),
            }],
            loc,
        });
        validate(&m).unwrap();
        let mut dispatches = 0;
        let mut receiver_reads = 0;
        m.visit_expressions(&mut |value| {
            if matches!(value, Expr::VirtualCall { .. }) {
                dispatches += 1;
            }
            if matches!(
                value,
                Expr::VarRef {
                    r#type: Type::Object { .. },
                    ..
                }
            ) {
                receiver_reads += 1;
            }
        });
        assert_eq!((dispatches, receiver_reads), (1, 1));
        let wire = serde_json::to_value(&m).unwrap();
        assert_eq!(
            wire["classes"][0]["methodNames"],
            serde_json::json!(["value"])
        );
        assert_eq!(
            wire["functions"][4]["body"][0]["value"]["kind"],
            "virtualCall"
        );
        m.functions[3].return_type = Type::String;
        assert_eq!(
            validate(&m).unwrap_err(),
            "incompatible native method override"
        );
        m.functions[3].return_type = Type::F64;
        m.functions[3].params[0].r#type = receiver("Base");
        assert_eq!(
            validate(&m).unwrap_err(),
            "invalid native method declaration/receiver"
        );
        m.functions[3].params[0].r#type = receiver("Child");
        m.classes[1].methods.clear();
        assert_eq!(
            validate(&m).unwrap_err(),
            "invalid native virtual call ABI/override"
        );
        m.classes[1].methods.push("value".into());
        m.classes[1].method_names.clear();
        assert_eq!(
            validate(&m).unwrap_err(),
            "invalid native method declaration/receiver"
        );
        m.classes[1].method_names.push("value".into());
        m.functions[3].name = "missing".into();
        assert_eq!(validate(&m).unwrap_err(), "missing native method function");
    }

    #[test]
    fn ordinary_layouts_validate_headers_slots_and_ancestry_independently() {
        let mut m = error_module();
        let loc = m.functions[0].loc.clone();
        m.unions.push(Union {
            id: 0,
            arms: vec![Type::F64, Type::Undefined],
        });
        let root = Class {
            name: "Box".into(),
            js_name: "Box".into(),
            runtime: false,
            base: None,
            fields: vec![Field {
                name: "name".into(),
                r#type: Type::Union { union_id: 0 },
            }],
            methods: vec![],
            symbol_methods: vec![],
            method_names: vec![],
            loc: loc.clone(),
        };
        let child = Class {
            name: "Child".into(),
            js_name: "Child".into(),
            base: Some(root.name.clone()),
            ..root.clone()
        };
        m.classes.extend([root.clone(), child.clone()]);
        validate(&m).unwrap();
        assert_eq!(m.class_header_len(&root), 0);
        assert_eq!(m.class_header_len(&m.classes[1]), error_fields().len());
        for invalid in [
            Class {
                runtime: true,
                ..root.clone()
            },
            Class {
                base: Some("Missing".into()),
                ..root.clone()
            },
            Class {
                base: Some("Child".into()),
                ..root.clone()
            },
            Class {
                fields: vec![],
                ..child.clone()
            },
            Class {
                fields: vec![Field {
                    name: "value".into(),
                    r#type: Type::F64,
                }],
                ..root.clone()
            },
            Class {
                fields: vec![Field {
                    name: "%cause".into(),
                    r#type: Type::Dyn,
                }],
                ..root.clone()
            },
        ] {
            let index = if invalid.name == "Child" { 3 } else { 2 };
            let previous = std::mem::replace(&mut m.classes[index], invalid);
            assert!(validate(&m).is_err());
            m.classes[index] = previous;
        }
        let test = Expr::LibCall {
            r#fn: "dyn.classInstanceof".into(),
            args: vec![
                Expr::DynObjLit {
                    fields: vec![],
                    r#type: Type::Dyn,
                    loc: loc.clone(),
                },
                Expr::StrLit {
                    value: "Box".into(),
                    r#type: Type::String,
                    loc: loc.clone(),
                },
            ],
            r#type: Type::Bool,
            loc: loc.clone(),
        };
        m.functions[0].body = vec![Stmt::Expression { expr: test, loc }];
        validate(&m).unwrap();
        if let Stmt::Expression {
            expr: Expr::LibCall { r#fn, .. },
            ..
        } = &mut m.functions[0].body[0]
        {
            *r#fn = "dyn.errInstanceof".into();
        }
        assert_eq!(
            validate(&m).unwrap_err(),
            "invalid native erased instanceof"
        );
    }

    #[test]
    fn error_layouts_validate_prefixes_roots_and_reserved_metadata() {
        let mut m = error_module();
        assert!(validate(&m).is_ok());
        m.classes[1].fields[0].r#type = Type::Bool;
        assert!(validate(&m).unwrap_err().contains("class/header"));
        m = error_module();
        m.classes[1].base = Some("Detail".into());
        assert!(validate(&m).is_err());
        m = error_module();
        m.classes[1].fields.push(Field {
            name: "uninitialized".into(),
            r#type: Type::String,
        });
        assert!(validate(&m).is_err());
        m = error_module();
        m.functions[0].locals.push(Local {
            id: "void_local".into(),
            name: "void_local".into(),
            r#type: Type::Void,
            mutable: false,
            boxed: false,
        });
        assert_eq!(validate(&m).unwrap_err(), "duplicate/void local");
        m = error_module();
        m.unions.push(Union {
            id: 0,
            arms: vec![
                Type::Object {
                    class_name: "%Error".into(),
                },
                Type::Object {
                    class_name: "Detail".into(),
                },
            ],
        });
        assert_eq!(validate(&m).unwrap_err(), "invalid/recursive union layout");
    }

    #[test]
    fn constructor_values_validate_identity_and_completed_abi() {
        let mut m = error_module();
        let loc = m.functions[0].loc.clone();
        let classval = Type::Classval {
            class_name: "Detail".into(),
        };
        let object = Type::Object {
            class_name: "Detail".into(),
        };
        let reference = || Expr::ClassRef {
            class_name: "Detail".into(),
            r#type: classval.clone(),
            loc: loc.clone(),
        };
        m.functions[0].body = vec![Stmt::Expression {
            expr: reference(),
            loc: loc.clone(),
        }];
        assert_eq!(validate(&m).unwrap_err(), "invalid native class value");
        m.functions.push(Function {
            is_async: false,
            rest: false,
            name: "%Detail.constructor".into(),
            params: vec![Param {
                local_id: "p0".into(),
                name: "this".into(),
                r#type: object.clone(),
            }],
            captures: None,
            return_type: Type::Void,
            locals: vec![Local {
                id: "p0".into(),
                name: "this".into(),
                r#type: object.clone(),
                mutable: true,
                boxed: false,
            }],
            body: vec![],
            loc: loc.clone(),
        });
        assert!(validate(&m).is_ok());
        m.functions[0].body = vec![Stmt::Expression {
            expr: Expr::NewValue {
                callee: Box::new(reference()),
                args: vec![],
                r#type: object,
                loc: loc.clone(),
            },
            loc: loc.clone(),
        }];
        assert!(validate(&m).is_ok());
        let wire = serde_json::to_value(&m).unwrap();
        assert_eq!(wire["functions"][0]["body"][0]["expr"]["kind"], "newValue");
        assert_eq!(
            wire["functions"][0]["body"][0]["expr"]["callee"]["type"]["kind"],
            "classval"
        );
        assert_eq!(
            wire["functions"][0]["body"][0]["expr"]["callee"]["className"],
            "Detail"
        );
        if let Stmt::Expression {
            expr: Expr::NewValue { r#type, .. },
            ..
        } = &mut m.functions[0].body[0]
        {
            *r#type = Type::Object {
                class_name: "%Error".into(),
            };
        }
        assert_eq!(
            validate(&m).unwrap_err(),
            "native constructor value has a different class"
        );
        m.functions[0].body = vec![Stmt::Expression {
            expr: reference(),
            loc,
        }];
        let ctor = m.functions.last_mut().unwrap();
        ctor.params[0].r#type = Type::F64;
        ctor.locals[0].r#type = Type::F64;
        assert_eq!(validate(&m).unwrap_err(), "invalid native class value");
    }

    #[test]
    fn error_operations_require_typed_fields_related_casts_and_constructors() {
        let mut m = error_module();
        let loc = m.functions[0].loc.clone();
        if let Stmt::Expression {
            expr: Expr::FieldGet { field, .. },
            ..
        } = &mut m.functions[0].body[0]
        {
            *field = "missing".into();
        }
        assert_eq!(validate(&m).unwrap_err(), "invalid native field read");
        m.functions[0].body = vec![Stmt::Expression {
            expr: Expr::New {
                class_name: "Detail".into(),
                args: vec![],
                r#type: Type::Object {
                    class_name: "Detail".into(),
                },
                loc: loc.clone(),
            },
            loc,
        }];
        assert_eq!(validate(&m).unwrap_err(), "missing native constructor");
    }

    #[test]
    fn tuple_layouts_require_dense_positions_and_keep_the_wire_flag() {
        let mut m = record_module();
        m.records[0].tuple = true;
        assert_eq!(validate(&m).unwrap_err(), "invalid tuple positions");
        m.records[0].fields[0].name = "0".into();
        m.records[0].declared_order = vec!["0".into()];
        m.functions[0].body.clear();
        validate(&m).unwrap();
        assert_eq!(serde_json::to_value(&m.records[0]).unwrap()["tuple"], true);
        m.records[0].tuple = false;
        assert!(
            serde_json::to_value(&m.records[0])
                .unwrap()
                .get("tuple")
                .is_none()
        );
        m.records[0].tuple = true;
        m.records[0].index_value = Some(Type::F64);
        assert!(validate(&m).is_err());
    }

    #[test]
    fn loop_bodies_do_not_initialize_outer_reads_and_conditions_are_boolean() {
        let mut m = callable_module();
        let loc = m.functions[0].loc.clone();
        m.functions[0].locals.push(Local {
            id: "temp".into(),
            name: "temp".into(),
            r#type: Type::F64,
            mutable: false,
            boxed: false,
        });
        m.functions[0].body = vec![
            Stmt::While {
                cond: Expr::BoolLit {
                    value: false,
                    r#type: Type::Bool,
                    loc: loc.clone(),
                },
                body: vec![Stmt::VarDecl {
                    local_id: "temp".into(),
                    init: Expr::NumLit {
                        value: 1.0,
                        spelling: None,
                        r#type: Type::F64,
                        loc: loc.clone(),
                    },
                    loc: loc.clone(),
                }],
                loc: loc.clone(),
            },
            Stmt::Expression {
                expr: Expr::VarRef {
                    local_id: "temp".into(),
                    r#type: Type::F64,
                    loc: loc.clone(),
                },
                loc: loc.clone(),
            },
        ];
        assert!(validate(&m).is_err());
        m.functions[0].body.pop();
        validate(&m).unwrap();
        if let Stmt::While { cond, .. } = &mut m.functions[0].body[0] {
            *cond = Expr::NumLit {
                value: 1.0,
                spelling: None,
                r#type: Type::F64,
                loc,
            };
        }
        assert_eq!(validate(&m).unwrap_err(), "non-boolean loop condition");
    }

    #[test]
    fn array_sequence_intrinsics_validate_indices_and_preserve_element_abi() {
        let mut module = callable_module();
        let loc = module.functions[0].loc.clone();
        let array = Type::Array {
            elem: Box::new(Type::F64),
        };
        let number = Expr::NumLit {
            value: 1.0,
            spelling: None,
            r#type: Type::F64,
            loc: loc.clone(),
        };
        for (method, args, result, valid) in [
            ("slice", vec![], array.clone(), true),
            ("slice", vec![number.clone()], array.clone(), true),
            (
                "slice",
                vec![number.clone(), number.clone()],
                array.clone(),
                true,
            ),
            (
                "slice",
                vec![number.clone(), number.clone(), number.clone()],
                array.clone(),
                false,
            ),
            (
                "slice",
                vec![],
                Type::Array {
                    elem: Box::new(Type::String),
                },
                false,
            ),
            ("nextPresent", vec![number.clone()], Type::F64, true),
            ("nextPresent", vec![], Type::F64, false),
            ("nextPresent", vec![number], Type::Bool, false),
        ] {
            module.functions[0].body = vec![Stmt::Expression {
                expr: Expr::ArrayIntrinsic {
                    method: method.into(),
                    receiver: Box::new(Expr::ArrayLit {
                        elems: vec![],
                        r#type: array.clone(),
                        loc: loc.clone(),
                    }),
                    args,
                    r#type: result,
                    loc: loc.clone(),
                },
                loc: loc.clone(),
            }];
            assert_eq!(validate(&module).is_ok(), valid, "{method}");
        }
    }

    #[test]
    fn array_push_checks_every_argument_and_the_result_type() {
        let mut m = callable_module();
        let loc = m.functions[0].loc.clone();
        m.functions[0].body = vec![Stmt::Expression {
            expr: Expr::ArrayIntrinsic {
                method: "push".into(),
                receiver: Box::new(Expr::ArrayLit {
                    elems: vec![],
                    r#type: Type::Array {
                        elem: Box::new(Type::F64),
                    },
                    loc: loc.clone(),
                }),
                args: vec![Expr::StrLit {
                    value: "wrong".into(),
                    r#type: Type::String,
                    loc: loc.clone(),
                }],
                r#type: Type::F64,
                loc: loc.clone(),
            },
            loc,
        }];
        assert_eq!(validate(&m).unwrap_err(), "invalid array operation");
        if let Stmt::Expression {
            expr: Expr::ArrayIntrinsic { args, .. },
            ..
        } = &mut m.functions[0].body[0]
        {
            args.clear();
        }
        validate(&m).unwrap();
    }

    #[test]
    fn array_pop_requires_an_undefined_capable_result_and_no_ir_arguments() {
        let mut m = callable_module();
        let loc = m.functions[0].loc.clone();
        let union_id = m.unions.len();
        m.unions.push(Union {
            id: union_id,
            arms: vec![Type::F64, Type::Undefined],
        });
        let result = Type::Union { union_id };
        m.functions[0].body = vec![Stmt::Expression {
            expr: Expr::ArrayIntrinsic {
                method: "pop".into(),
                receiver: Box::new(Expr::ArrayLit {
                    elems: vec![],
                    r#type: Type::Array {
                        elem: Box::new(Type::F64),
                    },
                    loc: loc.clone(),
                }),
                args: vec![],
                r#type: result.clone(),
                loc: loc.clone(),
            },
            loc: loc.clone(),
        }];
        validate(&m).unwrap();
        if let Stmt::Expression {
            expr: Expr::ArrayIntrinsic { r#type, .. },
            ..
        } = &mut m.functions[0].body[0]
        {
            *r#type = Type::F64;
        }
        assert_eq!(validate(&m).unwrap_err(), "invalid array operation");
        if let Stmt::Expression {
            expr: Expr::ArrayIntrinsic { r#type, args, .. },
            ..
        } = &mut m.functions[0].body[0]
        {
            *r#type = result.clone();
            args.push(Expr::NumLit {
                value: 0.0,
                spelling: None,
                r#type: Type::F64,
                loc: loc.clone(),
            });
        }
        assert_eq!(validate(&m).unwrap_err(), "invalid array operation");
        if let Stmt::Expression {
            expr: Expr::ArrayIntrinsic { receiver, args, .. },
            ..
        } = &mut m.functions[0].body[0]
        {
            args.clear();
            **receiver = Expr::ArrayLit {
                elems: vec![],
                r#type: Type::Array {
                    elem: Box::new(result),
                },
                loc,
            };
        }
        validate(&m).unwrap();
    }

    #[test]
    fn owned_container_layouts_validate_edges_and_keep_the_wire_contract() {
        let mut m = record_module();
        let array = Type::Array {
            elem: Box::new(Type::Record { shape_id: 0 }),
        };
        assert!(m.valid_type(array.clone(), &mut vec![]));
        let wire = serde_json::to_value(&array).unwrap();
        assert_eq!(
            wire,
            serde_json::json!({"kind":"array", "elem":{"kind":"record", "shapeId":"r0"}})
        );
        m.records[0].fields[0].r#type = array.clone();
        assert!(
            m.valid_type(array, &mut vec![]),
            "array and record handles guard recursive element storage"
        );
        assert!(!m.valid_type(
            Type::Array {
                elem: Box::new(Type::Func {
                    rest: false,
                    params: vec![],
                    ret: Box::new(Type::Void)
                })
            },
            &mut vec![]
        ));
    }

    #[test]
    fn global_storage_requires_unique_layouts_and_an_unconditional_initializer() {
        let mut m = callable_module();
        let loc = m.functions[0].loc.clone();
        m.globals.push(Global {
            id: "%g.0".into(),
            name: "answer".into(),
            r#type: Type::F64,
            mutable: false,
        });
        assert!(validate(&m).unwrap_err().contains("global storage"));
        let write = || Stmt::Assign {
            local_id: "%g.0".into(),
            initializes_global: true,
            value: Expr::NumLit {
                value: 42.0,
                spelling: None,
                r#type: Type::F64,
                loc: loc.clone(),
            },
            loc: loc.clone(),
        };
        m.functions[0].body.insert(0, write());
        validate(&m).unwrap();
        m.functions[0].body.push(write());
        assert_eq!(validate(&m).unwrap_err(), "invalid global assignment");
        if let Stmt::Assign {
            initializes_global, ..
        } = m.functions[0].body.last_mut().unwrap()
        {
            *initializes_global = false;
        }
        assert_eq!(validate(&m).unwrap_err(), "invalid global assignment");
        m.globals[0].mutable = true;
        validate(&m).unwrap();
        m.globals.push(m.globals[0].clone());
        assert!(validate(&m).unwrap_err().contains("global storage"));
    }

    #[test]
    fn dynamic_property_deletion_validates_key_mode_and_boolean_result() {
        let mut m = callable_module();
        m.functions.truncate(1);
        let loc = m.functions[0].loc.clone();
        let operation = Expr::LibCall {
            r#fn: "dyn.keyDelete".into(),
            args: vec![
                Expr::DynObjLit {
                    fields: vec![],
                    r#type: Type::Dyn,
                    loc: loc.clone(),
                },
                Expr::StrLit {
                    value: "key".into(),
                    r#type: Type::String,
                    loc: loc.clone(),
                },
                Expr::BoolLit {
                    value: true,
                    r#type: Type::Bool,
                    loc: loc.clone(),
                },
            ],
            r#type: Type::Bool,
            loc: loc.clone(),
        };
        m.functions[0].body = vec![Stmt::Expression {
            expr: operation,
            loc,
        }];
        validate(&m).unwrap();
        for kind in 0..3 {
            let mut invalid = callable_module();
            invalid.functions.truncate(1);
            invalid.functions[0].body = m.functions[0].body.clone();
            let Stmt::Expression {
                expr: Expr::LibCall { args, r#type, .. },
                ..
            } = &mut invalid.functions[0].body[0]
            else {
                unreachable!()
            };
            if kind == 0 {
                *r#type = Type::Void;
            } else if kind == 1 {
                args[2] = args[1].clone();
            } else {
                args.pop();
            }
            assert_eq!(
                validate(&invalid).unwrap_err(),
                "invalid native dynamic property deletion"
            );
        }
    }

    #[test]
    fn object_binding_source_check_requires_one_owning_value_and_no_result() {
        let mut module = callable_module();
        module.functions.truncate(1);
        let loc = module.functions[0].loc.clone();
        let value = Expr::DynObjLit {
            fields: vec![],
            r#type: Type::Dyn,
            loc: loc.clone(),
        };
        module.functions[0].body = vec![Stmt::Expression {
            expr: Expr::LibCall {
                r#fn: "dyn.objectRestCheck".into(),
                args: vec![value],
                r#type: Type::Void,
                loc: loc.clone(),
            },
            loc,
        }];
        validate(&module).unwrap();
        for kind in 0..3 {
            let mut invalid = callable_module();
            invalid.functions.truncate(1);
            invalid.functions[0].body = module.functions[0].body.clone();
            let Stmt::Expression {
                expr: Expr::LibCall {
                    args, r#type, loc, ..
                },
                ..
            } = &mut invalid.functions[0].body[0]
            else {
                unreachable!()
            };
            match kind {
                0 => {
                    args.clear();
                }
                1 => *r#type = Type::Dyn,
                _ => {
                    args[0] = Expr::StrLit {
                        value: "wrong".into(),
                        r#type: Type::String,
                        loc: loc.clone(),
                    }
                }
            }
            assert_eq!(
                validate(&invalid).unwrap_err(),
                "invalid native object binding source check"
            );
        }
    }

    #[test]
    fn regex_replacement_callback_validates_its_owning_abi() {
        let mut module = callable_module();
        module.functions.truncate(1);
        let loc = module.functions[0].loc.clone();
        let operation = Expr::LibCall {
            r#fn: "regex.replaceCaptures".into(),
            args: vec![
                Expr::StrLit {
                    value: "a".into(),
                    r#type: Type::String,
                    loc: loc.clone(),
                },
                Expr::RegexLit {
                    pattern: "(a)".into(),
                    flags: "g".into(),
                    r#type: Type::Regex,
                    loc: loc.clone(),
                },
                Expr::DynObjLit {
                    fields: vec![],
                    r#type: Type::Dyn,
                    loc: loc.clone(),
                },
                Expr::BoolLit {
                    value: false,
                    r#type: Type::Bool,
                    loc: loc.clone(),
                },
            ],
            r#type: Type::String,
            loc: loc.clone(),
        };
        module.functions[0].body = vec![Stmt::Expression {
            expr: operation,
            loc,
        }];
        validate(&module).unwrap();
        for index in 0..5 {
            let mut invalid = callable_module();
            invalid.functions.truncate(1);
            invalid.functions[0].body = module.functions[0].body.clone();
            let Stmt::Expression {
                expr: Expr::LibCall { args, r#type, .. },
                ..
            } = &mut invalid.functions[0].body[0]
            else {
                unreachable!()
            };
            match index {
                0 => {
                    args.pop();
                }
                1 => *r#type = Type::Void,
                2 => args[1] = args[0].clone(),
                3 => args[2] = args[0].clone(),
                _ => args[3] = args[0].clone(),
            }
            assert_eq!(
                validate(&invalid).unwrap_err(),
                "invalid native regex replacement callback"
            );
        }
    }

    #[test]
    fn dynamic_property_writes_keep_the_shared_void_signature() {
        let mut m = callable_module();
        m.functions.truncate(1);
        m.functions[0].body.clear();
        let loc = m.functions[0].loc.clone();
        m.functions[0].body.push(Stmt::Expression {
            expr: Expr::LibCall {
                r#fn: "dyn.keySet".into(),
                args: vec![
                    Expr::DynObjLit {
                        fields: vec![],
                        r#type: Type::Dyn,
                        loc: loc.clone(),
                    },
                    Expr::StrLit {
                        value: "field".into(),
                        r#type: Type::String,
                        loc: loc.clone(),
                    },
                    Expr::DynObjLit {
                        fields: vec![],
                        r#type: Type::Dyn,
                        loc: loc.clone(),
                    },
                ],
                r#type: Type::Void,
                loc: loc.clone(),
            },
            loc,
        });
        validate(&m).unwrap();
        if let Stmt::Expression {
            expr: Expr::LibCall { r#type, .. },
            ..
        } = &mut m.functions[0].body[0]
        {
            *r#type = Type::Dyn;
        }
        assert_eq!(
            validate(&m).unwrap_err(),
            "invalid native dynamic property write"
        );
        if let Stmt::Expression {
            expr: Expr::LibCall { r#type, args, .. },
            ..
        } = &mut m.functions[0].body[0]
        {
            *r#type = Type::Void;
            args.pop();
        }
        assert_eq!(
            validate(&m).unwrap_err(),
            "invalid native dynamic property write"
        );
    }

    #[test]
    fn a_module_thunk_owns_one_global_initializer() {
        let mut m = callable_module();
        let loc = m.functions[0].loc.clone();
        m.globals.push(Global {
            id: "%g.0".into(),
            name: "exports".into(),
            r#type: Type::Dyn,
            mutable: true,
        });
        let initializer = Stmt::Assign {
            local_id: "%g.0".into(),
            initializes_global: true,
            value: Expr::DynObjLit {
                fields: vec![],
                r#type: Type::Dyn,
                loc: loc.clone(),
            },
            loc: loc.clone(),
        };
        m.functions.push(Function {
            is_async: false,
            rest: false,
            name: "module_thunk".into(),
            params: vec![],
            captures: None,
            return_type: Type::Void,
            locals: vec![],
            body: vec![initializer],
            loc,
        });
        validate(&m).unwrap();
        assert!(m.initializes(
            &m.functions.last().unwrap().body[0],
            m.functions.last().unwrap(),
            "%g.0"
        ));
        let bad = Stmt::Assign {
            local_id: "%g.0".into(),
            initializes_global: true,
            value: Expr::DynObjLit {
                fields: vec![],
                r#type: Type::Dyn,
                loc: m.functions[0].loc.clone(),
            },
            loc: m.functions[0].loc.clone(),
        };
        m.functions[0].body.push(bad);
        assert_eq!(validate(&m).unwrap_err(), "invalid global assignment");
    }

    #[test]
    fn map_lookups_require_typed_keys_and_an_undefined_arm() {
        let mut m = callable_module();
        m.functions.truncate(1);
        let loc = m.functions[0].loc.clone();
        m.unions.push(Union {
            id: 0,
            arms: vec![Type::F64, Type::Undefined],
        });
        let map = || Expr::MapNew {
            seed: vec![],
            r#type: Type::Map {
                key: Box::new(Type::String),
                value: Box::new(Type::F64),
            },
            loc: loc.clone(),
        };
        let get = || Expr::MapIntrinsic {
            method: "get".into(),
            receiver: Box::new(map()),
            args: vec![Expr::StrLit {
                value: "missing".into(),
                r#type: Type::String,
                loc: loc.clone(),
            }],
            r#type: Type::Union { union_id: 0 },
            loc: loc.clone(),
        };
        m.functions[0].body = vec![Stmt::Expression {
            expr: get(),
            loc: loc.clone(),
        }];
        assert!(validate(&m).is_ok());
        if let Stmt::Expression {
            expr: Expr::MapIntrinsic { r#type, .. },
            ..
        } = &mut m.functions[0].body[0]
        {
            *r#type = Type::F64;
        }
        assert_eq!(validate(&m).unwrap_err(), "invalid Map operation");
        m.functions[0].body = vec![Stmt::Expression {
            expr: get(),
            loc: loc.clone(),
        }];
        if let Stmt::Expression {
            expr: Expr::MapIntrinsic { args, .. },
            ..
        } = &mut m.functions[0].body[0]
        {
            args[0] = Expr::BoolLit {
                value: true,
                r#type: Type::Bool,
                loc: loc.clone(),
            };
        }
        assert_eq!(validate(&m).unwrap_err(), "invalid Map operation");
        m.functions[0].body = vec![Stmt::Expression {
            expr: map(),
            loc: loc.clone(),
        }];
        if let Stmt::Expression {
            expr: Expr::MapNew { r#type, .. },
            ..
        } = &mut m.functions[0].body[0]
        {
            *r#type = Type::Map {
                key: Box::new(Type::Bool),
                value: Box::new(Type::F64),
            };
        }
        assert_eq!(validate(&m).unwrap_err(), "invalid Map layout");
    }

    #[test]
    fn shared_layout_dags_validate_without_expanding_every_path() {
        let mut m = callable_module();
        m.functions.truncate(1);
        m.records.clear();
        m.unions.clear();
        for id in 0..36 {
            let child = if id == 35 {
                Type::F64
            } else {
                Type::Record { shape_id: id + 1 }
            };
            m.records.push(Record {
                id,
                fields: vec![
                    Field {
                        name: "a".into(),
                        r#type: child.clone(),
                    },
                    Field {
                        name: "b".into(),
                        r#type: child,
                    },
                ],
                declared_order: vec!["a".into(), "b".into()],
                tuple: false,
                index_value: None,
            });
        }
        assert!(m.validate_layouts().is_ok());
        // A later IR edit starts a fresh proof; cached child success must not
        // hide the newly invalid sibling.
        m.records[35].fields[1].r#type = Type::Object {
            class_name: "missing".into(),
        };
        assert!(
            m.validate_layouts()
                .unwrap_err()
                .starts_with("invalid/recursive record layout")
        );
    }

    #[test]
    fn layout_proofs_keep_missing_siblings_and_unguarded_cycles_invalid() {
        let mut m = callable_module();
        m.functions.truncate(1);
        m.records = vec![Record {
            id: 0,
            fields: vec![
                Field {
                    name: "a".into(),
                    r#type: Type::Union { union_id: 0 },
                },
                Field {
                    name: "b".into(),
                    r#type: Type::Undefined,
                },
            ],
            declared_order: vec!["a".into(), "b".into()],
            tuple: false,
            index_value: None,
        }];
        m.unions = vec![Union {
            id: 0,
            arms: vec![Type::Record { shape_id: 0 }, Type::Undefined],
        }];
        assert!(m.validate_layouts().is_err());
        m.records[0].fields[1].r#type = Type::Dyn;
        assert!(m.validate_layouts().is_ok());
        m.unions[0].arms = vec![Type::Union { union_id: 0 }, Type::F64];
        assert!(m.validate_layouts().is_err());
    }

    #[test]
    fn indexed_layouts_accept_guarded_cycles_and_reject_incompatible_overflow() {
        let mut m = callable_module();
        m.functions.truncate(1);
        let loc = m.functions[0].loc.clone();
        m.records.push(Record {
            id: 0,
            fields: vec![],
            declared_order: vec![],
            tuple: false,
            index_value: Some(Type::F64),
        });
        m.functions[0].body = vec![Stmt::Expression {
            expr: Expr::RecordLit {
                fields: vec![FieldInit {
                    name: "key".into(),
                    value: Expr::BoolLit {
                        value: true,
                        r#type: Type::Bool,
                        loc: loc.clone(),
                    },
                    absent: false,
                    overflow: true,
                }],
                r#type: Type::Record { shape_id: 0 },
                loc: loc.clone(),
            },
            loc,
        }];
        assert_eq!(validate(&m).unwrap_err(), "invalid overflow initializer");
        m.records[0].index_value = Some(Type::Bool);
        assert!(validate(&m).is_ok());
        m.records[0].index_value = Some(Type::Record { shape_id: 0 });
        assert!(m.valid_type(Type::Record { shape_id: 0 }, &mut vec![]));
        assert_eq!(validate(&m).unwrap_err(), "invalid overflow initializer");
        m.records[0].index_value = Some(Type::Func {
            rest: false,
            params: vec![],
            ret: Box::new(Type::F64),
        });
        let error = validate(&m).unwrap_err();
        assert!(error.starts_with("invalid/recursive record layout r0:"));
        assert!(error.contains("index_value: Some(Func"));
    }

    #[test]
    fn array_union_payloads_keep_their_element_types() {
        let mut m = callable_module();
        m.functions.truncate(1);
        let loc = m.functions[0].loc.clone();
        let array = Type::Array {
            elem: Box::new(Type::String),
        };
        m.unions.push(Union {
            id: 0,
            arms: vec![array.clone(), Type::Undefined],
        });
        m.functions[0].body = vec![Stmt::Expression {
            expr: Expr::UnionWrap {
                union_id: "u0".into(),
                tag: 0,
                value: Box::new(Expr::ArrayLit {
                    elems: vec![],
                    r#type: array,
                    loc: loc.clone(),
                }),
                r#type: Type::Union { union_id: 0 },
                loc: loc.clone(),
            },
            loc,
        }];
        assert!(validate(&m).is_ok());
        m.unions[0].arms[0] = Type::Array {
            elem: Box::new(Type::F64),
        };
        assert!(validate(&m).is_err());
    }

    fn capturing_module() -> Module {
        let mut m = callable_module();
        let loc = m.functions[0].loc.clone();
        m.functions[0].locals = vec![Local {
            id: "v0".into(),
            name: "count".into(),
            r#type: Type::F64,
            mutable: true,
            boxed: true,
        }];
        m.functions[0].body = vec![
            Stmt::VarDecl {
                local_id: "v0".into(),
                init: Expr::NumLit {
                    value: 1.0,
                    spelling: None,
                    r#type: Type::F64,
                    loc: loc.clone(),
                },
                loc: loc.clone(),
            },
            Stmt::Expression {
                expr: Expr::Closure {
                    fn_name: "f0".into(),
                    captures: vec!["v0".into()],
                    r#type: Type::Func {
                        rest: false,
                        params: vec![],
                        ret: Box::new(Type::F64),
                    },
                    loc: loc.clone(),
                },
                loc: loc.clone(),
            },
        ];
        let target = &mut m.functions[1];
        target.params.clear();
        target.captures = Some(vec![Param {
            local_id: "c0".into(),
            name: "count".into(),
            r#type: Type::F64,
        }]);
        target.locals = vec![Local {
            id: "c0".into(),
            name: "count".into(),
            r#type: Type::F64,
            mutable: true,
            boxed: true,
        }];
        target.body = vec![Stmt::Return {
            value: Some(Expr::VarRef {
                local_id: "c0".into(),
                r#type: Type::F64,
                loc: loc.clone(),
            }),
            loc,
        }];
        m
    }

    #[test]
    fn recursive_signatures_and_record_handles_have_finite_storage() {
        let mut m = record_module();
        m.records[0].fields[0].r#type = Type::Func {
            rest: false,
            params: vec![],
            ret: Box::new(Type::Record { shape_id: 0 }),
        };
        assert!(m.valid_type(Type::Record { shape_id: 0 }, &mut vec![]));
        m.records[0].fields[0].r#type = Type::Record { shape_id: 0 };
        assert!(m.valid_type(Type::Record { shape_id: 0 }, &mut vec![]));
    }

    #[test]
    fn recursive_union_layouts_require_heap_edges_and_validate_other_members() {
        let mut m = record_module();
        m.unions.push(Union {
            id: 0,
            arms: vec![
                Type::Null,
                Type::Array {
                    elem: Box::new(Type::Union { union_id: 0 }),
                },
            ],
        });
        assert!(m.valid_type(Type::Union { union_id: 0 }, &mut vec![]));
        m.unions[0].arms[1] = Type::Union { union_id: 0 };
        assert!(!m.valid_type(Type::Union { union_id: 0 }, &mut vec![]));
        m.unions[0].arms[1] = Type::Record { shape_id: 0 };
        m.records[0].fields[0].r#type = Type::Union { union_id: 0 };
        assert!(m.valid_type(Type::Union { union_id: 0 }, &mut vec![]));
        m.records[0].fields.push(Field {
            name: "missing".into(),
            r#type: Type::Record { shape_id: 99 },
        });
        assert!(!m.valid_type(Type::Union { union_id: 0 }, &mut vec![]));
        m.records[0].fields.pop();
        m.unions[0].arms.clear();
        assert!(!m.valid_type(Type::Record { shape_id: 0 }, &mut vec![]));
    }

    #[test]
    fn closures_require_initialized_matching_capture_boxes() {
        let mut m = capturing_module();
        assert!(validate(&m).is_ok());
        m.functions[0].locals[0].boxed = false;
        assert_eq!(validate(&m).unwrap_err(), "invalid closure capture");
        let mut m = capturing_module();
        m.functions[0].body.remove(0);
        assert_eq!(validate(&m).unwrap_err(), "invalid closure capture");
        let mut m = capturing_module();
        m.functions[1].locals[0].boxed = false;
        assert_eq!(validate(&m).unwrap_err(), "capture requires a boxed local");
    }

    #[test]
    fn indirect_calls_validate_the_function_value_signature() {
        let mut m = callable_module();
        let loc = m.functions[0].loc.clone();
        let callee = Expr::Closure {
            fn_name: "f0".into(),
            captures: vec![],
            r#type: Type::Func {
                rest: false,
                params: vec![Type::F64],
                ret: Box::new(Type::F64),
            },
            loc: loc.clone(),
        };
        m.functions[0].body = vec![Stmt::Expression {
            expr: Expr::CallValue {
                callee: Box::new(callee),
                args: vec![],
                r#type: Type::F64,
                loc: loc.clone(),
            },
            loc,
        }];
        assert_eq!(validate(&m).unwrap_err(), "invalid indirect call signature");
    }

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
            tuple: false,
            index_value: None,
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
                    overflow: false,
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
        assert!(m.valid_type(Type::Record { shape_id: 0 }, &mut vec![]));
        assert!(
            validate(&m).is_err(),
            "the initializer must still match its recursive field"
        );
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
    fn own_key_construction_validates_the_closed_record_and_key_array() {
        for mode in ["valid", "wrong-keys", "wrong-result", "tuple", "arity"] {
            let mut m = record_module();
            let loc = m.functions[0].loc.clone();
            let Stmt::Expression { expr: source, .. } = m.functions[0].body.remove(0) else {
                unreachable!()
            };
            let keys = Expr::ArrayLit {
                elems: vec![Expr::StrLit {
                    value: "count".into(),
                    r#type: Type::String,
                    loc: loc.clone(),
                }],
                r#type: Type::Array {
                    elem: Box::new(Type::String),
                },
                loc: loc.clone(),
            };
            let mut args = vec![source, keys];
            if mode == "wrong-keys" {
                args[1] = Expr::BoolLit {
                    value: false,
                    r#type: Type::Bool,
                    loc: loc.clone(),
                };
            }
            if mode == "arity" {
                args.pop();
            }
            if mode == "tuple" {
                m.records[0].tuple = true;
            }
            m.functions[0].body.push(Stmt::Expression {
                expr: Expr::LibCall {
                    r#fn: "record.cloneOwn".into(),
                    args,
                    r#type: if mode == "wrong-result" {
                        Type::Dyn
                    } else {
                        Type::Record { shape_id: 0 }
                    },
                    loc: loc.clone(),
                },
                loc,
            });
            if mode == "valid" {
                validate(&m).unwrap();
                assert!(
                    serde_json::to_string(&m)
                        .unwrap()
                        .contains("record.cloneOwn")
                );
            } else {
                assert!(validate(&m).is_err(), "{mode}");
            }
        }
    }

    #[test]
    fn sequence_loops_validate_mutation_without_permitting_abrupt_completion() {
        for mode in ["valid", "return", "immutable", "uninitialized"] {
            let mut m = callable_module();
            let loc = m.functions[0].loc.clone();
            let num = || Expr::NumLit {
                value: 0.0,
                spelling: None,
                r#type: Type::F64,
                loc: loc.clone(),
            };
            m.functions[0].locals.push(Local {
                id: "counter".into(),
                name: "counter".into(),
                r#type: Type::F64,
                mutable: mode != "immutable",
                boxed: false,
            });
            let mut stmts = Vec::new();
            if mode != "uninitialized" {
                stmts.push(Stmt::VarDecl {
                    local_id: "counter".into(),
                    init: num(),
                    loc: loc.clone(),
                });
            }
            stmts.push(Stmt::While {
                cond: Expr::BoolLit {
                    value: false,
                    r#type: Type::Bool,
                    loc: loc.clone(),
                },
                body: vec![if mode == "return" {
                    Stmt::Return {
                        value: None,
                        loc: loc.clone(),
                    }
                } else {
                    Stmt::Assign {
                        local_id: "counter".into(),
                        value: num(),
                        initializes_global: false,
                        loc: loc.clone(),
                    }
                }],
                loc: loc.clone(),
            });
            m.functions[0].body = vec![Stmt::Expression {
                expr: Expr::Sequence {
                    stmts,
                    result: Box::new(num()),
                    r#type: Type::F64,
                    loc: loc.clone(),
                },
                loc,
            }];
            assert_eq!(validate(&m).is_ok(), mode == "valid", "{mode}");
        }
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
            globals: vec![],
            classes: vec![],
            functions: vec![
                Function {
                    is_async: false,
                    rest: false,
                    captures: None,
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
                    is_async: false,
                    rest: false,
                    captures: None,
                    name: "f0".into(),
                    params: vec![Param {
                        local_id: "p0".into(),
                        name: "n".into(),
                        r#type: Type::F64,
                    }],
                    return_type: Type::F64,
                    locals: vec![Local {
                        boxed: false,
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
    fn environment_reads_require_the_optional_string_contract() {
        let mut module = callable_module();
        module.functions.truncate(1);
        let loc = module.functions[0].loc.clone();
        module.unions.push(Union {
            id: 0,
            arms: vec![Type::String, Type::Undefined],
        });
        module.functions[0].body = vec![Stmt::Expression {
            expr: Expr::LibCall {
                r#fn: "process.envGet".into(),
                args: vec![Expr::StrLit {
                    value: "KEY".into(),
                    r#type: Type::String,
                    loc: loc.clone(),
                }],
                r#type: Type::Union { union_id: 0 },
                loc: loc.clone(),
            },
            loc,
        }];
        assert!(validate(&module).is_ok());
        if let Stmt::Expression {
            expr: Expr::LibCall { r#type, .. },
            ..
        } = &mut module.functions[0].body[0]
        {
            *r#type = Type::String;
        }
        assert_eq!(
            validate(&module).unwrap_err(),
            "invalid native environment read"
        );
    }

    #[test]
    fn weak_map_operations_validate_nominal_receivers_and_payload_abis() {
        let mut module = callable_module();
        module.functions.truncate(1);
        let loc = module.functions[0].loc.clone();
        module.classes.push(Class {
            name: "native_builtin_WeakMap".into(),
            js_name: "WeakMap".into(),
            runtime: false,
            base: None,
            fields: vec![],
            methods: vec![],
            symbol_methods: vec![],
            method_names: vec![],
            loc: loc.clone(),
        });
        let owner_type = Type::Object {
            class_name: "native_builtin_WeakMap".into(),
        };
        module.functions.push(Function {
            name: "%native_builtin_WeakMap.constructor".into(),
            params: vec![Param {
                local_id: "p0".into(),
                name: "this".into(),
                r#type: owner_type.clone(),
            }],
            locals: vec![Local {
                id: "p0".into(),
                name: "this".into(),
                r#type: owner_type,
                mutable: false,
                boxed: false,
            }],
            return_type: Type::Void,
            body: vec![],
            captures: None,
            rest: false,
            is_async: false,
            loc: loc.clone(),
        });
        for operation in ["get", "has", "delete", "set"] {
            for defect in ["none", "arity", "owner", "payload", "result"] {
                let owner_type = Type::Object {
                    class_name: "native_builtin_WeakMap".into(),
                };
                let owner = Expr::New {
                    class_name: "native_builtin_WeakMap".into(),
                    args: vec![],
                    r#type: owner_type,
                    loc: loc.clone(),
                };
                let dynamic = || Expr::DynObjLit {
                    fields: vec![],
                    r#type: Type::Dyn,
                    loc: loc.clone(),
                };
                let mut args = vec![owner, dynamic()];
                if operation == "set" {
                    args.push(dynamic());
                }
                let result = match operation {
                    "set" => Type::Void,
                    "get" => Type::Dyn,
                    _ => Type::Bool,
                };
                if defect == "arity" {
                    args.push(dynamic());
                }
                if defect == "owner" {
                    args[0] = dynamic();
                }
                if defect == "payload" {
                    args[1] = Expr::NumLit {
                        value: 1.0,
                        spelling: None,
                        r#type: Type::F64,
                        loc: loc.clone(),
                    };
                }
                let result = if defect == "result" {
                    Type::String
                } else {
                    result
                };
                module.functions[0].body = vec![Stmt::Expression {
                    expr: Expr::LibCall {
                        r#fn: format!("weakmap.{operation}"),
                        args,
                        r#type: result,
                        loc: loc.clone(),
                    },
                    loc: loc.clone(),
                }];
                assert_eq!(
                    validate(&module).is_ok(),
                    defect == "none",
                    "{operation}/{defect}: {:?}",
                    validate(&module)
                );
            }
        }
    }

    #[test]
    fn owning_set_elements_validate_their_layouts_and_keep_erasure_fenced() {
        let mut module = callable_module();
        module.functions.truncate(1);
        module.records.push(Record {
            id: 0,
            fields: vec![],
            declared_order: vec![],
            tuple: false,
            index_value: None,
        });
        let loc = module.functions[0].loc.clone();
        for (elem, accepted) in [
            (Type::Dyn, true),
            (Type::Symbol, true),
            (Type::Record { shape_id: 0 }, true),
            (
                Type::Func {
                    params: vec![],
                    ret: Box::new(Type::F64),
                    rest: false,
                },
                true,
            ),
            (Type::Record { shape_id: 9 }, false),
            (
                Type::Func {
                    params: vec![Type::Void],
                    ret: Box::new(Type::F64),
                    rest: false,
                },
                false,
            ),
            (Type::Bool, false),
            (Type::Undefined, false),
            (Type::Caught, false),
        ] {
            let ty = Type::Set {
                elem: Box::new(elem),
            };
            assert_eq!(module.valid_type(ty.clone(), &mut vec![]), accepted);
            let value = || Expr::SetNew {
                seed: None,
                r#type: ty.clone(),
                loc: loc.clone(),
            };
            module.functions[0].body = vec![Stmt::Expression {
                expr: value(),
                loc: loc.clone(),
            }];
            assert_eq!(validate(&module).is_ok(), accepted);
            if accepted {
                module.functions[0].body = vec![Stmt::Expression {
                    expr: Expr::DynFrom {
                        value: Box::new(value()),
                        r#type: Type::Dyn,
                        loc: loc.clone(),
                    },
                    loc: loc.clone(),
                }];
                assert!(validate(&module).is_err());
            }
        }
    }

    #[test]
    fn set_operations_validate_seed_elements_and_walk_the_seed() {
        let mut module = callable_module();
        module.functions.truncate(1);
        module.unions.push(Union {
            id: 0,
            arms: vec![
                Type::Set {
                    elem: Box::new(Type::String),
                },
                Type::String,
            ],
        });
        assert!(!module.valid_type(Type::Union { union_id: 0 }, &mut vec![]));
        assert!(contains_set(
            &Type::Array {
                elem: Box::new(Type::Set {
                    elem: Box::new(Type::String)
                })
            },
            &module.records,
            &module.unions
        ));
        module.unions.clear();
        let loc = module.functions[0].loc.clone();
        let set = Expr::SetNew {
            seed: Some(Box::new(Expr::ArrayLit {
                elems: vec![Expr::NumLit {
                    value: 1.0,
                    spelling: None,
                    r#type: Type::F64,
                    loc: loc.clone(),
                }],
                r#type: Type::Array {
                    elem: Box::new(Type::F64),
                },
                loc: loc.clone(),
            })),
            r#type: Type::Set {
                elem: Box::new(Type::F64),
            },
            loc: loc.clone(),
        };
        module.functions[0].body = vec![Stmt::Expression {
            expr: Expr::SetIntrinsic {
                method: "has".into(),
                receiver: Box::new(set),
                args: vec![Expr::NumLit {
                    value: 1.0,
                    spelling: None,
                    r#type: Type::F64,
                    loc: loc.clone(),
                }],
                r#type: Type::Bool,
                loc: loc.clone(),
            },
            loc: loc.clone(),
        }];
        assert!(validate(&module).is_ok());
        let mut count = 0;
        module.visit_expressions(&mut |_| count += 1);
        assert_eq!(count, 5);
        if let Stmt::Expression {
            expr: Expr::SetIntrinsic { args, .. },
            ..
        } = &mut module.functions[0].body[0]
        {
            args[0] = Expr::BoolLit {
                value: true,
                r#type: Type::Bool,
                loc,
            };
        }
        assert_eq!(validate(&module).unwrap_err(), "invalid Set operation");
    }

    #[test]
    fn string_operations_validate_and_visit_their_operands() {
        let mut module = callable_module();
        let loc = module.functions[0].loc.clone();
        module.functions.truncate(1);
        module.functions[0].body = vec![Stmt::Expression {
            expr: Expr::StrConcat {
                left: Box::new(Expr::StrLit {
                    value: "value: ".into(),
                    r#type: Type::String,
                    loc: loc.clone(),
                }),
                right: Box::new(Expr::ToString {
                    operand: Box::new(Expr::NumLit {
                        value: -0.0,
                        spelling: None,
                        r#type: Type::F64,
                        loc: loc.clone(),
                    }),
                    r#type: Type::String,
                    loc: loc.clone(),
                }),
                r#type: Type::String,
                loc: loc.clone(),
            },
            loc: loc.clone(),
        }];
        assert!(validate(&module).is_ok());
        let mut types = Vec::new();
        module.visit_expressions(&mut |e| types.push(e.ty()));
        assert_eq!(
            types,
            vec![Type::String, Type::String, Type::String, Type::F64]
        );
        let wire = serde_json::to_value(&module).unwrap();
        assert_eq!(wire["functions"][0]["body"][0]["expr"]["kind"], "strConcat");
        assert_eq!(
            wire["functions"][0]["body"][0]["expr"]["right"]["kind"],
            "toString"
        );
        if let Stmt::Expression {
            expr: Expr::StrConcat { right, .. },
            ..
        } = &mut module.functions[0].body[0]
        {
            **right = Expr::BoolLit {
                value: true,
                r#type: Type::Bool,
                loc: loc.clone(),
            };
        }
        assert_eq!(
            validate(&module).unwrap_err(),
            "invalid string concatenation"
        );
        if let Stmt::Expression {
            expr: Expr::StrConcat { right, .. },
            ..
        } = &mut module.functions[0].body[0]
        {
            **right = Expr::ToString {
                operand: Box::new(Expr::StrLit {
                    value: "already a string".into(),
                    r#type: Type::String,
                    loc: loc.clone(),
                }),
                r#type: Type::String,
                loc,
            };
        }
        assert_eq!(
            validate(&module).unwrap_err(),
            "invalid native string conversion"
        );
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
            globals: vec![],
            classes: vec![],
            ir_version: VERSION,
            source_file: loc.file.clone(),
            entry: "main".into(),
            functions: vec![Function {
                is_async: false,
                rest: false,
                captures: None,
                name: "main".into(),
                params: vec![],
                return_type: Type::Void,
                locals: vec![Local {
                    boxed: false,
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
    #[test]
    fn protected_regions_validate_payload_slots_and_finally_completion() {
        let mut m = callable_module();
        let loc = m.functions[0].loc.clone();
        m.functions[0].locals.clear();
        m.functions[0].params.clear();
        m.functions[0].return_type = Type::Void;
        m.functions[0].body = vec![Stmt::TryCatch {
            try_body: vec![],
            catch_body: None,
            catch_local_id: None,
            finally_body: None,
            loc: loc.clone(),
        }];
        assert_eq!(
            validate(&m).unwrap_err(),
            "native try needs a handler or finalizer"
        );
        if let Stmt::TryCatch {
            catch_body,
            catch_local_id,
            ..
        } = &mut m.functions[0].body[0]
        {
            *catch_body = Some(vec![]);
            *catch_local_id = Some("missing".into());
        }
        assert_eq!(
            validate(&m).unwrap_err(),
            "catch binding needs a fresh caught local"
        );
        m.functions[0].locals.push(Local {
            id: "missing".into(),
            name: "error".into(),
            r#type: Type::Caught,
            mutable: false,
            boxed: false,
        });
        assert!(validate(&m).is_ok());
        m.functions.push(Function {
            is_async: false,
            rest: false,
            name: "invalid_caught_abi".into(),
            params: vec![Param {
                local_id: "payload".into(),
                name: "payload".into(),
                r#type: Type::Caught,
            }],
            captures: None,
            return_type: Type::Void,
            locals: vec![Local {
                id: "payload".into(),
                name: "payload".into(),
                r#type: Type::Caught,
                mutable: false,
                boxed: false,
            }],
            body: vec![],
            loc: loc.clone(),
        });
        assert_eq!(
            validate(&m).unwrap_err(),
            "caught slots cannot cross the function ABI"
        );
        m.functions.pop();
        let returned = || Stmt::Return {
            value: None,
            loc: loc.clone(),
        };
        assert!(always_returns(&[Stmt::TryCatch {
            try_body: vec![],
            catch_body: None,
            catch_local_id: None,
            finally_body: Some(vec![returned()]),
            loc: loc.clone()
        }]));
        assert!(!always_returns(&[Stmt::TryCatch {
            try_body: vec![returned()],
            catch_body: Some(vec![]),
            catch_local_id: None,
            finally_body: None,
            loc
        }]));
    }
    #[test]
    fn byte_operations_validate_owned_layouts_and_signatures() {
        let mut module = callable_module();
        let loc = module.functions[0].loc.clone();
        let bytes = || Expr::BytesNew {
            source: None,
            r#type: Type::bytes(),
            loc: loc.clone(),
        };
        module.functions[0].body = vec![Stmt::Expression {
            expr: Expr::BytesIntrinsic {
                method: "length".into(),
                receiver: Box::new(bytes()),
                args: vec![],
                r#type: Type::F64,
                loc: loc.clone(),
            },
            loc: loc.clone(),
        }];
        assert!(validate(&module).is_ok());
        if let Stmt::Expression {
            expr: Expr::BytesIntrinsic { r#type, .. },
            ..
        } = &mut module.functions[0].body[0]
        {
            *r#type = Type::String;
        }
        assert!(validate(&module).is_err());
        module.functions[0].body = vec![Stmt::Expression {
            expr: Expr::BytesNew {
                source: Some(Box::new(Expr::StrLit {
                    value: "bad".into(),
                    r#type: Type::String,
                    loc: loc.clone(),
                })),
                r#type: Type::bytes(),
                loc: loc.clone(),
            },
            loc,
        }];
        assert!(validate(&module).is_err());
        assert!(!module.valid_type(Type::Bytes { elem: "u32".into() }, &mut vec![]));
    }
}
