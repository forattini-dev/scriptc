// effect's `JsonSchema.fromSchemaOpenApi3_0` / `fromSchemaOpenApi3_1` / `fromSchemaDraft07` / `fromSchemaDraft2020_12`:
// a faithful port of effect 4's JsonSchema.js over the program's dynamic value (the `ParseArgsValue` view every
// program's dyn enum implements). Key order follows JS (`map_string_entries_js_order`), unknown Draft-07 keywords drop
// exactly as effect drops them, and untouched sub-values are shared, never re-encoded. The result is the
// `{ dialect, schema, definitions }` document the site converts to its checker-typed shape.

fn js_is_object<T: ParseArgsValue>(value: &T) -> bool {
    value.parse_args_kind() == ParseArgsKind::Object
}

fn js_is_array<T: ParseArgsValue>(value: &T) -> bool {
    value.parse_args_kind() == ParseArgsKind::Array
}

fn js_entries<T: ParseArgsValue>(object: &T) -> Vec<(JsString, T)> {
    object.parse_args_object_entries().unwrap_or_default()
}

fn js_elements<T: ParseArgsValue>(array: &T) -> Vec<T> {
    (0..array.parse_args_array_len().unwrap_or(0))
        .filter_map(|index| array.parse_args_array_get(index))
        .collect()
}

fn js_new_array<T: ParseArgsValue>(values: impl IntoIterator<Item = T>) -> T {
    let array = T::parse_args_array_value();
    for value in values {
        array.parse_args_array_push(value);
    }
    array
}

fn js_str<T: ParseArgsValue>(value: &str) -> T {
    T::parse_args_string_value(string(value))
}

/// `{ ...object }` with `key` assigned (replaced in place when present, appended otherwise) and `skip` removed.
fn js_copy_with<T: ParseArgsValue>(object: &T, replace: Option<(&str, T)>, skip: &[&str]) -> T {
    let out = T::parse_args_object_value();
    let mut replaced = replace.is_none();
    let replace = replace.map(|(key, value)| (string(key), value));
    for (key, value) in js_entries(object) {
        if skip.contains(&{ let text: &str = key.as_ref(); text }) {
            continue;
        }
        match &replace {
            Some((target, new_value)) if target.as_ref() == key.as_ref() => {
                out.parse_args_object_set(key, new_value.clone());
                replaced = true;
            }
            _ => out.parse_args_object_set(key, value),
        }
    }
    if !replaced {
        if let Some((key, value)) = replace {
            if !skip.contains(&{ let text: &str = key.as_ref(); text }) {
                out.parse_args_object_set(key, value);
            }
        }
    }
    out
}

fn js_member<T: ParseArgsValue>(object: &T, key: &str) -> Option<T> {
    js_entries(object)
        .into_iter()
        .find_map(|(name, value)| (name.as_ref() == key).then_some(value))
        .filter(|value| value.parse_args_kind() != ParseArgsKind::Undefined)
}

/// `str.replace(/^<prefix>(?=\/|$)/, replacement)`.
fn js_replace_ref_prefix(text: &str, prefix: &str, replacement: &str) -> String {
    match text.strip_prefix(prefix) {
        Some(rest) if rest.is_empty() || rest.starts_with('/') => format!("{replacement}{rest}"),
        _ => text.to_owned(),
    }
}

fn js_rewrite_refs<T: ParseArgsValue>(node: &T, rewrite: &dyn Fn(&str) -> String) -> T {
    if js_is_array(node) {
        return js_new_array(js_elements(node).iter().map(|value| js_rewrite_refs(value, rewrite)));
    }
    if !js_is_object(node) {
        return node.clone();
    }
    let out = T::parse_args_object_value();
    for (key, value) in js_entries(node) {
        let next = if key.as_ref() == "$ref" {
            match value.parse_args_string() {
                Some(text) => js_str(&rewrite(text.as_ref())),
                None => value,
            }
        } else if js_is_array(&value) || js_is_object(&value) {
            js_rewrite_refs(&value, rewrite)
        } else {
            value
        };
        out.parse_args_object_set(key, next);
    }
    out
}

fn js_walk_object<T: ParseArgsValue>(value: &T, walk: &mut dyn FnMut(&T, bool) -> T) -> Option<T> {
    if !js_is_object(value) {
        return None;
    }
    let out = T::parse_args_object_value();
    for (key, item) in js_entries(value) {
        let mapped = walk(&item, false);
        out.parse_args_object_set(key, mapped);
    }
    Some(out)
}

const JSON_SCHEMA_DRAFT07_COPIED: &[&str] = &[
    "type", "required", "enum", "const", "title", "description", "default", "examples", "format", "readOnly",
    "writeOnly", "pattern", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "minLength", "maxLength",
    "minItems", "maxItems", "minProperties", "maxProperties", "multipleOf", "uniqueItems",
];

fn js_draft07_walk<T: ParseArgsValue>(node: &T, is_root: bool, definitions: &mut Option<T>) -> T {
    if js_is_array(node) {
        return js_new_array(js_elements(node).iter().map(|value| js_draft07_walk(value, false, definitions)));
    }
    if !js_is_object(node) {
        return node.clone();
    }
    let out = T::parse_args_object_value();
    let mut prefix_items: Option<T> = None;
    let mut additional_items: Option<T> = None;
    for (key, value) in js_entries(node) {
        let name: &str = key.as_ref();
        match name {
            "$ref" => {
                let next = match value.parse_args_string() {
                    Some(text) => js_str(&js_replace_ref_prefix(text.as_ref(), "#/definitions", "#/$defs")),
                    None => value,
                };
                out.parse_args_object_set(key, next);
            }
            "definitions" => {
                let mapped = js_walk_object(&value, &mut |item, _| js_draft07_walk(item, false, definitions));
                if is_root {
                    *definitions = mapped;
                } else {
                    out.parse_args_object_set(key, mapped.unwrap_or(value));
                }
            }
            "items" => prefix_items = Some(value),
            "additionalItems" => additional_items = Some(value),
            "properties" | "patternProperties" => {
                let mapped = js_walk_object(&value, &mut |item, _| js_draft07_walk(item, false, definitions));
                out.parse_args_object_set(key, mapped.unwrap_or(value));
            }
            "additionalProperties" | "propertyNames" => {
                let mapped = js_draft07_walk(&value, false, definitions);
                out.parse_args_object_set(key, mapped);
            }
            "allOf" | "anyOf" | "oneOf" => {
                let next = if js_is_array(&value) {
                    js_new_array(js_elements(&value).iter().map(|item| js_draft07_walk(item, false, definitions)))
                } else {
                    value
                };
                out.parse_args_object_set(key, next);
            }
            other if JSON_SCHEMA_DRAFT07_COPIED.contains(&other) => out.parse_args_object_set(key, value),
            _ => {}
        }
    }
    // Draft-07 tuples -> 2020-12 tuples.
    if let Some(prefix) = prefix_items {
        if js_is_array(&prefix) {
            let mapped = js_new_array(js_elements(&prefix).iter().map(|item| js_draft07_walk(item, false, definitions)));
            out.parse_args_object_set(string("prefixItems"), mapped);
            if let Some(additional) = additional_items {
                let walked = js_draft07_walk(&additional, false, definitions);
                out.parse_args_object_set(string("items"), walked);
            }
        } else {
            let walked = js_draft07_walk(&prefix, false, definitions);
            out.parse_args_object_set(string("items"), walked);
        }
    }
    out
}

fn js_document<T: ParseArgsValue>(schema: T, definitions: T) -> T {
    let document = T::parse_args_object_value();
    document.parse_args_object_set(string("dialect"), js_str("draft-2020-12"));
    document.parse_args_object_set(string("schema"), schema);
    document.parse_args_object_set(string("definitions"), definitions);
    document
}

pub fn json_schema_from_draft07<T: ParseArgsValue>(schema: &T) -> T {
    let mut definitions: Option<T> = None;
    let walked = js_draft07_walk(schema, true, &mut definitions);
    js_document(walked, definitions.unwrap_or_else(T::parse_args_object_value))
}

pub fn json_schema_from_draft2020_12<T: ParseArgsValue>(schema: &T) -> T {
    let defs = js_member(schema, "$defs");
    let rest = js_copy_with(schema, None, &["$defs"]);
    let definitions = match defs {
        Some(value) if js_is_object(&value) => value,
        _ => T::parse_args_object_value(),
    };
    js_document(rest, definitions)
}

pub fn json_schema_from_openapi3_1<T: ParseArgsValue>(schema: &T) -> T {
    let rewritten = js_rewrite_refs(schema, &|reference| js_replace_ref_prefix(reference, "#/components/schemas", "#/$defs"));
    json_schema_from_draft2020_12(&rewritten)
}

fn js_null_element<T: ParseArgsValue>(array: &T) -> bool {
    js_elements(array).iter().any(|item| item.parse_args_kind() == ParseArgsKind::Null)
}

fn js_string_element<T: ParseArgsValue>(array: &T, text: &str) -> bool {
    js_elements(array)
        .iter()
        .any(|item| item.parse_args_string().is_some_and(|value| value.as_ref() == text))
}

fn js_widen_type<T: ParseArgsValue>(node: &T) -> T {
    let Some(kind) = js_member(node, "type") else { return node.clone() };
    if let Some(text) = kind.parse_args_string() {
        if text.as_ref() == "null" {
            return node.clone();
        }
        return js_copy_with(node, Some(("type", js_new_array([js_str(text.as_ref()), js_str("null")]))), &[]);
    }
    if js_is_array(&kind) {
        if js_string_element(&kind, "null") {
            return node.clone();
        }
        let mut items = js_elements(&kind);
        items.push(js_str("null"));
        return js_copy_with(node, Some(("type", js_new_array(items))), &[]);
    }
    node.clone()
}

fn js_apply_nullable<T: ParseArgsValue>(node: &T) -> T {
    if let Some(values) = js_member(node, "enum").filter(|value| js_is_array(value)) {
        let widened = if js_null_element(&values) {
            values
        } else {
            let mut items = js_elements(&values);
            items.push(T::parse_args_null_value());
            js_new_array(items)
        };
        return js_widen_type(&js_copy_with(node, Some(("enum", widened)), &[]));
    }
    if js_member(node, "type").is_some() {
        return js_widen_type(node);
    }
    if js_member(node, "const").is_some_and(|value| value.parse_args_kind() == ParseArgsKind::Null) {
        return node.clone();
    }
    let null_schema = T::parse_args_object_value();
    null_schema.parse_args_object_set(string("type"), js_str("null"));
    let out = T::parse_args_object_value();
    out.parse_args_object_set(string("anyOf"), js_new_array([node.clone(), null_schema]));
    out
}

fn js_adjust_exclusivity<T: ParseArgsValue>(node: T) -> T {
    let mut out = node;
    for (flag, bound) in [("exclusiveMinimum", "minimum"), ("exclusiveMaximum", "maximum")] {
        let Some(value) = js_member(&out, flag).filter(|value| value.parse_args_kind() == ParseArgsKind::Boolean) else {
            continue;
        };
        let limit = js_member(&out, bound).filter(|limit| limit.parse_args_kind() == ParseArgsKind::Number);
        out = match (value.parse_args_bool(), limit) {
            (Some(true), Some(limit)) => js_copy_with(&out, Some((flag, limit)), &[bound]),
            _ => js_copy_with(&out, None, &[flag]),
        };
    }
    out
}

fn js_normalize_openapi3_0<T: ParseArgsValue>(node: &T) -> T {
    if js_is_array(node) {
        return js_new_array(js_elements(node).iter().map(js_normalize_openapi3_0));
    }
    if !js_is_object(node) {
        return node.clone();
    }
    let has_examples = js_member(node, "examples").is_some();
    let mut out = T::parse_args_object_value();
    for (key, value) in js_entries(node) {
        let name: &str = key.as_ref();
        if name == "$ref" && value.parse_args_string().is_some() {
            let text = value.parse_args_string().expect("checked string");
            out.parse_args_object_set(key, js_str(&js_replace_ref_prefix(text.as_ref(), "#/components/schemas", "#/definitions")));
        } else if name == "example" {
            if !has_examples {
                out.parse_args_object_set(string("examples"), js_new_array([value]));
            }
        } else if js_is_array(&value) || js_is_object(&value) {
            out.parse_args_object_set(key, js_normalize_openapi3_0(&value));
        } else {
            out.parse_args_object_set(key, value);
        }
    }
    out = js_adjust_exclusivity(out);
    if js_member(&out, "nullable").is_some_and(|value| value.parse_args_bool() == Some(true)) {
        out = js_apply_nullable(&out);
    }
    js_copy_with(&out, None, &["nullable"])
}

pub fn json_schema_from_openapi3_0<T: ParseArgsValue>(schema: &T) -> T {
    let normalized = js_normalize_openapi3_0(schema);
    json_schema_from_draft07(&normalized)
}
