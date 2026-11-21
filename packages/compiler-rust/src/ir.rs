//! The first native subset of the existing scriptc IR v13 wire contract.
use serde::Serialize;
pub(crate) mod bigint;
mod child_process;
mod control_flow;
mod filesystem_values;
pub(crate) mod normalize;
pub(crate) mod optimize;
pub mod record_equivalence;
pub mod record_views;
pub(crate) mod regex_captures;
mod symbol_methods;
mod symbols;
mod walk;
pub(crate) mod walk_mut;
use std::collections::HashMap;
pub use symbol_methods::{SymbolMethod, SymbolMethodKey};
pub(crate) use symbols::well_known_symbol;

pub const VERSION: u32 = 13;

/// Callable views can forward to a function whose owning signature differs
/// from the projected one. Carry receiver requirements across those views.
pub(crate) fn receiver_aware_function_types(
    functions: &[Function],
) -> std::collections::HashSet<Type> {
    let mut result = functions
        .iter()
        .filter(|function| function.reads_receiver())
        .map(|function| Type::Func {
            rest: function.rest,
            params: function
                .params
                .iter()
                .map(|param| param.r#type.clone())
                .collect(),
            ret: Box::new(function.call_result()),
        })
        .collect::<std::collections::HashSet<_>>();
    let mut views = Vec::new();
    for function in functions {
        function.visit_expressions(&mut |expression| {
            if let Expr::DynCheck {
                value,
                r#type: target @ Type::Func { .. },
                ..
            } = expression
            {
                let source = match value.as_ref() {
                    Expr::DynFrom { value, .. } if matches!(value.ty(), Type::Func { .. }) => {
                        Some(value.ty())
                    }
                    Expr::LibCall { r#fn, args, .. } if r#fn == "callable.opaqueViewSource" => {
                        args.first().map(Expr::ty)
                    }
                    _ => None,
                };
                views.push((source, target.clone()));
            }
        });
    }
    let any_receiver = !result.is_empty();
    loop {
        let before = result.len();
        for (source, target) in &views {
            if source
                .as_ref()
                .map_or(any_receiver, |source| result.contains(source))
            {
                result.insert(target.clone());
            }
        }
        if result.len() == before {
            break;
        }
    }
    result
}

/// A function view may change dynamic slots, but never arity or rest ABI.
/// Values crossing a dynamic slot are checked by the native call boundary.
pub fn callable_view_compatible(source: &Type, target: &Type) -> bool {
    let (
        Type::Func {
            params: a,
            ret: ar,
            rest: a_rest,
        },
        Type::Func {
            params: b,
            ret: br,
            rest: b_rest,
        },
    ) = (source, target)
    else {
        return false;
    };
    let erased_rest = |rest: bool, params: &[Type]| {
        rest && matches!(params, [Type::Array { elem }] if **elem == Type::Dyn)
    };
    let parameters = if erased_rest(*a_rest, a) || erased_rest(*b_rest, b) {
        true
    } else {
        a_rest == b_rest
            && a.len() == b.len()
            && a.iter()
                .zip(b)
                .all(|(left, right)| left == right || *left == Type::Dyn || *right == Type::Dyn)
    };
    source != target
        && parameters
        && (ar == br
            || (**ar != Type::Void
                && **br != Type::Void
                && (**ar == Type::Dyn
                    || **br == Type::Dyn
                    || matches!((ar.as_ref(), br.as_ref()),
                        (Type::Promise { inner: left }, Type::Promise { inner: right })
                            if **left != Type::Void
                                && **right != Type::Void
                                && (**left == Type::Dyn || **right == Type::Dyn)))))
}

/// Typed Sets have a portable reference ABI, but the shared dynamic value
/// contract cannot box them (including inside a composite or callback ABI).
pub fn contains_set(ty: &Type, records: &[Record], unions: &[Union]) -> bool {
    contains_type(ty, records, unions, |ty| matches!(ty, Type::Set { .. }))
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
            Type::Generator {
                yield_type,
                return_type,
                next_type,
                ..
            } => {
                visit(yield_type, records, unions, seen, predicate)
                    || visit(return_type, records, unions, seen, predicate)
                    || visit(next_type, records, unions, seen, predicate)
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
    CryptoHash,
    CryptoSign,
    Symbol,
    Child,
    Stats,
    Dirent,
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
    Generator {
        #[serde(rename = "async", skip_serializing_if = "std::ops::Not::not")]
        r#async: bool,
        #[serde(rename = "yieldT")]
        yield_type: Box<Type>,
        #[serde(rename = "retT")]
        return_type: Box<Type>,
        #[serde(rename = "nextT")]
        next_type: Box<Type>,
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

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Module {
    pub ir_version: u32,
    pub source_file: String,
    /// The executable source graph survives lowering so the backend can
    /// partition code without reconstructing module ownership from symbols.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub source_modules: Vec<SourceModule>,
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
pub struct SourceModule {
    pub file: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub static_dependencies: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub dynamic_dependencies: Vec<String>,
    /// Source bytes are a cheap, stable first estimate for generated-code
    /// weight. The chunk emitter can replace this with measured Rust weight.
    pub source_bytes: usize,
    /// Eager controls initialization only. Lazy code may share a crate with
    /// eager code without being evaluated before its dynamic import.
    pub eager: bool,
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
    pub captures: Vec<Type>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub methods: Vec<String>,
    /// Full own non-data surface (methods/accessors), including undemanded bodies.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub method_names: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub symbol_methods: Vec<SymbolMethod>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub symbol_brand: Option<String>,
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
    pub loc: Loc,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Function {
    #[serde(rename = "async", skip_serializing_if = "std::ops::Not::not")]
    pub is_async: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub generator: Option<GeneratorChannels>,
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
        if let Some(channels) = &self.generator {
            Type::Generator {
                r#async: self.is_async,
                yield_type: Box::new(channels.yield_type.clone()),
                return_type: Box::new(self.return_type.clone()),
                next_type: Box::new(channels.next_type.clone()),
            }
        } else if self.is_async {
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
pub struct GeneratorChannels {
    pub yield_type: Type,
    pub next_type: Type,
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
    #[serde(rename = "yieldExpr")]
    Yield {
        value: Box<Expr>,
        r#type: Type,
        loc: Loc,
    },
    YieldStar {
        generator: Box<Expr>,
        r#type: Type,
        loc: Loc,
    },
    GeneratorNext {
        generator: Box<Expr>,
        value: Box<Expr>,
        r#type: Type,
        loc: Loc,
    },
    GeneratorReturn {
        generator: Box<Expr>,
        value: Option<Box<Expr>>,
        r#type: Type,
        loc: Loc,
    },
    #[serde(rename = "awaitExpr")]
    Await {
        value: Box<Expr>,
        r#type: Type,
        loc: Loc,
    },
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
    DynIterN {
        value: Box<Expr>,
        count: usize,
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
    DynLooseEq {
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
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        optional: bool,
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
    ClassCreate {
        class_name: String,
        parent: Option<Box<Expr>>,
        captures: Vec<Expr>,
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
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        null_prototype: bool,
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
    UnionProject {
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
            Self::Yield { r#type, .. }
            | Self::YieldStar { r#type, .. }
            | Self::GeneratorNext { r#type, .. }
            | Self::GeneratorReturn { r#type, .. }
            | Self::Await { r#type, .. }
            | Self::CaughtToDyn { r#type, .. }
            | Self::CaughtNarrow { r#type, .. }
            | Self::CaughtTest { r#type, .. } => r#type.clone(),
            Self::DynFrom { r#type, .. }
            | Self::DynCheck { r#type, .. }
            | Self::DynIterN { r#type, .. }
            | Self::DynObjLit { r#type, .. }
            | Self::DynArrLit { r#type, .. }
            | Self::DynKeyGet { r#type, .. }
            | Self::DynTest { r#type, .. }
            | Self::DynScalarEq { r#type, .. }
            | Self::DynLooseEq { r#type, .. }
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
            | Self::ClassCreate { r#type, .. }
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
            | Self::UnionProject { r#type, .. }
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

pub fn walk_expression(value: &Expr, visitor: &mut impl FnMut(&Expr)) {
    walk::expression(value, visitor);
}

#[derive(Clone, Debug, Serialize)]
pub struct SwitchCase {
    pub test: Option<Expr>,
    pub body: Vec<Stmt>,
}

fn is_zero(value: &usize) -> bool {
    *value == 0
}

#[derive(Clone, Debug, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Stmt {
    GeneratorForOf {
        generator: Expr,
        local_id: String,
        body: Vec<Stmt>,
        loc: Loc,
    },
    Switch {
        disc: Expr,
        cases: Vec<SwitchCase>,
        loc: Loc,
    },
    ArraySet {
        arr: Expr,
        index: Expr,
        value: Expr,
        loc: Loc,
    },
    BytesSet {
        arr: Expr,
        index: Expr,
        value: Expr,
        loc: Loc,
    },
    ArraySetLength {
        arr: Expr,
        length: Expr,
        loc: Loc,
    },
    Break {
        #[serde(default, skip_serializing_if = "is_zero")]
        target_depth: usize,
        loc: Loc,
    },
    Continue {
        #[serde(default, skip_serializing_if = "is_zero")]
        target_depth: usize,
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
// The portable DataView ABI uses explicit numeric kinds; keep validation and
// code generation on the same closed list so an unknown operation is refused.
pub fn data_view_operation(method: &str) -> Option<(&'static str, bool, bool)> {
    let (kind, set, byte) = match method {
        "dvGetUint8" => ("u8", false, true),
        "dvGetInt8" => ("i8", false, true),
        "dvGetUint16" => ("u16", false, false),
        "dvGetInt16" => ("i16", false, false),
        "dvGetUint32" => ("u32", false, false),
        "dvGetInt32" => ("i32", false, false),
        "dvGetFloat32" => ("f32", false, false),
        "dvGetFloat64" => ("f64", false, false),
        "dvGetBigUint64Number" => ("u64", false, false),
        "dvGetBigInt64Number" => ("i64", false, false),
        "dvSetUint8" => ("u8", true, true),
        "dvSetInt8" => ("i8", true, true),
        "dvSetUint16" => ("u16", true, false),
        "dvSetInt16" => ("i16", true, false),
        "dvSetUint32" => ("u32", true, false),
        "dvSetInt32" => ("i32", true, false),
        "dvSetFloat32" => ("f32", true, false),
        "dvSetFloat64" => ("f64", true, false),
        _ => return None,
    };
    Some((kind, set, byte))
}

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
                && ((method.params.len() > base.params.len()
                    && method.params[base.params.len()..].iter().any(|parameter| {
                        parameter.r#type != Type::Dyn
                            && !matches!(&parameter.r#type, Type::Union { union_id }
                                if module.unions.get(*union_id).is_some_and(|union| union.arms.contains(&Type::Undefined)))
                    }))
                    || method
                        .params
                        .iter()
                        .skip(1)
                        .zip(base.params.iter().skip(1))
                        .any(|(method, base)| {
                            method.r#type != base.r#type && method.r#type != Type::Dyn
                        })
                    || (base.call_result() != method.call_result()
                        && base.call_result() != Type::Void))
            {
                return Err(format!(
                    "incompatible native method override: class={} method={} base_params={:?} params={:?} base_result={:?} result={:?}",
                    class.name,
                    name,
                    base.params
                        .iter()
                        .skip(1)
                        .map(|p| &p.r#type)
                        .collect::<Vec<_>>(),
                    method
                        .params
                        .iter()
                        .skip(1)
                        .map(|p| &p.r#type)
                        .collect::<Vec<_>>(),
                    base.call_result(),
                    method.call_result(),
                ));
            }
        }
    }
    symbol_methods::validate(module, &functions)?;
    let entry = functions
        .get(module.entry.as_str())
        .ok_or("missing entry")?;
    if entry.return_type != Type::Void || !entry.params.is_empty() {
        return Err("invalid native entry".into());
    }
    let mut global_ids = std::collections::HashSet::new();
    for global in &module.globals {
        if !global.id.starts_with("%g.") {
            return Err(format!("invalid global id: {global:?}"));
        }
        if !global_ids.insert(&global.id) {
            return Err(format!("duplicate global id: {}", global.id));
        }
        if !module.valid_type(global.r#type.clone(), &mut vec![]) {
            return Err(format!("invalid global storage type: {global:?}"));
        }
        if module.initializer(&global.id).is_none() {
            return Err(format!(
                "missing global initializer: id={} name={} type={:?}",
                global.id, global.name, global.r#type
            ));
        }
    }
    // Layouts and symbol tables must be sound before independent bodies can
    // be checked. A body failure must not hide failures in other functions.
    let errors = module
        .functions
        .iter()
        .filter_map(|function| {
            validate_function(function, &functions, module)
                .err()
                .map(|error| (function.name.as_str(), error))
        })
        .collect::<Vec<_>>();
    match errors.len() {
        0 => Ok(()),
        1 => Err(errors.into_iter().next().unwrap().1),
        _ => Err(errors
            .into_iter()
            .map(|(name, error)| format!("{name}: {error}"))
            .collect::<Vec<_>>()
            .join("\n")),
    }
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
                        | Type::Generator { .. }
                )
            });
        }
        let identity = ty.clone();
        active.push(ty.clone());
        let valid = match ty {
            Type::Object { class_name } => self.class(&class_name).is_some(),
            Type::Classval { class_name } => self.class(&class_name).is_some(),
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
                !matches!(*elem, Type::Stats)
                    && !matches!(&*elem, Type::Union { union_id } if self.unions.get(*union_id).is_some_and(|union| union.arms.contains(&Type::Stats)))
                    && self.valid_type_cached(*elem, active, proven)
            }
            Type::Bytes { elem } => matches!(elem.as_str(), "u8" | "u16" | "u32" | "i32" | "f32" | "f64"),
            Type::Promise { inner } => {
                *inner == Type::Void || self.valid_type_cached(*inner, active, proven)
            }
            Type::Generator {
                yield_type,
                return_type,
                next_type,
                ..
            } => {
                (*yield_type == Type::Void
                    || self.valid_type_cached(*yield_type, active, proven))
                    && (*return_type == Type::Void
                        || self.valid_type_cached(*return_type, active, proven))
                    && (*next_type == Type::Void
                        || *next_type == Type::Undefined
                        || self.valid_type_cached(*next_type, active, proven))
            }
            Type::Set { elem } => {
                elem.set_element() && self.valid_type_cached(*elem, active, proven)
            }
            Type::Map { key, value } => {
                matches!(*key, Type::F64 | Type::String | Type::Dyn)
                    && !matches!(*value, Type::Func { .. } | Type::Stats)
                    && !matches!(&*value, Type::Union { union_id } if self.unions.get(*union_id).is_some_and(|union| union.arms.contains(&Type::Stats)))
                    && !matches!(*value, Type::Bytes { .. })
                    && self.valid_type_cached(*value, active, proven)
            }
            Type::Record { shape_id } => self.records.get(shape_id).is_some_and(|r| {
                r.id == shape_id
                    && r.index_value.as_ref().is_none_or(|v| {
                        !matches!(v, Type::Func { .. } | Type::Map { .. } | Type::Stats)
                            && !matches!(v, Type::Union { union_id } if self.unions.get(*union_id).is_some_and(|union| union.arms.contains(&Type::Stats)) )
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
                    && (!u.arms.iter().any(|a| matches!(a, Type::Map { .. }))
                        || (u
                            .arms
                            .iter()
                            .filter(|a| matches!(a, Type::Map { .. }))
                            .count()
                            == 1
                            && u.arms.iter().all(|a| {
                                matches!(a, Type::Map { .. } | Type::Null | Type::Undefined)
                            })))
                    && u.arms
                        .iter()
                        .filter(|a| matches!(a, Type::Object { .. }))
                        .count()
                        <= 1
                    && (!u.arms.contains(&Type::Stats)
                        || u.arms.iter().all(|a| matches!(a, Type::Stats | Type::Null | Type::Undefined)))
                    && u.arms.iter().all(|arm| {
                        matches!(arm, Type::Null | Type::Undefined)
                            || (!matches!(arm, Type::Union { .. })
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
            if class.runtime && class.symbol_brand.is_some() {
                return Err("runtime class cannot declare a registry symbol brand".into());
            }
            let header = error_fields();
            let builtin = builtin_error_class(&class.name);
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
                    return Err(format!(
                        "invalid class inheritance/prefix: class={} base={} fields={:?} base_fields={:?}",
                        class.name, base.name, class.fields, base.fields
                    ));
                }
            }
            let mut fields = std::collections::HashSet::new();
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
                let invalid = r
                    .fields
                    .iter()
                    .filter(|field| {
                        !self.valid_type_cached(field.r#type.clone(), &mut vec![], &mut proven)
                    })
                    .map(|field| format!("{}: {:?}", field.name, field.r#type))
                    .collect::<Vec<_>>();
                return Err(format!(
                    "invalid/recursive record layout r{id}: {r:?} (invalid fields: {invalid:?})"
                ));
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
                return Err(format!("invalid/recursive union layout u{id}: {u:?}"));
            }
        }
        Ok(())
    }
}

pub fn builtin_error_class(name: &str) -> bool {
    matches!(
        name,
        "%Error"
            | "%EvalError"
            | "%RangeError"
            | "%ReferenceError"
            | "%SyntaxError"
            | "%TypeError"
            | "%URIError"
            | "%DOMException"
            | "%AggregateError"
    )
}

pub fn error_fields() -> Vec<Field> {
    [
        // Error subclasses can use public field declarations (`name;` or
        // `message;`), whose DefineField step stores JavaScript undefined
        // before the constructor body runs. Keep the owning slots dynamic;
        // typed reads install String views where their declaration requires
        // one, while Error.prototype.toString handles arbitrary live values.
        ("name", Type::Dyn),
        ("message", Type::Dyn),
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
    let mut await_outside_async = false;
    let mut invalid_yield = false;
    f.visit_expressions(&mut |expr| {
        if matches!(expr, Expr::Await { .. }) && !f.is_async {
            await_outside_async = true;
        }
        if let Expr::Yield { value, r#type, .. } = expr {
            invalid_yield |= !f.generator.as_ref().is_some_and(|channels| {
                value.ty() == channels.yield_type
                    && (*r#type == channels.next_type
                        || (*r#type == Type::Void && channels.next_type == Type::Undefined))
            });
        }
        if let Expr::YieldStar { generator, .. } = expr {
            invalid_yield |= !f.generator.as_ref().is_some_and(|channels| {
                matches!(generator.ty(), Type::Generator { r#async: false, yield_type, next_type, .. }
                    if (*yield_type == channels.yield_type
                        || channels.yield_type == Type::Dyn
                        || *yield_type == Type::Dyn
                        || (matches!(*yield_type, Type::Void | Type::Undefined)
                            && matches!(channels.yield_type, Type::Void | Type::Undefined)))
                    && (matches!(*next_type, Type::Void | Type::Undefined)
                        || *next_type == channels.next_type
                        || (matches!(*next_type, Type::Void | Type::Undefined)
                            && matches!(channels.next_type, Type::Void | Type::Undefined))))
            });
        }
    });
    if await_outside_async {
        return Err("await outside an async function".into());
    }
    if invalid_yield {
        return Err("yield outside a matching generator channel".into());
    }
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
        if !supported {
            return Err(format!(
                "invalid local layout in function {:?} at {}:{}..{}: {:?} ({}) has type {:?}",
                f.name, f.loc.file, f.loc.start, f.loc.end, local.name, local.id, local.r#type
            ));
        }
        if module.global(&local.id).is_some() {
            return Err(format!(
                "local/global id collision in function {:?}: {:?} ({})",
                f.name, local.name, local.id
            ));
        }
        if locals.insert(local.id.as_str(), local).is_some() {
            return Err(format!(
                "duplicate local id in function {:?}: {:?} ({})",
                f.name, local.name, local.id
            ));
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
            Expr::Yield { value, .. } => expr(value, locals, initialized, functions, module),
            Expr::YieldStar {
                generator, r#type, ..
            } => {
                expr(generator, locals, initialized, functions, module)?;
                let Type::Generator {
                    r#async: false,
                    return_type,
                    ..
                } = generator.ty()
                else {
                    return Err("yield* requires a synchronous represented generator".into());
                };
                if *return_type == *r#type
                    || (matches!(*return_type, Type::Void | Type::Undefined)
                        && matches!(r#type, Type::Void | Type::Undefined))
                {
                    Ok(())
                } else {
                    Err("invalid yield* result channel".into())
                }
            }
            Expr::GeneratorNext {
                generator,
                value,
                r#type,
                ..
            } => {
                expr(generator, locals, initialized, functions, module)?;
                let Type::Generator {
                    r#async, next_type, ..
                } = generator.ty()
                else {
                    return Err("generator next requires a represented generator".into());
                };
                if !(matches!(*next_type, Type::Void | Type::Undefined)
                    && matches!(value.as_ref(), Expr::UnitLit { .. }))
                {
                    expr(value, locals, initialized, functions, module)?;
                }
                let result_ok = if r#async {
                    matches!(r#type, Type::Promise { inner } if **inner == Type::Dyn)
                } else {
                    *r#type == Type::Dyn
                };
                if *next_type != value.ty() || !result_ok {
                    return Err("invalid generator next ABI".into());
                }
                Ok(())
            }
            Expr::GeneratorReturn {
                generator,
                value,
                r#type,
                ..
            } => {
                expr(generator, locals, initialized, functions, module)?;
                if let Some(value) = value {
                    let unit_channel = matches!(generator.ty(), Type::Generator { return_type, .. } if matches!(*return_type, Type::Void | Type::Undefined));
                    if !(unit_channel && matches!(value.as_ref(), Expr::UnitLit { .. })) {
                        expr(value, locals, initialized, functions, module)?;
                    }
                }
                let Type::Generator {
                    r#async,
                    return_type,
                    ..
                } = generator.ty()
                else {
                    return Err("generator return requires a represented generator".into());
                };
                let value_ok = value.as_ref().is_none_or(|value| {
                    value.ty() == *return_type
                        || (matches!(*return_type, Type::Void | Type::Undefined)
                            && matches!(value.ty(), Type::Void | Type::Undefined))
                });
                let result_ok = if r#async {
                    matches!(r#type, Type::Promise { inner } if **inner == Type::Dyn)
                } else {
                    *r#type == Type::Dyn
                };
                if !value_ok || !result_ok {
                    return Err("invalid generator return ABI".into());
                }
                Ok(())
            }
            Expr::Await { value, r#type, .. } => {
                expr(value, locals, initialized, functions, module)?;
                let compatible = match value.ty() {
                    Type::Promise { inner } => {
                        *inner == *r#type
                            || *inner == Type::Dyn
                            || *r#type == Type::Dyn
                            || matches!(
                                (inner.as_ref(), r#type),
                                (Type::Void, Type::Undefined) | (Type::Undefined, Type::Void)
                            )
                            || record_views::view_pairs(
                                &inner,
                                r#type,
                                &module.records,
                                &module.unions,
                            )
                            .is_some()
                    }
                    _ => false,
                };
                if !compatible {
                    return Err("await requires a Promise with the same result type".into());
                }
                Ok(())
            }
            Expr::Sequence {
                stmts,
                result,
                r#type,
                loc,
            } => {
                fn allowed(stmts: &[Stmt]) -> bool {
                    stmts.iter().all(|stmt| match stmt {
                        Stmt::VarDecl { .. }
                        | Stmt::ArraySet { .. }
                        | Stmt::ArraySetLength { .. }
                        | Stmt::RecordSet { .. }
                        | Stmt::RecordKeySet { .. }
                        | Stmt::FieldSet { .. }
                        | Stmt::BytesSet { .. }
                        | Stmt::Expression { .. } => true,
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
                    return Err(format!(
                        "invalid expression sequence statement at {:?}: {stmts:?}",
                        loc
                    ));
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
                if symbol_methods::contains_symbol_methods(&value.ty(), module) {
                    return Err(
                        "erasing symbol methods requires a native descriptor contract".into(),
                    );
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
            Expr::DynIterN { value, r#type, .. } => {
                expr(value, locals, initialized, functions, module)?;
                if value.ty() == Type::Dyn && *r#type == Type::Dyn {
                    Ok(())
                } else {
                    Err("invalid native bounded iteration".into())
                }
            }
            Expr::DynCheck { value, r#type, .. } => {
                expr(value, locals, initialized, functions, module)?;
                if value.ty() == Type::Dyn
                    && *r#type != Type::Dyn
                    && module.valid_type(r#type.clone(), &mut vec![])
                {
                    Ok(())
                } else {
                    Err(format!(
                        "invalid native value check: {:?} -> {:?}",
                        value.ty(),
                        r#type
                    ))
                }
            }
            Expr::DynObjLit { fields, r#type, .. } => {
                for f in fields {
                    expr(&f.key, locals, initialized, functions, module)?;
                    expr(&f.value, locals, initialized, functions, module)?;
                }
                if *r#type == Type::Dyn
                    && fields.iter().all(|f| {
                        matches!(f.key.ty(), Type::String | Type::Symbol)
                            && f.value.ty() == Type::Dyn
                    })
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
                if value.ty() == Type::Dyn
                    && matches!(key.ty(), Type::Dyn | Type::String | Type::Symbol)
                    && *r#type == Type::Dyn
                {
                    Ok(())
                } else {
                    Err(format!("invalid native value member read: {e:?}"))
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
                            | "objectInstance"
                            | "array"
                            | "bytes"
                            | "bytes.u8"
                            | "bytes.f32"
                            | "bytes.f64"
                            | "map"
                            | "mapValuesIterator"
                            | "syncGenerator"
                            | "classIterable"
                            | "set"
                            | "date"
                            | "regex"
                            | "url"
                            | "promise"
                            | "arrayBuffer"
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
            Expr::DynLooseEq {
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
                    Err("invalid native abstract equality".into())
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
            } if r#fn == "array.toString" => {
                for arg in args {
                    expr(arg, locals, initialized, functions, module)?;
                }
                if args.len() == 1 && args[0].ty() == Type::Dyn && *r#type == Type::Dyn {
                    Ok(())
                } else {
                    Err("invalid native array toString operation".into())
                }
            }
            Expr::LibCall {
                r#fn, args, r#type, ..
            } if r#fn == "class.setParent" => {
                for arg in args {
                    expr(arg, locals, initialized, functions, module)?;
                }
                if args.len() == 2
                    && args
                        .iter()
                        .all(|arg| matches!(arg.ty(), Type::Classval { .. }))
                    && *r#type == Type::Void
                {
                    Ok(())
                } else {
                    Err("invalid native class parent assignment".into())
                }
            }
            Expr::LibCall {
                r#fn, args, r#type, ..
            } if r#fn == "class.staticSymbolDefine" => {
                for arg in args {
                    expr(arg, locals, initialized, functions, module)?;
                }
                if args.len() == 3
                    && matches!(args[0].ty(), Type::Classval { .. })
                    && args[1].ty() == Type::Symbol
                    && args[2].ty() == Type::Dyn
                    && *r#type == Type::Void
                {
                    Ok(())
                } else {
                    Err("invalid native static symbol descriptor".into())
                }
            }

            Expr::LibCall {
                r#fn, args, r#type, ..
            } if r#fn.starts_with("class.symbolDefine:") => {
                for arg in args {
                    expr(arg, locals, initialized, functions, module)?;
                }
                let name = r#fn.trim_start_matches("class.symbolDefine:");
                let function = functions
                    .get(name)
                    .ok_or("missing native class symbol descriptor function")?;
                let class_name = match args.first().map(Expr::ty) {
                    Some(Type::Classval { class_name }) => class_name,
                    _ => return Err("invalid native class symbol descriptor owner".into()),
                };
                let receiver = function.params.first().map(|param| &param.r#type);
                if args.len() == 2
                    && args[1].ty() == Type::Symbol
                    && *r#type == Type::Void
                    && receiver == Some(&Type::Object { class_name })
                {
                    Ok(())
                } else {
                    Err("invalid native class symbol descriptor".into())
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
                || matches!(
                    r#fn.as_str(),
                    "dyn.typeof"
                        | "dyn.stringConstructor"
                        | "dyn.objectValue"
                        | "dyn.objectPrototype"
                        | "dyn.getPrototypeOf"
                        | "dyn.asyncIterator"
                        | "util.promisify"
                ) =>
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
                    "dyn.objectValue" => arg_types == [Type::Dyn] && *r#type == Type::Dyn,
                    "dyn.objectPrototype" => arg_types.is_empty() && *r#type == Type::Dyn,
                    "dyn.getPrototypeOf" => arg_types == [Type::Dyn] && *r#type == Type::Dyn,
                    "dyn.asyncIterator" => arg_types == [Type::Dyn] && *r#type == Type::Dyn,
                    "util.promisify" => arg_types == [Type::Dyn] && *r#type == Type::Dyn,
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
                if !matches!(r#type, Type::Bytes { .. })
                    || !module.valid_type(r#type.clone(), &mut vec![])
                {
                    return Err("invalid native bytes type".into());
                }
                if let Some(source) = source {
                    expr(source, locals, initialized, functions, module)?;
                    if source.ty() != Type::F64
                        && source.ty() != *r#type
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
                let valid = matches!(receiver.ty(), Type::Bytes { .. })
                    && match method.as_str() {
                        "length" | "byteLength" => args.is_empty() && *r#type == Type::F64,
                        "buffer" => args.is_empty() && *r#type == Type::Dyn,
                        "byteOffset" => {
                            receiver.ty() == Type::bytes()
                                && args.is_empty()
                                && *r#type == Type::F64
                        }
                        "windowView" => {
                            receiver.ty() == Type::bytes()
                                && args.is_empty()
                                && *r#type == Type::bytes()
                        }
                        "dataViewNew" => {
                            args.len() <= 2
                                && args.iter().all(|a| a.ty() == Type::F64)
                                && *r#type == Type::bytes()
                        }
                        method if data_view_operation(method).is_some() => {
                            let (_, is_set, is_byte) = data_view_operation(method).unwrap();
                            let required = if is_set { 2 } else { 1 };
                            receiver.ty() == Type::bytes()
                                && args.len() >= required
                                && args.len() <= required + usize::from(!is_byte)
                                && args[..required].iter().all(|a| a.ty() == Type::F64)
                                && args.get(required).is_none_or(|a| a.ty() == Type::Bool)
                                && *r#type == if is_set { Type::Void } else { Type::F64 }
                        }
                        "toArray" => {
                            args.is_empty()
                                && *r#type
                                    == (Type::Array {
                                        elem: Box::new(Type::F64),
                                    })
                        }
                        "get" => {
                            args.len() == 1 && args[0].ty() == Type::F64 && *r#type == Type::F64
                        }
                        "toStringVar" => {
                            receiver.ty() == Type::bytes()
                                && args.len() == 1
                                && args[0].ty() == Type::String
                                && *r#type == Type::String
                        }
                        "toStringRange" => {
                            receiver.ty() == Type::bytes()
                                && args.len() == 3
                                && args[0].ty() == Type::String
                                && args[1..].iter().all(|arg| arg.ty() == Type::F64)
                                && *r#type == Type::String
                        }
                        "join" => {
                            args.len() == 1
                                && args[0].ty() == Type::String
                                && *r#type == Type::String
                        }
                        "equals" => {
                            receiver.ty() == Type::bytes()
                                && args.len() == 1
                                && args[0].ty() == Type::bytes()
                                && *r#type == Type::Bool
                        }
                        "slice" | "subarray" => {
                            args.len() <= 2
                                && args.iter().all(|a| a.ty() == Type::F64)
                                && *r#type == receiver.ty()
                        }
                        "setFrom" => {
                            (args.len() == 1 || args.len() == 2)
                                && args[0].ty() == receiver.ty()
                                && args.get(1).is_none_or(|a| a.ty() == Type::F64)
                                && *r#type == Type::Void
                        }
                        "setFromArray" => {
                            (args.len() == 1 || args.len() == 2)
                                && args[0].ty()
                                    == (Type::Array {
                                        elem: Box::new(Type::F64),
                                    })
                                && args.get(1).is_none_or(|a| a.ty() == Type::F64)
                                && *r#type == Type::Void
                        }
                        "writeString" => {
                            receiver.ty() == Type::bytes()
                                && (1..=4).contains(&args.len())
                                && args.iter().all(|arg| arg.ty() == Type::Dyn)
                                && *r#type == Type::F64
                        }
                        "writeUIntBE" => {
                            receiver.ty() == Type::bytes()
                                && args.len() == 3
                                && args.iter().all(|a| a.ty() == Type::F64)
                                && *r#type == Type::F64
                        }
                        "readUIntBE" => {
                            receiver.ty() == Type::bytes()
                                && args.len() == 2
                                && args.iter().all(|a| a.ty() == Type::F64)
                                && *r#type == Type::F64
                        }
                        "copy" => {
                            receiver.ty() == Type::bytes()
                                && (1..=4).contains(&args.len())
                                && args[0].ty() == Type::bytes()
                                && args.iter().skip(1).all(|a| a.ty() == Type::F64)
                                && *r#type == Type::F64
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
                let valid = if method == "match" {
                    receiver.ty() == Type::String
                        && args.len() == 1
                        && args[0].ty() == Type::Regex
                        && regex_captures::exec_layout(module, r#type).is_some()
                } else if method == "matchAll" {
                    receiver.ty() == Type::String
                        && args.len() == 1
                        && args[0].ty() == Type::Regex
                        && regex_captures::match_all_layout(module, r#type).is_some()
                } else if method == "split" {
                    receiver.ty() == Type::String
                        && args.len() == 2
                        && args[0].ty() == Type::Regex
                        && args[1].ty() == Type::F64
                        && *r#type
                            == (Type::Array {
                                elem: Box::new(Type::String),
                            })
                } else if matches!(method.as_str(), "replace" | "replaceAll") {
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
                let class = module.class(class_name);
                if *r#type
                    != (Type::Classval {
                        class_name: class_name.clone(),
                    })
                    || !class.is_some_and(|class| {
                        !class.js_name.is_empty()
                            && (class.runtime
                                || ctor.is_some_and(|f| {
                                    !f.is_async
                                        && f.return_type == Type::Void
                                        && f.captures.is_none()
                                        && f.params.first().map(|p| &p.r#type)
                                            == Some(&Type::Object {
                                                class_name: class_name.clone(),
                                            })
                                }))
                    })
                {
                    return Err("invalid native class value".into());
                }
                Ok(())
            }
            Expr::ClassCreate {
                class_name,
                parent,
                captures,
                r#type,
                ..
            } => {
                let class = module
                    .class(class_name)
                    .ok_or("dynamic class layout is missing")?;
                if *r#type
                    != (Type::Classval {
                        class_name: class_name.clone(),
                    })
                    || captures.len() != class.captures.len()
                    || captures
                        .iter()
                        .zip(&class.captures)
                        .any(|(value, expected)| value.ty() != *expected)
                {
                    return Err("invalid dynamic class creation".into());
                }
                if let Some(parent) = parent {
                    expr(parent, locals, initialized, functions, module)?;
                    if !matches!(parent.ty(), Type::Classval { .. }) {
                        return Err("dynamic class parent is not a class value".into());
                    }
                }
                for capture in captures {
                    expr(capture, locals, initialized, functions, module)?;
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
                    || ctor.params.len()
                        != args.len() + 1 + module.class(class_name).unwrap().captures.len()
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
                    || (*r#type != target.call_result()
                        && !(*r#type == Type::Dyn && target.call_result() == Type::Void))
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
            } if r#fn == "dyn.valueInstanceof" => {
                for arg in args {
                    expr(arg, locals, initialized, functions, module)?;
                }
                if *r#type != Type::Bool
                    || args.len() != 2
                    || args.iter().any(|arg| arg.ty() != Type::Dyn)
                {
                    return Err("invalid native dynamic instanceof".into());
                }
                Ok(())
            }
            Expr::LibCall {
                r#fn, args, r#type, ..
            } if matches!(
                r#fn.as_str(),
                "map.constructorValue"
                    | "promise.constructorValue"
                    | "regex.constructorValue"
                    | "regex.globalValue"
                    | "legacy.unescapeGlobal"
                    | "array.spliceMethodValue"
            ) =>
            {
                if !args.is_empty() || *r#type != Type::Dyn {
                    return Err("invalid native intrinsic function value".into());
                }
                Ok(())
            }
            Expr::LibCall {
                r#fn, args, r#type, ..
            } if r#fn == "class.capture" => {
                for arg in args {
                    expr(arg, locals, initialized, functions, module)?;
                }
                let valid = match args.as_slice() {
                    [
                        object,
                        Expr::NumLit { value, .. },
                        Expr::StrLit { value: owner, .. },
                    ] if value.is_finite() && *value >= 0.0 && value.fract() == 0.0 => {
                        let receiver = match object.ty() {
                            Type::Object { class_name } => Some(class_name),
                            _ => None,
                        };
                        module.class(owner).is_some_and(|class| {
                            receiver.is_some_and(|receiver| module.subclass(&receiver, owner))
                                && class.captures.get(*value as usize) == Some(r#type)
                        })
                    }
                    _ => false,
                };
                if valid {
                    Ok(())
                } else {
                    Err("invalid native class capture read".into())
                }
            }
            Expr::LibCall {
                r#fn, args, r#type, ..
            } if r#fn == "class.captureSet" => {
                for arg in args {
                    expr(arg, locals, initialized, functions, module)?;
                }
                let valid = match args.as_slice() {
                    [
                        object,
                        Expr::NumLit { value, .. },
                        Expr::StrLit { value: owner, .. },
                        assigned,
                    ] if value.is_finite() && *value >= 0.0 && value.fract() == 0.0 => {
                        let receiver = match object.ty() {
                            Type::Object { class_name } => Some(class_name),
                            _ => None,
                        };
                        module.class(owner).is_some_and(|class| {
                            receiver.is_some_and(|receiver| module.subclass(&receiver, owner))
                                && class.captures.get(*value as usize) == Some(r#type)
                                && assigned.ty() == *r#type
                        })
                    }
                    _ => false,
                };
                if valid {
                    Ok(())
                } else {
                    Err("invalid native class capture write".into())
                }
            }
            Expr::LibCall {
                r#fn, args, r#type, ..
            } if matches!(
                r#fn.as_str(),
                "class.instanceConstructor" | "class.lexicalConstructor"
            ) =>
            {
                if args.len() != 1
                    || !matches!(
                        (&args[0].ty(), r#type),
                        (
                            Type::Object { class_name: object },
                            Type::Classval { class_name: constructor }
                        ) if r#fn == "class.lexicalConstructor"
                            || object == constructor
                    )
                {
                    return Err("invalid native instance constructor read".into());
                }
                Ok(())
            }
            Expr::LibCall {
                r#fn, args, r#type, ..
            } if r#fn.starts_with("error.") => {
                for arg in args {
                    expr(arg, locals, initialized, functions, module)?;
                }
                let builtin = |ty: Type| matches!(ty, Type::Object { class_name } if builtin_error_class(&class_name) && module.class(&class_name).is_some_and(|c| c.runtime));
                let valid = match r#fn.as_str() {
                    "error.new" => {
                        (args.len() == 1 || (args.len() == 2 && args[1].ty() == Type::Dyn))
                            && args[0].ty() == Type::String
                            && builtin(r#type.clone())
                    }
                    "error.ctor" => {
                        (args.len() == 2 || (args.len() == 3 && args[2].ty() == Type::Dyn))
                            && builtin(args[0].ty())
                            && args[1].ty() == Type::String
                            && *r#type == Type::Void
                    }
                    "error.domException" => {
                        args.len() == 2
                            && args.iter().all(|arg| arg.ty() == Type::String)
                            && matches!(r#type, Type::Object { class_name } if class_name == "%DOMException")
                            && builtin(r#type.clone())
                    }
                    "error.domExceptionCtor" => {
                        args.len() == 3
                            && builtin(args[0].ty())
                            && args[1].ty() == Type::String
                            && args[2].ty() == Type::String
                            && *r#type == Type::Void
                    }
                    "error.aggregate" => {
                        (args.len() == 2 || (args.len() == 3 && args[2].ty() == Type::Dyn))
                            && args[0].ty() == Type::Dyn
                            && args[1].ty() == Type::String
                            && matches!(r#type, Type::Object { class_name } if class_name == "%AggregateError")
                            && builtin(r#type.clone())
                    }
                    "error.captureStackTrace" => {
                        (args.len() == 1 || args.len() == 2) && *r#type == Type::Void
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
                    Err(format!(
                        "invalid native Error operation {}({:?}) -> {:?}",
                        r#fn,
                        args.iter().map(Expr::ty).collect::<Vec<_>>(),
                        r#type
                    ))
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
                    "forEach" => {
                        args.len() == 2
                            && args.iter().all(|arg| arg.ty() == Type::Dyn)
                            && *r#type == Type::Void
                    }
                    "size" => args.is_empty() && *r#type == Type::F64,
                    "keysToArray" => {
                        args.is_empty() && *r#type == (Type::Array { elem: key.clone() })
                    }
                    "valuesToArray" => {
                        args.is_empty()
                            && *r#type
                                == (Type::Array {
                                    elem: value.clone(),
                                })
                    }
                    "valuesIterator" => {
                        args.is_empty()
                            && *r#type
                                == (Type::Generator {
                                    r#async: false,
                                    yield_type: Box::new(Type::Dyn),
                                    return_type: Box::new(Type::Void),
                                    next_type: Box::new(Type::Undefined),
                                })
                    }
                    "valuesIteratorObject" => args.is_empty() && *r#type == Type::Dyn,
                    "entriesToArray" => {
                        let Type::Array { elem } = r#type else {
                            return Err("invalid Map entries result".into());
                        };
                        if let Type::Array { elem: item } = elem.as_ref() {
                            return if **item == *key && **item == *value {
                                Ok(())
                            } else {
                                Err("invalid homogeneous Map entry array".into())
                            };
                        }
                        let Type::Record { shape_id } = elem.as_ref() else {
                            return Err("invalid Map entry tuple".into());
                        };
                        let record = module
                            .records
                            .get(*shape_id)
                            .ok_or("unknown Map entry tuple")?;
                        args.is_empty()
                            && record.tuple
                            && record.fields.len() == 2
                            && record
                                .fields
                                .iter()
                                .any(|field| field.name == "0" && field.r#type == *key)
                            && record
                                .fields
                                .iter()
                                .any(|field| field.name == "1" && field.r#type == *value)
                    }
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
                    if seed.ty() != (Type::Array { elem: elem.clone() }) && seed.ty() != Type::Dyn {
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
                    "add" | "addValue" => (1, Type::Void),
                    "has" | "delete" | "hasValue" | "deleteValue" => (1, Type::Bool),
                    "clear" => (0, Type::Void),
                    "size" => (0, Type::F64),
                    "toArray" => (0, Type::Array { elem: elem.clone() }),
                    "iterator" => (
                        0,
                        Type::Generator {
                            r#async: false,
                            yield_type: elem.clone(),
                            return_type: Box::new(Type::Void),
                            next_type: Box::new(Type::Undefined),
                        },
                    ),
                    "dynamicIterator" => (
                        0,
                        Type::Generator {
                            r#async: false,
                            yield_type: Box::new(Type::Dyn),
                            return_type: Box::new(Type::Void),
                            next_type: Box::new(Type::Undefined),
                        },
                    ),
                    _ => return Err("invalid Set operation".into()),
                };
                let arg_type = if matches!(method.as_str(), "addValue" | "hasValue" | "deleteValue")
                {
                    Type::Dyn
                } else {
                    *elem
                };
                if args.len() != arity
                    || *r#type != result
                    || args.iter().any(|a| a.ty() != arg_type)
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
                let valid = (method == "split"
                    && args.len() == 2
                    && args[0].ty() == Type::String
                    && args[1].ty() == Type::F64
                    && *r#type
                        == (Type::Array {
                            elem: Box::new(Type::String),
                        }))
                    || (matches!(
                        method.as_str(),
                        "decodeURIComponent"
                            | "decodeURI"
                            | "encodeURIComponent"
                            | "encodeURI"
                            | "unescape"
                            | "atob"
                            | "btoa"
                    ) && args.is_empty()
                        && *r#type == Type::String)
                    || crate::string_builtins::by_method(method).is_some_and(|operation| {
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
                    "freeze" => *r#type == receiver.ty() && args.is_empty(),
                    "hasStoredValue" => {
                        *r#type == Type::Bool && args.len() == 1 && args[0].ty() == Type::F64
                    }
                    "join" => {
                        *elem == Type::String
                            && *r#type == Type::String
                            && args.len() == 1
                            && args[0].ty() == Type::String
                    }
                    "nextPresent" | "previousPresent" => {
                        *r#type == Type::F64 && args.len() == 1 && args[0].ty() == Type::F64
                    }
                    "slice" => {
                        *r#type == receiver.ty()
                            && args.len() <= 2
                            && args.iter().all(|arg| arg.ty() == Type::F64)
                    }
                    "fill" => {
                        *r#type == receiver.ty()
                            && (1..=3).contains(&args.len())
                            && args[0].ty() == *elem
                            && args[1..].iter().all(|arg| arg.ty() == Type::F64)
                    }
                    "reverse" => *r#type == receiver.ty() && args.is_empty(),
                    "splice" => {
                        *r#type == receiver.ty()
                            && args.len() >= 2
                            && args[0].ty() == Type::F64
                            && args[1].ty() == Type::F64
                            && args[2..].iter().all(|arg| arg.ty() == *elem)
                    }
                    "indexOf" => {
                        *r#type == Type::F64
                            && (1..=2).contains(&args.len())
                            && args[0].ty() == *elem
                            && args.get(1).is_none_or(|arg| arg.ty() == Type::F64)
                    }
                    "entriesToArray" => {
                        let Type::Array { elem: pair } = r#type else {
                            return Err("invalid array entries result".into());
                        };
                        let Type::Record { shape_id } = pair.as_ref() else {
                            return Err("invalid array entry tuple".into());
                        };
                        let record = module
                            .records
                            .get(*shape_id)
                            .ok_or("unknown array entry tuple")?;
                        args.is_empty()
                            && record.tuple
                            && record.fields.len() == 2
                            && record
                                .fields
                                .iter()
                                .any(|field| field.name == "0" && field.r#type == Type::F64)
                            && record
                                .fields
                                .iter()
                                .any(|field| field.name == "1" && field.r#type == *elem)
                    }
                    "push" | "unshift" => {
                        *r#type == Type::F64 && args.iter().all(|arg| arg.ty() == *elem)
                    }
                    "unshiftFrom" => {
                        *r#type == Type::F64 && args.len() == 1 && args[0].ty() == receiver.ty()
                    }
                    "concat" => {
                        *r#type == receiver.ty()
                            && args
                                .iter()
                                .all(|arg| arg.ty() == *elem || arg.ty() == receiver.ty())
                    }
                    "concatFrom" => {
                        *r#type == Type::F64 && args.len() == 1 && args[0].ty() == receiver.ty()
                    }
                    "pop" | "shift" => {
                        args.is_empty()
                            && ((*elem == Type::Dyn && *r#type == Type::Dyn)
                                || match r#type {
                                    Type::Union { union_id } => {
                                        module.unions.get(*union_id).is_some_and(|union| {
                                            union.arms.contains(&Type::Undefined)
                                                && if matches!(*elem, Type::Union { .. }) {
                                                    *r#type == *elem
                                                } else {
                                                    union.arms.len() == 2
                                                        && union.arms.contains(&elem)
                                                }
                                        })
                                    }
                                    _ => false,
                                })
                    }
                    _ => false,
                };
                if !valid {
                    return Err(format!(
                        "invalid array operation: method={} receiver={:?} args={:?} result={:?}",
                        method,
                        receiver.ty(),
                        args.iter().map(Expr::ty).collect::<Vec<_>>(),
                        r#type,
                    ));
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
                    if std::env::var_os("SCRIPTC_TRACE_CLOSURES").is_some() {
                        eprintln!(
                            "scriptc: closure {fn_name} typed {:?}, function {:?}, captures {} vs {}",
                            r#type,
                            expected,
                            captures.len(),
                            want.len()
                        );
                    }
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
                        && !matches!(&f.value, Expr::DynFrom { value, .. } if value.ty() == Type::Undefined)
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
                    match value.as_ref() {
                        Expr::UnitLit {
                            unit: "null",
                            r#type: Type::Null,
                            ..
                        }
                        | Expr::UnitLit {
                            unit: "undefined",
                            r#type: Type::Undefined,
                            ..
                        } => {}
                        Expr::UnionNarrow {
                            union_id: source_union_id,
                            tag: source_tag,
                            value: source,
                            r#type: source_type,
                            ..
                        } => {
                            // A nullish arm can move between union layouts without
                            // materializing a new value. Validate the extraction here:
                            // standalone unit narrowing remains invalid, while this
                            // immediately consumed form preserves the source check.
                            expr(source, locals, initialized, functions, module)?;
                            let Type::Union {
                                union_id: source_id,
                            } = source.ty()
                            else {
                                return Err("non-union unit extraction".into());
                            };
                            let source_union = module
                                .unions
                                .get(source_id)
                                .ok_or("unknown unit source union")?;
                            let source_arm = source_union
                                .arms
                                .get(*source_tag)
                                .ok_or("invalid unit source tag")?;
                            if *source_union_id != format!("u{source_id}")
                                || source_type != source_arm
                                || !matches!(source_arm, Type::Null | Type::Undefined)
                            {
                                return Err("invalid unit union extraction".into());
                            }
                        }
                        _ => {
                            return Err(format!(
                                "unit union payload must be a literal or checked extraction: union={union_id} tag={tag} arm={:?} payload={value:?}",
                                value.ty(),
                            ));
                        }
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
                loc,
            }
            | Expr::UnionIsTag {
                union_id,
                tag,
                value,
                r#type,
                loc,
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
                    return Err(format!(
                        "standalone unit narrowing at {}:{}..{}: union {:?}, tag {}, arm {:?}",
                        loc.file, loc.start, loc.end, union.arms, tag, arm
                    ));
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
            Expr::UnionProject { value, r#type, .. } => {
                expr(value, locals, initialized, functions, module)?;
                let Type::Union { union_id: source } = value.ty() else {
                    return Err("non-union projection source".into());
                };
                let Type::Union { union_id: target } = r#type else {
                    return Err("non-union projection target".into());
                };
                let source = module.unions.get(source).ok_or("unknown source union")?;
                let target = module.unions.get(*target).ok_or("unknown target union")?;
                if target.arms.len() >= source.arms.len()
                    || target.arms.iter().any(|arm| !source.arms.contains(arm))
                {
                    return Err("invalid narrowed union projection".into());
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
                r#fn,
                args,
                r#type,
                loc,
                ..
            } => {
                if r#fn == "template.object" {
                    for arg in args {
                        expr(arg, locals, initialized, functions, module)?;
                    }
                    let dynamic_array = Type::Array {
                        elem: Box::new(Type::Dyn),
                    };
                    let string_entry = |entry: &Expr| {
                        matches!(entry,
                        Expr::DynFrom { value, .. } if matches!(value.as_ref(), Expr::StrLit { .. }))
                    };
                    let undefined_entry = |entry: &Expr| {
                        matches!(entry,
                        Expr::DynFrom { value, .. } if matches!(value.as_ref(), Expr::UnitLit { unit, r#type: Type::Undefined, .. } if *unit == "undefined"))
                    };
                    let valid = matches!(args.as_slice(), [Expr::StrLit { value: site, .. }, Expr::ArrayLit { elems: cooked, r#type: cooked_type, .. }, Expr::ArrayLit { elems: raw, r#type: raw_type, .. }]
                        if !cooked.is_empty() && cooked.len() == raw.len()
                            && !site.is_empty()
                            && *cooked_type == dynamic_array && *raw_type == dynamic_array
                            && cooked.iter().all(|entry| string_entry(entry) || undefined_entry(entry))
                            && raw.iter().all(string_entry))
                        && *r#type == dynamic_array;
                    return if valid {
                        Ok(())
                    } else {
                        Err("invalid native template object".into())
                    };
                }
                if r#fn == "regex.constructDynamic" {
                    for arg in args {
                        expr(arg, locals, initialized, functions, module)?;
                    }
                    return if args.iter().all(|arg| arg.ty() == Type::Dyn) && *r#type == Type::Dyn {
                        Ok(())
                    } else {
                        Err("invalid dynamic RegExp construction".into())
                    };
                }
                if r#fn == "regex.requireGlobal" {
                    return if args.is_empty() && *r#type == Type::Void {
                        Ok(())
                    } else {
                        Err("invalid RegExp global constructor guard".into())
                    };
                }
                if r#fn == "legacy.requireUnescape" {
                    return if args.is_empty() && *r#type == Type::Void {
                        Ok(())
                    } else {
                        Err("invalid unescape global binding guard".into())
                    };
                }
                if matches!(r#fn.as_str(), "array.setSloppy" | "array.setLengthSloppy") {
                    for arg in args {
                        expr(arg, locals, initialized, functions, module)?;
                    }
                    let valid = match args.as_slice() {
                        [array, index, value] if r#fn == "array.setSloppy" => {
                            matches!(array.ty(), Type::Array { elem } if *elem == value.ty())
                                && index.ty() == Type::F64
                        }
                        [array, length] if r#fn == "array.setLengthSloppy" => {
                            matches!(array.ty(), Type::Array { .. }) && length.ty() == Type::F64
                        }
                        _ => false,
                    };
                    return if valid && *r#type == Type::Void {
                        Ok(())
                    } else {
                        Err("invalid sloppy native array write".into())
                    };
                }
                if r#fn == "map.valueView" {
                    let valid = if let [source] = args.as_slice()
                        && let Type::Map {
                            key: source_key,
                            value: source_value,
                        } = source.ty()
                        && let Type::Map {
                            key: target_key,
                            value: target_value,
                        } = r#type
                    {
                        source_key == *target_key && source_value != *target_value
                    } else {
                        false
                    };
                    return if valid {
                        Ok(())
                    } else {
                        Err("invalid Map value view".into())
                    };
                }
                if r#fn == "map.sameIdentity" {
                    let valid = if let [left, right] = args.as_slice()
                        && let Type::Map { key: left_key, .. } = left.ty()
                        && let Type::Map { key: right_key, .. } = right.ty()
                    {
                        left_key == right_key && *r#type == Type::Bool
                    } else {
                        false
                    };
                    return if valid {
                        Ok(())
                    } else {
                        Err("invalid Map identity comparison".into())
                    };
                }
                if r#fn == "abort.controllerNew" {
                    return if args.is_empty() && *r#type == Type::Dyn {
                        Ok(())
                    } else {
                        Err("invalid AbortController constructor".into())
                    };
                }
                if r#fn == "web.transformStreamNew" {
                    return if args.is_empty() && *r#type == Type::Dyn {
                        Ok(())
                    } else {
                        Err("invalid TransformStream constructor".into())
                    };
                }
                if r#fn == "web.textDecoderStreamNew" {
                    return if args.is_empty() && *r#type == Type::Dyn {
                        Ok(())
                    } else {
                        Err("invalid TextDecoderStream constructor".into())
                    };
                }
                if r#fn == "web.readableStreamNew" {
                    return if args.len() == 1 && args[0].ty() == Type::Dyn && *r#type == Type::Dyn {
                        Ok(())
                    } else {
                        Err("invalid ReadableStream constructor".into())
                    };
                }
                if r#fn == "fetch.headersNew" {
                    return if args.len() == 1 && args[0].ty() == Type::Dyn && *r#type == Type::Dyn {
                        Ok(())
                    } else {
                        Err("invalid Headers constructor".into())
                    };
                }
                if r#fn == "array.fromTyped" {
                    for arg in args {
                        expr(arg, locals, initialized, functions, module)?;
                    }
                    return if args.len() == 1
                        && args[0].ty() == Type::Dyn
                        && *r#type
                            == (Type::Array {
                                elem: Box::new(Type::F64),
                            })
                    {
                        Ok(())
                    } else {
                        Err("invalid Array.from typed array conversion".into())
                    };
                }
                if r#fn == "array.pushApplyDynamic" {
                    for arg in args {
                        expr(arg, locals, initialized, functions, module)?;
                    }
                    return if args.len() == 2
                        && args.iter().all(|arg| arg.ty() == Type::Dyn)
                        && *r#type == Type::F64
                    {
                        Ok(())
                    } else {
                        Err("invalid dynamic Array.prototype.push.apply".into())
                    };
                }
                if r#fn == "dyn.callSpread" {
                    for arg in args {
                        expr(arg, locals, initialized, functions, module)?;
                    }
                    return if matches!(args.as_slice(), [callee, values]
                        if callee.ty() == Type::Dyn
                            && matches!(values.ty(), Type::Array { elem } if *elem == Type::Dyn))
                        && *r#type == Type::Dyn
                    {
                        Ok(())
                    } else {
                        Err("invalid dynamic spread call".into())
                    };
                }
                if r#fn == "dyn.callWithThisSpread" {
                    for arg in args {
                        expr(arg, locals, initialized, functions, module)?;
                    }
                    return if matches!(args.as_slice(), [callee, receiver, values]
                        if callee.ty() == Type::Dyn && receiver.ty() == Type::Dyn
                            && matches!(values.ty(), Type::Array { elem } if *elem == Type::Dyn))
                        && *r#type == Type::Dyn
                    {
                        Ok(())
                    } else {
                        Err("invalid prepared dynamic spread method call".into())
                    };
                }
                if r#fn == "dyn.invokeSpread" {
                    for arg in args {
                        expr(arg, locals, initialized, functions, module)?;
                    }
                    return if matches!(args.as_slice(), [receiver, method, values]
                        if receiver.ty() == Type::Dyn
                            && method.ty() == Type::String
                            && matches!(values.ty(), Type::Array { elem } if *elem == Type::Dyn))
                        && *r#type == Type::Dyn
                    {
                        Ok(())
                    } else {
                        Err("invalid dynamic spread method call".into())
                    };
                }
                if matches!(r#fn.as_str(), "url.newValue" | "url.newValueBase") {
                    for arg in args {
                        expr(arg, locals, initialized, functions, module)?;
                    }
                    let arity = if r#fn == "url.newValue" { 1 } else { 2 };
                    return if args.len() == arity
                        && args.iter().all(|arg| arg.ty() == Type::String)
                        && *r#type == Type::Dyn
                    {
                        Ok(())
                    } else {
                        Err("invalid native URL construction".into())
                    };
                }
                if matches!(
                    r#fn.as_str(),
                    "searchParams.newValue"
                        | "searchParams.parseValue"
                        | "searchParams.keysArray"
                        | "searchParams.valuesArray"
                        | "searchParams.entriesArray"
                ) {
                    for arg in args {
                        expr(arg, locals, initialized, functions, module)?;
                    }
                    return if (*r#type == Type::Dyn
                        && ((r#fn == "searchParams.newValue" && args.is_empty())
                            || (r#fn == "searchParams.parseValue"
                                && args.len() == 1
                                && args[0].ty() == Type::String)))
                        || (matches!(
                            r#fn.as_str(),
                            "searchParams.keysArray" | "searchParams.valuesArray"
                        ) && args.len() == 1
                            && args[0].ty() == Type::Dyn
                            && *r#type
                                == (Type::Array {
                                    elem: Box::new(Type::String),
                                }))
                        || (r#fn == "searchParams.entriesArray"
                            && args.len() == 1
                            && args[0].ty() == Type::Dyn
                            && *r#type
                                == (Type::Array {
                                    elem: Box::new(Type::Array {
                                        elem: Box::new(Type::String),
                                    }),
                                }))
                    {
                        Ok(())
                    } else {
                        Err("invalid native URLSearchParams operation".into())
                    };
                }
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
                    if !expected.is_some_and(|(arity, result)| {
                        args.len() == arity
                            && *r#type == result
                            && matches!(args[0].ty(), Type::Object { class_name } if class_name == "native_builtin_WeakMap")
                            && matches!(args[1].ty(), Type::Dyn | Type::Object { .. })
                            && args[2..].iter().all(|arg| arg.ty() == Type::Dyn)
                    }) { return Err("invalid native weak map operation".into()); }
                    return Ok(());
                }
                if matches!(r#fn.as_str(), "nodeStream.destroy" | "nodeStream.destroyed") {
                    for arg in args {
                        expr(arg, locals, initialized, functions, module)?;
                    }
                    let owner = args.first().is_some_and(|arg| matches!(arg.ty(), Type::Object { ref class_name } if matches!(class_name.as_str(), "native_builtin_Transform" | "native_builtin_Duplex" | "native_builtin_Readable" | "native_builtin_Writable")));
                    let valid = owner
                        && if r#fn == "nodeStream.destroy" {
                            (args.len() == 1 || (args.len() == 2 && args[1].ty() == Type::Dyn))
                                && args[0].ty() == *r#type
                        } else {
                            args.len() == 1 && *r#type == Type::Bool
                        };
                    return if valid {
                        Ok(())
                    } else {
                        Err("invalid native stream state operation".into())
                    };
                }
                if r#fn == "timers.methodValue" {
                    for arg in args {
                        expr(arg, locals, initialized, functions, module)?;
                    }
                    let valid = args.len() == 2
                        && args[0].ty() == Type::F64
                        && matches!(&args[1], Expr::StrLit { value, .. } if matches!(value.as_str(), "refresh" | "ref" | "unref" | "hasRef"))
                        && *r#type == Type::Dyn;
                    return if valid {
                        Ok(())
                    } else {
                        Err("invalid native timer method value".into())
                    };
                }
                if matches!(
                    r#fn.as_str(),
                    "dom.targetAdd" | "dom.targetRemove" | "dom.targetDispatch"
                ) {
                    for arg in args {
                        expr(arg, locals, initialized, functions, module)?;
                    }
                    let owner = matches!(args.first().map(Expr::ty), Some(Type::Object { class_name }) if module.subclass(&class_name, "native_builtin_EventTarget"));
                    let valid = match r#fn.as_str() {
                        "dom.targetAdd" | "dom.targetRemove" => {
                            args.len() == 4
                                && args[1].ty() == Type::String
                                && args[2].ty() == Type::Dyn
                                && args[3].ty() == Type::Dyn
                                && *r#type == Type::Void
                        }
                        "dom.targetDispatch" => {
                            args.len() == 2 && args[1].ty() == Type::Dyn && *r#type == Type::Bool
                        }
                        _ => false,
                    };
                    return if owner && valid {
                        Ok(())
                    } else {
                        Err("invalid native EventTarget operation".into())
                    };
                }
                if matches!(
                    r#fn.as_str(),
                    "dom.eventNew" | "dom.eventGet" | "dom.eventAction"
                ) {
                    for arg in args {
                        expr(arg, locals, initialized, functions, module)?;
                    }
                    let valid = match r#fn.as_str() {
                        "dom.eventNew" => {
                            args.len() == 2
                                && args[0].ty() == Type::String
                                && args[1].ty() == Type::Dyn
                                && matches!(r#type, Type::Object { class_name } if class_name == "native_builtin_Event" && module.class(class_name).is_some())
                        }
                        "dom.eventGet" => {
                            args.len() == 2
                                && matches!(args[0].ty(), Type::Object { class_name } if module.subclass(&class_name, "native_builtin_Event"))
                                && matches!(&args[1], Expr::StrLit { value, .. } if matches!(value.as_str(), "type" | "bubbles" | "cancelable" | "composed" | "defaultPrevented" | "isTrusted" | "cancelBubble" | "eventPhase" | "target" | "currentTarget" | "srcElement"))
                                && *r#type == Type::Dyn
                        }
                        "dom.eventAction" => {
                            args.len() == 2
                                && matches!(args[0].ty(), Type::Object { class_name } if module.subclass(&class_name, "native_builtin_Event"))
                                && matches!(&args[1], Expr::StrLit { value, .. } if matches!(value.as_str(), "preventDefault" | "stopPropagation" | "stopImmediatePropagation"))
                                && *r#type == Type::Void
                        }
                        _ => false,
                    };
                    return if valid {
                        Ok(())
                    } else {
                        Err("invalid native DOM Event operation".into())
                    };
                }
                if let Some(operation) = r#fn.strip_prefix("events.instance") {
                    for arg in args {
                        expr(arg, locals, initialized, functions, module)?;
                    }
                    let owner = matches!(args.first().map(Expr::ty), Some(Type::Object { class_name })
                        if module.subclass(&class_name, "native_builtin_EventEmitter"));
                    let event = args.get(1).is_some_and(|arg| arg.ty() == Type::String);
                    let valid = match operation {
                        "On" | "Prepend" | "Once" | "PrependOnce" | "Off" => {
                            args.len() == 3 && args[2].ty() == Type::Dyn && *r#type == args[0].ty()
                        }
                        "Emit" => {
                            args.len() >= 2
                                && args[2..].iter().all(|arg| arg.ty() == Type::Dyn)
                                && *r#type == Type::Bool
                        }
                        _ => false,
                    };
                    return if owner && event && valid {
                        Ok(())
                    } else {
                        Err("invalid native EventEmitter operation".into())
                    };
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
                        Err(format!(
                            "invalid native record own-value write: args={:?}, result={:?}",
                            args.iter().map(Expr::ty).collect::<Vec<_>>(),
                            r#type
                        ))
                    };
                }
                if r#fn == "record.view" || r#fn == "record.checkedView" {
                    for arg in args {
                        expr(arg, locals, initialized, functions, module)?;
                    }
                    let pairs = if r#fn == "record.checkedView" {
                        record_views::dynamic_view_pairs(
                            &args[0].ty(),
                            r#type,
                            &module.records,
                            &module.unions,
                        )
                    } else {
                        record_views::view_pairs(
                            &args[0].ty(),
                            r#type,
                            &module.records,
                            &module.unions,
                        )
                    };
                    return if args.len() == 1 && pairs.is_some() {
                        Ok(())
                    } else {
                        Err("invalid or ambiguous native record view".into())
                    };
                }
                if r#fn == "record.mutableDynView" {
                    for arg in args {
                        expr(arg, locals, initialized, functions, module)?;
                    }
                    return if matches!(args.as_slice(), [source]
                        if matches!(source.ty(), Type::Record { .. }))
                        && *r#type == Type::Dyn
                    {
                        Ok(())
                    } else {
                        Err("invalid mutable native record view".into())
                    };
                }
                if r#fn == "array.view" {
                    for arg in args {
                        expr(arg, locals, initialized, functions, module)?;
                    }
                    let valid = matches!(args.as_slice(), [source]
                        if matches!((source.ty(), r#type),
                            (Type::Array { elem: source }, Type::Array { elem: target })
                                if source != *target));
                    return if valid {
                        Ok(())
                    } else {
                        Err("invalid native array view".into())
                    };
                }
                if r#fn == "array.generator" {
                    for arg in args {
                        expr(arg, locals, initialized, functions, module)?;
                    }
                    let valid = matches!(args.as_slice(), [source]
                        if matches!((source.ty(), r#type),
                            (Type::Array { elem: source }, Type::Generator {
                                r#async: false,
                                yield_type,
                                return_type,
                                next_type,
                            }) if source == *yield_type
                                && matches!(**return_type, Type::Void | Type::Undefined)
                                && matches!(**next_type, Type::Void | Type::Undefined | Type::Dyn)));
                    return if valid {
                        Ok(())
                    } else {
                        Err("invalid native array generator".into())
                    };
                }
                if r#fn == "callable.view" {
                    for arg in args {
                        expr(arg, locals, initialized, functions, module)?;
                    }
                    return if args.len() == 1
                        && matches!(r#type, Type::Record { shape_id } if module.records.get(*shape_id).is_some_and(|record| !record.tuple && record.index_value.is_none() && record.fields.iter().any(|field| field.name == "\0scriptc.call" && (field.r#type == args[0].ty() || matches!(args[0].ty(), Type::Classval { .. })))))
                        && matches!(args[0].ty(), Type::Func { .. } | Type::Classval { .. })
                    {
                        Ok(())
                    } else {
                        Err("invalid native callable view".into())
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
                if r#fn == "dyn.proxyNew" {
                    for arg in args {
                        expr(arg, locals, initialized, functions, module)?;
                    }
                    return if args.len() == 2
                        && args.iter().all(|arg| arg.ty() == Type::Dyn)
                        && *r#type == Type::Dyn
                    {
                        Ok(())
                    } else {
                        Err("invalid native Proxy construction".into())
                    };
                }
                if r#fn == "dyn.reflectGet" || r#fn == "dyn.reflectSet" {
                    for arg in args {
                        expr(arg, locals, initialized, functions, module)?;
                    }
                    let valid = if r#fn == "dyn.reflectGet" {
                        args.len() == 3 && *r#type == Type::Dyn
                    } else {
                        args.len() == 4 && *r#type == Type::Bool
                    };
                    return if valid && args.iter().all(|arg| arg.ty() == Type::Dyn) {
                        Ok(())
                    } else {
                        Err("invalid native Reflect.get/set operation".into())
                    };
                }
                if r#fn == "dyn.reflectApply" {
                    for arg in args {
                        expr(arg, locals, initialized, functions, module)?;
                    }
                    return if args.len() == 3
                        && args.iter().all(|arg| arg.ty() == Type::Dyn)
                        && *r#type == Type::Dyn
                    {
                        Ok(())
                    } else {
                        Err("invalid native Reflect.apply operation".into())
                    };
                }
                if r#fn == "dyn.classLayoutIs" {
                    for arg in args {
                        expr(arg, locals, initialized, functions, module)?;
                    }
                    return if args.len() == 2
                        && args.iter().all(|arg| arg.ty() == Type::Dyn)
                        && *r#type == Type::Bool
                    {
                        Ok(())
                    } else {
                        Err("invalid native class layout test".into())
                    };
                }
                if r#fn == "dyn.constructCallable" {
                    for arg in args {
                        expr(arg, locals, initialized, functions, module)?;
                    }
                    return if !args.is_empty()
                        && args.iter().all(|arg| arg.ty() == Type::Dyn)
                        && *r#type == Type::Dyn
                    {
                        Ok(())
                    } else {
                        Err("invalid native callable construction".into())
                    };
                }
                if r#fn == "dyn.reflectOwnKeys" {
                    for arg in args {
                        expr(arg, locals, initialized, functions, module)?;
                    }
                    return if args.len() == 1
                        && args[0].ty() == Type::Dyn
                        && *r#type
                            == (Type::Array {
                                elem: Box::new(Type::Dyn),
                            })
                    {
                        Ok(())
                    } else {
                        Err("invalid native Reflect.ownKeys operation".into())
                    };
                }
                if r#fn == "dyn.objectOwnSymbols" {
                    for arg in args {
                        expr(arg, locals, initialized, functions, module)?;
                    }
                    return if args.len() == 1
                        && args[0].ty() == Type::Dyn
                        && *r#type
                            == (Type::Array {
                                elem: Box::new(Type::Symbol),
                            })
                    {
                        Ok(())
                    } else {
                        Err("invalid native Object.getOwnPropertySymbols operation".into())
                    };
                }
                if r#fn == "dyn.objectOwnNames" {
                    for arg in args {
                        expr(arg, locals, initialized, functions, module)?;
                    }
                    return if args.len() == 1
                        && args[0].ty() == Type::Dyn
                        && *r#type
                            == (Type::Array {
                                elem: Box::new(Type::String),
                            })
                    {
                        Ok(())
                    } else {
                        Err("invalid native Object.getOwnPropertyNames operation".into())
                    };
                }
                if r#fn == "promise.construct" {
                    for arg in args {
                        expr(arg, locals, initialized, functions, module)?;
                    }
                    let valid_executor = matches!(
                        args.as_slice(),
                        [executor]
                            if executor.ty() == Type::Dyn
                                || matches!(executor.ty(), Type::Func { rest: false, params, ret }
                                    if params == vec![Type::Dyn, Type::Dyn]
                                        && (*ret == Type::Void
                                            || matches!(ret.as_ref(), Type::Promise { inner }
                                                if inner.as_ref() == &Type::Void)))
                    );
                    return if valid_executor && matches!(r#type, Type::Promise { .. }) {
                        Ok(())
                    } else {
                        Err(format!(
                            "invalid native Promise construction at {}:{}..{}: executor {:?}, result {:?}",
                            loc.file,
                            loc.start,
                            loc.end,
                            args.first().map(Expr::ty),
                            r#type
                        ))
                    };
                }
                if r#fn == "dyn.freezeValue" {
                    for arg in args {
                        expr(arg, locals, initialized, functions, module)?;
                    }
                    return if args.len() == 1 && args[0].ty() == Type::Dyn && *r#type == Type::Dyn {
                        Ok(())
                    } else {
                        Err("invalid native freeze value".into())
                    };
                }
                if r#fn == "dyn.isFrozenValue" {
                    for arg in args {
                        expr(arg, locals, initialized, functions, module)?;
                    }
                    return if args.len() == 1 && args[0].ty() == Type::Dyn && *r#type == Type::Bool
                    {
                        Ok(())
                    } else {
                        Err("invalid native frozen-state query".into())
                    };
                }
                if r#fn == "dyn.sameValue" {
                    for arg in args {
                        expr(arg, locals, initialized, functions, module)?;
                    }
                    return if args.len() == 2
                        && args.iter().all(|arg| arg.ty() == Type::Dyn)
                        && *r#type == Type::Bool
                    {
                        Ok(())
                    } else {
                        Err("invalid native SameValue comparison".into())
                    };
                }
                if matches!(
                    r#fn.as_str(),
                    "dyn.objectRestCheck" | "dyn.objectAssignSourceCheck"
                ) {
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
                if matches!(
                    r#fn.as_str(),
                    "dyn.copyEnumerableSymbols" | "dyn.objectAssignCopy"
                ) {
                    for arg in args {
                        expr(arg, locals, initialized, functions, module)?;
                    }
                    return if args.len() == 2
                        && args.iter().all(|arg| arg.ty() == Type::Dyn)
                        && *r#type == Type::Void
                    {
                        Ok(())
                    } else {
                        Err("invalid native symbol copy".into())
                    };
                }
                if r#fn == "dyn.hasSymbolKey" {
                    for arg in args {
                        expr(arg, locals, initialized, functions, module)?;
                    }
                    return if args.len() == 2
                        && args.iter().all(|arg| arg.ty() == Type::Dyn)
                        && *r#type == Type::Bool
                    {
                        Ok(())
                    } else {
                        Err("invalid native symbol presence".into())
                    };
                }
                if r#fn == "dyn.defineOrdinaryData" {
                    for arg in args {
                        expr(arg, locals, initialized, functions, module)?;
                    }
                    return if args.len() == 3
                        && args.iter().all(|arg| arg.ty() == Type::Dyn)
                        && *r#type == Type::Dyn
                    {
                        Ok(())
                    } else {
                        Err("invalid native ordinary data descriptor".into())
                    };
                }
                if r#fn == "dyn.defineProperties" {
                    for arg in args {
                        expr(arg, locals, initialized, functions, module)?;
                    }
                    return if args.len() == 2
                        && args.iter().all(|arg| arg.ty() == Type::Dyn)
                        && *r#type == Type::Dyn
                    {
                        Ok(())
                    } else {
                        Err("invalid native Object.defineProperties operation".into())
                    };
                }
                if r#fn == "dyn.getOwnPropertyDescriptor" {
                    for arg in args {
                        expr(arg, locals, initialized, functions, module)?;
                    }
                    return if args.len() == 2
                        && args.iter().all(|arg| arg.ty() == Type::Dyn)
                        && *r#type == Type::Dyn
                    {
                        Ok(())
                    } else {
                        Err("invalid native own-property descriptor read".into())
                    };
                }
                if matches!(
                    r#fn.as_str(),
                    "dyn.defineOrdinaryGetter" | "dyn.defineOrdinarySetter"
                ) {
                    for arg in args {
                        expr(arg, locals, initialized, functions, module)?;
                    }
                    return if args.len() == 5
                        && args.iter().all(|arg| arg.ty() == Type::Dyn)
                        && *r#type == Type::Dyn
                    {
                        Ok(())
                    } else {
                        Err("invalid native accessor descriptor".into())
                    };
                }
                if r#fn == "dyn.defineOrdinaryAccessor" {
                    for arg in args {
                        expr(arg, locals, initialized, functions, module)?;
                    }
                    return if args.len() == 6
                        && args.iter().all(|arg| arg.ty() == Type::Dyn)
                        && *r#type == Type::Dyn
                    {
                        Ok(())
                    } else {
                        Err("invalid native combined accessor descriptor".into())
                    };
                }
                if r#fn == "dyn.keyDeleteComputed" {
                    for arg in args {
                        expr(arg, locals, initialized, functions, module)?;
                    }
                    return if args.len() == 3
                        && args[0].ty() == Type::Dyn
                        && args[1].ty() == Type::Dyn
                        && args[2].ty() == Type::Bool
                        && *r#type == Type::Bool
                    {
                        Ok(())
                    } else {
                        Err("invalid native computed property deletion".into())
                    };
                }
                if r#fn == "dyn.mapKeysImmediate" {
                    for arg in args {
                        expr(arg, locals, initialized, functions, module)?;
                    }
                    return if args.len() == 1
                        && args[0].ty() == Type::Dyn
                        && *r#type
                            == (Type::Array {
                                elem: Box::new(Type::Dyn),
                            })
                    {
                        Ok(())
                    } else {
                        Err("invalid dynamic immediate Map keys".into())
                    };
                }
                if r#fn == "dyn.arrayIteratorFirstResult" {
                    for arg in args {
                        expr(arg, locals, initialized, functions, module)?;
                    }
                    return if args.len() == 1 && args[0].ty() == Type::Dyn && *r#type == Type::Dyn {
                        Ok(())
                    } else {
                        Err("invalid immediate array iterator result".into())
                    };
                }
                if r#fn == "dyn.arrayIteratorNextResult" {
                    for arg in args {
                        expr(arg, locals, initialized, functions, module)?;
                    }
                    return if args.len() == 1 && args[0].ty() == Type::Dyn && *r#type == Type::Dyn {
                        Ok(())
                    } else {
                        Err("invalid stateful array iterator result".into())
                    };
                }
                if r#fn == "dyn.typedArrayNumericIndex" {
                    for arg in args {
                        expr(arg, locals, initialized, functions, module)?;
                    }
                    return if args.len() == 1 && args[0].ty() == Type::Dyn && *r#type == Type::F64 {
                        Ok(())
                    } else {
                        Err("invalid dynamic typed array numeric index".into())
                    };
                }
                if r#fn == "dyn.fromEntries" {
                    for arg in args {
                        expr(arg, locals, initialized, functions, module)?;
                    }
                    let valid = args.len() == 1
                        && (matches!(args[0].ty(), Type::Array { elem }
                            if matches!(*elem, Type::Array { .. } | Type::Dyn)
                                || matches!(*elem, Type::Record { shape_id }
                                    if module.records.get(shape_id).is_some_and(|record| record.tuple && record.fields.len() == 2)))
                            || matches!(args[0].ty(), Type::Map { key, .. }
                                if *key == Type::String))
                        && *r#type == Type::Dyn;
                    return if valid {
                        Ok(())
                    } else {
                        Err("invalid native Object.fromEntries".into())
                    };
                }
                if r#fn == "dyn.fromSearchParams" {
                    for arg in args {
                        expr(arg, locals, initialized, functions, module)?;
                    }
                    return if matches!(args.as_slice(), [value] if value.ty() == Type::Dyn)
                        && *r#type == Type::Dyn
                    {
                        Ok(())
                    } else {
                        Err("invalid native Object.fromEntries URLSearchParams input".into())
                    };
                }
                if r#fn == "dyn.fromHeaders" {
                    for arg in args {
                        expr(arg, locals, initialized, functions, module)?;
                    }
                    return if matches!(args.as_slice(), [value] if value.ty() == Type::Dyn)
                        && *r#type == Type::Dyn
                    {
                        Ok(())
                    } else {
                        Err("invalid native Object.fromEntries Headers input".into())
                    };
                }
                if matches!(
                    r#fn.as_str(),
                    "dyn.hasOwn" | "dyn.hasOwnKey" | "dyn.hasKey" | "dyn.objKeys"
                ) {
                    for arg in args {
                        expr(arg, locals, initialized, functions, module)?;
                    }
                    let valid = if r#fn == "dyn.hasOwnKey" {
                        args.len() == 2
                            && args.iter().all(|arg| arg.ty() == Type::Dyn)
                            && *r#type == Type::Bool
                    } else if r#fn != "dyn.objKeys" {
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
                if matches!(
                    r#fn.as_str(),
                    "buffer.fromStr"
                        | "buffer.fromDyn"
                        | "bytes.fromDyn"
                        | "text.decode"
                        | "text.decodeFatal"
                        | "text.decoderNew"
                        | "text.decodeStream"
                        | "text.decodeSelected"
                ) {
                    for arg in args {
                        expr(arg, locals, initialized, functions, module)?;
                    }
                    let valid = if r#fn == "text.decoderNew" {
                        args.is_empty() && *r#type == Type::F64
                    } else if matches!(r#fn.as_str(), "text.decodeStream" | "text.decodeSelected") {
                        args.len() == if r#fn == "text.decodeSelected" { 5 } else { 4 }
                            && args[0].ty() == Type::F64
                            && args[1].ty() == Type::bytes()
                            && args[2].ty() == Type::Bool
                            && args[3].ty() == Type::Bool
                            && (r#fn != "text.decodeSelected" || args[4].ty() == Type::F64)
                            && *r#type == Type::String
                    } else if r#fn == "bytes.fromDyn" {
                        args.len() == 1 && args[0].ty() == Type::Dyn && *r#type == Type::bytes()
                    } else if r#fn == "buffer.fromDyn" {
                        args.len() == 2
                            && args[0].ty() == Type::Dyn
                            && args[1].ty() == Type::String
                            && *r#type == Type::bytes()
                    } else if r#fn == "buffer.fromStr" {
                        args.len() == 2
                            && args.iter().all(|a| a.ty() == Type::String)
                            && *r#type == Type::bytes()
                    } else if r#fn == "text.decode" {
                        args.len() == 1 && args[0].ty() == Type::bytes() && *r#type == Type::String
                    } else {
                        args.len() == 2
                            && args[0].ty() == Type::bytes()
                            && args[1].ty() == Type::Bool
                            && *r#type == Type::String
                    };
                    return if valid {
                        Ok(())
                    } else {
                        Err("invalid native text codec operation".into())
                    };
                }
                if r#fn == "buffer.byteLenStr" {
                    for arg in args {
                        expr(arg, locals, initialized, functions, module)?;
                    }
                    return if args.len() == 2
                        && args.iter().all(|arg| arg.ty() == Type::String)
                        && *r#type == Type::F64
                    {
                        Ok(())
                    } else {
                        Err("invalid native Buffer byte length".into())
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
                if matches!(
                    r#fn.as_str(),
                    "dyn.keySet"
                        | "dyn.keySetComputed"
                        | "dyn.keySetSloppy"
                        | "dyn.keySetComputedSloppy"
                ) {
                    for arg in args {
                        expr(arg, locals, initialized, functions, module)?;
                    }
                    if args.len() != 3
                        || args[0].ty() != Type::Dyn
                        || args[1].ty()
                            != if matches!(r#fn.as_str(), "dyn.keySet" | "dyn.keySetSloppy") {
                                Type::String
                            } else {
                                Type::Dyn
                            }
                        || args[2].ty() != Type::Dyn
                        || *r#type != Type::Void
                    {
                        return Err("invalid native dynamic property write".into());
                    }
                    return Ok(());
                }
                if matches!(
                    r#fn.as_str(),
                    "process.onUnhandledRejection" | "process.onUncaughtException"
                ) {
                    for arg in args {
                        expr(arg, locals, initialized, functions, module)?;
                    }
                    let unary_listener = matches!(args.first(), Some(Expr::DynFrom { value, .. })
                        if matches!(value.ty(), Type::Func { params, ret, rest: false } if params == vec![Type::Dyn] && *ret == Type::Void));
                    if args.len() != 2
                        || !unary_listener
                        || !matches!(&args[1], Expr::BoolLit { value: false, .. })
                        || *r#type != Type::Void
                        || !module.classes.iter().any(|class| class.name == "%Error")
                    {
                        return Err("invalid native process exception listener".into());
                    }
                    return Ok(());
                }
                if matches!(
                    r#fn.as_str(),
                    "process.onExit"
                        | "process.offExit"
                        | "process.onUncaughtMonitor"
                        | "process.offUncaughtMonitor"
                ) {
                    for arg in args {
                        expr(arg, locals, initialized, functions, module)?;
                    }
                    if args.len() != 1 || args[0].ty() != Type::Dyn || *r#type != Type::Void {
                        return Err("invalid native process lifecycle listener".into());
                    }
                    return Ok(());
                }
                if matches!(
                    r#fn.as_str(),
                    "process.onSignal"
                        | "process.offSignal"
                        | "process.onNamedSignal"
                        | "process.offNamedSignal"
                ) {
                    for arg in args {
                        expr(arg, locals, initialized, functions, module)?;
                    }
                    let callback = matches!(args.get(1).map(Expr::ty), Some(Type::Func { rest: false, params, ret }) if params.is_empty() && *ret == Type::Void);
                    let named = matches!(
                        r#fn.as_str(),
                        "process.onNamedSignal" | "process.offNamedSignal"
                    );
                    let registering =
                        matches!(r#fn.as_str(), "process.onSignal" | "process.onNamedSignal");
                    let valid = args.first().is_some_and(|arg| {
                        arg.ty() == if named { Type::String } else { Type::F64 }
                    }) && callback
                        && *r#type == Type::Void
                        && if registering {
                            args.len() == 3 && args[2].ty() == Type::Bool
                        } else {
                            args.len() == 2
                        };
                    if !valid {
                        return Err("invalid native process signal listener".into());
                    }
                    return Ok(());
                }
                if r#fn == "process.envSet" {
                    for arg in args {
                        expr(arg, locals, initialized, functions, module)?;
                    }
                    if args.len() != 2
                        || args.iter().any(|arg| arg.ty() != Type::String)
                        || *r#type != Type::Void
                    {
                        return Err("invalid native environment write".into());
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
                if r#fn == "bun.which" {
                    for arg in args {
                        expr(arg, locals, initialized, functions, module)?;
                    }
                    let valid_result = matches!(r#type, Type::Union { union_id }
                    if module.unions.get(*union_id).is_some_and(|union| {
                        union.arms.len() == 2
                            && union.arms.contains(&Type::String)
                            && union.arms.contains(&Type::Null)
                    }));
                    if args.len() != 3
                        || args[0].ty() != Type::String
                        || !matches!(args[1].ty(), Type::String | Type::Null)
                        || !matches!(args[2].ty(), Type::String | Type::Null)
                        || !valid_result
                    {
                        return Err("invalid native Bun.which call".into());
                    }
                    return Ok(());
                }
                if matches!(
                    r#fn.as_str(),
                    "timers.setTimeout"
                        | "timers.setInterval"
                        | "timers.setImmediate"
                        | "timers.clearTimeout"
                        | "timers.clearInterval"
                        | "timers.clearImmediate"
                        | "timers.setRef"
                        | "timers.hasRef"
                        | "timers.refresh"
                        | "timers.queueMicrotask"
                ) {
                    for arg in args {
                        expr(arg, locals, initialized, functions, module)?;
                    }
                    let valid =
                        if matches!(r#fn.as_str(), "timers.setTimeout" | "timers.setInterval") {
                            args.len() == 2
                                && matches!(&args[0].ty(), Type::Func { params, ret, rest: false }
                                if params.is_empty() && **ret == Type::Void)
                                && args[1].ty() == Type::F64
                                && *r#type == Type::F64
                        } else if r#fn == "timers.setImmediate" {
                            args.len() == 1
                                && matches!(&args[0].ty(), Type::Func { params, ret, rest: false }
                                if params.is_empty() && **ret == Type::Void)
                                && *r#type == Type::F64
                        } else if matches!(
                            r#fn.as_str(),
                            "timers.clearTimeout"
                                | "timers.clearInterval"
                                | "timers.clearImmediate"
                        ) {
                            args.len() == 1 && args[0].ty() == Type::F64 && *r#type == Type::Void
                        } else if r#fn == "timers.setRef" {
                            args.len() == 2
                                && args[0].ty() == Type::F64
                                && args[1].ty() == Type::Bool
                                && *r#type == Type::F64
                        } else if r#fn == "timers.hasRef" {
                            args.len() == 1 && args[0].ty() == Type::F64 && *r#type == Type::Bool
                        } else if r#fn == "timers.queueMicrotask" {
                            args.len() == 1
                                && matches!(&args[0].ty(), Type::Func { params, ret, rest: false }
                                if params.is_empty() && **ret == Type::Void)
                                && *r#type == Type::Void
                        } else {
                            args.len() == 1 && args[0].ty() == Type::F64 && *r#type == Type::F64
                        };
                    return if valid {
                        Ok(())
                    } else {
                        Err("invalid native timer call".into())
                    };
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
                if r#fn == "dns.lookupPromisified" {
                    for arg in args {
                        expr(arg, locals, initialized, functions, module)?;
                    }
                    return if args.len() == 1
                        && args[0].ty()
                            == (Type::Array {
                                elem: Box::new(Type::Dyn),
                            })
                        && *r#type
                            == (Type::Promise {
                                inner: Box::new(Type::Dyn),
                            })
                    {
                        Ok(())
                    } else {
                        Err("invalid native DNS lookup signature".into())
                    };
                }
                if let Some(valid) = filesystem_values::signature(
                    r#fn,
                    &args.iter().map(Expr::ty).collect::<Vec<_>>(),
                    r#type,
                ) {
                    for arg in args {
                        expr(arg, locals, initialized, functions, module)?;
                    }
                    return if valid {
                        Ok(())
                    } else {
                        Err("invalid native filesystem namespace signature".into())
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
                let builtin = crate::builtins::by_ir(r#fn)
                    .ok_or_else(|| format!("unknown native library call: {}", r#fn))?;
                if *r#type != builtin.result || args.len() != builtin.args.len() {
                    return Err("invalid native library signature".into());
                }
                for (index, (arg, expected)) in args.iter().zip(&builtin.args).enumerate() {
                    expr(arg, locals, initialized, functions, module)?;
                    if arg.ty() != *expected {
                        return Err(format!(
                            "invalid native library argument: call={} index={index} expected={expected:?} actual={:?} at {}:{}..{}",
                            r#fn,
                            arg.ty(),
                            loc.file,
                            loc.start,
                            loc.end
                        ));
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
            Expr::UnitLit { unit, r#type, .. }
                if matches!(
                    (*unit, r#type),
                    ("void", Type::Void) | ("undefined", Type::Undefined) | ("null", Type::Null)
                ) =>
            {
                Ok(())
            }
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
                    "+" | "-" | "*" | "/" | "%" | "**" | "&" | "|" | "^" | "<<" | ">>" | ">>>" => {
                        Type::F64
                    }
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
                                | Type::Classval { .. }
                                | Type::Bytes { .. }
                                | Type::Promise { .. }
                                | Type::CryptoSign
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
                if (matches!(op.as_str(), "-" | "~")
                    && operand.ty() == Type::F64
                    && *r#type == Type::F64)
                    || (op == "!" && operand.ty() == Type::Bool && *r#type == Type::Bool)
                {
                    Ok(())
                } else {
                    Err("invalid unary types".into())
                }
            }
            Expr::Intrinsic {
                name, args, r#type, ..
            } if name == "promise.block" => {
                for arg in args {
                    expr(arg, locals, initialized, functions, module)?;
                }
                if matches!(args.as_slice(), [value] if matches!(value.ty(), Type::Promise { inner } if *inner == *r#type && *r#type != Type::Void))
                {
                    Ok(())
                } else {
                    Err("invalid native blocking await".into())
                }
            }
            Expr::Intrinsic { name, args, .. } if name == "global.intlSegmenterUnavailable" => {
                if args.is_empty() {
                    Ok(())
                } else {
                    Err("invalid unavailable Intl.Segmenter intrinsic".into())
                }
            }
            Expr::Intrinsic {
                name,
                args,
                r#type: Type::Dyn,
                ..
            } if name == "arrayBuffer.new" => {
                for arg in args {
                    expr(arg, locals, initialized, functions, module)?;
                }
                if matches!(args.as_slice(), [length] if length.ty() == Type::F64) {
                    Ok(())
                } else {
                    Err("invalid native ArrayBuffer constructor".into())
                }
            }
            Expr::Intrinsic {
                name,
                args,
                r#type: Type::Dyn,
                ..
            } if matches!(
                name.as_str(),
                "object.nullConstructor"
                    | "object.createNull"
                    | "global.object"
                    | "global.navigator"
                    | "global.process"
                    | "global.fetch"
                    | "global.abortSignal"
                    | "global.readableStreamConstructor"
                    | "global.blobConstructor"
                    | "global.urlSearchParamsConstructor"
                    | "global.fileConstructor"
                    | "global.urlConstructor"
                    | "global.messagePortConstructor"
                    | "global.responseConstructor"
                    | "global.headersConstructor"
                    | "global.formDataConstructor"
                    | "global.intl"
                    | "inspector.session.new"
                    | "function.call.value"
                    | "function.hasInstance.value"
            ) =>
            {
                if args.is_empty() {
                    Ok(())
                } else {
                    Err("invalid null-object intrinsic".into())
                }
            }
            Expr::Intrinsic {
                name,
                args,
                r#type: Type::Dyn,
                ..
            } if name == "blob.new" => {
                for arg in args {
                    expr(arg, locals, initialized, functions, module)?;
                }
                if args.len() == 2 && args.iter().all(|arg| arg.ty() == Type::Dyn) {
                    Ok(())
                } else {
                    Err("invalid native Blob constructor".into())
                }
            }
            Expr::Intrinsic {
                name,
                args,
                r#type: Type::Dyn,
                ..
            } if name == "file.new" => {
                for arg in args {
                    expr(arg, locals, initialized, functions, module)?;
                }
                if args.len() == 3 && args.iter().all(|arg| arg.ty() == Type::Dyn) {
                    Ok(())
                } else {
                    Err("invalid native File constructor".into())
                }
            }
            Expr::Intrinsic {
                name,
                args,
                r#type: Type::Dyn,
                ..
            } if name == "web.writableStreamNew" => {
                for arg in args {
                    expr(arg, locals, initialized, functions, module)?;
                }
                if matches!(args.as_slice(), [source] if source.ty() == Type::Dyn) {
                    Ok(())
                } else {
                    Err("invalid native WritableStream constructor".into())
                }
            }
            Expr::Intrinsic {
                name,
                args,
                r#type: Type::Dyn,
                ..
            } if name == "object.constructNull" => {
                if matches!(args.as_slice(), [arg] if arg.ty() == Type::Dyn) {
                    expr(&args[0], locals, initialized, functions, module)
                } else {
                    Err("invalid null-object construction".into())
                }
            }
            Expr::Intrinsic {
                name,
                args,
                r#type: Type::Dyn,
                ..
            } if name == "object.setPrototypeNull" => {
                if matches!(args.as_slice(), [arg] if arg.ty() == Type::Dyn) {
                    expr(&args[0], locals, initialized, functions, module)
                } else {
                    Err("invalid null-prototype mutation".into())
                }
            }
            Expr::Intrinsic {
                name,
                args,
                r#type: Type::Dyn,
                ..
            } if name == "object.setPrototype" => {
                if matches!(args.as_slice(), [target, prototype] if target.ty() == Type::Dyn && prototype.ty() == Type::Dyn)
                {
                    expr(&args[0], locals, initialized, functions, module)?;
                    expr(&args[1], locals, initialized, functions, module)
                } else {
                    Err("invalid prototype mutation".into())
                }
            }
            Expr::Intrinsic {
                name,
                args,
                r#type: Type::Dyn,
                ..
            } if matches!(name.as_str(), "weakRef.new" | "finalizationRegistry.new") => {
                if matches!(args.as_slice(), [arg] if arg.ty() == Type::Dyn) {
                    expr(&args[0], locals, initialized, functions, module)
                } else {
                    Err("invalid weak-reference construction".into())
                }
            }
            Expr::Intrinsic {
                name,
                args,
                r#type: Type::Dyn,
                ..
            } if name == "global.unbound" => {
                if matches!(args.as_slice(), [arg] if arg.ty() == Type::String) {
                    expr(&args[0], locals, initialized, functions, module)
                } else {
                    Err("invalid unbound-global intrinsic".into())
                }
            }
            Expr::Intrinsic {
                name,
                args,
                r#type: Type::Dyn,
                ..
            } if name == "module.require.missing" => {
                if matches!(args.as_slice(), [arg] if arg.ty() == Type::String) {
                    expr(&args[0], locals, initialized, functions, module)
                } else {
                    Err("invalid missing CommonJS module intrinsic".into())
                }
            }
            Expr::Intrinsic {
                name,
                args,
                r#type: Type::Void,
                ..
            } if matches!(
                name.as_str(),
                "inspector.session.connect" | "inspector.session.disconnect"
            ) =>
            {
                for arg in args {
                    expr(arg, locals, initialized, functions, module)?;
                }
                if matches!(args.as_slice(), [receiver] if receiver.ty() == Type::Dyn) {
                    Ok(())
                } else {
                    Err("invalid inspector session lifecycle intrinsic".into())
                }
            }
            Expr::Intrinsic {
                name,
                args,
                r#type: Type::Void,
                ..
            } if name == "inspector.session.post" => {
                for arg in args {
                    expr(arg, locals, initialized, functions, module)?;
                }
                if matches!(args.as_slice(), [receiver, method, params, callback]
                    if receiver.ty() == Type::Dyn && method.ty() == Type::String
                        && params.ty() == Type::Dyn && callback.ty() == Type::Dyn)
                {
                    Ok(())
                } else {
                    Err("invalid inspector session post intrinsic".into())
                }
            }
            Expr::Intrinsic {
                name,
                args,
                r#type: Type::Promise { inner },
                ..
            } if name == "promise.resolve" || name == "module.import.inert" => {
                for arg in args {
                    expr(arg, locals, initialized, functions, module)?;
                }
                if (name == "promise.resolve" && args.is_empty() && **inner == Type::Void)
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
                r#type: Type::Promise { .. },
                ..
            } if name == "promise.reject" => {
                for arg in args.iter() {
                    expr(arg, locals, initialized, functions, module)?;
                }
                if args.len() == 1 && args[0].ty() == Type::Dyn {
                    Ok(())
                } else {
                    Err("invalid native Promise.reject".into())
                }
            }
            Expr::Intrinsic {
                name,
                args,
                r#type: Type::Promise { .. },
                ..
            } if name == "module.import.missing" => {
                for arg in args.iter() {
                    expr(arg, locals, initialized, functions, module)?;
                }
                if matches!(args.as_slice(), [specifier] if specifier.ty() == Type::String) {
                    Ok(())
                } else {
                    Err("invalid missing dynamic module import".into())
                }
            }
            Expr::Intrinsic {
                name,
                args,
                r#type: Type::Promise { inner },
                ..
            } if name == "module.import.lazy" => {
                for arg in args {
                    expr(arg, locals, initialized, functions, module)?;
                }
                let valid = matches!(args.as_slice(), [namespace, Expr::Closure { fn_name, captures, r#type: Type::Func { rest: false, params, ret }, .. }]
                    if fn_name.starts_with("%lazy_module_") && namespace.ty() == **inner && captures.is_empty() && params.is_empty() && **ret == Type::Void);
                if valid {
                    Ok(())
                } else {
                    Err("invalid lazy native module import".into())
                }
            }
            Expr::Intrinsic {
                name,
                args,
                r#type: Type::Promise { inner },
                ..
            } if name == "module.import.cjs" => {
                for arg in args {
                    expr(arg, locals, initialized, functions, module)?;
                }
                let valid = matches!(args.as_slice(), [namespace, Expr::Closure { fn_name, captures, r#type: Type::Func { rest: false, params, ret }, .. }]
                    if fn_name.starts_with("cjs") && namespace.ty() == **inner && captures.is_empty() && params.is_empty() && **ret == Type::Dyn);
                if valid {
                    Ok(())
                } else {
                    Err("invalid dynamic CommonJS module import".into())
                }
            }
            Expr::Intrinsic {
                name,
                args,
                r#type: Type::Promise { inner },
                ..
            } if name == "promise.valueView" => {
                for arg in args {
                    expr(arg, locals, initialized, functions, module)?;
                }
                if **inner == Type::Dyn
                    && matches!(args.as_slice(), [source] if matches!(source.ty(), Type::Promise { inner } if *inner != Type::Dyn))
                {
                    Ok(())
                } else {
                    Err("invalid Promise value view".into())
                }
            }
            Expr::Intrinsic {
                name,
                args,
                r#type: Type::Promise { inner },
                ..
            } if name == "promise.allInput" => {
                for arg in args {
                    expr(arg, locals, initialized, functions, module)?;
                }
                let Type::Array { elem: result_elem } = inner.as_ref() else {
                    return Err("Promise.all dynamic result is not an array".into());
                };
                let [input] = args.as_slice() else {
                    return Err("Promise.all dynamic input arity is invalid".into());
                };
                let Type::Array { elem } = input.ty() else {
                    return Err("Promise.all dynamic input is not an array".into());
                };
                let Type::Promise { inner: source_elem } = elem.as_ref() else {
                    return Err("Promise.all dynamic input elements are not promises".into());
                };
                if source_elem.as_ref() == result_elem.as_ref()
                    || result_elem.as_ref() == &Type::Dyn
                    || matches!(
                        (source_elem.as_ref(), result_elem.as_ref()),
                        (Type::Void, Type::Undefined) | (Type::Undefined, Type::Void)
                    )
                {
                    Ok(())
                } else {
                    Err("Promise.all dynamic input/result element layouts differ".into())
                }
            }
            Expr::Intrinsic {
                name,
                args,
                r#type: Type::Promise { inner },
                ..
            } if name == "promise.allValuesInput" => {
                for arg in args {
                    expr(arg, locals, initialized, functions, module)?;
                }
                let Type::Array { .. } = inner.as_ref() else {
                    return Err("Promise.all value result is not an array".into());
                };
                if matches!(args.as_slice(), [input] if matches!(input.ty(), Type::Array { .. })) {
                    Ok(())
                } else {
                    Err("Promise.all value input is not an array".into())
                }
            }
            Expr::Intrinsic {
                name,
                args,
                r#type: Type::Promise { inner },
                ..
            } if name == "promise.allDiscard" => {
                for arg in args {
                    expr(arg, locals, initialized, functions, module)?;
                }
                if **inner == Type::Dyn
                    && args
                        .iter()
                        .all(|arg| matches!(arg.ty(), Type::Promise { .. }))
                {
                    Ok(())
                } else {
                    Err("invalid discarded Promise.all".into())
                }
            }
            Expr::Intrinsic {
                name,
                args,
                r#type: Type::Promise { .. },
                ..
            } if name == "promise.raceArray" => {
                for arg in args {
                    expr(arg, locals, initialized, functions, module)?;
                }
                if !args.is_empty()
                    && args
                        .iter()
                        .all(|arg| matches!(arg.ty(), Type::Promise { .. }))
                {
                    Ok(())
                } else {
                    Err("invalid native Promise.race array".into())
                }
            }
            Expr::Intrinsic {
                name,
                args,
                r#type: Type::Promise { inner },
                ..
            } if name == "promise.allArray" => {
                for arg in args {
                    expr(arg, locals, initialized, functions, module)?;
                }
                let Type::Array { elem } = inner.as_ref() else {
                    return Err("Promise.all array result is not an array".into());
                };
                if args
                    .iter()
                    .all(|arg| matches!(arg.ty(), Type::Promise { inner } if *inner == **elem))
                {
                    Ok(())
                } else {
                    Err("invalid homogeneous Promise.all array".into())
                }
            }
            Expr::Intrinsic {
                name,
                args,
                r#type: Type::Promise { inner },
                ..
            } if name == "promise.allTuple" => {
                for arg in args {
                    expr(arg, locals, initialized, functions, module)?;
                }
                let Type::Record { shape_id } = inner.as_ref() else {
                    return Err("Promise.all tuple result is not a record".into());
                };
                let Some(tuple) = module.records.get(*shape_id) else {
                    return Err("Promise.all tuple result shape is missing".into());
                };
                let valid = tuple.tuple
                    && tuple.declared_order.len() == args.len()
                    && tuple.declared_order.iter().zip(args).all(|(name, arg)| {
                        let Some(field) = tuple.fields.iter().find(|field| &field.name == name)
                        else {
                            return false;
                        };
                        matches!(arg.ty(), Type::Promise { inner } if *inner == field.r#type)
                    });
                if valid {
                    Ok(())
                } else {
                    Err("invalid heterogeneous Promise.all tuple".into())
                }
            }
            Expr::Intrinsic {
                name,
                args,
                r#type: Type::String,
                ..
            } if name == "caught.toString" => {
                for arg in args {
                    expr(arg, locals, initialized, functions, module)?;
                }
                if args.len() == 1 && args[0].ty() == Type::Caught {
                    Ok(())
                } else {
                    Err("invalid caught string conversion".into())
                }
            }
            Expr::Intrinsic {
                name,
                args,
                r#type: Type::Void,
                ..
            } if matches!(name.as_str(), "console.log.spread" | "console.error.spread") => {
                for arg in args {
                    expr(arg, locals, initialized, functions, module)?;
                }
                if matches!(args.as_slice(), [arg] if matches!(arg.ty(), Type::Array { elem } if *elem == Type::Dyn))
                {
                    Ok(())
                } else {
                    Err("invalid native console spread".into())
                }
            }
            Expr::Intrinsic {
                name,
                args,
                r#type: Type::Void,
                ..
            } if matches!(
                name.as_str(),
                "console.log" | "console.error" | "console.log.format" | "console.error.format"
            ) =>
            {
                for arg in args {
                    expr(arg, locals, initialized, functions, module)?;
                    if !matches!(arg.ty(), Type::F64 | Type::String | Type::Bool | Type::Dyn) {
                        return Err("non-primitive console argument".into());
                    }
                }
                Ok(())
            }
            Expr::Intrinsic {
                name,
                args,
                r#type: Type::Void,
                ..
            } if name == "console.dir" => {
                for arg in args {
                    expr(arg, locals, initialized, functions, module)?;
                }
                if args.len() == 1 && args[0].ty() == Type::Dyn {
                    Ok(())
                } else {
                    Err("invalid native console.dir".into())
                }
            }
            Expr::Call {
                callee,
                args,
                r#type,
                loc,
            } => {
                let target = functions.get(callee.as_str()).ok_or("unknown callee")?;
                if target.captures.is_some() {
                    return Err(format!(
                        "invalid call signature for {callee} at {}:{}..{}: direct call targets a capturing function",
                        loc.file, loc.start, loc.end
                    ));
                }
                if args.len() != target.params.len() {
                    return Err(format!(
                        "invalid call signature for {callee} at {}:{}..{}: expected {} arguments, got {}",
                        loc.file,
                        loc.start,
                        loc.end,
                        target.params.len(),
                        args.len()
                    ));
                }
                let call_result = target.call_result();
                if *r#type != call_result {
                    return Err(format!(
                        "invalid call signature for {callee} at {}:{}..{}: expected result {call_result:?}, got {:?}",
                        loc.file, loc.start, loc.end, r#type
                    ));
                }
                for (index, (arg, param)) in args.iter().zip(&target.params).enumerate() {
                    expr(arg, locals, initialized, functions, module)?;
                    if arg.ty() != param.r#type {
                        return Err(format!(
                            "invalid call argument {index} for {callee} at {}:{}..{}: expected {:?}, got {:?}",
                            loc.file,
                            loc.start,
                            loc.end,
                            param.r#type,
                            arg.ty()
                        ));
                    }
                }
                Ok(())
            }
            _ => Err(format!("invalid native expression: {e:?}")),
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
                Stmt::BytesSet {
                    arr, index, value, ..
                } => {
                    expr(arr, locals, initialized, functions, module)?;
                    expr(index, locals, initialized, functions, module)?;
                    expr(value, locals, initialized, functions, module)?;
                    if !matches!(arr.ty(), Type::Bytes { .. })
                        || index.ty() != Type::F64
                        || value.ty() != Type::F64
                    {
                        return Err("invalid native bytes write".into());
                    }
                }
                Stmt::ArraySet {
                    arr, index, value, ..
                } => {
                    expr(arr, locals, initialized, functions, module)?;
                    expr(index, locals, initialized, functions, module)?;
                    expr(value, locals, initialized, functions, module)?;
                    if !matches!(arr.ty(), Type::Array { elem } if *elem == value.ty())
                        || index.ty() != Type::F64
                    {
                        return Err("invalid native array element write".into());
                    }
                }
                Stmt::ArraySetLength { arr, length, .. } => {
                    expr(arr, locals, initialized, functions, module)?;
                    expr(length, locals, initialized, functions, module)?;
                    if !matches!(arr.ty(), Type::Array { .. }) || length.ty() != Type::F64 {
                        return Err("invalid array length write".into());
                    }
                }
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
                    if let Expr::LibCall {
                        r#fn, args, r#type, ..
                    } = init
                        && r#fn == "lexical.empty"
                    {
                        if !args.is_empty()
                            || *r#type != Type::Dyn
                            || !locals
                                .get(local_id.as_str())
                                .is_some_and(|local| local.boxed && local.r#type == Type::Dyn)
                        {
                            return Err("invalid native lexical cell declaration".into());
                        }
                    } else {
                        expr(init, locals, initialized, functions, module)?;
                    }
                    if initialized.contains(local_id) {
                        return Err(format!("duplicate local initialization: {local_id}"));
                    }
                    let expected = locals.get(local_id.as_str()).map(|local| &local.r#type);
                    if expected != Some(&init.ty()) {
                        return Err(format!(
                            "invalid local initialization: id={local_id} expected={expected:?} actual={:?}",
                            init.ty()
                        ));
                    }
                    initialized.insert(local_id.clone());
                }
                Stmt::Assign {
                    local_id,
                    value,
                    initializes_global,
                    ..
                } => {
                    if let Expr::LibCall {
                        r#fn, args, r#type, ..
                    } = value
                        && r#fn == "lexical.initialize"
                    {
                        if args.len() != 1
                            || *r#type != Type::Dyn
                            || args[0].ty() != Type::Dyn
                            || !locals
                                .get(local_id.as_str())
                                .is_some_and(|local| local.boxed && local.r#type == Type::Dyn)
                        {
                            return Err("invalid native lexical cell initialization".into());
                        }
                        expr(&args[0], locals, initialized, functions, module)?;
                    } else {
                        expr(value, locals, initialized, functions, module)?;
                    }
                    if let Some(global) = module.global(local_id) {
                        if global.r#type != value.ty()
                            || (*initializes_global
                                && !function.is_some_and(|f| module.initializes(stmt, f, local_id)))
                            || (!global.mutable
                                && !function.is_some_and(|f| module.initializes(stmt, f, local_id)))
                        {
                            return Err(format!(
                                "invalid global assignment: id={local_id} name={} mutable={} initializes={} first_initializer={} expected={:?} actual={:?}",
                                global.name,
                                global.mutable,
                                initializes_global,
                                function.is_some_and(|f| module.initializes(stmt, f, local_id)),
                                global.r#type,
                                value.ty()
                            ));
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
                Stmt::Switch { disc, cases, .. } => {
                    expr(disc, locals, initialized, functions, module)?;
                    if !matches!(disc.ty(), Type::F64 | Type::String | Type::Bool)
                        || cases.iter().filter(|case| case.test.is_none()).count() > 1
                    {
                        return Err("invalid native switch discriminant/default".into());
                    }
                    for case in cases {
                        if case
                            .body
                            .iter()
                            .any(|statement| matches!(statement, Stmt::VarDecl { .. }))
                        {
                            return Err("native switch shared case locals require declaration instantiation".into());
                        }
                        if let Some(test) = &case.test {
                            expr(test, locals, initialized, functions, module)?;
                            if test.ty() != disc.ty() {
                                return Err("native switch case type mismatch".into());
                            }
                        }
                        body(
                            &case.body,
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
                Stmt::GeneratorForOf {
                    generator,
                    local_id,
                    body: stmts,
                    ..
                } => {
                    expr(generator, locals, initialized, functions, module)?;
                    let Type::Generator {
                        r#async: false,
                        yield_type,
                        next_type,
                        ..
                    } = generator.ty()
                    else {
                        return Err(
                            "native generator for-of requires a synchronous generator".into()
                        );
                    };
                    if !matches!(*next_type, Type::Void | Type::Undefined | Type::Dyn)
                        || initialized.contains(local_id)
                        || !locals
                            .get(local_id.as_str())
                            .is_some_and(|local| local.r#type == *yield_type)
                    {
                        return Err("invalid native generator for-of channels".into());
                    }
                    let mut loop_initialized = initialized.clone();
                    loop_initialized.insert(local_id.clone());
                    body(
                        stmts,
                        locals,
                        &mut loop_initialized,
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

/// Whether execution can reach the next statement in the current block.
/// A loop-local jump stops this block without exiting its function.
pub fn falls_through(stmts: &[Stmt]) -> bool {
    control_flow::falls_through(stmts)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn await_uses_shared_wire_contract_and_supports_conditional_continuations() {
        let mut module = callable_module();
        let loc = module.functions[0].loc.clone();
        let promise = Type::Promise {
            inner: Box::new(Type::F64),
        };
        module.functions[1].is_async = true;
        if let Stmt::Expression {
            expr: Expr::Call { r#type, .. },
            ..
        } = &mut module.functions[0].body[0]
        {
            *r#type = promise.clone();
        } else {
            unreachable!()
        }
        module.functions[1].body = vec![Stmt::Return {
            value: Some(Expr::Await {
                value: Box::new(Expr::Intrinsic {
                    name: "promise.resolve".into(),
                    args: vec![Expr::NumLit {
                        value: 1.0,
                        spelling: None,
                        r#type: Type::F64,
                        loc: loc.clone(),
                    }],
                    r#type: promise,
                    loc: loc.clone(),
                }),
                r#type: Type::F64,
                loc: loc.clone(),
            }),
            loc: loc.clone(),
        }];
        validate(&module).unwrap();
        let json = serde_json::to_value(&module).unwrap();
        assert_eq!(
            json["functions"][1]["body"][0]["value"]["kind"],
            "awaitExpr"
        );
        let mut visited = 0;
        module.visit_expressions(&mut |expr| {
            if matches!(expr, Expr::Intrinsic { .. }) {
                visited += 1;
            }
        });
        assert_eq!(visited, 1);
        let rust = crate::emit::rust(&module).unwrap();
        assert!(rust.contains("runtime::promise_then(&source"));
        module.functions[1].body.insert(
            0,
            Stmt::If {
                cond: Expr::BoolLit {
                    value: true,
                    r#type: Type::Bool,
                    loc: loc.clone(),
                },
                then: vec![],
                else_: None,
                loc: loc.clone(),
            },
        );
        assert!(
            crate::emit::rust(&module)
                .unwrap()
                .contains("runtime::promise_then(&source")
        );
        if let Stmt::If { then, .. } = &mut module.functions[1].body[0] {
            then.push(Stmt::Return {
                value: Some(Expr::NumLit {
                    value: 2.0,
                    spelling: None,
                    r#type: Type::F64,
                    loc: loc.clone(),
                }),
                loc: loc.clone(),
            });
        }
        let rust = crate::emit::rust(&module).unwrap();
        assert!(rust.contains("runtime::promise_then(&source"));
        assert!(rust.contains("runtime::promise_fulfill(&target"));
        module.functions[1].body.remove(0);
        if let Stmt::Return {
            value: Some(Expr::Await { r#type, .. }),
            ..
        } = &mut module.functions[1].body[0]
        {
            *r#type = Type::String;
        } else {
            unreachable!()
        }
        assert_eq!(
            validate(&module).unwrap_err(),
            "await requires a Promise with the same result type"
        );
        module.functions[1].is_async = false;
        if let Stmt::Expression {
            expr: Expr::Call { r#type, .. },
            ..
        } = &mut module.functions[0].body[0]
        {
            *r#type = Type::F64;
        }
        assert_eq!(
            validate(&module).unwrap_err(),
            "await outside an async function"
        );
    }

    #[test]
    fn callable_views_only_change_dynamic_slots_and_preserve_arity() {
        let signature = |param, ret, rest| Type::Func {
            params: vec![param],
            ret: Box::new(ret),
            rest,
        };
        let typed = signature(Type::String, Type::String, false);
        let erased_input = signature(Type::Dyn, Type::String, false);
        let erased = signature(Type::Dyn, Type::Dyn, false);
        assert!(callable_view_compatible(&typed, &erased_input));
        assert!(callable_view_compatible(&erased, &typed));
        assert!(!callable_view_compatible(
            &typed,
            &signature(Type::F64, Type::String, false)
        ));
        assert!(!callable_view_compatible(
            &typed,
            &signature(Type::Dyn, Type::Void, false)
        ));
        assert!(!callable_view_compatible(
            &typed,
            &signature(Type::Dyn, Type::String, true)
        ));
        let promise = |inner| Type::Promise {
            inner: Box::new(inner),
        };
        let broad = signature(Type::Dyn, promise(Type::Dyn), false);
        let narrow = signature(Type::String, promise(Type::Record { shape_id: 0 }), false);
        assert!(callable_view_compatible(&broad, &narrow));
        assert!(callable_view_compatible(&narrow, &broad));
        assert!(!callable_view_compatible(
            &broad,
            &signature(Type::String, promise(Type::Void), false)
        ));
        assert!(!callable_view_compatible(
            &narrow,
            &signature(Type::String, promise(Type::F64), false)
        ));
    }

    #[test]
    fn nullable_stats_preserve_nominal_container_boundaries() {
        let mut module = callable_module();
        module.unions.push(Union {
            id: 0,
            arms: vec![Type::Stats, Type::Null, Type::Undefined],
        });
        let optional = Type::Union { union_id: 0 };
        assert!(module.valid_type(optional.clone(), &mut vec![]));
        assert!(!module.valid_type(
            Type::Array {
                elem: Box::new(optional.clone())
            },
            &mut vec![]
        ));
        assert!(!module.valid_type(
            Type::Map {
                key: Box::new(Type::String),
                value: Box::new(optional)
            },
            &mut vec![]
        ));
        module.unions.push(Union {
            id: 1,
            arms: vec![Type::Stats, Type::String],
        });
        assert!(!module.valid_type(Type::Union { union_id: 1 }, &mut vec![]));
    }

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
        let erased = Expr::DynFrom {
            value: Box::new(stat),
            r#type: Type::Dyn,
            loc: loc.clone(),
        };
        module.functions[0].body = vec![Stmt::Expression {
            expr: Expr::DynCheck {
                value: Box::new(erased),
                r#type: Type::Stats,
                loc: loc.clone(),
            },
            loc: loc.clone(),
        }];
        assert!(validate(&module).is_ok());
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
    fn template_object_requires_paired_nonempty_dynamic_literals() {
        let mut module = callable_module();
        let loc = module.functions[0].loc.clone();
        let array_type = Type::Array {
            elem: Box::new(Type::Dyn),
        };
        let text = |value: &str| Expr::StrLit {
            value: value.into(),
            r#type: Type::String,
            loc: loc.clone(),
        };
        let entry = || Expr::DynFrom {
            value: Box::new(text("segment")),
            r#type: Type::Dyn,
            loc: loc.clone(),
        };
        let undefined = || Expr::DynFrom {
            value: Box::new(Expr::UnitLit {
                unit: "undefined",
                r#type: Type::Undefined,
                loc: loc.clone(),
            }),
            r#type: Type::Dyn,
            loc: loc.clone(),
        };
        let array = |elems| Expr::ArrayLit {
            elems,
            r#type: array_type.clone(),
            loc: loc.clone(),
        };
        let cases = [
            (
                vec![text("site"), array(vec![entry()]), array(vec![entry()])],
                array_type.clone(),
                true,
            ),
            (
                vec![text("site"), array(vec![undefined()]), array(vec![entry()])],
                array_type.clone(),
                true,
            ),
            (
                vec![text("site"), array(vec![entry()]), array(vec![undefined()])],
                array_type.clone(),
                false,
            ),
            (
                vec![text(""), array(vec![entry()]), array(vec![entry()])],
                array_type.clone(),
                false,
            ),
            (
                vec![text("site"), array(vec![]), array(vec![])],
                array_type.clone(),
                false,
            ),
            (
                vec![text("site"), array(vec![entry()]), array(vec![])],
                array_type.clone(),
                false,
            ),
            (
                vec![text("site"), array(vec![entry()])],
                array_type.clone(),
                false,
            ),
            (
                vec![text("site"), array(vec![entry()]), array(vec![entry()])],
                Type::Dyn,
                false,
            ),
            (
                vec![entry(), array(vec![entry()]), array(vec![entry()])],
                array_type,
                false,
            ),
        ];
        for (args, result, valid) in cases {
            module.functions[0].body = vec![Stmt::Expression {
                expr: Expr::LibCall {
                    r#fn: "template.object".into(),
                    args,
                    r#type: result,
                    loc: loc.clone(),
                },
                loc: loc.clone(),
            }];
            assert_eq!(validate(&module).is_ok(), valid);
            if valid {
                let rust = crate::emit::rust(&module).unwrap();
                assert!(rust.contains("runtime::template_object_storage(\"site\""));
                assert!(rust.contains("runtime::array_values(&cooked)"));
            }
        }
    }

    #[test]
    fn string_construction_requires_numeric_arrays_and_string_results() {
        let mut module = callable_module();
        let loc = module.functions[0].loc.clone();
        let number = Expr::NumLit {
            value: 65.0,
            spelling: None,
            r#type: Type::F64,
            loc: loc.clone(),
        };
        let text = Expr::StrLit {
            value: "65".into(),
            r#type: Type::String,
            loc: loc.clone(),
        };
        let array = Expr::ArrayLit {
            elems: vec![number.clone()],
            r#type: Type::Array {
                elem: Box::new(Type::F64),
            },
            loc: loc.clone(),
        };
        let strings = Expr::ArrayLit {
            elems: vec![text],
            r#type: Type::Array {
                elem: Box::new(Type::String),
            },
            loc: loc.clone(),
        };
        for name in ["string.fromCharCode", "string.fromCodePoint"] {
            for (args, result, valid) in [
                (vec![array.clone()], Type::String, true),
                (vec![], Type::String, false),
                (vec![number.clone()], Type::String, false),
                (vec![strings.clone()], Type::String, false),
                (vec![array.clone(), array.clone()], Type::String, false),
                (vec![array.clone()], Type::F64, false),
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
                if valid {
                    let wire = serde_json::to_value(&module).unwrap();
                    assert_eq!(wire["functions"][0]["body"][0]["expr"]["fn"], name);
                    let rust = crate::emit::rust(&module).unwrap();
                    assert!(rust.contains(if name == "string.fromCharCode" {
                        "runtime::string_from_char_codes"
                    } else {
                        "runtime::string_from_code_points"
                    }));
                }
            }
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
        assert!(
            validate(&m)
                .unwrap_err()
                .starts_with("invalid call signature")
        );
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
        assert_eq!(validate(&m).unwrap_err(), "invalid closure signature");
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

    #[test]
    fn regex_match_contract_validates_operands_and_capture_layout() {
        let mut module = callable_module();
        module.unions = vec![
            Union {
                id: 0,
                arms: vec![Type::String, Type::Undefined],
            },
            Union {
                id: 1,
                arms: vec![
                    Type::Array {
                        elem: Box::new(Type::Union { union_id: 0 }),
                    },
                    Type::Null,
                ],
            },
        ];
        let loc = module.functions[0].loc.clone();
        let text = Expr::StrLit {
            value: "x".into(),
            r#type: Type::String,
            loc: loc.clone(),
        };
        let regex = Expr::RegexLit {
            pattern: "x".into(),
            flags: "".into(),
            r#type: Type::Regex,
            loc: loc.clone(),
        };
        for (receiver, args, result, valid) in [
            (
                text.clone(),
                vec![regex.clone()],
                Type::Union { union_id: 1 },
                true,
            ),
            (
                regex.clone(),
                vec![text.clone()],
                Type::Union { union_id: 1 },
                false,
            ),
            (text.clone(), vec![], Type::Union { union_id: 1 }, false),
            (text.clone(), vec![regex.clone()], Type::String, false),
        ] {
            module.functions[0].body = vec![Stmt::Expression {
                expr: Expr::RegexIntrinsic {
                    method: "match".into(),
                    receiver: Box::new(receiver),
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
    fn regex_split_contract_rejects_malformed_operands() {
        let mut module = callable_module();
        let loc = module.functions[0].loc.clone();
        let text = Expr::StrLit {
            value: "x".into(),
            r#type: Type::String,
            loc: loc.clone(),
        };
        let regex = Expr::RegexLit {
            pattern: "x".into(),
            flags: "".into(),
            r#type: Type::Regex,
            loc: loc.clone(),
        };
        let limit = Expr::NumLit {
            value: 2.0,
            spelling: None,
            r#type: Type::F64,
            loc: loc.clone(),
        };
        let result = Type::Array {
            elem: Box::new(Type::String),
        };
        for (receiver, args, ty, valid) in [
            (
                text.clone(),
                vec![regex.clone(), limit.clone()],
                result.clone(),
                true,
            ),
            (
                regex.clone(),
                vec![regex.clone(), limit.clone()],
                result.clone(),
                false,
            ),
            (
                text.clone(),
                vec![text.clone(), limit.clone()],
                result.clone(),
                false,
            ),
            (text.clone(), vec![regex.clone()], result.clone(), false),
            (
                text.clone(),
                vec![regex.clone(), limit.clone()],
                Type::String,
                false,
            ),
        ] {
            module.functions[0].body = vec![Stmt::Expression {
                expr: Expr::RegexIntrinsic {
                    method: "split".into(),
                    receiver: Box::new(receiver),
                    args,
                    r#type: ty,
                    loc: loc.clone(),
                },
                loc: loc.clone(),
            }];
            assert_eq!(validate(&module).is_ok(), valid);
        }
    }

    #[test]
    fn dom_event_operations_validate_owner_field_and_action() {
        let mut module = callable_module();
        let loc = module.functions[0].loc.clone();
        module.classes.push(Class {
            name: "native_builtin_Event".into(),
            js_name: "Event".into(),
            runtime: false,
            base: None,
            fields: vec![],
            captures: vec![],
            methods: vec![],
            symbol_methods: vec![],
            symbol_brand: None,
            method_names: vec![],
            loc: loc.clone(),
        });
        let name = |value: &str| Expr::StrLit {
            value: value.into(),
            r#type: Type::String,
            loc: loc.clone(),
        };
        let event = || Expr::LibCall {
            r#fn: "dom.eventNew".into(),
            args: vec![
                name("x"),
                Expr::DynFrom {
                    value: Box::new(Expr::UnitLit {
                        unit: "undefined",
                        r#type: Type::Undefined,
                        loc: loc.clone(),
                    }),
                    r#type: Type::Dyn,
                    loc: loc.clone(),
                },
            ],
            r#type: Type::Object {
                class_name: "native_builtin_Event".into(),
            },
            loc: loc.clone(),
        };
        for (operation, field, ty, valid) in [
            ("dom.eventGet", "type", Type::Dyn, true),
            ("dom.eventGet", "unknown", Type::Dyn, false),
            ("dom.eventGet", "type", Type::String, false),
            ("dom.eventAction", "preventDefault", Type::Void, true),
            ("dom.eventAction", "unknown", Type::Void, false),
            ("dom.eventAction", "preventDefault", Type::Dyn, false),
        ] {
            module.functions[0].body = vec![Stmt::Expression {
                expr: Expr::LibCall {
                    r#fn: operation.into(),
                    args: vec![event(), name(field)],
                    r#type: ty,
                    loc: loc.clone(),
                },
                loc: loc.clone(),
            }];
            assert_eq!(validate(&module).is_ok(), valid, "{operation} {field}");
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
            captures: vec![],
            methods: vec![],
            symbol_methods: vec![],
            symbol_brand: None,
            method_names: vec![],
            loc: loc.clone(),
        });
        m.classes.push(Class {
            name: "Detail".into(),
            js_name: "Detail".into(),
            runtime: false,
            base: Some("%Error".into()),
            fields: error_fields(),
            captures: vec![],
            methods: vec![],
            symbol_methods: vec![],
            symbol_brand: None,
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
                r#type: Type::Dyn,
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
        **key = Expr::LibCall {
            r#fn: "sym.iterator".into(),
            args: vec![],
            r#type: Type::Symbol,
            loc: loc.clone(),
        };
        assert!(validate(&m).is_ok());
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
        assert!(
            validate(&m)
                .unwrap_err()
                .starts_with("invalid native value member read:")
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
    fn bounded_iteration_validates_and_visits_its_owning_operand() {
        let mut module = error_module();
        let loc = module.functions[0].loc.clone();
        for count in [0, 3] {
            module.functions[0].body = vec![Stmt::Expression {
                expr: Expr::DynIterN {
                    value: Box::new(Expr::DynArrLit {
                        elems: vec![],
                        r#type: Type::Dyn,
                        loc: loc.clone(),
                    }),
                    count,
                    r#type: Type::Dyn,
                    loc: loc.clone(),
                },
                loc: loc.clone(),
            }];
            validate(&module).unwrap();
            let wire = serde_json::to_value(&module).unwrap();
            assert_eq!(wire["functions"][0]["body"][0]["expr"]["kind"], "dynIterN");
            assert_eq!(wire["functions"][0]["body"][0]["expr"]["count"], count);
            let mut visited = 0;
            module.functions[0].visit_expressions(&mut |_| visited += 1);
            assert_eq!(visited, 2);
        }
        let Stmt::Expression {
            expr: Expr::DynIterN { value, .. },
            ..
        } = &mut module.functions[0].body[0]
        else {
            unreachable!()
        };
        **value = Expr::BoolLit {
            value: true,
            r#type: Type::Bool,
            loc: loc.clone(),
        };
        assert_eq!(
            validate(&module).unwrap_err(),
            "invalid native bounded iteration"
        );
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
            optional: false,
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
                captures: vec![],
                methods: vec!["value".into()],
                symbol_methods: vec![],
                symbol_brand: None,
                method_names: vec!["value".into()],
                loc: loc.clone(),
            });
            m.functions.push(Function {
                is_async: false,
                generator: None,
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
            generator: None,
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
            loc: loc.clone(),
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
        let mut discarded = m.clone();
        discarded.functions[2].return_type = Type::Void;
        discarded.functions[2].body = vec![Stmt::Return {
            value: None,
            loc: loc.clone(),
        }];
        discarded.functions[4].return_type = Type::Void;
        let Stmt::Return {
            value: Some(call), ..
        } = &discarded.functions[4].body[0]
        else {
            unreachable!()
        };
        let mut call = call.clone();
        let Expr::VirtualCall { r#type, .. } = &mut call else {
            unreachable!()
        };
        *r#type = Type::Void;
        discarded.functions[4].body = vec![Stmt::Expression {
            expr: call,
            loc: loc.clone(),
        }];
        validate(&discarded).unwrap();
        let mut observed = discarded.clone();
        observed.functions[4].return_type = Type::Dyn;
        let Stmt::Expression { expr: call, .. } = &mut observed.functions[4].body[0] else {
            unreachable!()
        };
        let Expr::VirtualCall { r#type, .. } = call else {
            unreachable!()
        };
        *r#type = Type::Dyn;
        let Stmt::Expression { expr: call, .. } = observed.functions[4].body.remove(0) else {
            unreachable!()
        };
        observed.functions[4].body.push(Stmt::Return {
            value: Some(call),
            loc: loc.clone(),
        });
        validate(&observed).unwrap();
        m.functions[3].return_type = Type::String;
        assert!(
            validate(&m)
                .unwrap_err()
                .starts_with("incompatible native method override:")
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
            captures: vec![],
            methods: vec![],
            symbol_methods: vec![],
            symbol_brand: None,
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
        validate(&m).unwrap();
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
        assert!(
            validate(&m)
                .unwrap_err()
                .contains("invalid local layout in function")
        );
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
        assert!(
            validate(&m)
                .unwrap_err()
                .starts_with("invalid/recursive union layout u0:")
        );
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
            generator: None,
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
    fn switches_validate_case_types_defaults_and_jump_targets() {
        let mut m = callable_module();
        let loc = m.functions[0].loc.clone();
        let disc = Expr::BoolLit {
            value: true,
            r#type: Type::Bool,
            loc: loc.clone(),
        };
        let switch = Stmt::Switch {
            disc: disc.clone(),
            cases: vec![SwitchCase {
                test: None,
                body: vec![Stmt::Break {
                    target_depth: 0,
                    loc: loc.clone(),
                }],
            }],
            loc: loc.clone(),
        };
        m.functions[0].body = vec![switch.clone()];
        validate(&m).unwrap();
        let wire = serde_json::to_value(&switch).unwrap();
        assert_eq!(wire["kind"], "switch");
        assert!(wire["cases"][0]["test"].is_null());
        if let Stmt::Switch { cases, .. } = &mut m.functions[0].body[0] {
            cases[0].test = Some(Expr::NumLit {
                value: 1.0,
                spelling: None,
                r#type: Type::F64,
                loc: loc.clone(),
            });
        }
        assert_eq!(
            validate(&m).unwrap_err(),
            "native switch case type mismatch"
        );
        m.functions[0].body = vec![switch.clone()];
        if let Stmt::Switch { cases, .. } = &mut m.functions[0].body[0] {
            cases.push(cases[0].clone());
        }
        assert_eq!(
            validate(&m).unwrap_err(),
            "invalid native switch discriminant/default"
        );
        let mut continued = switch;
        if let Stmt::Switch { cases, .. } = &mut continued {
            cases[0].body = vec![Stmt::Continue {
                target_depth: 0,
                loc: loc.clone(),
            }];
        }
        m.functions[0].body = vec![continued.clone()];
        assert_eq!(validate(&m).unwrap_err(), "loop jump has no enclosing loop");
        m.functions[0].body = vec![Stmt::While {
            cond: disc,
            body: vec![continued],
            loc,
        }];
        validate(&m).unwrap();
    }

    #[test]
    fn array_element_writes_keep_the_portable_storage_contract() {
        let mut m = callable_module();
        let loc = m.functions[0].loc.clone();
        let number = Expr::NumLit {
            value: 1.0,
            spelling: None,
            r#type: Type::F64,
            loc: loc.clone(),
        };
        m.functions[0].body = vec![Stmt::ArraySet {
            arr: Expr::ArrayLit {
                elems: vec![number.clone()],
                r#type: Type::Array {
                    elem: Box::new(Type::F64),
                },
                loc: loc.clone(),
            },
            index: number.clone(),
            value: number,
            loc: loc.clone(),
        }];
        validate(&m).unwrap();
        assert_eq!(
            serde_json::to_value(&m.functions[0].body[0]).unwrap()["kind"],
            "arraySet"
        );
        if let Stmt::ArraySet { value, .. } = &mut m.functions[0].body[0] {
            *value = Expr::BoolLit {
                value: true,
                r#type: Type::Bool,
                loc,
            };
        }
        assert_eq!(
            validate(&m).unwrap_err(),
            "invalid native array element write"
        );
    }

    #[test]
    fn array_length_writes_validate_receiver_and_numeric_length() {
        let mut m = callable_module();
        let loc = m.functions[0].loc.clone();
        m.functions[0].body = vec![Stmt::ArraySetLength {
            arr: Expr::ArrayLit {
                elems: vec![],
                r#type: Type::Array {
                    elem: Box::new(Type::F64),
                },
                loc: loc.clone(),
            },
            length: Expr::NumLit {
                value: 3.0,
                spelling: None,
                r#type: Type::F64,
                loc: loc.clone(),
            },
            loc: loc.clone(),
        }];
        validate(&m).unwrap();
        assert_eq!(
            serde_json::to_value(&m.functions[0].body[0]).unwrap()["kind"],
            "arraySetLength"
        );
        if let Stmt::ArraySetLength { length, .. } = &mut m.functions[0].body[0] {
            *length = Expr::BoolLit {
                value: true,
                r#type: Type::Bool,
                loc: loc.clone(),
            };
        }
        assert_eq!(validate(&m).unwrap_err(), "invalid array length write");
        if let Stmt::ArraySetLength { arr, .. } = &mut m.functions[0].body[0] {
            *arr = Expr::BoolLit {
                value: true,
                r#type: Type::Bool,
                loc,
            };
        }
        assert_eq!(validate(&m).unwrap_err(), "invalid array length write");
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
    fn string_array_join_requires_one_string_separator() {
        let mut module = callable_module();
        let loc = module.functions[0].loc.clone();
        let string = Expr::StrLit {
            value: ",".into(),
            r#type: Type::String,
            loc: loc.clone(),
        };
        for (elem, args, result, valid) in [
            (Type::String, vec![string.clone()], Type::String, true),
            (Type::F64, vec![string.clone()], Type::String, false),
            (Type::String, vec![], Type::String, false),
            (Type::String, vec![string], Type::Bool, false),
        ] {
            module.functions[0].body = vec![Stmt::Expression {
                expr: Expr::ArrayIntrinsic {
                    method: "join".into(),
                    receiver: Box::new(Expr::ArrayLit {
                        elems: vec![],
                        r#type: Type::Array {
                            elem: Box::new(elem),
                        },
                        loc: loc.clone(),
                    }),
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
        assert!(
            validate(&m)
                .unwrap_err()
                .starts_with("invalid array operation:")
        );
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
        assert!(
            validate(&m)
                .unwrap_err()
                .starts_with("invalid array operation:")
        );
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
        assert!(
            validate(&m)
                .unwrap_err()
                .starts_with("invalid array operation:")
        );
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
        assert!(m.valid_type(
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
            loc: loc.clone(),
        });
        assert!(
            validate(&m)
                .unwrap_err()
                .starts_with("missing global initializer:")
        );
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
        assert!(
            validate(&m)
                .unwrap_err()
                .starts_with("invalid global assignment:")
        );
        if let Stmt::Assign {
            initializes_global, ..
        } = m.functions[0].body.last_mut().unwrap()
        {
            *initializes_global = false;
        }
        assert!(
            validate(&m)
                .unwrap_err()
                .starts_with("invalid global assignment:")
        );
        m.globals[0].mutable = true;
        validate(&m).unwrap();
        m.globals.push(m.globals[0].clone());
        assert!(
            validate(&m)
                .unwrap_err()
                .starts_with("duplicate global id:")
        );
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
    fn callable_view_requires_the_exact_callable_record_signature() {
        let mut module = callable_module();
        let loc = module.functions[0].loc.clone();
        let function_type = Type::Func {
            rest: false,
            params: vec![Type::F64],
            ret: Box::new(Type::F64),
        };
        module.records.push(Record {
            id: 0,
            fields: vec![Field {
                name: "\0scriptc.call".into(),
                r#type: function_type.clone(),
            }],
            declared_order: vec!["\0scriptc.call".into()],
            tuple: false,
            index_value: None,
        });
        module.functions[0].body = vec![Stmt::Expression {
            expr: Expr::LibCall {
                r#fn: "callable.view".into(),
                args: vec![Expr::Closure {
                    fn_name: "f0".into(),
                    captures: vec![],
                    r#type: function_type,
                    loc: loc.clone(),
                }],
                r#type: Type::Record { shape_id: 0 },
                loc: loc.clone(),
            },
            loc,
        }];
        validate(&module).unwrap();
        module.records[0].fields[0].r#type = Type::String;
        assert_eq!(
            validate(&module).unwrap_err(),
            "invalid native callable view"
        );
    }

    #[test]
    fn getter_descriptor_requires_dynamic_operands_and_attributes() {
        let mut module = callable_module();
        module.functions.truncate(1);
        let loc = module.functions[0].loc.clone();
        let dynamic = || Expr::DynObjLit {
            fields: vec![],
            r#type: Type::Dyn,
            loc: loc.clone(),
        };
        let flag = || Expr::BoolLit {
            value: false,
            r#type: Type::Bool,
            loc: loc.clone(),
        };
        module.functions[0].body = vec![Stmt::Expression {
            expr: Expr::LibCall {
                r#fn: "dyn.defineOrdinaryGetter".into(),
                args: vec![dynamic(), dynamic(), dynamic(), dynamic(), dynamic()],
                r#type: Type::Dyn,
                loc: loc.clone(),
            },
            loc: loc.clone(),
        }];
        validate(&module).unwrap();
        if let Stmt::Expression {
            expr: Expr::LibCall { args, .. },
            ..
        } = &mut module.functions[0].body[0]
        {
            args[3] = flag();
        }
        assert_eq!(
            validate(&module).unwrap_err(),
            "invalid native accessor descriptor"
        );
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
            loc: loc.clone(),
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
            generator: None,
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
        assert!(
            validate(&m)
                .unwrap_err()
                .starts_with("invalid global assignment:")
        );
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
                null_prototype: false,
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
                null_prototype: false,
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
        assert!(
            validate(&m)
                .unwrap_err()
                .starts_with("invalid/recursive union layout u0:")
        );
    }

    #[test]
    fn nullish_union_payload_can_be_a_checked_extraction() {
        let mut m = record_module();
        m.unions.push(Union {
            id: 0,
            arms: vec![Type::Null, Type::F64],
        });
        m.unions.push(Union {
            id: 1,
            arms: vec![Type::Null, Type::Undefined],
        });
        let loc = m.functions[0].loc.clone();
        let source = Expr::UnionWrap {
            union_id: "u0".into(),
            tag: 0,
            value: Box::new(Expr::UnitLit {
                unit: "null",
                r#type: Type::Null,
                loc: loc.clone(),
            }),
            r#type: Type::Union { union_id: 0 },
            loc: loc.clone(),
        };
        let narrowed = Expr::UnionNarrow {
            union_id: "u0".into(),
            tag: 0,
            value: Box::new(source),
            r#type: Type::Null,
            loc: loc.clone(),
        };
        m.functions[0].body = vec![Stmt::Expression {
            expr: Expr::UnionWrap {
                union_id: "u1".into(),
                tag: 0,
                value: Box::new(narrowed.clone()),
                r#type: Type::Union { union_id: 1 },
                loc: loc.clone(),
            },
            loc: loc.clone(),
        }];
        assert!(validate(&m).is_ok());

        m.functions[0].body = vec![Stmt::Expression {
            expr: narrowed,
            loc,
        }];
        assert!(
            validate(&m)
                .unwrap_err()
                .starts_with("standalone unit narrowing")
        );
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
        validate(&m).unwrap();
        if let Stmt::Expression {
            expr: Expr::UnitLit { r#type, .. },
            ..
        } = &mut m.functions[0].body[0]
        {
            *r#type = Type::Undefined;
        }
        assert!(
            validate(&m)
                .unwrap_err()
                .starts_with("invalid native expression:")
        );
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
            source_modules: vec![],
            entry: "__main".into(),
            records: vec![],
            unions: vec![],
            globals: vec![],
            classes: vec![],
            functions: vec![
                Function {
                    is_async: false,
                    generator: None,
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
                    generator: None,
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
            captures: vec![],
            methods: vec![],
            symbol_methods: vec![],
            symbol_brand: None,
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
            generator: None,
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
                assert!(validate(&module).is_ok());
            }
        }
    }

    #[test]
    fn set_dynamic_seed_and_membership_require_owned_dynamic_values() {
        let mut module = callable_module();
        module.functions.truncate(1);
        let loc = module.functions[0].loc.clone();
        let seed = Expr::DynArrLit {
            elems: vec![],
            r#type: Type::Dyn,
            loc: loc.clone(),
        };
        let set = Expr::SetNew {
            seed: Some(Box::new(seed)),
            r#type: Type::Set {
                elem: Box::new(Type::F64),
            },
            loc: loc.clone(),
        };
        let key = Expr::DynFrom {
            value: Box::new(Expr::NumLit {
                value: 1.0,
                spelling: None,
                r#type: Type::F64,
                loc: loc.clone(),
            }),
            r#type: Type::Dyn,
            loc: loc.clone(),
        };
        module.functions[0].body = vec![Stmt::Expression {
            expr: Expr::SetIntrinsic {
                method: "hasValue".into(),
                receiver: Box::new(set),
                args: vec![key],
                r#type: Type::Bool,
                loc: loc.clone(),
            },
            loc: loc.clone(),
        }];
        assert!(validate(&module).is_ok());
        let Stmt::Expression {
            expr: Expr::SetIntrinsic { args, .. },
            ..
        } = &mut module.functions[0].body[0]
        else {
            unreachable!()
        };
        args[0] = Expr::NumLit {
            value: 1.0,
            spelling: None,
            r#type: Type::F64,
            loc,
        };
        assert_eq!(validate(&module).unwrap_err(), "invalid Set operation");
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
    fn map_values_iterator_requires_dynamic_generator_channels() {
        let mut module = callable_module();
        module.functions.truncate(1);
        let loc = module.functions[0].loc.clone();
        module.functions[0].body = vec![Stmt::Expression {
            expr: Expr::MapIntrinsic {
                method: "valuesIterator".into(),
                receiver: Box::new(Expr::MapNew {
                    seed: vec![],
                    r#type: Type::Map {
                        key: Box::new(Type::String),
                        value: Box::new(Type::F64),
                    },
                    loc: loc.clone(),
                }),
                args: vec![],
                r#type: Type::Generator {
                    r#async: false,
                    yield_type: Box::new(Type::Dyn),
                    return_type: Box::new(Type::Void),
                    next_type: Box::new(Type::Undefined),
                },
                loc: loc.clone(),
            },
            loc,
        }];
        validate(&module).unwrap();
        let Stmt::Expression {
            expr: Expr::MapIntrinsic { r#type, .. },
            ..
        } = &mut module.functions[0].body[0]
        else {
            unreachable!()
        };
        *r#type = Type::Generator {
            r#async: false,
            yield_type: Box::new(Type::F64),
            return_type: Box::new(Type::Void),
            next_type: Box::new(Type::Undefined),
        };
        assert_eq!(validate(&module).unwrap_err(), "invalid Map operation");
    }

    #[test]
    fn map_values_iterator_object_requires_dynamic_result_and_no_arguments() {
        let mut module = callable_module();
        module.functions.truncate(1);
        let loc = module.functions[0].loc.clone();
        module.functions[0].body = vec![Stmt::Expression {
            expr: Expr::MapIntrinsic {
                method: "valuesIteratorObject".into(),
                receiver: Box::new(Expr::MapNew {
                    seed: vec![],
                    r#type: Type::Map {
                        key: Box::new(Type::String),
                        value: Box::new(Type::F64),
                    },
                    loc: loc.clone(),
                }),
                args: vec![],
                r#type: Type::Dyn,
                loc: loc.clone(),
            },
            loc: loc.clone(),
        }];
        validate(&module).unwrap();
        let Stmt::Expression {
            expr: Expr::MapIntrinsic { r#type, .. },
            ..
        } = &mut module.functions[0].body[0]
        else {
            unreachable!()
        };
        *r#type = Type::String;
        assert_eq!(validate(&module).unwrap_err(), "invalid Map operation");
        let Stmt::Expression {
            expr: Expr::MapIntrinsic { r#type, args, .. },
            ..
        } = &mut module.functions[0].body[0]
        else {
            unreachable!()
        };
        *r#type = Type::Dyn;
        args.push(Expr::NumLit {
            value: 1.0,
            spelling: None,
            r#type: Type::F64,
            loc,
        });
        assert_eq!(validate(&module).unwrap_err(), "invalid Map operation");
    }

    #[test]
    fn set_iterator_requires_matching_generator_channels() {
        let mut module = callable_module();
        module.functions.truncate(1);
        let loc = module.functions[0].loc.clone();
        let generator = Type::Generator {
            r#async: false,
            yield_type: Box::new(Type::String),
            return_type: Box::new(Type::Void),
            next_type: Box::new(Type::Undefined),
        };
        module.functions[0].body = vec![Stmt::Expression {
            expr: Expr::SetIntrinsic {
                method: "iterator".into(),
                receiver: Box::new(Expr::SetNew {
                    seed: None,
                    r#type: Type::Set {
                        elem: Box::new(Type::String),
                    },
                    loc: loc.clone(),
                }),
                args: vec![],
                r#type: generator.clone(),
                loc: loc.clone(),
            },
            loc,
        }];
        validate(&module).unwrap();
        for invalid in [
            Type::Generator {
                r#async: false,
                yield_type: Box::new(Type::F64),
                return_type: Box::new(Type::Void),
                next_type: Box::new(Type::Undefined),
            },
            Type::Generator {
                r#async: true,
                yield_type: Box::new(Type::String),
                return_type: Box::new(Type::Void),
                next_type: Box::new(Type::Undefined),
            },
            Type::Generator {
                r#async: false,
                yield_type: Box::new(Type::String),
                return_type: Box::new(Type::Void),
                next_type: Box::new(Type::Dyn),
            },
        ] {
            let Stmt::Expression {
                expr: Expr::SetIntrinsic { r#type, .. },
                ..
            } = &mut module.functions[0].body[0]
            else {
                unreachable!()
            };
            *r#type = invalid;
            assert_eq!(validate(&module).unwrap_err(), "invalid Set operation");
        }
    }

    #[test]
    fn set_to_array_requires_the_matching_element_type() {
        let mut module = callable_module();
        module.functions.truncate(1);
        let loc = module.functions[0].loc.clone();
        let set = Expr::SetNew {
            seed: None,
            r#type: Type::Set {
                elem: Box::new(Type::String),
            },
            loc: loc.clone(),
        };
        module.functions[0].body = vec![Stmt::Expression {
            expr: Expr::SetIntrinsic {
                method: "toArray".into(),
                receiver: Box::new(set),
                args: vec![],
                r#type: Type::Array {
                    elem: Box::new(Type::String),
                },
                loc: loc.clone(),
            },
            loc,
        }];
        assert!(validate(&module).is_ok());
        if let Stmt::Expression {
            expr: Expr::SetIntrinsic { r#type, .. },
            ..
        } = &mut module.functions[0].body[0]
        {
            *r#type = Type::Array {
                elem: Box::new(Type::F64),
            };
        }
        assert_eq!(validate(&module).unwrap_err(), "invalid Set operation");
    }

    #[test]
    fn string_split_requires_string_separator_and_numeric_limit() {
        let mut module = callable_module();
        module.functions.truncate(1);
        let loc = module.functions[0].loc.clone();
        let string = |value: &str| Expr::StrLit {
            value: value.into(),
            r#type: Type::String,
            loc: loc.clone(),
        };
        module.functions[0].body = vec![Stmt::Expression {
            expr: Expr::StringIntrinsic {
                method: "split".into(),
                receiver: Box::new(string("a.b")),
                args: vec![
                    string("."),
                    Expr::NumLit {
                        value: 42.0,
                        spelling: None,
                        r#type: Type::F64,
                        loc: loc.clone(),
                    },
                ],
                r#type: Type::Array {
                    elem: Box::new(Type::String),
                },
                loc: loc.clone(),
            },
            loc: loc.clone(),
        }];
        assert!(validate(&module).is_ok());
        if let Stmt::Expression {
            expr: Expr::StringIntrinsic { args, .. },
            ..
        } = &mut module.functions[0].body[0]
        {
            args[1] = string("invalid limit");
        }
        assert_eq!(
            validate(&module).unwrap_err(),
            "invalid native string operation"
        );
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
        assert!(
            validate(&module)
                .unwrap_err()
                .starts_with("invalid call signature")
        );
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
            source_modules: vec![],
            entry: "main".into(),
            functions: vec![Function {
                is_async: false,
                generator: None,
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
            generator: None,
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
    fn wide_bytes_validate_storage_kind_writes_and_portable_abi() {
        let mut module = callable_module();
        let loc = module.functions[0].loc.clone();
        let number = |value| Expr::NumLit {
            value,
            spelling: None,
            r#type: Type::F64,
            loc: loc.clone(),
        };
        for elem in ["u32", "i32", "f32", "f64"] {
            let ty = Type::Bytes { elem: elem.into() };
            let owner = || Expr::BytesNew {
                source: Some(Box::new(number(2.0))),
                r#type: ty.clone(),
                loc: loc.clone(),
            };
            module.functions[0].body = vec![
                Stmt::BytesSet {
                    arr: owner(),
                    index: number(0.0),
                    value: number(0.1),
                    loc: loc.clone(),
                },
                Stmt::Expression {
                    expr: Expr::BytesIntrinsic {
                        receiver: Box::new(owner()),
                        method: "byteLength".into(),
                        args: vec![],
                        r#type: Type::F64,
                        loc: loc.clone(),
                    },
                    loc: loc.clone(),
                },
            ];
            validate(&module).unwrap();
            let wire = serde_json::to_value(&module).unwrap();
            assert_eq!(wire["functions"][0]["body"][0]["kind"], "bytesSet");
            assert_eq!(wire["functions"][0]["body"][0]["arr"]["type"]["elem"], elem);
            let rust = crate::emit::rust(&module).unwrap();
            assert!(rust.contains(&format!("bytes_alloc::<{elem}>")));
            assert!(rust.contains("runtime::bytes_byte_len(&bytes)"));
            if let Stmt::BytesSet { value, .. } = &mut module.functions[0].body[0] {
                *value = Expr::BoolLit {
                    value: true,
                    r#type: Type::Bool,
                    loc: loc.clone(),
                };
            }
            assert_eq!(validate(&module).unwrap_err(), "invalid native bytes write");
            module.functions[0].body = vec![Stmt::Expression {
                expr: Expr::BytesIntrinsic {
                    receiver: Box::new(owner()),
                    method: "slice".into(),
                    args: vec![],
                    r#type: Type::bytes(),
                    loc: loc.clone(),
                },
                loc: loc.clone(),
            }];
            assert_eq!(
                validate(&module).unwrap_err(),
                "invalid native bytes operation"
            );
            module.functions[0].body = vec![Stmt::Expression {
                expr: Expr::BytesNew {
                    source: Some(Box::new(owner())),
                    r#type: Type::bytes(),
                    loc: loc.clone(),
                },
                loc: loc.clone(),
            }];
            assert_eq!(
                validate(&module).unwrap_err(),
                "invalid native bytes source"
            );
            module.functions[0].body = vec![Stmt::Expression {
                expr: Expr::BytesIntrinsic {
                    receiver: Box::new(owner()),
                    method: "byteOffset".into(),
                    args: vec![],
                    r#type: Type::F64,
                    loc: loc.clone(),
                },
                loc: loc.clone(),
            }];
            assert_eq!(
                validate(&module).unwrap_err(),
                "invalid native bytes operation"
            );
        }
    }
    #[test]
    fn data_view_portable_signatures_validate_and_emit() {
        let mut module = callable_module();
        let loc = module.functions[0].loc.clone();
        let number = || Expr::NumLit {
            value: 1.0,
            spelling: None,
            r#type: Type::F64,
            loc: loc.clone(),
        };
        let boolean = || Expr::BoolLit {
            value: true,
            r#type: Type::Bool,
            loc: loc.clone(),
        };
        let bytes = |elem: &str| Expr::BytesNew {
            source: None,
            r#type: Type::Bytes { elem: elem.into() },
            loc: loc.clone(),
        };
        let operation = |method: &str, receiver, args, result| Expr::BytesIntrinsic {
            method: method.into(),
            receiver: Box::new(receiver),
            args,
            r#type: result,
            loc: loc.clone(),
        };
        let check = |module: &mut Module, expr: Expr| {
            module.functions[0].body = vec![Stmt::Expression {
                expr,
                loc: loc.clone(),
            }];
            validate(module)
        };

        for elem in ["u8", "f32", "f64"] {
            for args in [vec![], vec![number()], vec![number(), number()]] {
                check(
                    &mut module,
                    operation("dataViewNew", bytes(elem), args, Type::bytes()),
                )
                .unwrap();
                let rust = crate::emit::rust(&module).unwrap();
                assert!(rust.contains("runtime::data_view_new(&bytes,"));
            }
        }
        assert!(
            check(
                &mut module,
                operation("dataViewNew", bytes("u8"), vec![boolean()], Type::bytes())
            )
            .is_err()
        );
        assert!(
            check(
                &mut module,
                operation(
                    "dataViewNew",
                    bytes("u8"),
                    vec![number(), number(), number()],
                    Type::bytes()
                )
            )
            .is_err()
        );
        assert!(
            check(
                &mut module,
                operation("dataViewNew", bytes("u8"), vec![], Type::F64)
            )
            .is_err()
        );

        let methods = [
            "dvGetUint8",
            "dvGetInt8",
            "dvGetUint16",
            "dvGetInt16",
            "dvGetUint32",
            "dvGetInt32",
            "dvGetFloat32",
            "dvGetFloat64",
            "dvGetBigUint64Number",
            "dvGetBigInt64Number",
            "dvSetUint8",
            "dvSetInt8",
            "dvSetUint16",
            "dvSetInt16",
            "dvSetUint32",
            "dvSetInt32",
            "dvSetFloat32",
            "dvSetFloat64",
        ];
        for method in methods {
            let (kind, is_set, is_byte) = data_view_operation(method).unwrap();
            let required = if is_set { 2 } else { 1 };
            let result = if is_set { Type::Void } else { Type::F64 };
            let args = (0..required).map(|_| number()).collect::<Vec<_>>();
            check(
                &mut module,
                operation(method, bytes("u8"), args.clone(), result.clone()),
            )
            .unwrap();
            let rust = crate::emit::rust(&module).unwrap();
            let expected = format!(
                "runtime::data_view_{}(&bytes, \"{}\",",
                if is_set { "set" } else { "get" },
                kind
            );
            assert!(rust.contains(&expected), "{method}");
            assert!(rust.contains(", false)"), "{method} defaults to big-endian");
            assert!(
                check(
                    &mut module,
                    operation(method, bytes("f32"), args.clone(), result.clone())
                )
                .is_err(),
                "{method} rejects non-u8 views"
            );
            assert!(
                check(
                    &mut module,
                    operation(method, bytes("u8"), vec![], result.clone())
                )
                .is_err(),
                "{method} requires arguments"
            );
            assert!(
                check(
                    &mut module,
                    operation(method, bytes("u8"), args.clone(), Type::String)
                )
                .is_err(),
                "{method} rejects wrong return"
            );
            let mut with_endian = args.clone();
            with_endian.push(boolean());
            assert_eq!(
                check(
                    &mut module,
                    operation(method, bytes("u8"), with_endian, result.clone())
                )
                .is_ok(),
                !is_byte,
                "{method} endian argument"
            );
            let mut wrong_endian = args;
            wrong_endian.push(number());
            assert!(
                check(
                    &mut module,
                    operation(method, bytes("u8"), wrong_endian, result)
                )
                .is_err(),
                "{method} rejects numeric endian"
            );
        }
        assert!(
            check(
                &mut module,
                operation("dvGetUnknown", bytes("u8"), vec![number()], Type::F64)
            )
            .is_err()
        );
    }

    #[test]
    #[ignore = "requires the offline Rust runtime toolchain and Node"]
    fn data_view_emitted_program_matches_node() {
        let mut module = callable_module();
        module.functions.truncate(1);
        let loc = module.functions[0].loc.clone();
        let num = |value| Expr::NumLit {
            value,
            spelling: None,
            r#type: Type::F64,
            loc: loc.clone(),
        };
        let bool_lit = |value| Expr::BoolLit {
            value,
            r#type: Type::Bool,
            loc: loc.clone(),
        };
        let var = |name: &str| Expr::VarRef {
            local_id: name.into(),
            r#type: Type::bytes(),
            loc: loc.clone(),
        };
        let op =
            |method: &str, receiver: Expr, args: Vec<Expr>, r#type: Type| Expr::BytesIntrinsic {
                method: method.into(),
                receiver: Box::new(receiver),
                args,
                r#type,
                loc: loc.clone(),
            };
        module.functions[0].locals = ["owner", "view"]
            .into_iter()
            .map(|name| Local {
                boxed: false,
                id: name.into(),
                name: name.into(),
                r#type: Type::bytes(),
                mutable: false,
            })
            .collect();
        module.functions[0].body = vec![
            Stmt::VarDecl {
                local_id: "owner".into(),
                init: Expr::BytesNew {
                    source: Some(Box::new(num(16.0))),
                    r#type: Type::bytes(),
                    loc: loc.clone(),
                },
                loc: loc.clone(),
            },
            Stmt::VarDecl {
                local_id: "view".into(),
                init: op(
                    "dataViewNew",
                    var("owner"),
                    vec![num(1.0), num(14.0)],
                    Type::bytes(),
                ),
                loc: loc.clone(),
            },
            Stmt::Expression {
                expr: op(
                    "dvSetUint32",
                    var("view"),
                    vec![num(0.0), num(305419896.0)],
                    Type::Void,
                ),
                loc: loc.clone(),
            },
            Stmt::Expression {
                expr: Expr::Intrinsic {
                    name: "console.log".into(),
                    args: vec![
                        op("dvGetUint32", var("view"), vec![num(0.0)], Type::F64),
                        op(
                            "dvGetUint32",
                            var("view"),
                            vec![num(0.0), bool_lit(true)],
                            Type::F64,
                        ),
                        op("get", var("owner"), vec![num(1.0)], Type::F64),
                        op("byteOffset", var("view"), vec![], Type::F64),
                        op("byteLength", var("view"), vec![], Type::F64),
                    ],
                    r#type: Type::Void,
                    loc: loc.clone(),
                },
                loc: loc.clone(),
            },
        ];
        let mut script = String::from(
            r#"
            const owner = new Uint8Array(16);
            const view = new DataView(owner.buffer, 1, 14);
            view.setUint32(0, 305419896);
            console.log(view.getUint32(0), view.getUint32(0, true), owner[1], view.byteOffset, view.byteLength);
        "#,
        );
        for (name, value, byte) in [
            ("Uint8", 250.0, true),
            ("Int8", -2.0, true),
            ("Uint16", 4660.0, false),
            ("Int16", -1234.0, false),
            ("Uint32", 305419896.0, false),
            ("Int32", -123456.0, false),
            ("Float32", -1.25, false),
            ("Float64", -42.5, false),
        ] {
            let mut args = vec![num(0.0), num(value)];
            if !byte {
                args.push(bool_lit(true));
            }
            module.functions[0].body.push(Stmt::Expression {
                expr: op(&format!("dvSet{name}"), var("view"), args, Type::Void),
                loc: loc.clone(),
            });
            let mut read_args = vec![num(0.0)];
            if !byte {
                read_args.push(bool_lit(true));
            }
            module.functions[0].body.push(Stmt::Expression {
                expr: Expr::Intrinsic {
                    name: "console.log".into(),
                    args: vec![op(
                        &format!("dvGet{name}"),
                        var("view"),
                        read_args,
                        Type::F64,
                    )],
                    r#type: Type::Void,
                    loc: loc.clone(),
                },
                loc: loc.clone(),
            });
            script.push_str(&format!(
                "view.set{name}(0, {value}{}); console.log(view.get{name}(0{}));\n",
                if byte { "" } else { ", true" },
                if byte { "" } else { ", true" }
            ));
        }
        for (method, js_method) in [
            ("dvGetBigUint64Number", "getBigUint64"),
            ("dvGetBigInt64Number", "getBigInt64"),
        ] {
            module.functions[0].body.push(Stmt::Expression {
                expr: Expr::Intrinsic {
                    name: "console.log".into(),
                    args: vec![op(
                        method,
                        var("view"),
                        vec![num(0.0), bool_lit(true)],
                        Type::F64,
                    )],
                    r#type: Type::Void,
                    loc: loc.clone(),
                },
                loc: loc.clone(),
            });
            script.push_str(&format!(
                "console.log(Number(view.{js_method}(0, true)));\n"
            ));
        }
        let rust = crate::emit::rust_with_metrics(&module).unwrap();
        let partition = crate::emit::chunks::plan_abi(&module, 4 * 1024 * 1024)
            .unwrap()
            .partition;
        let work = tempfile::Builder::new()
            .prefix("scriptc_dataview_")
            .tempdir()
            .unwrap();
        let binary = crate::compile(&rust, &partition, work.path(), true, false).unwrap();
        let native = std::process::Command::new(binary).output().unwrap();
        let node = std::process::Command::new("node")
            .args(["-e", &script])
            .output()
            .unwrap();
        assert_eq!(
            native.status.code(),
            node.status.code(),
            "native stderr: {}",
            String::from_utf8_lossy(&native.stderr)
        );
        assert_eq!(native.stdout, node.stdout);
        assert_eq!(native.stderr, node.stderr);
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
        assert!(module.valid_type(Type::Bytes { elem: "u16".into() }, &mut vec![]));
    }
    #[test]
    fn validation_reports_independent_body_failures() {
        let mut module = callable_module();
        let mut broken = module.functions[0].clone();
        broken.name = "broken_a".into();
        broken.body = vec![Stmt::Expression {
            expr: Expr::VarRef {
                local_id: "missing".into(),
                r#type: Type::String,
                loc: broken.loc.clone(),
            },
            loc: broken.loc.clone(),
        }];
        module.functions.push(broken.clone());
        broken.name = "broken_b".into();
        module.functions.push(broken);
        let errors = validate(&module).unwrap_err();
        assert!(errors.contains("broken_a:"), "{errors}");
        assert!(errors.contains("broken_b:"), "{errors}");
    }
}
