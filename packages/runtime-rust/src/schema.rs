// The Schema kernel (effect's `Schema.*` values): a schema is a DESCRIPTOR held by a kernel data handle
// (`KernelData::Schema`), and decoding runs the descriptor over the program's dynamic value — generic over the
// `ParseArgsValue` view every program's dyn enum implements — producing a fresh dynamic value the site converts
// to its checker-typed shape. Messages follow effect 4's issue formatter (`Expected string, got 5\n  at ["k"][1]`).

#[derive(Clone)]
pub enum SchemaLiteral {
    Str(JsString),
    Num(f64),
    Bool(bool),
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum SchemaPrim {
    String,
    Number,
    Boolean,
    Unknown,
    Any,
    Defect,
    Json,
    Null,
    Undefined,
    Finite,
    Int,
    NumberFromString,
}

#[derive(Clone)]
pub enum SchemaFilter {
    StartsWith(JsString),
    EndsWith(JsString),
    Includes(JsString),
    Gte(f64),
    Lte(f64),
    Gt(f64),
    Lt(f64),
    MinLength(f64),
    MaxLength(f64),
    Int,
    Finite,
    /// `Schema.isPattern(re)`: the source and flags of the program's regular expression.
    Pattern(JsString, JsString),
    /// `Schema.isBetween({ minimum, maximum })`: an inclusive range.
    Between(f64, f64),
}

pub struct SchemaField {
    pub name: JsString,
    pub node: Rc<SchemaNode>,
}

pub enum SchemaNode {
    Prim(SchemaPrim),
    Literal(Vec<SchemaLiteral>),
    Struct(Vec<SchemaField>),
    Array(Rc<SchemaNode>),
    Record(Rc<SchemaNode>, Rc<SchemaNode>),
    Union(Vec<Rc<SchemaNode>>),
    NullOr(Rc<SchemaNode>),
    UndefinedOr(Rc<SchemaNode>),
    /// A struct field whose KEY may be absent (`optionalKey`; `optional` = OptionalKey(UndefinedOr(inner))).
    OptionalKey(Rc<SchemaNode>),
    Check(Rc<SchemaNode>, SchemaFilter),
    /// A bare filter value (`Schema.isStartsWith("a")`), applied through `check`.
    Filter(SchemaFilter),
    /// `annotate({ identifier })`: the name the formatter uses for this schema.
    Named(JsString, Rc<SchemaNode>),
    /// `Schema.tag("x")`: a required literal key that `make` fills in when absent.
    Tag(SchemaLiteral),
    /// `Schema.fromJsonString(S)`: the input is JSON TEXT — parse it, then decode the result against S.
    FromJsonString(Rc<SchemaNode>),
    /// `Schema.Tuple([A, B])`: an array of exactly these element schemas, in order.
    Tuple(Vec<Rc<SchemaNode>>),
    /// `source.pipe(Schema.decodeTo(target, { decode: SchemaGetter.transform(f) }))`: decode against `source`, run
    /// the program's `f` over the result, then decode THAT against `target`. The transform crosses as a boxed value
    /// (`Rc<dyn Any>`) so one node serves every decoder value type.
    DecodeTo(Rc<SchemaNode>, Rc<SchemaNode>, Rc<dyn Fn(EffectValue) -> EffectValue>),
}

/// A parsed JSON document as the decoder's own value type: the generic constructors of ParseArgsValue rebuild it.
fn json_node_to_value<T: ParseArgsValue>(node: &JsonNode) -> T {
    match node {
        JsonNode::Null => T::parse_args_undefined(),
        JsonNode::Bool(value) => T::parse_args_bool_value(*value),
        JsonNode::Number(value) => T::parse_args_number_value(*value),
        JsonNode::String(text) => T::parse_args_string_value(text.clone()),
        JsonNode::Array(items) => {
            let array = T::parse_args_array_value();
            for item in items {
                array.parse_args_array_push(json_node_to_value(item));
            }
            array
        }
        JsonNode::Object(entries) => {
            let object = T::parse_args_object_value();
            for (key, value) in entries {
                object.parse_args_object_set(string(key), json_node_to_value(value));
            }
            object
        }
    }
}

fn schema_handle(node: SchemaNode) -> JsEffect {
    schema_handle_rc(Rc::new(node))
}

fn schema_handle_rc(node: Rc<SchemaNode>) -> JsEffect {
    effect_new(EffectNode::Data(KernelData::Schema(node)))
}

pub fn schema_node_of(handle: &JsEffect) -> Rc<SchemaNode> {
    handle.with(|data| match &data.node {
        EffectNode::Data(KernelData::Schema(node)) => node.clone(),
        _ => throw_error("scriptc: a schema handle was expected".to_owned()),
    })
}

/// Effect's `Schema.toType`: strip each encoding and retain its decoded target while preserving the surrounding
/// schema structure and checks. The descriptor remains immutable; a fresh handle owns the transformed graph.
fn schema_to_type_node(node: &Rc<SchemaNode>) -> Rc<SchemaNode> {
    Rc::new(match &**node {
        SchemaNode::Prim(SchemaPrim::NumberFromString) => SchemaNode::Prim(SchemaPrim::Number),
        SchemaNode::Prim(prim) => SchemaNode::Prim(*prim),
        SchemaNode::Literal(values) => SchemaNode::Literal(values.clone()),
        SchemaNode::Struct(fields) => SchemaNode::Struct(fields.iter().map(|field| SchemaField {
            name: field.name.clone(),
            node: schema_to_type_node(&field.node),
        }).collect()),
        SchemaNode::Array(item) => SchemaNode::Array(schema_to_type_node(item)),
        SchemaNode::Record(key, value) => SchemaNode::Record(schema_to_type_node(key), schema_to_type_node(value)),
        SchemaNode::Union(members) => SchemaNode::Union(members.iter().map(schema_to_type_node).collect()),
        SchemaNode::NullOr(inner) => SchemaNode::NullOr(schema_to_type_node(inner)),
        SchemaNode::UndefinedOr(inner) => SchemaNode::UndefinedOr(schema_to_type_node(inner)),
        SchemaNode::OptionalKey(inner) => SchemaNode::OptionalKey(schema_to_type_node(inner)),
        SchemaNode::Check(inner, filter) => SchemaNode::Check(schema_to_type_node(inner), filter.clone()),
        SchemaNode::Filter(filter) => SchemaNode::Filter(filter.clone()),
        SchemaNode::Named(name, inner) => SchemaNode::Named(name.clone(), schema_to_type_node(inner)),
        SchemaNode::Tag(literal) => SchemaNode::Tag(literal.clone()),
        SchemaNode::FromJsonString(inner) => return schema_to_type_node(inner),
        SchemaNode::Tuple(elements) => SchemaNode::Tuple(elements.iter().map(schema_to_type_node).collect()),
        SchemaNode::DecodeTo(_, target, _) => return schema_to_type_node(target),
    })
}

pub fn schema_to_type(schema: &JsEffect) -> JsEffect {
    schema_handle_rc(schema_to_type_node(&schema_node_of(schema)))
}

fn schema_json_object<T: ParseArgsValue>() -> T {
    T::parse_args_object_value()
}

fn schema_json_array<T: ParseArgsValue>(values: impl IntoIterator<Item = T>) -> T {
    let array = T::parse_args_array_value();
    for value in values {
        array.parse_args_array_push(value);
    }
    array
}

fn schema_json_set<T: ParseArgsValue>(object: &T, key: &str, value: T) {
    object.parse_args_object_set(string(key), value);
}

fn schema_json_string<T: ParseArgsValue>(value: &str) -> T {
    T::parse_args_string_value(string(value))
}

fn schema_json_typed<T: ParseArgsValue>(kind: &str) -> T {
    let out = schema_json_object();
    schema_json_set(&out, "type", schema_json_string(kind));
    out
}

fn schema_json_literal<T: ParseArgsValue>(literal: &SchemaLiteral) -> T {
    match literal {
        SchemaLiteral::Str(value) => T::parse_args_string_value(value.clone()),
        SchemaLiteral::Num(value) => T::parse_args_number_value(*value),
        SchemaLiteral::Bool(value) => T::parse_args_bool_value(*value),
    }
}

fn schema_json_literal_schema<T: ParseArgsValue>(literal: &SchemaLiteral) -> T {
    let kind = match literal {
        SchemaLiteral::Str(_) => "string",
        SchemaLiteral::Num(_) => "number",
        SchemaLiteral::Bool(_) => "boolean",
    };
    let out = schema_json_typed(kind);
    schema_json_set(&out, "enum", schema_json_array([schema_json_literal(literal)]));
    out
}

fn schema_pattern_escape(text: &str) -> String {
    let mut out = String::new();
    for ch in text.chars() {
        if matches!(ch, '\\' | '^' | '$' | '.' | '*' | '+' | '?' | '(' | ')' | '[' | ']' | '{' | '}' | '|') {
            out.push('\\');
        }
        out.push(ch);
    }
    out
}

fn schema_json_constraint<T: ParseArgsValue>(filter: &SchemaFilter) -> T {
    let out = schema_json_object();
    match filter {
        SchemaFilter::StartsWith(text) => schema_json_set(&out, "pattern", schema_json_string(&format!("^{}", schema_pattern_escape(text)))),
        SchemaFilter::EndsWith(text) => schema_json_set(&out, "pattern", schema_json_string(&format!("{}$", schema_pattern_escape(text)))),
        SchemaFilter::Includes(text) => schema_json_set(&out, "pattern", schema_json_string(&schema_pattern_escape(text))),
        SchemaFilter::Gte(value) => schema_json_set(&out, "minimum", T::parse_args_number_value(*value)),
        SchemaFilter::Lte(value) => schema_json_set(&out, "maximum", T::parse_args_number_value(*value)),
        SchemaFilter::Gt(value) => schema_json_set(&out, "exclusiveMinimum", T::parse_args_number_value(*value)),
        SchemaFilter::Lt(value) => schema_json_set(&out, "exclusiveMaximum", T::parse_args_number_value(*value)),
        SchemaFilter::MinLength(value) => schema_json_set(&out, "minLength", T::parse_args_number_value(*value)),
        SchemaFilter::MaxLength(value) => schema_json_set(&out, "maxLength", T::parse_args_number_value(*value)),
        SchemaFilter::Pattern(source, _) => schema_json_set(&out, "pattern", T::parse_args_string_value(source.clone())),
        SchemaFilter::Between(minimum, maximum) => {
            schema_json_set(&out, "minimum", T::parse_args_number_value(*minimum));
            schema_json_set(&out, "maximum", T::parse_args_number_value(*maximum));
        }
        SchemaFilter::Int | SchemaFilter::Finite => {}
    }
    out
}

fn schema_json_merge<T: ParseArgsValue>(target: &T, source: &T) {
    if let Some(entries) = source.parse_args_object_entries() {
        for (key, value) in entries {
            target.parse_args_object_set(key, value);
        }
    }
}

/// The draft-2020-12 representation of the native schema subset. Values are built through `ParseArgsValue`, so the
/// result is the generated program's own dynamic enum and never crosses an untyped or foreign heap boundary.
fn schema_to_json<T: ParseArgsValue>(node: &SchemaNode) -> T {
    match node {
        SchemaNode::Prim(prim) => match prim {
            SchemaPrim::String | SchemaPrim::NumberFromString => schema_json_typed("string"),
            SchemaPrim::Boolean => schema_json_typed("boolean"),
            SchemaPrim::Null | SchemaPrim::Undefined => schema_json_typed("null"),
            SchemaPrim::Finite => schema_json_typed("number"),
            SchemaPrim::Int => schema_json_typed("integer"),
            SchemaPrim::Unknown | SchemaPrim::Any | SchemaPrim::Defect | SchemaPrim::Json => schema_json_object(),
            SchemaPrim::Number => {
                let number = schema_json_typed("number");
                let sentinels = ["NaN", "Infinity", "-Infinity"].into_iter().map(|value| {
                    let branch = schema_json_typed("string");
                    schema_json_set(&branch, "enum", schema_json_array([schema_json_string(value)]));
                    branch
                });
                let out = schema_json_object();
                schema_json_set(&out, "anyOf", schema_json_array(std::iter::once(number).chain(sentinels)));
                out
            }
        },
        SchemaNode::Literal(values) => {
            let same_kind = values.first().map(std::mem::discriminant);
            if !values.is_empty() && values.iter().all(|value| Some(std::mem::discriminant(value)) == same_kind) {
                let out = schema_json_literal_schema(&values[0]);
                schema_json_set(&out, "enum", schema_json_array(values.iter().map(schema_json_literal)));
                out
            } else {
                let out = schema_json_object();
                schema_json_set(&out, "anyOf", schema_json_array(values.iter().map(schema_json_literal_schema)));
                out
            }
        }
        SchemaNode::Struct(fields) if fields.is_empty() => {
            let out = schema_json_object();
            schema_json_set(&out, "anyOf", schema_json_array([schema_json_typed("object"), schema_json_typed("array")]));
            out
        }
        SchemaNode::Struct(fields) => {
            let out = schema_json_typed("object");
            let properties: T = schema_json_object();
            let required: T = T::parse_args_array_value();
            for field in fields {
                let (field_schema, optional) = match &*field.node {
                    SchemaNode::OptionalKey(inner) => (schema_to_json(&**inner), true),
                    _ => (schema_to_json(&*field.node), false),
                };
                properties.parse_args_object_set(field.name.clone(), field_schema);
                if !optional {
                    required.parse_args_array_push(T::parse_args_string_value(field.name.clone()));
                }
            }
            schema_json_set(&out, "properties", properties);
            if required.parse_args_array_len().unwrap_or(0) > 0 {
                schema_json_set(&out, "required", required);
            }
            schema_json_set(&out, "additionalProperties", T::parse_args_bool_value(false));
            out
        }
        SchemaNode::Array(item) => {
            let out = schema_json_typed("array");
            schema_json_set(&out, "items", schema_to_json(&**item));
            out
        }
        SchemaNode::Record(_, value) => {
            let out = schema_json_typed("object");
            let additional: T = schema_to_json(&**value);
            if additional.parse_args_object_entries().is_some_and(|entries| !entries.is_empty()) {
                schema_json_set(&out, "additionalProperties", additional);
            }
            out
        }
        SchemaNode::Union(members) => {
            let out = schema_json_object();
            if members.is_empty() {
                schema_json_set(&out, "not", schema_json_object());
            } else {
                schema_json_set(&out, "anyOf", schema_json_array(members.iter().map(|member| schema_to_json(&**member))));
            }
            out
        }
        SchemaNode::NullOr(inner) | SchemaNode::UndefinedOr(inner) => {
            let out = schema_json_object();
            schema_json_set(&out, "anyOf", schema_json_array([schema_to_json(&**inner), schema_json_typed("null")]));
            out
        }
        SchemaNode::OptionalKey(inner) | SchemaNode::Named(_, inner) => schema_to_json(&**inner),
        SchemaNode::Check(inner, filter) => {
            let out = schema_to_json(&**inner);
            schema_json_merge(&out, &schema_json_constraint(filter));
            out
        }
        SchemaNode::Filter(filter) => schema_json_constraint(filter),
        SchemaNode::Tag(literal) => schema_json_literal_schema(literal),
        SchemaNode::FromJsonString(_) => schema_json_typed("string"),
        SchemaNode::Tuple(elements) => {
            let out = schema_json_typed("array");
            if elements.is_empty() {
                schema_json_set(&out, "items", T::parse_args_bool_value(false));
            } else {
                schema_json_set(&out, "prefixItems", schema_json_array(elements.iter().map(|element| schema_to_json(&**element))));
                schema_json_set(&out, "minItems", T::parse_args_number_value(elements.len() as f64));
                schema_json_set(&out, "maxItems", T::parse_args_number_value(elements.len() as f64));
            }
            out
        }
        SchemaNode::DecodeTo(source, _, _) => schema_to_json(&**source),
    }
}

pub fn schema_to_json_document<T: ParseArgsValue>(schema: &JsEffect) -> T {
    let document = schema_json_object();
    schema_json_set(&document, "dialect", schema_json_string("draft-2020-12"));
    schema_json_set(&document, "schema", schema_to_json(&*schema_node_of(schema)));
    schema_json_set(&document, "definitions", schema_json_object());
    document
}

pub fn schema_prim(kind: &JsString) -> JsEffect {
    let prim = match &**kind {
        "string" => SchemaPrim::String,
        "number" => SchemaPrim::Number,
        "boolean" => SchemaPrim::Boolean,
        "unknown" => SchemaPrim::Unknown,
        "any" => SchemaPrim::Any,
        "defect" => SchemaPrim::Defect,
        "json" => SchemaPrim::Json,
        "null" => SchemaPrim::Null,
        "undefined" => SchemaPrim::Undefined,
        "finite" => SchemaPrim::Finite,
        "int" => SchemaPrim::Int,
        "numberFromString" => SchemaPrim::NumberFromString,
        other => throw_error(format!("scriptc: unknown schema primitive '{other}'")),
    };
    effect_reference_cached(EffectReferenceKey::SchemaPrimitive(kind.to_string()), || schema_handle(SchemaNode::Prim(prim)))
}

pub fn schema_literal(values: Vec<SchemaLiteral>) -> JsEffect {
    schema_handle(SchemaNode::Literal(values))
}

pub fn schema_struct(fields: Vec<(JsString, JsEffect)>) -> JsEffect {
    schema_handle(SchemaNode::Struct(fields.into_iter().map(|(name, node)| SchemaField { name, node: schema_node_of(&node) }).collect()))
}

pub fn schema_array(item: &JsEffect) -> JsEffect {
    schema_handle(SchemaNode::Array(schema_node_of(item)))
}

pub fn schema_record(key: &JsEffect, value: &JsEffect) -> JsEffect {
    schema_handle(SchemaNode::Record(schema_node_of(key), schema_node_of(value)))
}

pub fn schema_union(members: Vec<JsEffect>) -> JsEffect {
    schema_handle(SchemaNode::Union(members.iter().map(schema_node_of).collect()))
}

/// `Schema.Tuple([A, B])`: an array of exactly these element schemas.
/// `Schema.decodeTo(target, { decode })` applied to a source schema.
pub fn schema_decode_to(source: &JsEffect, target: &JsEffect, transform: Rc<dyn Fn(EffectValue) -> EffectValue>) -> JsEffect {
    schema_handle(SchemaNode::DecodeTo(schema_node_of(source), schema_node_of(target), transform))
}

pub fn schema_tuple(elements: Vec<JsEffect>) -> JsEffect {
    schema_handle(SchemaNode::Tuple(elements.iter().map(schema_node_of).collect()))
}

/// `nullOr` / `undefinedOr` / `optional` / `optionalKey` / `fromJsonString`; `mutable`, `mutableKey` and `brand`
/// answer the inner schema.
pub fn schema_wrap(kind: &JsString, inner: &JsEffect) -> JsEffect {
    let node = schema_node_of(inner);
    match &**kind {
        "nullOr" => schema_handle(SchemaNode::NullOr(node)),
        "undefinedOr" => schema_handle(SchemaNode::UndefinedOr(node)),
        "optional" => schema_handle(SchemaNode::OptionalKey(Rc::new(SchemaNode::UndefinedOr(node)))),
        "optionalKey" => schema_handle(SchemaNode::OptionalKey(node)),
        "fromJsonString" => schema_handle(SchemaNode::FromJsonString(node)),
        named if named.starts_with("identifier:") => schema_handle(SchemaNode::Named(string(&named["identifier:".len()..]), node)),
        tag if tag.starts_with("tag:") => schema_handle(SchemaNode::Tag(SchemaLiteral::Str(string(&tag["tag:".len()..])))),
        _ => inner.clone(),
    }
}

/// `Schema.isPattern(re)`: the pattern's source and flags, tested with the runtime's own regex engine.
pub fn schema_filter_pattern(source: &JsString, flags: &JsString) -> JsEffect {
    schema_handle(SchemaNode::Filter(SchemaFilter::Pattern(source.clone(), flags.clone())))
}

/// `Schema.isBetween({ minimum, maximum })`: an inclusive range.
pub fn schema_filter_between(minimum: f64, maximum: f64) -> JsEffect {
    schema_handle(SchemaNode::Filter(SchemaFilter::Between(minimum, maximum)))
}

pub fn schema_filter(kind: &JsString, number: f64, text: &JsString) -> JsEffect {
    let filter = match &**kind {
        "isStartsWith" => SchemaFilter::StartsWith(text.clone()),
        "isEndsWith" => SchemaFilter::EndsWith(text.clone()),
        "isIncludes" => SchemaFilter::Includes(text.clone()),
        "isGreaterThanOrEqualTo" => SchemaFilter::Gte(number),
        "isLessThanOrEqualTo" => SchemaFilter::Lte(number),
        "isGreaterThan" => SchemaFilter::Gt(number),
        "isLessThan" => SchemaFilter::Lt(number),
        "isMinLength" => SchemaFilter::MinLength(number),
        "isMaxLength" => SchemaFilter::MaxLength(number),
        "isInt" => SchemaFilter::Int,
        "isFinite" => SchemaFilter::Finite,
        other => throw_error(format!("scriptc: unknown schema filter '{other}'")),
    };
    schema_handle(SchemaNode::Filter(filter))
}

pub fn schema_check(inner: &JsEffect, filter: &JsEffect) -> JsEffect {
    let filter = match &*schema_node_of(filter) {
        SchemaNode::Filter(filter) => filter.clone(),
        _ => throw_error("scriptc: Schema.check expects a filter".to_owned()),
    };
    schema_handle(SchemaNode::Check(schema_node_of(inner), filter))
}

/// The thrown SchemaError of a failed synchronous decode: a runtime Error named SchemaError (effect's is a
/// yieldable non-Error object; `.message` and `.name` agree).
pub fn schema_throw(message: JsString) -> ! {
    throw_value(error_new("SchemaError", message))
}

/// The failure value of `decodeUnknownEffect`/`Exit`: a kernel data handle whose `.message` is the issue text.
pub fn schema_error_handle(message: JsString) -> JsEffect {
    effect_new(EffectNode::Data(KernelData::SchemaError(message)))
}

pub fn schema_error_message(handle: &JsEffect) -> JsString {
    handle.with(|data| match &data.node {
        EffectNode::Data(KernelData::SchemaError(message))
        | EffectNode::Data(KernelData::SqlError(message))
        | EffectNode::Data(KernelData::Unknown(message)) => message.clone(),
        _ => throw_error("scriptc: a SchemaError handle was expected".to_owned()),
    })
}

/// `new SqlError({ reason: classifySqliteError(cause, { message }) })`: the wrapper effect's message is the reason's,
/// which is the classify option verbatim (effect derives `message`, `cause` and `isRetryable` from the reason).
pub fn effect_sql_error_handle(message: JsString) -> JsEffect {
    effect_new(EffectNode::Data(KernelData::SqlError(message)))
}

/// JS `Number(text)` for NumberFromString: trimmed, empty is 0, otherwise a decimal literal or NaN.
fn schema_string_to_number(text: &str) -> f64 {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return 0.0;
    }
    match trimmed {
        "Infinity" | "+Infinity" => f64::INFINITY,
        "-Infinity" => f64::NEG_INFINITY,
        _ => trimmed.parse::<f64>().ok().filter(|_| !trimmed.contains(['e', 'E']) || trimmed.contains(['.', 'e', 'E'])).unwrap_or(f64::NAN),
    }
}

enum PathSeg {
    Key(JsString),
    Index(usize),
}

struct Decoder<'a> {
    path: Vec<PathSeg>,
    _marker: std::marker::PhantomData<&'a ()>,
}

fn render_path(path: &[PathSeg]) -> String {
    let mut out = String::new();
    for seg in path {
        match seg {
            PathSeg::Key(key) => out.push_str(&format!("[{}]", json_stringify(&key.clone()))),
            PathSeg::Index(index) => out.push_str(&format!("[{index}]")),
        }
    }
    out
}

/// effect's issue formatter for the actual value: JSON for strings and compounds, plain numbers (NaN, Infinity, -0 → 0).
fn render_actual<T: ParseArgsValue + JsonValue>(value: &T) -> String {
    match value.parse_args_kind() {
        ParseArgsKind::Undefined => "undefined".to_owned(),
        ParseArgsKind::Null => "null".to_owned(),
        ParseArgsKind::Number => format_number(value.parse_args_number().unwrap_or(f64::NAN)),
        ParseArgsKind::Boolean => display_bool(value.parse_args_bool().unwrap_or(false)),
        ParseArgsKind::String | ParseArgsKind::Array | ParseArgsKind::Object => json_stringify(value).to_string(),
        ParseArgsKind::Other => value.parse_args_inspect_lite(),
    }
}

fn render_literal(literal: &SchemaLiteral) -> String {
    match literal {
        SchemaLiteral::Str(text) => json_stringify(text).to_string(),
        SchemaLiteral::Num(number) => format_number(*number),
        SchemaLiteral::Bool(flag) => display_bool(*flag),
    }
}

/// What a schema EXPECTS, as the formatter names it (`string`, `"a" | "b"`, `string | null`, `{ readonly "kind": "a", ... }`).
fn expected_of(node: &SchemaNode) -> String {
    match node {
        SchemaNode::Prim(prim) => match prim {
            SchemaPrim::String => "string",
            SchemaPrim::Number | SchemaPrim::Finite | SchemaPrim::Int => "number",
            SchemaPrim::Boolean => "boolean",
            SchemaPrim::Unknown | SchemaPrim::Any | SchemaPrim::Defect => "unknown",
            SchemaPrim::Json => "Json",
            SchemaPrim::Null => "null",
            SchemaPrim::Undefined => "undefined",
            SchemaPrim::NumberFromString => "string",
        }
        .to_owned(),
        SchemaNode::Literal(values) => values.iter().map(render_literal).collect::<Vec<_>>().join(" | "),
        SchemaNode::Struct(fields) => match fields.first() {
            Some(field) => format!("{{ readonly {}: {}, ... }}", json_stringify(&field.name), expected_of(&field.node)),
            None => "{}".to_owned(),
        },
        SchemaNode::Array(_) => "array".to_owned(),
        SchemaNode::FromJsonString(_) => "string".to_owned(),
        SchemaNode::DecodeTo(source, _, _) => expected_of(source),
        SchemaNode::Tuple(_) => "array".to_owned(),
        SchemaNode::Record(_, _) => "object".to_owned(),
        SchemaNode::Union(members) => members.iter().map(|m| expected_of(m)).collect::<Vec<_>>().join(" | "),
        SchemaNode::NullOr(inner) => format!("{} | null", expected_of(inner)),
        SchemaNode::UndefinedOr(inner) => format!("{} | undefined", expected_of(inner)),
        SchemaNode::OptionalKey(inner) | SchemaNode::Check(inner, _) => expected_of(inner),
        SchemaNode::Filter(_) => "unknown".to_owned(),
        SchemaNode::Named(name, _) => name.to_string(),
        SchemaNode::Tag(literal) => render_literal(literal),
    }
}

/// The name a node's OWN type mismatch reports (a struct or record says `object`, an array `array`).
fn own_expected(node: &SchemaNode) -> String {
    match node {
        SchemaNode::Struct(_) | SchemaNode::Record(_, _) => "object".to_owned(),
        SchemaNode::Array(_) => "array".to_owned(),
        _ => expected_of(node),
    }
}

fn filter_expected(filter: &SchemaFilter) -> String {
    match filter {
        SchemaFilter::StartsWith(text) => format!("a string starting with {}", json_stringify(text)),
        SchemaFilter::EndsWith(text) => format!("a string ending with {}", json_stringify(text)),
        SchemaFilter::Includes(text) => format!("a string including {}", json_stringify(text)),
        SchemaFilter::Gte(n) => format!("a value greater than or equal to {}", format_number(*n)),
        SchemaFilter::Lte(n) => format!("a value less than or equal to {}", format_number(*n)),
        SchemaFilter::Gt(n) => format!("a value greater than {}", format_number(*n)),
        SchemaFilter::Lt(n) => format!("a value less than {}", format_number(*n)),
        SchemaFilter::MinLength(n) => format!("a value with a length of at least {}", format_number(*n)),
        SchemaFilter::MaxLength(n) => format!("a value with a length of at most {}", format_number(*n)),
        SchemaFilter::Int => "an integer".to_owned(),
        SchemaFilter::Finite => "a finite number".to_owned(),
        SchemaFilter::Pattern(source, _) => format!("a string matching the RegExp {source}"),
        SchemaFilter::Between(min, max) => format!("a value between {} and {}", format_number(*min), format_number(*max)),
    }
}

fn filter_holds<T: ParseArgsValue>(filter: &SchemaFilter, value: &T) -> bool {
    let text = || value.parse_args_string().map(|s| s.to_string()).unwrap_or_default();
    let number = || value.parse_args_number().unwrap_or(f64::NAN);
    let length = || match value.parse_args_kind() {
        ParseArgsKind::String => value.parse_args_string().map(|s| s.chars().count()).unwrap_or(0) as f64,
        ParseArgsKind::Array => value.parse_args_array_len().unwrap_or(0) as f64,
        _ => 0.0,
    };
    match filter {
        SchemaFilter::StartsWith(prefix) => text().starts_with(&**prefix),
        SchemaFilter::EndsWith(suffix) => text().ends_with(&**suffix),
        SchemaFilter::Includes(part) => text().contains(&**part),
        SchemaFilter::Gte(n) => number() >= *n,
        SchemaFilter::Lte(n) => number() <= *n,
        SchemaFilter::Gt(n) => number() > *n,
        SchemaFilter::Lt(n) => number() < *n,
        SchemaFilter::MinLength(n) => length() >= *n,
        SchemaFilter::MaxLength(n) => length() <= *n,
        SchemaFilter::Int => number().fract() == 0.0 && number().is_finite(),
        SchemaFilter::Finite => number().is_finite(),
        SchemaFilter::Pattern(source, flags) => regex_test(&regex_new(source, flags), &string(&text())),
        SchemaFilter::Between(min, max) => number() >= *min && number() <= *max,
    }
}

impl Decoder<'_> {
    fn issue<T: ParseArgsValue + JsonValue>(&self, expected: &str, actual: &T) -> String {
        self.at(format!("Expected {expected}, got {}", render_actual(actual)))
    }

    fn at(&self, message: String) -> String {
        if self.path.is_empty() { message } else { format!("{message}\n  at {}", render_path(&self.path)) }
    }

    fn decode_json_value<T: ParseArgsValue + JsonValue>(&mut self, input: &T) -> Result<T, String> {
        match input.parse_args_kind() {
            ParseArgsKind::Null | ParseArgsKind::Number | ParseArgsKind::Boolean | ParseArgsKind::String => Ok(input.clone()),
            ParseArgsKind::Array => {
                let length = input.parse_args_array_len().unwrap_or(0);
                for index in 0..length {
                    self.path.push(PathSeg::Index(index));
                    let item = input.parse_args_array_get(index).unwrap_or_else(T::parse_args_undefined);
                    let result = self.decode_json_value(&item);
                    self.path.pop();
                    result?;
                }
                Ok(input.clone())
            }
            ParseArgsKind::Object => {
                for (name, value) in input.parse_args_object_entries().unwrap_or_default() {
                    self.path.push(PathSeg::Key(name.clone()));
                    let result = self.decode_json_value(&value);
                    self.path.pop();
                    result?;
                }
                Ok(input.clone())
            }
            ParseArgsKind::Undefined | ParseArgsKind::Other => Err(self.issue("Json", input)),
        }
    }

    fn decode<T: ParseArgsValue + JsonValue>(&mut self, node: &SchemaNode, input: &T) -> Result<T, String> {
        let kind = input.parse_args_kind();
        match node {
            SchemaNode::Prim(prim) => match prim {
                SchemaPrim::Unknown | SchemaPrim::Any | SchemaPrim::Defect => Ok(input.clone()),
                SchemaPrim::Json => self.decode_json_value(input),
                SchemaPrim::String if kind == ParseArgsKind::String => Ok(input.clone()),
                SchemaPrim::Number if kind == ParseArgsKind::Number => Ok(input.clone()),
                SchemaPrim::Boolean if kind == ParseArgsKind::Boolean => Ok(input.clone()),
                SchemaPrim::Null if kind == ParseArgsKind::Null => Ok(input.clone()),
                SchemaPrim::Undefined if kind == ParseArgsKind::Undefined => Ok(input.clone()),
                SchemaPrim::Finite | SchemaPrim::Int if kind == ParseArgsKind::Number => {
                    let filter = if *prim == SchemaPrim::Int { SchemaFilter::Int } else { SchemaFilter::Finite };
                    if filter_holds(&filter, input) { Ok(input.clone()) } else { Err(self.issue(&filter_expected(&filter), input)) }
                }
                SchemaPrim::NumberFromString if kind == ParseArgsKind::String => {
                    let text = input.parse_args_string().unwrap_or_else(empty_string);
                    Ok(T::parse_args_number_value(schema_string_to_number(&text)))
                }
                _ => Err(self.issue(&expected_of(node), input)),
            },
            SchemaNode::DecodeTo(source, target, transform) => {
                let decoded = self.decode(source, input)?;
                let transformed = transform(Rc::new(decoded) as EffectValue);
                match transformed.downcast_ref::<T>() {
                    Some(value) => self.decode(target, value),
                    None => Err(self.at("scriptc: a schema transform answered a foreign value".to_owned())),
                }
            }
            SchemaNode::FromJsonString(inner) => {
                if kind != ParseArgsKind::String {
                    return Err(self.issue("string", input));
                }
                let text = input.parse_args_string().unwrap_or_else(empty_string);
                match json_parse_node(&text) {
                    Ok(parsed) => self.decode(inner, &json_node_to_value::<T>(&parsed)),
                    Err(message) => Err(self.at(message)),
                }
            }
            SchemaNode::Tuple(elements) => {
                let Some(len) = input.parse_args_array_len() else {
                    return Err(self.issue("array", input));
                };
                // effect reports a SHORT tuple as a missing key at the index and a LONG one as an unexpected key.
                if len > elements.len() {
                    let extra = input.parse_args_array_get(elements.len()).unwrap_or_else(T::parse_args_undefined);
                    self.path.push(PathSeg::Index(elements.len()));
                    let message = self.at(format!("Unexpected key with value {}", render_actual(&extra)));
                    self.path.pop();
                    return Err(message);
                }
                let out = T::parse_args_array_value();
                for (index, element) in elements.iter().enumerate() {
                    self.path.push(PathSeg::Index(index));
                    let decoded = match input.parse_args_array_get(index) {
                        Some(item) => self.decode(element, &item),
                        None => Err(self.at("Missing key".to_owned())),
                    };
                    self.path.pop();
                    out.parse_args_array_push(decoded?);
                }
                Ok(out)
            }
            SchemaNode::Literal(values) => {
                let matches = values.iter().any(|literal| match literal {
                    SchemaLiteral::Str(text) => input.parse_args_string().is_some_and(|s| *s == **text),
                    SchemaLiteral::Num(n) => input.parse_args_number() == Some(*n),
                    SchemaLiteral::Bool(b) => input.parse_args_bool() == Some(*b),
                });
                if matches { Ok(input.clone()) } else { Err(self.issue(&expected_of(node), input)) }
            }
            SchemaNode::Struct(fields) => {
                if kind != ParseArgsKind::Object {
                    return Err(self.issue("object", input));
                }
                let entries = input.parse_args_object_entries().unwrap_or_default();
                let output = T::parse_args_object_value();
                for field in fields {
                    let present = entries.iter().find(|(name, _)| **name == *field.name).map(|(_, value)| value.clone());
                    let (optional, node) = match &*field.node {
                        SchemaNode::OptionalKey(inner) => (true, inner.clone()),
                        SchemaNode::Named(_, inner) if matches!(&**inner, SchemaNode::OptionalKey(_)) => match &**inner { SchemaNode::OptionalKey(key) => (true, key.clone()), _ => unreachable!() },
                        _ => (false, field.node.clone()),
                    };
                    match present {
                        None if optional => {}
                        None => {
                            self.path.push(PathSeg::Key(field.name.clone()));
                            let message = format!("Missing key\n  at {}", render_path(&self.path));
                            self.path.pop();
                            return Err(message);
                        }
                        Some(value) => {
                            self.path.push(PathSeg::Key(field.name.clone()));
                            let decoded = self.decode(&node, &value)?;
                            self.path.pop();
                            output.parse_args_object_set(field.name.clone(), decoded);
                        }
                    }
                }
                Ok(output)
            }
            SchemaNode::Array(item) => {
                if kind != ParseArgsKind::Array {
                    return Err(self.issue("array", input));
                }
                let output = T::parse_args_array_value();
                let len = input.parse_args_array_len().unwrap_or(0);
                for index in 0..len {
                    let element = input.parse_args_array_get(index).unwrap_or_else(T::parse_args_undefined);
                    self.path.push(PathSeg::Index(index));
                    let decoded = self.decode(item, &element)?;
                    self.path.pop();
                    output.parse_args_array_push(decoded);
                }
                Ok(output)
            }
            SchemaNode::Record(key, value) => {
                if kind != ParseArgsKind::Object {
                    return Err(self.issue("object", input));
                }
                let output = T::parse_args_object_value();
                for (name, entry) in input.parse_args_object_entries().unwrap_or_default() {
                    self.path.push(PathSeg::Key(name.clone()));
                    let key_value = T::parse_args_string_value(name.clone());
                    self.decode(key, &key_value)?;
                    let decoded = self.decode(value, &entry)?;
                    self.path.pop();
                    output.parse_args_object_set(name, decoded);
                }
                Ok(output)
            }
            SchemaNode::Union(members) => {
                // A literal discriminator picks the member whose issues are reported (effect's candidate rule).
                if kind == ParseArgsKind::Object {
                    let entries = input.parse_args_object_entries().unwrap_or_default();
                    for member in members {
                        if let SchemaNode::Struct(fields) = &**member {
                            let discriminated = fields.iter().any(|field| matches!(&*field.node, SchemaNode::Literal(values) if entries.iter().any(|(name, value)| *name == field.name && values.iter().any(|literal| match literal {
                                SchemaLiteral::Str(text) => value.parse_args_string().is_some_and(|s| *s == **text),
                                SchemaLiteral::Num(n) => value.parse_args_number() == Some(*n),
                                SchemaLiteral::Bool(b) => value.parse_args_bool() == Some(*b),
                            }))));
                            if discriminated {
                                return self.decode(member, input);
                            }
                        }
                    }
                }
                let depth = self.path.len();
                for member in members {
                    if let Ok(value) = self.decode(member, input) {
                        return Ok(value);
                    }
                    self.path.truncate(depth);
                }
                Err(self.issue(&expected_of(node), input))
            }
            SchemaNode::NullOr(inner) => {
                if kind == ParseArgsKind::Null { Ok(input.clone()) } else { self.decode(inner, input).map_err(|_| self.issue(&expected_of(node), input)) }
            }
            SchemaNode::UndefinedOr(inner) => {
                if kind == ParseArgsKind::Undefined { Ok(input.clone()) } else { self.decode(inner, input).map_err(|_| self.issue(&expected_of(node), input)) }
            }
            SchemaNode::OptionalKey(inner) => self.decode(inner, input),
            SchemaNode::Named(_, inner) => {
                let depth = self.path.len();
                self.decode(inner, input).map_err(|message| {
                    // The named schema's own type mismatch reports the NAME; nested issues keep their own text.
                    if self.path.len() == depth && message.starts_with(&format!("Expected {}, ", own_expected(inner))) { self.issue(&expected_of(node), input) } else { message }
                })
            }
            SchemaNode::Check(inner, filter) => {
                let value = self.decode(inner, input)?;
                if filter_holds(filter, &value) { Ok(value) } else { Err(self.issue(&filter_expected(filter), &value)) }
            }
            SchemaNode::Filter(_) => Ok(input.clone()),
            SchemaNode::Tag(literal) => self.decode(&SchemaNode::Literal(vec![literal.clone()]), input),
        }
    }
}

/// Decodes `input` against the schema: the decoded dynamic value (fresh objects/arrays holding only the declared
/// keys), or the issue message.
pub fn schema_decode<T: ParseArgsValue + JsonValue>(schema: &JsEffect, input: &T) -> Result<T, JsString> {
    let node = schema_node_of(schema);
    let mut decoder = Decoder { path: Vec::new(), _marker: std::marker::PhantomData };
    decoder.decode(&node, input).map_err(JsString::from)
}

/// `S.make(props)`: the props with a Struct's constructor defaults applied (a `tag` field absent from the props is
/// filled with its literal); other schemas answer the props unchanged. The caller converts the result to the Type.
pub fn schema_make<T: ParseArgsValue + JsonValue>(schema: &JsEffect, props: &T) -> T {
    fn tag_value<T: ParseArgsValue>(literal: &SchemaLiteral) -> T {
        match literal {
            SchemaLiteral::Str(text) => T::parse_args_string_value(text.clone()),
            SchemaLiteral::Num(n) => T::parse_args_number_value(*n),
            SchemaLiteral::Bool(b) => T::parse_args_bool_value(*b),
        }
    }
    let mut node = schema_node_of(schema);
    while let SchemaNode::Named(_, inner) | SchemaNode::Check(inner, _) = &*node {
        node = inner.clone();
    }
    let SchemaNode::Struct(fields) = &*node else { return props.clone() };
    if props.parse_args_kind() != ParseArgsKind::Object {
        return props.clone();
    }
    let entries = props.parse_args_object_entries().unwrap_or_default();
    let output = T::parse_args_object_value();
    for (name, value) in &entries {
        output.parse_args_object_set(name.clone(), value.clone());
    }
    for field in fields {
        if let SchemaNode::Tag(literal) = &*field.node {
            // Absent, or present as `undefined` (a compiled record fills an optional key it was not given).
            let given = entries.iter().any(|(name, value)| **name == *field.name && value.parse_args_kind() != ParseArgsKind::Undefined);
            if !given {
                output.parse_args_object_set(field.name.clone(), tag_value::<T>(literal));
            }
        }
    }
    output
}
