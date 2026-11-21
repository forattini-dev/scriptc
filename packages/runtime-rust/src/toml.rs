use toml_edit::{Array, ArrayOfTables, DocumentMut, InlineTable, Item, Table, Value};

fn toml_array(value: &Array) -> JsonNode {
    JsonNode::Array(value.iter().map(toml_value).collect())
}

fn toml_inline_table(value: &InlineTable) -> JsonNode {
    JsonNode::Object(
        value
            .iter()
            .map(|(name, value)| (name.into(), toml_value(value)))
            .collect(),
    )
}

fn toml_value(value: &Value) -> JsonNode {
    match value {
        Value::String(value) => JsonNode::String(value.value().as_str().into()),
        Value::Integer(value) => JsonNode::Number(*value.value() as f64),
        Value::Float(value) => JsonNode::Number(*value.value()),
        Value::Boolean(value) => JsonNode::Bool(*value.value()),
        Value::Datetime(value) => JsonNode::String(value.value().to_string().into()),
        Value::Array(value) => toml_array(value),
        Value::InlineTable(value) => toml_inline_table(value),
    }
}

fn toml_table(value: &Table) -> JsonNode {
    JsonNode::Object(
        value
            .iter()
            .filter_map(|(name, item)| toml_item(item).map(|value| (name.into(), value)))
            .collect(),
    )
}

fn toml_array_of_tables(value: &ArrayOfTables) -> JsonNode {
    JsonNode::Array(value.iter().map(toml_table).collect())
}

fn toml_item(value: &Item) -> Option<JsonNode> {
    match value {
        Item::None => None,
        Item::Value(value) => Some(toml_value(value)),
        Item::Table(value) => Some(toml_table(value)),
        Item::ArrayOfTables(value) => Some(toml_array_of_tables(value)),
    }
}

/// Parse Bun-compatible TOML data into the runtime's owning data tree. The
/// generated program converts that tree directly into its dynamic-value ABI.
pub fn toml_parse_node(source: &JsString) -> JsonNode {
    let source = source
        .well_formed_utf8()
        .unwrap_or_else(|| throw_syntax_error("TOML source contains invalid Unicode".into()));
    let document = source
        .parse::<DocumentMut>()
        .unwrap_or_else(|error| throw_syntax_error(error.to_string()));
    JsonNode::Object(
        document
            .iter()
            .filter_map(|(name, item)| toml_item(item).map(|value| (name.into(), value)))
            .collect(),
    )
}
