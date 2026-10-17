//! The first native subset of the existing scriptc IR v13 wire contract.
use serde::Serialize;
mod walk;
use std::collections::HashMap;

pub const VERSION: u32 = 13;

/// Typed Sets have a portable reference ABI, but the shared dynamic value
/// contract cannot box them (including inside a composite or callback ABI).
pub fn contains_set(ty: &Type, records: &[Record], unions: &[Union]) -> bool {
    fn visit(
        ty: &Type,
        records: &[Record],
        unions: &[Union],
        seen: &mut std::collections::HashSet<Type>,
    ) -> bool {
        if !seen.insert(ty.clone()) {
            return false;
        }
        match ty {
            Type::Set { .. } => true,
            Type::Array { elem } | Type::Promise { inner: elem } => {
                visit(elem, records, unions, seen)
            }
            Type::Map { key, value } => {
                visit(key, records, unions, seen) || visit(value, records, unions, seen)
            }
            Type::Func { params, ret } => {
                params.iter().any(|t| visit(t, records, unions, seen))
                    || visit(ret, records, unions, seen)
            }
            Type::Record { shape_id } => records.get(*shape_id).is_some_and(|r| {
                r.fields
                    .iter()
                    .any(|f| visit(&f.r#type, records, unions, seen))
                    || r.index_value
                        .as_ref()
                        .is_some_and(|t| visit(t, records, unions, seen))
            }),
            Type::Union { union_id } => unions
                .get(*union_id)
                .is_some_and(|u| u.arms.iter().any(|t| visit(t, records, unions, seen))),
            _ => false,
        }
    }
    visit(ty, records, unions, &mut std::collections::HashSet::new())
}

#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Type {
    Func {
        params: Vec<Type>,
        ret: Box<Type>,
    },
    F64,
    String,
    Bool,
    Regex,
    // Owned native tagged value; never an embedded engine handle.
    Dyn,
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
#[derive(Debug, Serialize)]
pub struct MapEntry {
    pub key: Expr,
    pub value: Expr,
}

#[derive(Debug, Serialize)]
pub struct DynamicField {
    pub key: Expr,
    pub value: Expr,
}

#[derive(Debug, Serialize)]
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
    pub name: String,
    pub params: Vec<Param>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub captures: Option<Vec<Param>>,
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
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub boxed: bool,
}

#[derive(Debug, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Expr {
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
            Self::DynFrom { r#type, .. }
            | Self::DynCheck { r#type, .. }
            | Self::DynObjLit { r#type, .. }
            | Self::DynArrLit { r#type, .. }
            | Self::DynKeyGet { r#type, .. }
            | Self::DynTest { r#type, .. }
            | Self::DynScalarEq { r#type, .. }
            | Self::DynInvoke { r#type, .. }
            | Self::DynCall { r#type, .. }
            | Self::RegexLit { r#type, .. }
            | Self::RegexIntrinsic { r#type, .. }
            | Self::New { r#type, .. }
            | Self::FieldGet { r#type, .. }
            | Self::Upcast { r#type, .. }
            | Self::Downcast { r#type, .. }
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
            | Self::StrConcat { r#type, .. }
            | Self::ToString { r#type, .. }
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
            | Self::Intrinsic { r#type, .. } => r#type.clone(),
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
            .find(|f| f.name == self.entry)?
            .body
            .iter()
            .find(|stmt| matches!(stmt, Stmt::Assign { local_id, initializes_global: true, .. } if local_id == id))
    }

    pub fn initializes(&self, stmt: &Stmt, function: &Function, id: &str) -> bool {
        function.name == self.entry
            && self
                .initializer(id)
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
        if let Some(first) = active.iter().position(|current| *current == ty) {
            // Callable signatures describe an ABI, rather than an inline
            // storage edge. Recursive callable results may name their record.
            return active[first..]
                .iter()
                .any(|edge| matches!(edge, Type::Func { .. }));
        }
        active.push(ty.clone());
        let valid = match ty {
            Type::Object { class_name } => self.class(&class_name).is_some(),
            Type::Classval { class_name } => self.class(&class_name).is_some_and(|c| !c.runtime),
            Type::Func { params, ret } => {
                params.iter().all(|p| self.valid_type(p.clone(), active))
                    && (*ret == Type::Void || self.valid_type(*ret, active))
            }
            Type::Void | Type::Null | Type::Undefined => false,
            Type::Array { elem } => {
                !matches!(*elem, Type::Func { .. }) && self.valid_type(*elem, active)
            }
            Type::Promise { inner } => *inner == Type::Void || self.valid_type(*inner, active),
            Type::Set { elem } => matches!(*elem, Type::String | Type::F64),
            Type::Map { key, value } => {
                matches!(*key, Type::F64 | Type::String | Type::Dyn)
                    && !matches!(*value, Type::Func { .. } | Type::Map { .. })
                    && self.valid_type(*value, active)
            }
            Type::Record { shape_id } => self.records.get(shape_id).is_some_and(|r| {
                r.id == shape_id
                    && r.index_value.as_ref().is_none_or(|v| {
                        r.fields.is_empty()
                            && !matches!(v, Type::Func { .. } | Type::Map { .. })
                            && self.valid_type(v.clone(), active)
                    })
                    && r.fields
                        .iter()
                        .all(|f| self.valid_type(f.r#type.clone(), active))
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
                            || (!matches!(arm, Type::Union { .. } | Type::Map { .. })
                                && self.valid_type(arm.clone(), active))
                    })
            }),
            _ => true,
        };
        active.pop();
        valid
    }
    fn validate_layouts(&self) -> Result<(), String> {
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
            if !class.fields.starts_with(&header) || class.runtime != builtin
                || !self.subclass(&class.name, "%Error")
                || (class.name == "%Error" && class.base.is_some())
                || (builtin && class.name != "%Error" && class.base.as_deref() != Some("%Error"))
                || (builtin && class.fields.len() != header.len())
                || !class.fields.iter().skip(header.len()).all(|field| field.r#type == Type::Dyn || matches!(&field.r#type, Type::Union { union_id } if self.unions.get(*union_id).is_some_and(|u| u.arms.contains(&Type::Undefined)))) {
                return Err("invalid native Error class/header/slot".into());
            }
            if let Some(base) = &class.base {
                let base = self.class(base).ok_or("unknown class base")?;
                if self.subclass(&base.name, &class.name) || !class.fields.starts_with(&base.fields)
                {
                    return Err("invalid class inheritance/prefix".into());
                }
            }
            let mut fields = std::collections::HashSet::new();
            if !class.fields.iter().enumerate().all(|(i, field)| {
                fields.insert(&field.name)
                    && (i < header.len()
                        || (!matches!(field.r#type, Type::Func { .. })
                            && self.valid_type(field.r#type.clone(), &mut vec![])))
            }) {
                return Err("invalid class field layout".into());
            }
        }
        for (id, r) in self.records.iter().enumerate() {
            let mut names = r.fields.iter().map(|f| f.name.as_str()).collect::<Vec<_>>();
            if r.id != id
                || !names.windows(2).all(|pair| pair[0] < pair[1])
                || !self.valid_type(Type::Record { shape_id: id }, &mut vec![])
            {
                return Err("invalid/recursive record layout".into());
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
                || !self.valid_type(Type::Union { union_id: id }, &mut vec![])
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
    if f.return_type != Type::Void && !module.valid_type(f.return_type.clone(), &mut vec![]) {
        return Err("invalid return layout".into());
    }
    let mut locals = HashMap::new();
    for local in &f.locals {
        let supported = module.valid_type(local.r#type.clone(), &mut vec![]);
        if !supported
            || module.global(&local.id).is_some()
            || locals.insert(local.id.as_str(), local).is_some()
        {
            return Err("duplicate/void local".into());
        }
    }
    let mut parameter_ids = std::collections::HashSet::new();
    for param in f.params.iter().chain(f.captures.iter().flatten()) {
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
            Expr::DynFrom { value, r#type, .. } => {
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
                if *r#type == Type::Dyn && value.ty() != Type::Void {
                    Ok(())
                } else {
                    Err("invalid native value boxing".into())
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
                        "string"
                            | "number"
                            | "boolean"
                            | "undefined"
                            | "null"
                            | "nullish"
                            | "object"
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
                let valid = receiver.ty() == Type::Regex
                    && match method.as_str() {
                        "test" => {
                            args.len() == 1 && args[0].ty() == Type::String && *r#type == Type::Bool
                        }
                        "source" | "flags" => args.is_empty() && *r#type == Type::String,
                        "lastIndex" => args.is_empty() && *r#type == Type::F64,
                        "setLastIndex" => {
                            args.len() == 1 && args[0].ty() == Type::F64 && *r#type == Type::F64
                        }
                        _ => false,
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
                        f.return_type == Type::Void
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
                if !matches!(**elem, Type::String | Type::F64) {
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
                if !matches!(operand.ty(), Type::F64 | Type::Bool | Type::Dyn)
                    || *r#type != Type::String
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
                if *r#type != Type::F64
                    || match method.as_str() {
                        "length" => !args.is_empty(),
                        "push" => args.iter().any(|arg| arg.ty() != *elem),
                        _ => true,
                    }
                {
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
                    params: target.params.iter().map(|p| p.r#type.clone()).collect(),
                    ret: Box::new(target.return_type.clone()),
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
                let Type::Func { params, ret } = callee.ty() else {
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
                                | Type::Promise { .. }
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
                    || *r#type != target.return_type
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
        function: &Function,
    ) -> Result<(), String> {
        for stmt in stmts {
            match stmt {
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
                                && !module.initializes(stmt, function, local_id))
                            || (!global.mutable && !module.initializes(stmt, function, local_id))
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
        f,
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

    fn error_module() -> Module {
        let mut m = callable_module();
        let loc = m.functions[0].loc.clone();
        m.classes.push(Class {
            name: "%Error".into(),
            js_name: "Error".into(),
            runtime: true,
            base: None,
            fields: error_fields(),
            loc: loc.clone(),
        });
        m.classes.push(Class {
            name: "Detail".into(),
            js_name: "Detail".into(),
            runtime: false,
            base: Some("%Error".into()),
            fields: error_fields(),
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
    fn error_layouts_validate_prefixes_roots_and_reserved_metadata() {
        let mut m = error_module();
        assert!(validate(&m).is_ok());
        m.classes[1].fields[0].r#type = Type::Bool;
        assert!(validate(&m).unwrap_err().contains("Error class/header"));
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
            !m.valid_type(array, &mut vec![]),
            "cycles through array elements must be checked"
        );
        assert!(!m.valid_type(
            Type::Array {
                elem: Box::new(Type::Func {
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
    fn indexed_layouts_reject_cycles_and_incompatible_overflow() {
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
        assert_eq!(validate(&m).unwrap_err(), "invalid/recursive record layout");
        m.records[0].index_value = Some(Type::Func {
            params: vec![],
            ret: Box::new(Type::F64),
        });
        assert_eq!(validate(&m).unwrap_err(), "invalid/recursive record layout");
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
    fn callable_signature_cycles_are_distinct_from_inline_layout_cycles() {
        let mut m = record_module();
        m.records[0].fields[0].r#type = Type::Func {
            params: vec![],
            ret: Box::new(Type::Record { shape_id: 0 }),
        };
        assert!(m.valid_type(Type::Record { shape_id: 0 }, &mut vec![]));
        m.records[0].fields[0].r#type = Type::Record { shape_id: 0 };
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
            globals: vec![],
            classes: vec![],
            functions: vec![
                Function {
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
}
