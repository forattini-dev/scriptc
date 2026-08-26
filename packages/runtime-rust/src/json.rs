pub fn number_to_string(value: f64) -> JsString {
    Rc::from(format_number(value))
}

pub fn number_is_integer(value: f64) -> bool {
    value.is_finite() && value.fract() == 0.0
}

pub fn number_is_safe_integer(value: f64) -> bool {
    number_is_integer(value) && value.abs() <= 9_007_199_254_740_991.0
}

pub fn bool_to_string(value: bool) -> JsString {
    string(if value { "true" } else { "false" })
}

pub trait JsonValue {
    fn write_json(&self, writer: &mut JsonWriter);

    fn is_json_undefined(&self) -> bool {
        false
    }
}

pub trait JsonObject: Trace + ClearEdges + 'static {
    const IS_ARRAY: bool = false;

    fn write_json_object(&self, writer: &mut JsonWriter);
}

enum JsonEdge {
    Property(String),
    Index(usize),
}

struct JsonSeen {
    identity: usize,
    is_array: bool,
    edge: Option<JsonEdge>,
}

pub struct JsonWriter {
    output: String,
    stack: Vec<JsonSeen>,
}

impl JsonWriter {
    fn new() -> Self {
        Self {
            output: String::new(),
            stack: Vec::new(),
        }
    }

    pub fn begin_array(&mut self) {
        self.output.push('[');
    }

    pub fn end_array(&mut self) {
        self.output.push(']');
    }

    pub fn begin_object(&mut self) {
        self.output.push('{');
    }

    pub fn end_object(&mut self) {
        self.output.push('}');
    }

    pub fn element<T: JsonValue>(&mut self, first: &mut bool, index: usize, value: &T) {
        if !*first {
            self.output.push(',');
        }
        *first = false;
        self.set_edge(JsonEdge::Index(index));
        value.write_json(self);
    }

    pub fn property<T: JsonValue>(&mut self, first: &mut bool, name: &str, value: &T) {
        if value.is_json_undefined() {
            return;
        }
        if !*first {
            self.output.push(',');
        }
        *first = false;
        self.write_string(name);
        self.output.push(':');
        self.set_edge(JsonEdge::Property(name.to_owned()));
        value.write_json(self);
    }

    fn set_edge(&mut self, edge: JsonEdge) {
        if let Some(container) = self.stack.last_mut() {
            container.edge = Some(edge);
        }
    }

    fn circular_message(&self, start: usize) -> String {
        let mut message = String::from("Converting circular structure to JSON\n    --> starting at ");
        push_json_constructor(&mut message, self.stack[start].is_array);
        let end = self.stack.len();
        let hops = end - 1 - start;
        if hops <= 3 {
            for index in start + 1..end {
                push_json_hop(&mut message, &self.stack, index);
            }
        } else {
            push_json_hop(&mut message, &self.stack, start + 1);
            push_json_hop(&mut message, &self.stack, start + 2);
            message.push_str("\n    |     ...");
            push_json_hop(&mut message, &self.stack, end - 1);
        }
        message.push_str("\n    --- ");
        push_json_edge(
            &mut message,
            self.stack[end - 1]
                .edge
                .as_ref()
                .expect("scriptc: circular JSON edge was not recorded"),
        );
        message.push_str(" closes the circle");
        message
    }

    pub fn write_null(&mut self) {
        self.output.push_str("null");
    }

    fn write_string(&mut self, value: &str) {
        self.output.push('"');
        for ch in value.chars() {
            match ch {
                '"' => self.output.push_str("\\\""),
                '\\' => self.output.push_str("\\\\"),
                '\u{0008}' => self.output.push_str("\\b"),
                '\u{000c}' => self.output.push_str("\\f"),
                '\n' => self.output.push_str("\\n"),
                '\r' => self.output.push_str("\\r"),
                '\t' => self.output.push_str("\\t"),
                '\u{0000}'..='\u{001f}' => {
                    self.output.push_str(&format!("\\u{:04x}", ch as u32));
                }
                _ => self.output.push(ch),
            }
        }
        self.output.push('"');
    }
}

fn push_json_edge(output: &mut String, edge: &JsonEdge) {
    match edge {
        JsonEdge::Property(name) => {
            output.push_str("property '");
            output.push_str(name);
            output.push('\'');
        }
        JsonEdge::Index(index) => {
            output.push_str("index ");
            output.push_str(&index.to_string());
        }
    }
}

fn push_json_constructor(output: &mut String, is_array: bool) {
    output.push_str(if is_array {
        "object with constructor 'Array'"
    } else {
        "object with constructor 'Object'"
    });
}

fn push_json_hop(output: &mut String, stack: &[JsonSeen], index: usize) {
    output.push_str("\n    |     ");
    push_json_edge(
        output,
        stack[index - 1]
            .edge
            .as_ref()
            .expect("scriptc: circular JSON edge was not recorded"),
    );
    output.push_str(" -> ");
    push_json_constructor(output, stack[index].is_array);
}

impl JsonValue for f64 {
    fn write_json(&self, writer: &mut JsonWriter) {
        if self.is_finite() {
            writer.output.push_str(&format_number(*self));
        } else {
            writer.write_null();
        }
    }
}

impl JsonValue for bool {
    fn write_json(&self, writer: &mut JsonWriter) {
        writer.output.push_str(if *self { "true" } else { "false" });
    }
}

impl JsonValue for JsString {
    fn write_json(&self, writer: &mut JsonWriter) {
        writer.write_string(self);
    }
}

impl<T> JsonValue for Gc<T>
where
    T: JsonObject,
{
    fn write_json(&self, writer: &mut JsonWriter) {
        let id = self.identity();
        if let Some(start) = writer.stack.iter().position(|entry| entry.identity == id) {
            throw_type_error(writer.circular_message(start));
        }
        writer.stack.push(JsonSeen {
            identity: id,
            is_array: T::IS_ARRAY,
            edge: None,
        });
        self.with(|value| value.write_json_object(writer));
        let entry = writer
            .stack
            .pop()
            .expect("scriptc: JSON container stack underflow");
        assert_eq!(entry.identity, id);
    }
}

impl<T> JsonObject for ArrayData<T>
where
    T: ArrayElement + JsonValue,
{
    const IS_ARRAY: bool = true;

    fn write_json_object(&self, writer: &mut JsonWriter) {
        writer.begin_array();
        let mut first = true;
        for (index, value) in self.elements.iter().enumerate() {
            writer.element(&mut first, index, value);
        }
        writer.end_array();
    }
}

impl<V> JsonObject for MapData<JsString, V>
where
    V: HeapValue + JsonValue,
{
    fn write_json_object(&self, writer: &mut JsonWriter) {
        writer.begin_object();
        let mut first = true;
        for position in map_string_entry_order(self) {
            let (key, value) = self.entries[position]
                .as_ref()
                .expect("scriptc: ordered JSON property points at a tombstone");
            writer.property(&mut first, key, value);
        }
        writer.end_object();
    }
}

pub fn json_write_map_properties<V>(
    writer: &mut JsonWriter,
    first: &mut bool,
    map: &JsMap<JsString, V>,
) where
    V: HeapValue + JsonValue,
{
    map.with(|data| {
        for position in map_string_entry_order(data) {
            let (key, value) = data.entries[position]
                .as_ref()
                .expect("scriptc: ordered JSON property points at a tombstone");
            writer.property(first, key, value);
        }
    });
}

pub fn json_stringify<T: JsonValue>(value: &T) -> JsString {
    let mut writer = JsonWriter::new();
    value.write_json(&mut writer);
    Rc::from(writer.output)
}

pub fn json_stringify_indented<T: JsonValue>(value: &T, indent: &str) -> JsString {
    let compact = json_stringify(value);
    if indent.is_empty() {
        return compact;
    }
    let mut output = String::with_capacity(compact.len() + indent.len() * 4);
    let mut chars = compact.chars().peekable();
    let mut depth = 0_usize;
    let mut in_string = false;
    let mut escaped = false;
    while let Some(ch) = chars.next() {
        if in_string {
            output.push(ch);
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == '"' {
                in_string = false;
            }
            continue;
        }
        match ch {
            '"' => {
                in_string = true;
                output.push(ch);
            }
            '{' | '[' => {
                output.push(ch);
                depth += 1;
                let close = if ch == '{' { '}' } else { ']' };
                if chars.peek() != Some(&close) {
                    output.push('\n');
                    output.push_str(&indent.repeat(depth));
                }
            }
            '}' | ']' => {
                depth = depth
                    .checked_sub(1)
                    .expect("scriptc: malformed compact JSON nesting");
                let open = if ch == '}' { '{' } else { '[' };
                if !output.ends_with(open) {
                    output.push('\n');
                    output.push_str(&indent.repeat(depth));
                }
                output.push(ch);
            }
            ',' => {
                output.push(',');
                output.push('\n');
                output.push_str(&indent.repeat(depth));
            }
            ':' => output.push_str(": "),
            _ => output.push(ch),
        }
    }
    Rc::from(output)
}

pub enum JsonNode {
    Null,
    Bool(bool),
    Number(f64),
    String(JsString),
    Array(Vec<JsonNode>),
    Object(Vec<(String, JsonNode)>),
}

impl JsonNode {
    fn kind(&self) -> &'static str {
        match self {
            Self::Null => "null",
            Self::Bool(_) => "boolean",
            Self::Number(_) => "number",
            Self::String(_) => "string",
            Self::Array(_) => "array",
            Self::Object(_) => "object",
        }
    }
}

pub trait JsonDecode: Sized {
    fn decode_json(node: &JsonNode, path: &str) -> Result<Self, String>;
}

pub trait JsonObjectDecode: Trace + ClearEdges + Sized + 'static {
    fn decode_json_object(node: &JsonNode, path: &str) -> Result<Self, String>;
}

pub fn json_type_error(path: &str, expected: &str, node: &JsonNode) -> String {
    format!("expected {expected} at {path}, got {}", node.kind())
}

pub fn json_property_path(path: &str, property: &str) -> String {
    format!("{path}.{property}")
}

pub fn json_index_path(path: &str, index: usize) -> String {
    format!("{path}[{index}]")
}

pub fn json_expect_object<'a>(
    node: &'a JsonNode,
    path: &str,
) -> Result<&'a [(String, JsonNode)], String> {
    match node {
        JsonNode::Object(fields) => Ok(fields),
        _ => Err(json_type_error(path, "object", node)),
    }
}

pub fn json_expect_array<'a>(node: &'a JsonNode, path: &str) -> Result<&'a [JsonNode], String> {
    match node {
        JsonNode::Array(elements) => Ok(elements),
        _ => Err(json_type_error(path, "array", node)),
    }
}

pub fn json_object_field<'a>(object: &'a [(String, JsonNode)], name: &str) -> Option<&'a JsonNode> {
    object
        .iter()
        .rev()
        .find_map(|(key, value)| (key == name).then_some(value))
}

pub fn json_required_field<'a>(
    object: &'a [(String, JsonNode)],
    name: &str,
    path: &str,
) -> Result<&'a JsonNode, String> {
    json_object_field(object, name).ok_or_else(|| format!("expected property '{}' at {path}", name))
}

impl JsonDecode for f64 {
    fn decode_json(node: &JsonNode, path: &str) -> Result<Self, String> {
        match node {
            JsonNode::Number(value) => Ok(*value),
            _ => Err(json_type_error(path, "number", node)),
        }
    }
}

impl JsonDecode for bool {
    fn decode_json(node: &JsonNode, path: &str) -> Result<Self, String> {
        match node {
            JsonNode::Bool(value) => Ok(*value),
            _ => Err(json_type_error(path, "boolean", node)),
        }
    }
}

impl JsonDecode for JsString {
    fn decode_json(node: &JsonNode, path: &str) -> Result<Self, String> {
        match node {
            JsonNode::String(value) => Ok(value.clone()),
            _ => Err(json_type_error(path, "string", node)),
        }
    }
}

impl<T> JsonDecode for Gc<T>
where
    T: JsonObjectDecode,
{
    fn decode_json(node: &JsonNode, path: &str) -> Result<Self, String> {
        Ok(Gc::new(T::decode_json_object(node, path)?))
    }
}

impl<T> JsonObjectDecode for ArrayData<T>
where
    T: ArrayElement + JsonDecode,
{
    fn decode_json_object(node: &JsonNode, path: &str) -> Result<Self, String> {
        let elements = json_expect_array(node, path)?;
        let mut decoded = Vec::with_capacity(elements.len());
        for (index, element) in elements.iter().enumerate() {
            decoded.push(T::decode_json(element, &json_index_path(path, index))?);
        }
        Ok(Self { elements: decoded })
    }
}

impl<V> JsonObjectDecode for MapData<JsString, V>
where
    V: HeapValue + JsonDecode,
{
    fn decode_json_object(node: &JsonNode, path: &str) -> Result<Self, String> {
        let fields = json_expect_object(node, path)?;
        let mut entries: Vec<Option<(JsString, V)>> = Vec::with_capacity(fields.len());
        for (key, value) in fields {
            let decoded = V::decode_json(value, &json_property_path(path, key))?;
            if let Some((_, stored)) = entries
                .iter_mut()
                .flatten()
                .find(|(stored, _)| stored.as_ref() == key)
            {
                *stored = decoded;
            } else {
                entries.push(Some((string(key), decoded)));
            }
        }
        Ok(Self {
            live: entries.len(),
            entries,
            iteration_depth: 0,
        })
    }
}

pub fn json_parse_typed<T: JsonDecode>(text: &JsString) -> T {
    let node = JsonParser::new(text)
        .parse()
        .unwrap_or_else(|message| throw_syntax_error(message));
    T::decode_json(&node, "$").unwrap_or_else(|message| throw_type_error(message))
}

struct JsonParser<'a> {
    bytes: &'a [u8],
    position: usize,
}

impl<'a> JsonParser<'a> {
    fn new(text: &'a str) -> Self {
        Self {
            bytes: text.as_bytes(),
            position: 0,
        }
    }

    fn parse(mut self) -> Result<JsonNode, String> {
        self.whitespace();
        let value = self.value()?;
        self.whitespace();
        if self.position != self.bytes.len() {
            return self.syntax("unexpected trailing input");
        }
        Ok(value)
    }

    fn value(&mut self) -> Result<JsonNode, String> {
        self.whitespace();
        match self.peek() {
            Some(b'n') => {
                self.keyword(b"null")?;
                Ok(JsonNode::Null)
            }
            Some(b't') => {
                self.keyword(b"true")?;
                Ok(JsonNode::Bool(true))
            }
            Some(b'f') => {
                self.keyword(b"false")?;
                Ok(JsonNode::Bool(false))
            }
            Some(b'"') => Ok(JsonNode::String(Rc::from(self.string()?))),
            Some(b'[') => self.array(),
            Some(b'{') => self.object(),
            Some(b'-' | b'0'..=b'9') => self.number(),
            _ => self.syntax("unexpected token"),
        }
    }

    fn array(&mut self) -> Result<JsonNode, String> {
        self.position += 1;
        self.whitespace();
        let mut elements = Vec::new();
        if self.take(b']') {
            return Ok(JsonNode::Array(elements));
        }
        loop {
            elements.push(self.value()?);
            self.whitespace();
            if self.take(b']') {
                return Ok(JsonNode::Array(elements));
            }
            if !self.take(b',') {
                return self.syntax("expected ',' or ']'");
            }
        }
    }

    fn object(&mut self) -> Result<JsonNode, String> {
        self.position += 1;
        self.whitespace();
        let mut fields = Vec::new();
        if self.take(b'}') {
            return Ok(JsonNode::Object(fields));
        }
        loop {
            self.whitespace();
            if self.peek() != Some(b'"') {
                return self.syntax("expected a string property name");
            }
            let name = self.string()?;
            self.whitespace();
            if !self.take(b':') {
                return self.syntax("expected ':'");
            }
            fields.push((name, self.value()?));
            self.whitespace();
            if self.take(b'}') {
                return Ok(JsonNode::Object(fields));
            }
            if !self.take(b',') {
                return self.syntax("expected ',' or '}'");
            }
        }
    }

    fn number(&mut self) -> Result<JsonNode, String> {
        let start = self.position;
        self.take(b'-');
        match self.peek() {
            Some(b'0') => self.position += 1,
            Some(b'1'..=b'9') => {
                self.position += 1;
                while matches!(self.peek(), Some(b'0'..=b'9')) {
                    self.position += 1;
                }
            }
            _ => return self.syntax("invalid number"),
        }
        if self.take(b'.') {
            if !matches!(self.peek(), Some(b'0'..=b'9')) {
                return self.syntax("invalid number fraction");
            }
            while matches!(self.peek(), Some(b'0'..=b'9')) {
                self.position += 1;
            }
        }
        if matches!(self.peek(), Some(b'e' | b'E')) {
            self.position += 1;
            if matches!(self.peek(), Some(b'+' | b'-')) {
                self.position += 1;
            }
            if !matches!(self.peek(), Some(b'0'..=b'9')) {
                return self.syntax("invalid number exponent");
            }
            while matches!(self.peek(), Some(b'0'..=b'9')) {
                self.position += 1;
            }
        }
        let spelling = std::str::from_utf8(&self.bytes[start..self.position])
            .map_err(|_| "invalid UTF-8 in JSON number".to_owned())?;
        let value = spelling
            .parse::<f64>()
            .map_err(|_| format!("invalid JSON number at byte {start}"))?;
        Ok(JsonNode::Number(value))
    }

    fn string(&mut self) -> Result<String, String> {
        debug_assert_eq!(self.peek(), Some(b'"'));
        self.position += 1;
        let mut output = String::new();
        loop {
            let Some(byte) = self.peek() else {
                return self.syntax("unterminated string");
            };
            match byte {
                b'"' => {
                    self.position += 1;
                    return Ok(output);
                }
                b'\\' => {
                    self.position += 1;
                    let escaped = self
                        .peek()
                        .ok_or_else(|| format!("unterminated escape at byte {}", self.position))?;
                    self.position += 1;
                    match escaped {
                        b'"' => output.push('"'),
                        b'\\' => output.push('\\'),
                        b'/' => output.push('/'),
                        b'b' => output.push('\u{0008}'),
                        b'f' => output.push('\u{000c}'),
                        b'n' => output.push('\n'),
                        b'r' => output.push('\r'),
                        b't' => output.push('\t'),
                        b'u' => {
                            let first = self.hex_quad()?;
                            if (0xd800..=0xdbff).contains(&first)
                                && self.bytes.get(self.position..self.position + 2) == Some(b"\\u")
                            {
                                self.position += 2;
                                let second = self.hex_quad()?;
                                if (0xdc00..=0xdfff).contains(&second) {
                                    let scalar = 0x10000
                                        + (((first as u32 - 0xd800) << 10)
                                            | (second as u32 - 0xdc00));
                                    output.push(
                                        char::from_u32(scalar).expect("valid JSON surrogate pair"),
                                    );
                                } else {
                                    output.push('\u{fffd}');
                                    output
                                        .push(char::from_u32(second as u32).unwrap_or('\u{fffd}'));
                                }
                            } else {
                                output.push(char::from_u32(first as u32).unwrap_or('\u{fffd}'));
                            }
                        }
                        _ => return self.syntax("invalid string escape"),
                    }
                }
                0x00..=0x1f => return self.syntax("unescaped control character in string"),
                _ => {
                    let tail = std::str::from_utf8(&self.bytes[self.position..])
                        .map_err(|_| format!("invalid UTF-8 at byte {}", self.position))?;
                    let ch = tail.chars().next().expect("non-empty JSON input tail");
                    output.push(ch);
                    self.position += ch.len_utf8();
                }
            }
        }
    }

    fn hex_quad(&mut self) -> Result<u16, String> {
        let start = self.position;
        let end = start.saturating_add(4);
        let Some(bytes) = self.bytes.get(start..end) else {
            return self.syntax("incomplete unicode escape");
        };
        let spelling = std::str::from_utf8(bytes).expect("ASCII JSON unicode escape");
        let value = u16::from_str_radix(spelling, 16)
            .map_err(|_| format!("invalid unicode escape at byte {start}"))?;
        self.position = end;
        Ok(value)
    }

    fn keyword(&mut self, keyword: &[u8]) -> Result<(), String> {
        if self.bytes.get(self.position..self.position + keyword.len()) != Some(keyword) {
            return self.syntax("unexpected token");
        }
        self.position += keyword.len();
        Ok(())
    }

    fn whitespace(&mut self) {
        while matches!(self.peek(), Some(b' ' | b'\n' | b'\r' | b'\t')) {
            self.position += 1;
        }
    }

    fn peek(&self) -> Option<u8> {
        self.bytes.get(self.position).copied()
    }

    fn take(&mut self, byte: u8) -> bool {
        if self.peek() == Some(byte) {
            self.position += 1;
            true
        } else {
            false
        }
    }

    fn syntax<T>(&self, message: &str) -> Result<T, String> {
        Err(format!("{message} at byte {}", self.position))
    }
}
