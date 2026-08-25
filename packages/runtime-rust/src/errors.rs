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

pub fn assert_dyn_result(equal: bool, negated: bool, message: &JsString, has_message: bool) {
    if (negated && !equal) || (!negated && equal) {
        return;
    }
    throw_assertion_error(if has_message {
        message.to_string()
    } else if negated {
        "Expected values to be strictly unequal".to_owned()
    } else {
        "Expected values to be strictly equal".to_owned()
    })
}

thread_local! {
    static ASSERT_SHAPE: RefCell<Option<(JsError, [Option<JsString>; 3])>> = const { RefCell::new(None) };
}

pub fn assert_shape_begin(error: &JsError) {
    ASSERT_SHAPE.with(|shape| {
        *shape.borrow_mut() = Some((error.clone(), [None, None, None]));
    });
}

pub fn assert_shape_string(key: f64, value: &JsString) {
    let index = key as usize;
    ASSERT_SHAPE.with(|shape| {
        let mut shape = shape.borrow_mut();
        let (_, slots) = shape
            .as_mut()
            .expect("scriptc: assertion shape slot without begin");
        let slot = slots
            .get_mut(index)
            .expect("scriptc: invalid assertion shape slot");
        *slot = Some(value.clone());
    });
}

pub fn assert_shape_end(message: &JsString, has_message: bool) {
    let (error, slots) = ASSERT_SHAPE.with(|shape| {
        shape
            .borrow_mut()
            .take()
            .expect("scriptc: assertion shape end without begin")
    });
    let actual = [
        error_code(&error),
        Some(error_message(&error)),
        Some(error_name(&error)),
    ];
    let matches = slots
        .iter()
        .zip(actual.iter())
        .all(|(expected, actual)| match expected {
            None => true,
            Some(expected) => actual
                .as_ref()
                .is_some_and(|actual| actual.as_ref() == expected.as_ref()),
        });
    if !matches {
        throw_assertion_error(if has_message {
            message.to_string()
        } else {
            "Expected values to be strictly deep-equal".to_owned()
        });
    }
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
