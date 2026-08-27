#[derive(Clone)]
pub struct JsError {
    identity: Rc<()>,
    name: String,
    message: String,
    code: Option<String>,
    dom: Option<DomExceptionData>,
}

#[derive(Clone)]
struct DomExceptionData {
    code: f64,
    cause: Option<Caught>,
}

impl std::fmt::Debug for JsError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("JsError")
            .field("name", &self.name)
            .field("message", &self.message)
            .field("code", &self.code)
            .field("dom_code", &self.dom.as_ref().map(|dom| dom.code))
            .field(
                "dom_has_cause",
                &self.dom.as_ref().is_some_and(|dom| dom.cause.is_some()),
            )
            .finish()
    }
}

impl PartialEq for JsError {
    fn eq(&self, other: &Self) -> bool {
        let dom_equal = match (&self.dom, &other.dom) {
            (None, None) => true,
            (Some(left), Some(right)) => {
                left.code == right.code
                    && match (&left.cause, &right.cause) {
                        (None, None) => true,
                        (Some(left), Some(right)) => Rc::ptr_eq(&left.value, &right.value),
                        _ => false,
                    }
            }
            _ => false,
        };
        self.name == other.name
            && self.message == other.message
            && self.code == other.code
            && dom_equal
    }
}

impl Eq for JsError {}

impl Trace for JsError {
    fn trace(&self, _tracer: &mut Tracer<'_>) {}
}

pub fn error_new(name: &str, message: JsString) -> JsError {
    JsError {
        identity: Rc::new(()),
        name: name.to_owned(),
        message: message.to_string(),
        code: None,
        dom: None,
    }
}

pub fn error_new_code(name: &str, message: JsString, code: &str) -> JsError {
    JsError {
        identity: Rc::new(()),
        name: name.to_owned(),
        message: message.to_string(),
        code: Some(code.to_owned()),
        dom: None,
    }
}

#[derive(Clone)]
pub struct Caught {
    value: Rc<dyn Any>,
}

pub fn caught_value<T: 'static>(value: T) -> Caught {
    Caught {
        value: Rc::new(value),
    }
}

pub enum Completion<T> {
    Normal,
    Return(T),
    Throw(Caught),
    Break(usize),
    Continue(usize),
}

struct ScriptThrow;

pub fn throw_value<T: 'static>(value: T) -> ! {
    EXCEPTION_SLOT.with(|slot| {
        let previous = slot.borrow_mut().replace(Rc::new(value));
        assert!(
            previous.is_none(),
            "scriptc: throw with an occupied exception slot"
        );
    });
    std::panic::resume_unwind(Box::new(ScriptThrow))
}

pub fn throw_reference_error(message: String) -> ! {
    throw_value(JsError {
        identity: Rc::new(()),
        name: "ReferenceError".to_owned(),
        message,
        code: None,
        dom: None,
    })
}

pub fn throw_undefined_global<T>(name: &JsString) -> T {
    throw_reference_error(format!("{name} is not defined"))
}

pub fn throw_error(message: String) -> ! {
    throw_value(JsError {
        identity: Rc::new(()),
        name: "Error".to_owned(),
        message,
        code: None,
        dom: None,
    })
}

pub fn throw_error_code(message: String, code: &str) -> ! {
    throw_value(JsError {
        identity: Rc::new(()),
        name: "Error".to_owned(),
        message,
        code: Some(code.to_owned()),
        dom: None,
    })
}

pub fn throw_type_error_code(message: String, code: &str) -> ! {
    throw_value(JsError {
        identity: Rc::new(()),
        name: "TypeError".to_owned(),
        message,
        code: Some(code.to_owned()),
        dom: None,
    })
}

pub fn throw_type_error(message: String) -> ! {
    throw_value(JsError {
        identity: Rc::new(()),
        name: "TypeError".to_owned(),
        message,
        code: None,
        dom: None,
    })
}

pub fn dynamic_specific_string(value: &str) -> String {
    if value.encode_utf16().count() + 2 <= 28 {
        return format!("type string ('{value}')");
    }
    let prefix: String = value
        .chars()
        .scan(0usize, |units, character| {
            let next = *units + character.len_utf16();
            if next > 24 {
                None
            } else {
                *units = next;
                Some(character)
            }
        })
        .collect();
    format!("type string ('{prefix}...)")
}

pub fn throw_syntax_error(message: String) -> ! {
    throw_value(JsError {
        identity: Rc::new(()),
        name: "SyntaxError".to_owned(),
        message,
        code: None,
        dom: None,
    })
}

pub fn throw_range_error(message: String) -> ! {
    throw_value(JsError {
        identity: Rc::new(()),
        name: "RangeError".to_owned(),
        message,
        code: None,
        dom: None,
    })
}

pub fn throw_range_error_code(message: String, code: &str) -> ! {
    throw_value(JsError {
        identity: Rc::new(()),
        name: "RangeError".to_owned(),
        message,
        code: Some(code.to_owned()),
        dom: None,
    })
}

pub fn throw_node_coded(kind: f64, code: &JsString, message: &JsString) -> ! {
    match (kind as i32, code.is_empty()) {
        (0, true) => throw_error(message.to_string()),
        (0, false) => throw_error_code(message.to_string(), code),
        (1, true) => throw_type_error(message.to_string()),
        (1, false) => throw_type_error_code(message.to_string(), code),
        (2, true) => throw_range_error(message.to_string()),
        (2, false) => throw_range_error_code(message.to_string(), code),
        _ => unreachable!("scriptc invariant: invalid Node error kind"),
    }
}

pub fn throw_uri_error(message: String) -> ! {
    throw_value(JsError {
        identity: Rc::new(()),
        name: "URIError".to_owned(),
        message,
        code: None,
        dom: None,
    })
}

pub fn caught_from_panic(payload: Box<dyn Any + Send>) -> Caught {
    match payload.downcast::<ScriptThrow>() {
        Ok(_) => EXCEPTION_SLOT.with(|slot| Caught {
            value: slot
                .borrow_mut()
                .take()
                .expect("scriptc: throw marker without an exception value"),
        }),
        Err(payload) => std::panic::resume_unwind(payload),
    }
}

pub fn rethrow_caught(caught: Caught) -> ! {
    EXCEPTION_SLOT.with(|slot| {
        let previous = slot.borrow_mut().replace(caught.value);
        assert!(
            previous.is_none(),
            "scriptc: rethrow with an occupied exception slot"
        );
    });
    std::panic::resume_unwind(Box::new(ScriptThrow))
}

pub fn caught_is_error(caught: &Caught) -> bool {
    caught.value.is::<JsError>()
}

pub fn caught_is<T: 'static>(caught: &Caught) -> bool {
    caught.value.is::<T>()
}

pub fn caught_narrow<T: Clone + 'static>(caught: &Caught) -> T {
    caught
        .value
        .downcast_ref::<T>()
        .expect("scriptc: narrowed caught value has the wrong runtime type")
        .clone()
}

pub fn caught_is_error_class(caught: &Caught, name: &str) -> bool {
    caught
        .value
        .downcast_ref::<JsError>()
        .is_some_and(|error| error_is_class(error, name))
}

pub fn caught_check_error(caught: &Caught, name: &str) -> JsError {
    if !caught_is_error_class(caught, name) {
        throw_type_error(format!("caught value is not a {name}"));
    }
    caught_error_value(caught)
}

pub fn caught_error_value(caught: &Caught) -> JsError {
    caught
        .value
        .downcast_ref::<JsError>()
        .expect("scriptc: narrowed non-Error caught value")
        .clone()
}

pub fn caught_error_name(caught: &Caught) -> JsString {
    let error = caught
        .value
        .downcast_ref::<JsError>()
        .expect("scriptc: narrowed non-Error caught value");
    Rc::<str>::from(error.name.as_str())
}

pub fn caught_error_message(caught: &Caught) -> JsString {
    let error = caught
        .value
        .downcast_ref::<JsError>()
        .expect("scriptc: narrowed non-Error caught value");
    Rc::<str>::from(error.message.as_str())
}

pub fn caught_error_code(caught: &Caught) -> Option<JsString> {
    caught
        .value
        .downcast_ref::<JsError>()
        .expect("scriptc: narrowed non-Error caught value")
        .code
        .as_deref()
        .map(Rc::<str>::from)
}

pub fn caught_to_string(caught: &Caught) -> JsString {
    if let Some(value) = caught.value.downcast_ref::<f64>() {
        return number_to_string(*value);
    }
    if let Some(value) = caught.value.downcast_ref::<bool>() {
        return bool_to_string(*value);
    }
    if let Some(value) = caught.value.downcast_ref::<JsString>() {
        return value.clone();
    }
    if let Some(error) = caught.value.downcast_ref::<JsError>() {
        return error_to_string(error);
    }
    string("[object Object]")
}

pub fn error_to_string_parts(name: &str, message: &str) -> JsString {
    if name.is_empty() {
        return Rc::from(message);
    }
    if message.is_empty() {
        return Rc::from(name);
    }
    Rc::from(format!("{name}: {message}"))
}

pub fn error_to_string(error: &JsError) -> JsString {
    if error.name == "AssertionError" {
        if let Some(code) = &error.code {
            return error_to_string_parts(&format!("{} [{code}]", error.name), &error.message);
        }
    }
    error_to_string_parts(&error.name, &error.message)
}

pub fn error_is_class(error: &JsError, name: &str) -> bool {
    name == "Error"
        || if error.dom.is_some() {
            name == "DOMException"
        } else {
            error.name == name
        }
}

pub fn error_name(error: &JsError) -> JsString {
    Rc::from(error.name.as_str())
}

pub fn error_message(error: &JsError) -> JsString {
    Rc::from(error.message.as_str())
}

pub fn error_code(error: &JsError) -> Option<JsString> {
    error.code.as_deref().map(Rc::from)
}

pub fn error_identity(error: &JsError) -> usize {
    Rc::as_ptr(&error.identity) as usize
}

fn dom_exception_code(name: &str) -> f64 {
    match name {
        "IndexSizeError" => 1.0,
        "DOMStringSizeError" => 2.0,
        "HierarchyRequestError" => 3.0,
        "WrongDocumentError" => 4.0,
        "InvalidCharacterError" => 5.0,
        "NoDataAllowedError" => 6.0,
        "NoModificationAllowedError" => 7.0,
        "NotFoundError" => 8.0,
        "NotSupportedError" => 9.0,
        "InUseAttributeError" => 10.0,
        "InvalidStateError" => 11.0,
        "SyntaxError" => 12.0,
        "InvalidModificationError" => 13.0,
        "NamespaceError" => 14.0,
        "InvalidAccessError" => 15.0,
        "ValidationError" => 16.0,
        "TypeMismatchError" => 17.0,
        "SecurityError" => 18.0,
        "NetworkError" => 19.0,
        "AbortError" => 20.0,
        "URLMismatchError" => 21.0,
        "QuotaExceededError" => 22.0,
        "TimeoutError" => 23.0,
        "InvalidNodeTypeError" => 24.0,
        "DataCloneError" => 25.0,
        _ => 0.0,
    }
}

pub fn dom_exception_new(message: JsString, name: JsString, cause: Option<Caught>) -> JsError {
    JsError {
        identity: Rc::new(()),
        name: name.to_string(),
        message: message.to_string(),
        code: None,
        dom: Some(DomExceptionData {
            code: dom_exception_code(&name),
            cause,
        }),
    }
}

pub fn throw_dom_exception(name: &str, message: &str) -> ! {
    throw_value(dom_exception_new(string(message), string(name), None))
}

pub fn error_dom_code(error: &JsError) -> f64 {
    error
        .dom
        .as_ref()
        .expect("scriptc: DOMException accessor on a non-DOM error")
        .code
}

pub fn error_dom_has_cause(error: &JsError) -> bool {
    error
        .dom
        .as_ref()
        .expect("scriptc: DOMException accessor on a non-DOM error")
        .cause
        .is_some()
}

pub fn error_dom_cause<T: Clone + 'static>(error: &JsError) -> Option<T> {
    error
        .dom
        .as_ref()
        .expect("scriptc: DOMException accessor on a non-DOM error")
        .cause
        .as_ref()
        .map(caught_narrow::<T>)
}

pub fn error_dom_clone(error: &JsError) -> JsError {
    dom_exception_new(error_message(error), error_name(error), None)
}

fn throw_assertion_error(message: String) -> ! {
    throw_value(JsError {
        identity: Rc::new(()),
        name: "AssertionError".to_owned(),
        message,
        code: Some("ERR_ASSERTION".to_owned()),
        dom: None,
    })
}

pub fn assert_ok(pass: bool, message: &JsString) {
    if !pass {
        throw_assertion_error(message.to_string());
    }
}

pub fn assert_same_value_f64(left: f64, right: f64) -> bool {
    if left == right {
        return left != 0.0 || left.is_sign_negative() == right.is_sign_negative();
    }
    left.is_nan() && right.is_nan()
}

pub fn assert_inspect_string(value: &str) -> String {
    let quote = if !value.contains('\'') {
        '\''
    } else if !value.contains('"') {
        '"'
    } else {
        '`'
    };
    let mut output = String::with_capacity(value.len() + 2);
    output.push(quote);
    for character in value.chars() {
        if character == quote || character == '\\' {
            output.push('\\');
            output.push(character);
        } else {
            match character {
                '\u{0008}' => output.push_str("\\b"),
                '\t' => output.push_str("\\t"),
                '\n' => output.push_str("\\n"),
                '\u{000c}' => output.push_str("\\f"),
                '\r' => output.push_str("\\r"),
                '\u{0000}'..='\u{001f}' | '\u{007f}' => {
                    output.push_str(&format!("\\x{:02X}", character as u32));
                }
                _ => output.push(character),
            }
        }
    }
    output.push(quote);
    output
}

fn assert_not_equal_message(actual: &str, deep: bool, message: &JsString, has_message: bool) -> ! {
    if has_message {
        throw_assertion_error(message.to_string());
    }
    let header = if deep {
        "Expected \"actual\" not to be strictly deep-equal to:"
    } else {
        "Expected \"actual\" to be strictly unequal to:"
    };
    throw_assertion_error(format!(
        "{header}{}{actual}",
        if actual.len() > 5 { "\n\n" } else { " " }
    ))
}

fn assert_equal_message(
    actual: &str,
    expected: &str,
    quote_count: usize,
    both_zero: bool,
    deep: bool,
    message: &JsString,
    has_message: bool,
) -> ! {
    let header = if has_message && !message.is_empty() {
        message.to_string()
    } else if deep {
        "Expected values to be strictly deep-equal:".to_owned()
    } else {
        "Expected values to be strictly equal:".to_owned()
    };
    if actual.len() + expected.len() - (2 * quote_count) <= 12 && !both_zero {
        throw_assertion_error(format!("{header}\n\n{actual} !== {expected}\n"));
    }
    let mut output = format!("{header}\n+ actual - expected\n\n+ {actual}\n- {expected}");
    if actual.len() + expected.len() <= 80 {
        let mismatch = actual
            .bytes()
            .zip(expected.bytes())
            .position(|(left, right)| left != right);
        if let Some(index) = mismatch.filter(|index| *index >= 3) {
            output.push('\n');
            output.push_str(&" ".repeat(index + 2));
            output.push('^');
        }
    }
    output.push('\n');
    throw_assertion_error(output)
}

pub fn assert_eq_f64(
    left: f64,
    right: f64,
    negated: bool,
    deep: bool,
    message: &JsString,
    has_message: bool,
) {
    let same = assert_same_value_f64(left, right);
    if (negated && !same) || (!negated && same) {
        return;
    }
    let actual = display_number(left);
    if negated {
        assert_not_equal_message(&actual, deep, message, has_message);
    }
    assert_equal_message(
        &actual,
        &display_number(right),
        0,
        left == 0.0 && right == 0.0,
        deep,
        message,
        has_message,
    )
}

pub fn assert_eq_string(
    left: &JsString,
    right: &JsString,
    negated: bool,
    deep: bool,
    message: &JsString,
    has_message: bool,
) {
    let same = left.as_ref() == right.as_ref();
    if (negated && !same) || (!negated && same) {
        return;
    }
    let actual = assert_inspect_string(left);
    if negated {
        assert_not_equal_message(&actual, deep, message, has_message);
    }
    assert_equal_message(
        &actual,
        &assert_inspect_string(right),
        2,
        false,
        deep,
        message,
        has_message,
    )
}

pub fn assert_eq_bool(
    left: bool,
    right: bool,
    negated: bool,
    deep: bool,
    message: &JsString,
    has_message: bool,
) {
    let same = left == right;
    if (negated && !same) || (!negated && same) {
        return;
    }
    let actual = if left { "true" } else { "false" };
    if negated {
        assert_not_equal_message(actual, deep, message, has_message);
    }
    assert_equal_message(
        actual,
        if right { "true" } else { "false" },
        0,
        false,
        deep,
        message,
        has_message,
    )
}

pub fn assert_eq_symbol(
    left: &JsSymbol,
    right: &JsSymbol,
    negated: bool,
    deep: bool,
    message: &JsString,
    has_message: bool,
) {
    let same = symbol_ptr_eq(left, right);
    if (negated && !same) || (!negated && same) {
        return;
    }
    let actual = symbol_to_string(left);
    if negated {
        assert_not_equal_message(&actual, deep, message, has_message);
    }
    assert_equal_message(
        &actual,
        &symbol_to_string(right),
        0,
        false,
        deep,
        message,
        has_message,
    )
}

pub fn assert_ref_eq_bytes<T: ByteElement>(
    left: &JsBytes<T>,
    right: &JsBytes<T>,
    negated: bool,
    brands_equal: bool,
    message: &JsString,
    has_message: bool,
) {
    let same = left.ptr_eq(right);
    if (negated && !same) || (!negated && same) {
        return;
    }
    if has_message && (negated || !message.is_empty()) {
        throw_assertion_error(message.to_string());
    }
    let header = if negated {
        "Expected \"actual\" not to be reference-equal to \"expected\":"
    } else if brands_equal && bytes_deep_equals(left, right) {
        "Values have same structure but are not reference-equal:"
    } else {
        "Expected \"actual\" to be reference-equal to \"expected\":"
    };
    throw_assertion_error(header.to_owned())
}

pub fn assert_ref_eq_function(
    left: usize,
    right: usize,
    negated: bool,
    message: &JsString,
    has_message: bool,
) {
    let same = left == right;
    if (negated && !same) || (!negated && same) {
        return;
    }
    if has_message && (negated || !message.is_empty()) {
        throw_assertion_error(message.to_string());
    }
    throw_assertion_error(if negated {
        "Expected \"actual\" not to be reference-equal to \"expected\":".to_owned()
    } else {
        "Expected \"actual\" to be reference-equal to \"expected\":".to_owned()
    })
}

pub fn assert_match(
    input: &JsString,
    regex: &JsRegex,
    negated: bool,
    message: &JsString,
    has_message: bool,
) {
    let matched = regex_hits(regex, input);
    if (negated && !matched) || (!negated && matched) {
        return;
    }
    if has_message {
        throw_assertion_error(message.to_string());
    }
    let head = if negated {
        "The input was expected to not match the regular expression "
    } else {
        "The input did not match the regular expression "
    };
    throw_assertion_error(format!(
        "{head}/{}/{}. Input:\n\n{}\n",
        regex_source(regex),
        regex_flags(regex),
        assert_inspect_string(input),
    ))
}

pub fn assert_throws_regex(
    regex: &JsRegex,
    actual: &JsString,
    message: &JsString,
    has_message: bool,
) {
    if regex_hits(regex, actual) {
        return;
    }
    if has_message {
        throw_assertion_error(message.to_string());
    }
    throw_assertion_error(format!(
        "The input did not match the regular expression /{}/{}. Input:\n\n{}\n",
        regex_source(regex),
        regex_flags(regex),
        assert_inspect_string(actual),
    ))
}

thread_local! {
    static ASSERT_DEEP_PAIRS: RefCell<Vec<(usize, usize)>> = const { RefCell::new(Vec::new()) };
}

pub fn assert_deep_pair_enter(left: usize, right: usize) -> bool {
    ASSERT_DEEP_PAIRS.with(|pairs| {
        let mut pairs = pairs.borrow_mut();
        if pairs.contains(&(left, right)) {
            true
        } else {
            pairs.push((left, right));
            false
        }
    })
}

pub fn assert_deep_pair_leave() {
    ASSERT_DEEP_PAIRS.with(|pairs| {
        let _ = pairs.borrow_mut().pop();
    });
}

pub fn assert_deep_result(equal: bool, negated: bool, message: &JsString, has_message: bool) {
    if (negated && !equal) || (!negated && equal) {
        return;
    }
    throw_assertion_error(if has_message && (negated || !message.is_empty()) {
        message.to_string()
    } else if negated {
        "Expected \"actual\" not to be strictly deep-equal to:".to_owned()
    } else {
        "Expected values to be strictly deep-equal:".to_owned()
    })
}

pub fn assert_throws_none(
    rejection: bool,
    expected_name: &JsString,
    has_expected_name: bool,
    message: &JsString,
    has_message: bool,
) {
    let mut output = if rejection {
        "Missing expected rejection".to_owned()
    } else {
        "Missing expected exception".to_owned()
    };
    if has_expected_name {
        output.push_str(" (");
        output.push_str(expected_name);
        output.push(')');
    }
    if has_message {
        output.push_str(": ");
        output.push_str(message);
    } else {
        output.push('.');
    }
    throw_assertion_error(output)
}

pub fn assert_throws_mismatch(
    expected_name: &JsString,
    received_name: &JsString,
    received_message: &JsString,
    message: &JsString,
    has_message: bool,
) {
    if has_message {
        throw_assertion_error(message.to_string());
    }
    let mut output = format!(
        "The error is expected to be an instance of \"{expected_name}\". Received \"{received_name}\""
    );
    if !received_message.is_empty() {
        output.push_str("\n\nError message:\n\n");
        output.push_str(received_message);
    }
    throw_assertion_error(output)
}
