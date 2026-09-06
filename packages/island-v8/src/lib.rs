//! The V8 island: scriptc's embedded JavaScript engine, behind a surface
//! that knows nothing about the runtime — values are opaque handles,
//! host functions are closures over plain Rust types, modules come from a
//! resolver closure. The runtime crate (`#![forbid(unsafe_code)]`) maps
//! its own types onto this surface; the `unsafe` the rusty_v8 scope API
//! requires lives here, in the few audited spots marked SAFETY.
//!
//! One engine per thread (V8 isolates are thread-confined). Every entry
//! point opens a scope on the thread's isolate; re-entrant calls (a host
//! function calling back into the engine) nest the same way V8 nests
//! callback scopes.

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::rc::Rc;
use std::sync::Once;

/// An engine value the runtime holds across calls (a persistent handle).
#[derive(Clone)]
pub struct Value(v8::Global<v8::Value>);

impl std::fmt::Debug for Value {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Value(<engine>)")
    }
}

/// A caught engine exception, decomposed for the runtime: `name` and
/// `message` from the object (or the thrown primitive's text), `code`
/// when the object carries one (Node's errno/library codes), `stack` when
/// present, and the thrown value itself.
#[derive(Clone, Debug)]
pub struct Error {
    pub name: String,
    pub message: String,
    pub code: Option<String>,
    pub stack: Option<String>,
    pub value: Option<Value>,
}

impl Error {
    fn text(name: &str, message: impl Into<String>) -> Self {
        Error { name: name.to_owned(), message: message.into(), code: None, stack: None, value: None }
    }
}

/// What a host function answers.
pub enum HostResult {
    Undefined,
    Null,
    Number(f64),
    Bool(bool),
    String(String),
    Bytes(Vec<u8>),
    Value(Value),
    /// Raised into the engine as an Error of `name` carrying `message`
    /// (and `code`).
    Throw(Error),
}

pub type HostFn = Rc<dyn Fn(&[Value]) -> HostResult>;

/// One module source the resolver answers: `key` names it uniquely (the
/// engine caches by key and reports it as the referrer of its imports).
#[derive(Clone, Debug)]
pub struct ModuleSource {
    pub key: String,
    /// The module text. A BORROWED text that is Latin-1 becomes a V8
    /// external string (no copy into the heap): embedded graphs are tens
    /// of megabytes, and their sources already live for the process.
    pub source: std::borrow::Cow<'static, str>,
    /// A JSON module: `source` is the JSON text, the default export is
    /// the parsed value.
    pub json: bool,
    /// V8 code cache bytes a previous run produced for exactly this
    /// source (`module_code_caches`); consumed at compile, and a key whose
    /// cache is missing or rejected is reported back for regeneration.
    pub code_cache: Option<Rc<Vec<u8>>>,
}

/// `(referrer key, specifier)` → the module, or a message (raised as a
/// ReferenceError at the import site).
pub type ModuleResolver = Rc<dyn Fn(&str, &str) -> Result<ModuleSource, String>>;

pub enum PromiseState {
    Pending,
    Fulfilled(Value),
    Rejected(Value),
}

struct Engine {
    /// Kept alive here; the pointer below is what every entry uses.
    _isolate: Box<v8::OwnedIsolate>,
    isolate: *mut v8::Isolate,
    context: v8::Global<v8::Context>,
    modules: HashMap<String, v8::Global<v8::Module>>,
    module_keys: HashMap<i32, String>,
    /// The promise `Module::evaluate` answered, per key: a later `import()`
    /// of a module still evaluating (top-level await) settles from it.
    module_promises: HashMap<String, v8::Global<v8::Promise>>,
    module_sources: HashMap<String, String>,
    /// Keys compiled without a usable code cache this run, in order.
    cache_misses: Vec<String>,
    resolver: Option<ModuleResolver>,
    host_fns: Vec<HostFn>,
    unhandled: Vec<(v8::Global<v8::Promise>, v8::Global<v8::Value>)>,
}

thread_local! {
    static ENGINE: RefCell<Option<Engine>> = const { RefCell::new(None) };
    /// How many engine entries are on the stack (a host callback calling
    /// back in nests them).
    static DEPTH: Cell<u32> = const { Cell::new(0) };
    /// A Rust unwind that reached a host callback: it must not cross the
    /// engine's C++ frames, so the trampoline parks it here, throws a
    /// JavaScript sentinel for V8 to unwind with, and the OUTERMOST entry
    /// re-raises it on the way out (`EntryGuard`).
    static PARKED: RefCell<Option<Box<dyn std::any::Any + Send>>> = const { RefCell::new(None) };
}

/// Counts an engine entry; on the outermost exit, re-raises a parked
/// unwind (never while another unwind is already in flight).
struct EntryGuard;

impl EntryGuard {
    fn enter() -> Self {
        DEPTH.with(|depth| depth.set(depth.get() + 1));
        EntryGuard
    }
}

impl Drop for EntryGuard {
    fn drop(&mut self) {
        let remaining = DEPTH.with(|depth| {
            let value = depth.get().saturating_sub(1);
            depth.set(value);
            value
        });
        if remaining == 0 && !std::thread::panicking()
            && let Some(payload) = PARKED.with(|slot| slot.borrow_mut().take())
        {
            std::panic::resume_unwind(payload);
        }
    }
}

/// True while a host callback's unwind is parked (its JavaScript
/// sentinel is unwinding the engine's frames).
pub fn unwind_parked() -> bool {
    PARKED.with(|slot| slot.borrow().is_some())
}

static PLATFORM: Once = Once::new();

fn with_engine<T>(f: impl FnOnce(&mut Engine) -> T) -> T {
    ENGINE.with(|slot| {
        let mut slot = slot.borrow_mut();
        f(slot.as_mut().expect("scriptc island (v8): engine not initialized on this thread"))
    })
}

fn isolate_ptr() -> *mut v8::Isolate {
    with_engine(|engine| engine.isolate)
}

fn context_global() -> v8::Global<v8::Context> {
    with_engine(|engine| engine.context.clone())
}

/// Opens a scope on this thread's isolate for the block that follows:
/// `enter!(scope);` binds `scope` to a context-entered handle scope.
///
/// Re-entrant by construction: an entry point called from inside a host
/// callback opens a callback scope beneath the engine's own frames.
macro_rules! enter {
    ($scope:ident) => {
        let _entry_guard = EntryGuard::enter();
        let __ptr = isolate_ptr();
        let __context = context_global();
        // SAFETY: the isolate is created once per thread, boxed, and only
        // ever dereferenced on that thread; V8 permits nested callback
        // scopes while the isolate is entered, which it is for the whole
        // engine lifetime (OwnedIsolate enters at creation).
        let __isolate: &mut v8::Isolate = unsafe { &mut *__ptr };
        v8::callback_scope!(unsafe __cb, __isolate);
        v8::scope!(let __hs, __cb);
        let __local_context = v8::Local::new(__hs, &__context);
        let $scope = &mut v8::ContextScope::new(__hs, __local_context);
    };
}

/// Creates this thread's engine. `stack_size` is the size of the thread
/// the engine runs on (its stack limit is set 64 KiB below the top).
pub fn init() {
    STATS.with(|slot| slot.set(Stats::default()));
    PLATFORM.call_once(|| {
        // Engine flags for experiments (`--prof`, `--single-threaded`,
        // `--max-lazy`…); they must land before the platform starts.
        if let Ok(flags) = std::env::var("SCRIPTC_V8_FLAGS")
            && !flags.is_empty()
        {
            v8::V8::set_flags_from_string(&flags);
        }
        let platform = v8::new_default_platform(0, false).make_shared();
        v8::V8::initialize_platform(platform);
        v8::V8::initialize();
    });
    let mut isolate = Box::new(v8::Isolate::new(v8::CreateParams::default()));
    isolate.set_host_import_module_dynamically_callback(dynamic_import_callback);
    isolate.set_promise_reject_callback(promise_reject_callback);
    isolate.set_host_initialize_import_meta_object_callback(import_meta_callback);
    let ptr: *mut v8::Isolate = &mut **isolate;
    let context = {
        // SAFETY: as in `enter!` — the boxed isolate has a stable address.
        let isolate_ref: &mut v8::Isolate = unsafe { &mut *ptr };
        v8::scope!(let scope, isolate_ref);
        let context = v8::Context::new(scope, Default::default());
        v8::Global::new(scope, context)
    };
    ENGINE.with(|slot| {
        *slot.borrow_mut() = Some(Engine {
            _isolate: isolate,
            isolate: ptr,
            context,
            modules: HashMap::new(),
            module_keys: HashMap::new(),
            module_promises: HashMap::new(),
            module_sources: HashMap::new(),
        cache_misses: Vec::new(),
            resolver: None,
            host_fns: Vec::new(),
            unhandled: Vec::new(),
        });
    });
}

pub fn is_initialized() -> bool {
    ENGINE.with(|slot| slot.borrow().is_some())
}

/// Drops this thread's engine (every handle the runtime still holds must
/// be gone first).
pub fn finish() {
    ENGINE.with(|slot| {
        *slot.borrow_mut() = None;
    });
}

/// A local as a persistent handle the runtime can keep.
fn keep(scope: &mut v8::PinScope<'_, '_>, local: v8::Local<'_, v8::Value>) -> Value {
    Value(v8::Global::new(scope, local))
}

/* ── errors ────────────────────────────────────────────────────────── */

fn string_property(scope: &mut v8::PinScope<'_, '_>, object: v8::Local<v8::Object>, name: &str) -> Option<String> {
    let key = v8::String::new(scope, name)?;
    let value = object.get(scope, key.into())?;
    if value.is_undefined() || value.is_null() {
        return None;
    }
    Some(value.to_rust_string_lossy(scope))
}

fn error_of(scope: &mut v8::PinScope<'_, '_>, exception: v8::Local<v8::Value>) -> Error {
    let value = Some(Value(v8::Global::new(scope, exception)));
    if let Ok(object) = v8::Local::<v8::Object>::try_from(exception) {
        let name = string_property(scope, object, "name").unwrap_or_else(|| "Error".to_owned());
        let message = string_property(scope, object, "message").unwrap_or_default();
        let code = string_property(scope, object, "code");
        let stack = string_property(scope, object, "stack");
        return Error { name, message, code, stack, value };
    }
    Error {
        name: "Error".to_owned(),
        message: exception.to_rust_string_lossy(scope),
        code: None,
        stack: None,
        value,
    }
}

/// The exception a pinned TryCatch holds, as an `Error`.
macro_rules! caught {
    ($tc:ident) => {
        match $tc.exception() {
            Some(exception) => error_of($tc, exception),
            None => Error::text("Error", "engine call failed without an exception"),
        }
    };
}

fn error_value<'s>(scope: &mut v8::PinScope<'s, '_>, error: &Error) -> v8::Local<'s, v8::Value> {
    if let Some(value) = &error.value {
        return v8::Local::new(scope, &value.0);
    }
    let message = v8::String::new(scope, &error.message).unwrap_or_else(|| v8::String::empty(scope));
    let value = match error.name.as_str() {
        "TypeError" => v8::Exception::type_error(scope, message),
        "RangeError" => v8::Exception::range_error(scope, message),
        "ReferenceError" => v8::Exception::reference_error(scope, message),
        "SyntaxError" => v8::Exception::syntax_error(scope, message),
        _ => v8::Exception::error(scope, message),
    };
    if let Ok(object) = v8::Local::<v8::Object>::try_from(value) {
        if let Some(code) = &error.code
            && let (Some(key), Some(text)) = (v8::String::new(scope, "code"), v8::String::new(scope, code))
        {
            object.set(scope, key.into(), text.into());
        }
        if error.name != "Error"
            && !matches!(error.name.as_str(), "TypeError" | "RangeError" | "ReferenceError" | "SyntaxError")
            && let (Some(key), Some(text)) = (v8::String::new(scope, "name"), v8::String::new(scope, &error.name))
        {
            object.set(scope, key.into(), text.into());
        }
    }
    value
}

/// An engine Error object of `name` (Error/TypeError/RangeError/…) with
/// `message` and an own `code` when given.
pub fn error(name: &str, message: &str, code: Option<&str>) -> Value {
    enter!(scope);
    let error = Error { name: name.to_owned(), message: message.to_owned(), code: code.map(str::to_owned), stack: None, value: None };
    let value = error_value(scope, &error);
    Value(v8::Global::new(scope, value))
}

/* ── evaluation and calls ──────────────────────────────────────────── */

/// Evaluates `source` as a classic script named `name`.
pub fn eval(source: &str, name: &str) -> Result<Value, Error> {
    enter!(scope);
    v8::tc_scope!(let tc, scope);
    let code = match v8::String::new(tc, source) {
        Some(code) => code,
        None => return Err(Error::text("RangeError", "source too large for the engine")),
    };
    let resource = v8::String::new(tc, name).unwrap_or_else(|| v8::String::empty(tc));
    let origin = v8::ScriptOrigin::new(tc, resource.into(), 0, 0, false, 0, None, false, false, false, None);
    let Some(script) = v8::Script::compile(tc, code, Some(&origin)) else {
        return Err(caught!(tc));
    };
    match script.run(tc) {
        Some(value) => Ok(Value(v8::Global::new(tc, value))),
        None => Err(caught!(tc)),
    }
}

pub fn global() -> Value {
    enter!(scope);
    let object = scope.get_current_context().global(scope);
    keep(scope, object.into())
}

fn locals<'s>(scope: &mut v8::PinScope<'s, '_>, values: &[Value]) -> Vec<v8::Local<'s, v8::Value>> {
    values.iter().map(|value| v8::Local::new(scope, &value.0)).collect()
}

/// `callee.call(this, ...args)`.
pub fn call(callee: &Value, this: Option<&Value>, args: &[Value]) -> Result<Value, Error> {
    enter!(scope);
    v8::tc_scope!(let tc, scope);
    let callee_local = v8::Local::new(tc, &callee.0);
    let Ok(function) = v8::Local::<v8::Function>::try_from(callee_local) else {
        return Err(Error::text("TypeError", "value is not a function"));
    };
    let receiver: v8::Local<v8::Value> = match this {
        Some(this) => v8::Local::new(tc, &this.0),
        None => v8::undefined(tc).into(),
    };
    let arguments = locals(tc, args);
    match function.call(tc, receiver, &arguments) {
        Some(value) => Ok(Value(v8::Global::new(tc, value))),
        None => Err(caught!(tc)),
    }
}

/// `new callee(...args)`.
pub fn construct(callee: &Value, args: &[Value]) -> Result<Value, Error> {
    enter!(scope);
    v8::tc_scope!(let tc, scope);
    let callee_local = v8::Local::new(tc, &callee.0);
    let Ok(function) = v8::Local::<v8::Function>::try_from(callee_local) else {
        return Err(Error::text("TypeError", "value is not a constructor"));
    };
    let arguments = locals(tc, args);
    match function.new_instance(tc, &arguments) {
        Some(object) => Ok(keep(tc, object.into())),
        None => Err(caught!(tc)),
    }
}

/* ── properties ────────────────────────────────────────────────────── */

pub fn get(target: &Value, key: &str) -> Result<Value, Error> {
    enter!(scope);
    v8::tc_scope!(let tc, scope);
    let local = v8::Local::new(tc, &target.0);
    let Some(object) = local.to_object(tc) else {
        return Err(Error::text("TypeError", format!("cannot read property '{key}' of {}", local.to_rust_string_lossy(tc))));
    };
    let key_local = v8::String::new(tc, key).unwrap_or_else(|| v8::String::empty(tc));
    match object.get(tc, key_local.into()) {
        Some(value) => Ok(Value(v8::Global::new(tc, value))),
        None => Err(caught!(tc)),
    }
}

pub fn set(target: &Value, key: &str, value: &Value) -> Result<(), Error> {
    enter!(scope);
    v8::tc_scope!(let tc, scope);
    let local = v8::Local::new(tc, &target.0);
    let Some(object) = local.to_object(tc) else {
        return Err(Error::text("TypeError", format!("cannot set property '{key}' of {}", local.to_rust_string_lossy(tc))));
    };
    let key_local = v8::String::new(tc, key).unwrap_or_else(|| v8::String::empty(tc));
    let value_local = v8::Local::new(tc, &value.0);
    match object.set(tc, key_local.into(), value_local) {
        Some(_) => Ok(()),
        None => Err(caught!(tc)),
    }
}

pub fn get_index(target: &Value, index: u32) -> Result<Value, Error> {
    enter!(scope);
    v8::tc_scope!(let tc, scope);
    let local = v8::Local::new(tc, &target.0);
    let Some(object) = local.to_object(tc) else {
        return Err(Error::text("TypeError", "cannot index a non-object"));
    };
    match object.get_index(tc, index) {
        Some(value) => Ok(Value(v8::Global::new(tc, value))),
        None => Err(caught!(tc)),
    }
}

pub fn set_index(target: &Value, index: u32, value: &Value) -> Result<(), Error> {
    enter!(scope);
    v8::tc_scope!(let tc, scope);
    let local = v8::Local::new(tc, &target.0);
    let Some(object) = local.to_object(tc) else {
        return Err(Error::text("TypeError", "cannot index a non-object"));
    };
    let value_local = v8::Local::new(tc, &value.0);
    match object.set_index(tc, index, value_local) {
        Some(_) => Ok(()),
        None => Err(caught!(tc)),
    }
}

/// The value's own enumerable string keys, in JavaScript order.
pub fn own_keys(target: &Value) -> Result<Vec<String>, Error> {
    enter!(scope);
    v8::tc_scope!(let tc, scope);
    let local = v8::Local::new(tc, &target.0);
    let Some(object) = local.to_object(tc) else {
        return Ok(Vec::new());
    };
    let Some(names) = object.get_own_property_names(tc, v8::GetPropertyNamesArgs::default()) else {
        return Err(caught!(tc));
    };
    let mut out = Vec::with_capacity(names.length() as usize);
    for index in 0..names.length() {
        if let Some(name) = names.get_index(tc, index) {
            out.push(name.to_rust_string_lossy(tc));
        }
    }
    Ok(out)
}

/* ── values ────────────────────────────────────────────────────────── */

pub fn undefined() -> Value {
    enter!(scope);
    let local: v8::Local<v8::Value> = v8::undefined(scope).into();
    keep(scope, local)
}

pub fn null() -> Value {
    enter!(scope);
    let local: v8::Local<v8::Value> = v8::null(scope).into();
    keep(scope, local)
}

pub fn number(value: f64) -> Value {
    enter!(scope);
    let local: v8::Local<v8::Value> = v8::Number::new(scope, value).into();
    keep(scope, local)
}

pub fn boolean(value: bool) -> Value {
    enter!(scope);
    let local: v8::Local<v8::Value> = v8::Boolean::new(scope, value).into();
    keep(scope, local)
}

pub fn string(value: &str) -> Value {
    enter!(scope);
    let local = v8::String::new(scope, value).unwrap_or_else(|| v8::String::empty(scope));
    keep(scope, local.into())
}

/// A fresh `Uint8Array` holding a copy of `bytes`.
pub fn bytes(bytes: &[u8]) -> Value {
    enter!(scope);
    let store = v8::ArrayBuffer::new_backing_store_from_vec(bytes.to_vec()).make_shared();
    let buffer = v8::ArrayBuffer::with_backing_store(scope, &store);
    let array = v8::Uint8Array::new(scope, buffer, 0, bytes.len()).expect("scriptc island (v8): Uint8Array");
    keep(scope, array.into())
}

pub fn array(items: &[Value]) -> Value {
    enter!(scope);
    let elements = locals(scope, items);
    let array = v8::Array::new_with_elements(scope, &elements);
    keep(scope, array.into())
}

pub fn object() -> Value {
    enter!(scope);
    let local: v8::Local<v8::Value> = v8::Object::new(scope).into();
    keep(scope, local)
}

pub fn regexp(source: &str, flags: &str) -> Result<Value, Error> {
    enter!(scope);
    v8::tc_scope!(let tc, scope);
    let pattern = v8::String::new(tc, source).unwrap_or_else(|| v8::String::empty(tc));
    let mut parsed = v8::RegExpCreationFlags::empty();
    for flag in flags.chars() {
        parsed |= match flag {
            'g' => v8::RegExpCreationFlags::GLOBAL,
            'i' => v8::RegExpCreationFlags::IGNORE_CASE,
            'm' => v8::RegExpCreationFlags::MULTILINE,
            's' => v8::RegExpCreationFlags::DOT_ALL,
            'u' => v8::RegExpCreationFlags::UNICODE,
            'v' => v8::RegExpCreationFlags::UNICODE_SETS,
            'y' => v8::RegExpCreationFlags::STICKY,
            'd' => v8::RegExpCreationFlags::HAS_INDICES,
            other => return Err(Error::text("SyntaxError", format!("Invalid regular expression flags: {other}"))),
        };
    }
    match v8::RegExp::new(tc, pattern, parsed) {
        Some(regexp) => Ok(keep(tc, regexp.into())),
        None => Err(caught!(tc)),
    }
}

pub fn date(ms: f64) -> Value {
    enter!(scope);
    let date = v8::Date::new(scope, ms).expect("scriptc island (v8): Date");
    keep(scope, date.into())
}

pub fn json_parse(text: &str) -> Result<Value, Error> {
    enter!(scope);
    v8::tc_scope!(let tc, scope);
    let Some(source) = v8::String::new(tc, text) else {
        return Err(Error::text("RangeError", "JSON text too large for the engine"));
    };
    match v8::json::parse(tc, source) {
        Some(value) => Ok(Value(v8::Global::new(tc, value))),
        None => Err(caught!(tc)),
    }
}

/// `JSON.stringify(value)`; `None` when the value has no JSON form
/// (undefined, a function, a symbol).
pub fn json_stringify(value: &Value) -> Result<Option<String>, Error> {
    enter!(scope);
    v8::tc_scope!(let tc, scope);
    let local = v8::Local::new(tc, &value.0);
    match v8::json::stringify(tc, local) {
        Some(text) => Ok(Some(text.to_rust_string_lossy(tc))),
        None if tc.has_caught() => Err(caught!(tc)),
        None => Ok(None),
    }
}

pub fn type_of(value: &Value) -> String {
    enter!(scope);
    let local = v8::Local::new(scope, &value.0);
    local.type_of(scope).to_rust_string_lossy(scope)
}

pub fn is_undefined(value: &Value) -> bool {
    enter!(scope);
    v8::Local::new(scope, &value.0).is_undefined()
}

pub fn is_null(value: &Value) -> bool {
    enter!(scope);
    v8::Local::new(scope, &value.0).is_null()
}

pub fn is_function(value: &Value) -> bool {
    enter!(scope);
    v8::Local::new(scope, &value.0).is_function()
}

pub fn is_object(value: &Value) -> bool {
    enter!(scope);
    v8::Local::new(scope, &value.0).is_object()
}

pub fn is_promise(value: &Value) -> bool {
    enter!(scope);
    v8::Local::new(scope, &value.0).is_promise()
}

pub fn is_native_error(value: &Value) -> bool {
    enter!(scope);
    v8::Local::new(scope, &value.0).is_native_error()
}

pub fn is_uint8_array(value: &Value) -> bool {
    enter!(scope);
    v8::Local::new(scope, &value.0).is_uint8_array()
}

pub fn is_array(value: &Value) -> bool {
    enter!(scope);
    v8::Local::new(scope, &value.0).is_array()
}

pub fn as_number(value: &Value) -> Option<f64> {
    enter!(scope);
    let local = v8::Local::new(scope, &value.0);
    if local.is_number() { local.number_value(scope) } else { None }
}

pub fn as_bool(value: &Value) -> Option<bool> {
    enter!(scope);
    let local = v8::Local::new(scope, &value.0);
    if local.is_boolean() { Some(local.boolean_value(scope)) } else { None }
}

pub fn as_string(value: &Value) -> Option<String> {
    enter!(scope);
    let local = v8::Local::new(scope, &value.0);
    if local.is_string() { Some(local.to_rust_string_lossy(scope)) } else { None }
}

/// A copy of a Uint8Array's (or any ArrayBufferView's) bytes.
pub fn as_bytes(value: &Value) -> Option<Vec<u8>> {
    enter!(scope);
    let local = v8::Local::new(scope, &value.0);
    let view = v8::Local::<v8::ArrayBufferView>::try_from(local).ok()?;
    let mut out = vec![0_u8; view.byte_length()];
    let copied = view.copy_contents(&mut out);
    out.truncate(copied);
    Some(out)
}

pub fn to_string(value: &Value) -> Result<String, Error> {
    enter!(scope);
    v8::tc_scope!(let tc, scope);
    let local = v8::Local::new(tc, &value.0);
    match local.to_string(tc) {
        Some(text) => Ok(text.to_rust_string_lossy(tc)),
        None => Err(caught!(tc)),
    }
}

pub fn to_number(value: &Value) -> Result<f64, Error> {
    enter!(scope);
    v8::tc_scope!(let tc, scope);
    let local = v8::Local::new(tc, &value.0);
    match local.number_value(tc) {
        Some(number) => Ok(number),
        None => Err(caught!(tc)),
    }
}

pub fn truthy(value: &Value) -> bool {
    enter!(scope);
    v8::Local::new(scope, &value.0).boolean_value(scope)
}

pub fn strict_equal(left: &Value, right: &Value) -> bool {
    enter!(scope);
    let a = v8::Local::new(scope, &left.0);
    let b = v8::Local::new(scope, &right.0);
    a.strict_equals(b)
}

pub fn instance_of(value: &Value, target: &Value) -> Result<bool, Error> {
    enter!(scope);
    v8::tc_scope!(let tc, scope);
    let local = v8::Local::new(tc, &value.0);
    let target_local = v8::Local::new(tc, &target.0);
    let Ok(object) = v8::Local::<v8::Object>::try_from(target_local) else {
        return Err(Error::text("TypeError", "Right-hand side of 'instanceof' is not callable"));
    };
    match local.instance_of(tc, object) {
        Some(answer) => Ok(answer),
        None => Err(caught!(tc)),
    }
}

/* ── host functions ────────────────────────────────────────────────── */

fn host_trampoline(
    scope: &mut v8::PinScope<'_, '_>,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    let index = match v8::Local::<v8::External>::try_from(args.data()) {
        Ok(external) => external.value() as usize,
        Err(_) => {
            let message = v8::String::new(scope, "scriptc island (v8): host function without its index").unwrap();
            let exception = v8::Exception::error(scope, message);
            scope.throw_exception(exception);
            return;
        }
    };
    let host = with_engine(|engine| engine.host_fns.get(index).cloned());
    let Some(host) = host else {
        let message = v8::String::new(scope, "scriptc island (v8): host function index out of range").unwrap();
        let exception = v8::Exception::error(scope, message);
        scope.throw_exception(exception);
        return;
    };
    let mut values = Vec::with_capacity(args.length() as usize);
    for i in 0..args.length() {
        values.push(Value(v8::Global::new(scope, args.get(i))));
    }
    let result = match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| host(&values))) {
        Ok(result) => result,
        Err(payload) => {
            PARKED.with(|slot| *slot.borrow_mut() = Some(payload));
            let message = v8::String::new(scope, "scriptc: a host function is unwinding (parked)").unwrap();
            let exception = v8::Exception::error(scope, message);
            scope.throw_exception(exception);
            return;
        }
    };
    match result {
        HostResult::Undefined => rv.set_undefined(),
        HostResult::Null => rv.set_null(),
        HostResult::Number(n) => rv.set_double(n),
        HostResult::Bool(b) => rv.set_bool(b),
        HostResult::String(s) => {
            let local = v8::String::new(scope, &s).unwrap_or_else(|| v8::String::empty(scope));
            rv.set(local.into());
        }
        HostResult::Bytes(b) => {
            let store = v8::ArrayBuffer::new_backing_store_from_vec(b).make_shared();
            let buffer = v8::ArrayBuffer::with_backing_store(scope, &store);
            let length = buffer.byte_length();
            let array = v8::Uint8Array::new(scope, buffer, 0, length).expect("scriptc island (v8): Uint8Array");
            rv.set(array.into());
        }
        HostResult::Value(value) => {
            let local = v8::Local::new(scope, &value.0);
            rv.set(local);
        }
        HostResult::Throw(error) => {
            let exception = error_value(scope, &error);
            scope.throw_exception(exception);
        }
    }
}

/// A function the engine can call that runs `host` with the arguments as
/// handles. `arity` is what `fn.length` reports.
pub fn host_function(name: &str, arity: i32, host: HostFn) -> Value {
    let index = with_engine(|engine| {
        engine.host_fns.push(host);
        engine.host_fns.len() - 1
    });
    enter!(scope);
    let data = v8::External::new(scope, index as *mut std::ffi::c_void);
    let function = v8::Function::builder(host_trampoline)
        .data(data.into())
        .length(arity)
        .build(scope)
        .expect("scriptc island (v8): host function");
    if let Some(label) = v8::String::new(scope, name) {
        function.set_name(label);
    }
    keep(scope, function.into())
}

/* ── promises and jobs ─────────────────────────────────────────────── */

/// A pending promise plus its settling functions.
pub struct Resolver(v8::Global<v8::PromiseResolver>);

pub fn promise_new() -> (Value, Resolver) {
    enter!(scope);
    let resolver = v8::PromiseResolver::new(scope).expect("scriptc island (v8): PromiseResolver");
    let promise = resolver.get_promise(scope);
    (keep(scope, promise.into()), Resolver(v8::Global::new(scope, resolver)))
}

impl Resolver {
    pub fn resolve(&self, value: &Value) {
        enter!(scope);
        let resolver = v8::Local::new(scope, &self.0);
        let local = v8::Local::new(scope, &value.0);
        resolver.resolve(scope, local);
    }

    pub fn reject(&self, reason: &Value) {
        enter!(scope);
        let resolver = v8::Local::new(scope, &self.0);
        let local = v8::Local::new(scope, &reason.0);
        resolver.reject(scope, local);
    }
}

pub fn promise_state(value: &Value) -> Option<PromiseState> {
    enter!(scope);
    let local = v8::Local::new(scope, &value.0);
    let promise = v8::Local::<v8::Promise>::try_from(local).ok()?;
    Some(match promise.state() {
        v8::PromiseState::Pending => PromiseState::Pending,
        v8::PromiseState::Fulfilled => PromiseState::Fulfilled(Value(v8::Global::new(scope, promise.result(scope)))),
        v8::PromiseState::Rejected => PromiseState::Rejected(Value(v8::Global::new(scope, promise.result(scope)))),
    })
}

/// `promise.then(on_fulfilled, on_rejected)` with host reactions.
pub fn promise_then(value: &Value, on_fulfilled: HostFn, on_rejected: HostFn) -> Result<(), Error> {
    let fulfilled = host_function("onFulfilled", 1, on_fulfilled);
    let rejected = host_function("onRejected", 1, on_rejected);
    enter!(scope);
    v8::tc_scope!(let tc, scope);
    let local = v8::Local::new(tc, &value.0);
    let Ok(promise) = v8::Local::<v8::Promise>::try_from(local) else {
        return Err(Error::text("TypeError", "value is not a promise"));
    };
    let f = v8::Local::<v8::Function>::try_from(v8::Local::new(tc, &fulfilled.0)).expect("host function");
    let r = v8::Local::<v8::Function>::try_from(v8::Local::new(tc, &rejected.0)).expect("host function");
    match promise.then2(tc, f, r) {
        Some(_) => Ok(()),
        None => Err(caught!(tc)),
    }
}

/// Runs every queued microtask.
pub fn run_microtasks() {
    let _entry_guard = EntryGuard::enter();
    let ptr = isolate_ptr();
    // SAFETY: as in `enter!`.
    let isolate: &mut v8::Isolate = unsafe { &mut *ptr };
    isolate.perform_microtask_checkpoint();
}

extern "C" fn promise_reject_callback(message: v8::PromiseRejectMessage) {
    v8::callback_scope!(unsafe scope, &message);
    let promise = message.get_promise();
    match message.get_event() {
        v8::PromiseRejectEvent::PromiseRejectWithNoHandler => {
            let reason = message.get_value().unwrap_or_else(|| v8::undefined(scope).into());
            let entry = (v8::Global::new(scope, promise), v8::Global::new(scope, reason));
            with_engine(|engine| engine.unhandled.push(entry));
        }
        v8::PromiseRejectEvent::PromiseHandlerAddedAfterReject => {
            let target = v8::Global::new(scope, promise);
            with_engine(|engine| engine.unhandled.retain(|(candidate, _)| *candidate != target));
        }
        _ => {}
    }
}

/// Rejections nobody handled by now, oldest first (taken: a later call
/// reports only new ones).
pub fn take_unhandled_rejections() -> Vec<(Value, Value)> {
    let taken = with_engine(|engine| std::mem::take(&mut engine.unhandled));
    taken
        .into_iter()
        .map(|(promise, reason)| {
            enter!(scope);
            let promise_local: v8::Local<v8::Value> = v8::Local::new(scope, &promise).into();
            (Value(v8::Global::new(scope, promise_local)), Value(reason))
        })
        .collect()
}

/* ── modules ───────────────────────────────────────────────────────── */

pub fn set_module_resolver(resolver: ModuleResolver) {
    with_engine(|engine| engine.resolver = Some(resolver));
}

fn resolve_source(referrer: &str, specifier: &str) -> Result<ModuleSource, String> {
    let resolver = with_engine(|engine| engine.resolver.clone());
    match resolver {
        Some(resolver) => resolver(referrer, specifier),
        None => Err(format!("module '{specifier}' cannot be resolved: no module resolver installed")),
    }
}

fn synthetic_json_steps<'s>(
    context: v8::Local<'s, v8::Context>,
    module: v8::Local<v8::Module>,
) -> Option<v8::Local<'s, v8::Value>> {
    v8::callback_scope!(unsafe scope, context);
    let key = with_engine(|engine| engine.module_keys.get(&module.get_identity_hash().get()).cloned())?;
    let text = with_engine(|engine| engine.module_sources.get(&key).cloned())?;
    let source = v8::String::new(scope, &text)?;
    let value = v8::json::parse(scope, source)?;
    let name = v8::String::new(scope, "default")?;
    module.set_synthetic_module_export(scope, name, value)?;
    Some(v8::undefined(scope).into())
}

/// Compiles (or finds) the module behind `source`, registering its key.
fn module_for<'s>(scope: &mut v8::PinScope<'s, '_>, source: ModuleSource) -> Option<v8::Local<'s, v8::Module>> {
    if let Some(existing) = with_engine(|engine| engine.modules.get(&source.key).cloned()) {
        return Some(v8::Local::new(scope, &existing));
    }
    let name = v8::String::new(scope, &source.key)?;
    let compile_started = std::time::Instant::now();
    let module = if source.json {
        let export_names = [v8::String::new(scope, "default")?];
        with_engine(|engine| {
            engine.module_sources.insert(source.key.clone(), source.source.to_string());
        });
        v8::Module::create_synthetic_module(scope, name, &export_names, synthetic_json_steps)
    } else {
        let text = source_string(scope, &source.source, source.static_text())?;
        let origin = v8::ScriptOrigin::new(scope, name.into(), 0, 0, false, 0, None, false, false, true, None);
        let (module, usable) = match &source.code_cache {
            Some(bytes) => {
                let cached = v8::script_compiler::CachedData::new(bytes.as_slice());
                let mut compiled = v8::script_compiler::Source::new_with_cached_data(text, Some(&origin), cached);
                let module = v8::script_compiler::compile_module2(
                    scope,
                    &mut compiled,
                    v8::script_compiler::CompileOptions::ConsumeCodeCache,
                    v8::script_compiler::NoCacheReason::NoReason,
                )?;
                let rejected = compiled.get_cached_data().is_none_or(|data| data.rejected());
                (module, !rejected)
            }
            None => {
                let mut compiled = v8::script_compiler::Source::new(text, Some(&origin));
                (v8::script_compiler::compile_module(scope, &mut compiled)?, false)
            }
        };
        if !usable {
            with_engine(|engine| engine.cache_misses.push(source.key.clone()));
        }
        stats_update(|stats| {
            stats.compiles += 1;
            stats.cache_hits += u32::from(usable);
        });
        module
    };
    stats_update(|stats| stats.compile_ns += compile_started.elapsed().as_nanos());
    let global = v8::Global::new(scope, module);
    with_engine(|engine| {
        engine.modules.insert(source.key.clone(), global);
        engine.module_keys.insert(module.get_identity_hash().get(), source.key.clone());
    });
    Some(module)
}

/// `import.meta.url` for a module whose key is an absolute path: its
/// file URL (a key that is not a path — `node:x`, a synthetic name —
/// gets no `url`, as in Node for non-file modules).
extern "C" fn import_meta_callback(
    context: v8::Local<v8::Context>,
    module: v8::Local<v8::Module>,
    meta: v8::Local<v8::Object>,
) {
    v8::callback_scope!(unsafe scope, context);
    let Some(key) = with_engine(|engine| engine.module_keys.get(&module.get_identity_hash().get()).cloned()) else {
        return;
    };
    let path = std::path::Path::new(&key);
    if !path.is_absolute() {
        return;
    }
    let mut url = String::from("file://");
    for component in path.components() {
        match component {
            std::path::Component::RootDir => {}
            std::path::Component::Normal(part) => {
                url.push('/');
                for byte in part.to_string_lossy().bytes() {
                    match byte {
                        b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' | b'!' | b'$' | b'&' | b'\'' | b'(' | b')' | b'*' | b'+' | b',' | b';' | b'=' | b':' | b'@' => url.push(byte as char),
                        _ => url.push_str(&format!("%{byte:02X}")),
                    }
                }
            }
            _ => return,
        }
    }
    if let (Some(name), Some(value)) = (v8::String::new(scope, "url"), v8::String::new(scope, &url)) {
        meta.set(scope, name.into(), value.into());
    }
}

fn resolve_module_callback<'s>(
    context: v8::Local<'s, v8::Context>,
    specifier: v8::Local<'s, v8::String>,
    _import_attributes: v8::Local<'s, v8::FixedArray>,
    referrer: v8::Local<'s, v8::Module>,
) -> Option<v8::Local<'s, v8::Module>> {
    v8::callback_scope!(unsafe scope, context);
    let referrer_key = with_engine(|engine| engine.module_keys.get(&referrer.get_identity_hash().get()).cloned()).unwrap_or_default();
    let spec = specifier.to_rust_string_lossy(scope);
    match resolve_source(&referrer_key, &spec) {
        Ok(source) => module_for(scope, source),
        Err(message) => {
            let text = v8::String::new(scope, &message)?;
            let exception = v8::Exception::reference_error(scope, text);
            scope.throw_exception(exception);
            None
        }
    }
}

/// How far a module's evaluation got.
enum Evaluation<'s> {
    /// Evaluated: its namespace.
    Done(v8::Local<'s, v8::Value>),
    /// A top-level await keeps it pending: the evaluation promise.
    Pending(v8::Local<'s, v8::Promise>),
    /// Still inside its own synchronous evaluation (a cycle reached
    /// through `import()`): usable once the current evaluation returns.
    Cycle,
}

/// Instantiates and evaluates `module` (once — a module never evaluates
/// twice, and no namespace is read below `EvaluatingAsync`, which V8
/// checks fatally), draining microtasks; Err on a link or evaluation
/// failure.
struct PhaseDepthGuard;

impl Drop for PhaseDepthGuard {
    fn drop(&mut self) {
        PHASE_DEPTH.with(|depth| depth.set(depth.get().saturating_sub(1)));
    }
}

fn evaluate_module<'s>(scope: &mut v8::PinScope<'s, '_>, key: &str, module: v8::Local<'s, v8::Module>) -> Result<Evaluation<'s>, Error> {
    v8::tc_scope!(let tc, scope);
    // Only a ROOT call (not one nested through a host callback) accounts
    // its phases, so dependencies compiled during instantiate and
    // modules evaluated during evaluate are not double-counted.
    let root = PHASE_DEPTH.with(|depth| {
        let outer = depth.get() == 0;
        depth.set(depth.get() + 1);
        outer
    });
    let _depth_guard = PhaseDepthGuard;
    if module.get_status() == v8::ModuleStatus::Uninstantiated {
        let started = std::time::Instant::now();
        let instantiated = module.instantiate_module(tc, resolve_module_callback).is_some();
        if root {
            stats_update(|stats| stats.instantiate_ns += started.elapsed().as_nanos());
        }
        if !instantiated {
            return Err(caught!(tc));
        }
    }
    if module.get_status() == v8::ModuleStatus::Instantiated {
        let started = std::time::Instant::now();
        let evaluated = module.evaluate(tc);
        if root {
            stats_update(|stats| stats.evaluate_ns += started.elapsed().as_nanos());
        }
        let Some(promise_value) = evaluated else {
            return Err(caught!(tc));
        };
        if let Ok(promise) = v8::Local::<v8::Promise>::try_from(promise_value) {
            let global = v8::Global::new(tc, promise);
            with_engine(|engine| {
                engine.module_promises.insert(key.to_owned(), global);
            });
        }
    }
    // SAFETY: as in `enter!`.
    let isolate: &mut v8::Isolate = unsafe { &mut *isolate_ptr() };
    isolate.perform_microtask_checkpoint();
    match module.get_status() {
        // The API folds "evaluating async" (a top-level await in flight)
        // into Evaluated: the evaluation promise's state tells them apart.
        v8::ModuleStatus::Evaluated => {
            let stored = with_engine(|engine| engine.module_promises.get(key).cloned());
            if let Some(promise) = stored {
                let promise = v8::Local::new(tc, &promise);
                if promise.state() == v8::PromiseState::Pending {
                    return Ok(Evaluation::Pending(promise));
                }
            }
            Ok(Evaluation::Done(module.get_module_namespace()))
        }
        v8::ModuleStatus::Errored => {
            let exception = module.get_exception();
            Err(error_of(tc, exception))
        }
        _ => Ok(Evaluation::Cycle),
    }
}

/// Imports the module named `key` (through the resolver, with an empty
/// referrer), evaluating it and everything it reaches. Ok(None) when a
/// top-level await (or a cycle in progress) left it pending.
pub fn import_module(key: &str) -> Result<Option<Value>, Error> {
    enter!(scope);
    let source = resolve_source("", key).map_err(|message| Error::text("ReferenceError", message))?;
    let Some(module) = module_for(scope, source) else {
        v8::tc_scope!(let tc, scope);
        return Err(caught!(tc));
    };
    match evaluate_module(scope, key, module)? {
        Evaluation::Done(namespace) => Ok(Some(Value(v8::Global::new(scope, namespace)))),
        Evaluation::Pending(_) | Evaluation::Cycle => Ok(None),
    }
}

/// The namespace of an already-evaluated module, if any.
pub fn module_namespace(key: &str) -> Option<Value> {
    enter!(scope);
    let module = with_engine(|engine| engine.modules.get(key).cloned())?;
    let local = v8::Local::new(scope, &module);
    if local.get_status() != v8::ModuleStatus::Evaluated {
        return None;
    }
    Some(Value(v8::Global::new(scope, local.get_module_namespace())))
}

/// Where an engine's time went, for the runtime's trace: module
/// compiles (count and time, cache hits and misses), the root
/// instantiate and evaluate phases (nested calls are not double-counted).
#[derive(Clone, Copy, Default, Debug)]
pub struct Stats {
    pub compiles: u32,
    pub cache_hits: u32,
    pub compile_ns: u128,
    pub instantiate_ns: u128,
    pub evaluate_ns: u128,
}

thread_local! {
    static STATS: Cell<Stats> = const { Cell::new(Stats { compiles: 0, cache_hits: 0, compile_ns: 0, instantiate_ns: 0, evaluate_ns: 0 }) };
    static PHASE_DEPTH: Cell<u32> = const { Cell::new(0) };
}

fn stats_update(update: impl FnOnce(&mut Stats)) {
    STATS.with(|slot| {
        let mut stats = slot.get();
        update(&mut stats);
        slot.set(stats);
    });
}

/// The counters since `init`.
pub fn stats() -> Stats {
    STATS.with(Cell::get)
}

/// A V8 string for a source text: a borrowed ASCII text is wrapped as an
/// external one-byte string (V8 reads the bytes in place for the
/// isolate's life); anything else is copied in.
fn source_string<'s>(scope: &mut v8::PinScope<'s, '_>, text: &str, static_text: Option<&'static str>) -> Option<v8::Local<'s, v8::String>> {
    match static_text {
        Some(text) if text.is_ascii() => v8::String::new_external_onebyte_static(scope, text.as_bytes()),
        _ => v8::String::new(scope, text),
    }
}

impl ModuleSource {
    /// The text when it is borrowed for the process's life.
    fn static_text(&self) -> Option<&'static str> {
        match &self.source {
            std::borrow::Cow::Borrowed(text) => Some(text),
            std::borrow::Cow::Owned(_) => None,
        }
    }
}

/// `eval` with a code cache: `cache` (from an earlier `eval_cached` of
/// the same source) is consumed when V8 accepts it; when it is missing
/// or rejected, the cache produced after the run comes back for storage.
pub fn eval_cached(source: &'static str, name: &str, cache: Option<Rc<Vec<u8>>>) -> Result<(Value, Option<Vec<u8>>), Error> {
    enter!(scope);
    v8::tc_scope!(let tc, scope);
    let code = match source_string(tc, source, Some(source)) {
        Some(code) => code,
        None => return Err(Error::text("RangeError", "source too large for the engine")),
    };
    let resource = v8::String::new(tc, name).unwrap_or_else(|| v8::String::empty(tc));
    let origin = v8::ScriptOrigin::new(tc, resource.into(), 0, 0, false, 0, None, false, false, false, None);
    let (script, usable) = match cache {
        Some(bytes) => {
            let cached = v8::script_compiler::CachedData::new(bytes.as_slice());
            let mut compiled = v8::script_compiler::Source::new_with_cached_data(code, Some(&origin), cached);
            let script = v8::script_compiler::compile_unbound_script(
                tc,
                &mut compiled,
                v8::script_compiler::CompileOptions::ConsumeCodeCache,
                v8::script_compiler::NoCacheReason::NoReason,
            );
            let rejected = compiled.get_cached_data().is_none_or(|data| data.rejected());
            (script, !rejected)
        }
        None => {
            let mut compiled = v8::script_compiler::Source::new(code, Some(&origin));
            (v8::script_compiler::compile_unbound_script(tc, &mut compiled, v8::script_compiler::CompileOptions::NoCompileOptions, v8::script_compiler::NoCacheReason::NoReason), false)
        }
    };
    let Some(unbound) = script else {
        return Err(caught!(tc));
    };
    let script = unbound.bind_to_current_context(tc);
    let Some(value) = script.run(tc) else {
        return Err(caught!(tc));
    };
    let produced = if usable { None } else { unbound.create_code_cache().map(|data| data.to_vec()) };
    Ok((Value(v8::Global::new(tc, value)), produced))
}

/// The version tag of the code cache format this V8 produces; a cache
/// produced under another tag is rejected at compile, so callers key
/// their store by it.
pub fn code_cache_version() -> u32 {
    v8::script_compiler::cached_data_version_tag()
}

/// Code caches for the modules compiled without a usable one this run,
/// produced from their current state (after evaluation, so functions
/// compiled lazily since are included). Each key is reported once.
pub fn module_code_caches() -> Vec<(String, Vec<u8>)> {
    if !is_initialized() {
        return Vec::new();
    }
    enter!(scope);
    let misses = with_engine(|engine| std::mem::take(&mut engine.cache_misses));
    let mut caches = Vec::with_capacity(misses.len());
    for key in misses {
        let Some(module) = with_engine(|engine| engine.modules.get(&key).cloned()) else { continue };
        let local = v8::Local::new(scope, &module);
        if local.get_status() == v8::ModuleStatus::Errored || !local.is_source_text_module() {
            continue;
        }
        let script = local.get_unbound_module_script(scope);
        if let Some(data) = script.create_code_cache() {
            caches.push((key, data.to_vec()));
        }
    }
    caches
}

/// One deferred step of a dynamic import: evaluate the module now (the
/// importer's own evaluation has returned by the time the microtask
/// runs) and answer its namespace — or its evaluation promise chained to
/// a namespace getter while a top-level await keeps it pending.
fn import_step(source: &ModuleSource) -> HostResult {
    enter!(scope);
    let key = source.key.as_str();
    let Some(module) = module_for(scope, source.clone()) else {
        v8::tc_scope!(let tc, scope);
        return HostResult::Throw(caught!(tc));
    };
    match evaluate_module(scope, key, module) {
        Err(error) => HostResult::Throw(error),
        Ok(Evaluation::Done(namespace)) => HostResult::Value(Value(v8::Global::new(scope, namespace))),
        Ok(Evaluation::Pending(promise)) => {
            let owned = key.to_owned();
            let getter = host_function("namespaceOf", 0, Rc::new(move |_| match module_namespace(&owned) {
                Some(namespace) => HostResult::Value(namespace),
                None => HostResult::Throw(Error::text("Error", format!("module '{owned}' did not finish evaluating"))),
            }));
            let Some(text) = v8::String::new(scope, "(p, get) => p.then(() => get())") else {
                return HostResult::Throw(Error::text("Error", "engine string"));
            };
            let Some(helper) = v8::Script::compile(scope, text, None).and_then(|script| script.run(scope)) else {
                return HostResult::Throw(Error::text("Error", "engine helper"));
            };
            let Ok(helper) = v8::Local::<v8::Function>::try_from(helper) else {
                return HostResult::Throw(Error::text("Error", "engine helper"));
            };
            let getter_local = v8::Local::new(scope, &getter.0);
            match helper.call(scope, v8::undefined(scope).into(), &[promise.into(), getter_local]) {
                Some(chained) => HostResult::Value(Value(v8::Global::new(scope, chained))),
                None => HostResult::Throw(Error::text("Error", "engine helper call")),
            }
        }
        Ok(Evaluation::Cycle) => HostResult::Throw(Error::text("Error", format!("module '{key}' did not finish evaluating"))),
    }
}

fn dynamic_import_callback<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    _host_defined_options: v8::Local<'s, v8::Data>,
    resource_name: v8::Local<'s, v8::Value>,
    specifier: v8::Local<'s, v8::String>,
    _import_attributes: v8::Local<'s, v8::FixedArray>,
) -> Option<v8::Local<'s, v8::Promise>> {
    let referrer = if resource_name.is_string() { resource_name.to_rust_string_lossy(scope) } else { String::new() };
    let spec = specifier.to_rust_string_lossy(scope);
    // Resolution happens now (the specifier is judged at the call site);
    // evaluation waits for a microtask, after the importer's own
    // evaluation has returned — V8 forbids evaluating a graph that is
    // mid-evaluation, and a cycle reached through import() is exactly
    // that.
    let source = match resolve_source(&referrer, &spec) {
        Ok(source) => source,
        Err(message) => {
            let resolver = v8::PromiseResolver::new(scope)?;
            let value = error_value(scope, &Error::text("ReferenceError", message));
            resolver.reject(scope, value);
            return Some(resolver.get_promise(scope));
        }
    };
    let step = host_function("importStep", 0, Rc::new(move |_| import_step(&source)));
    let step_local = v8::Local::new(scope, &step.0);
    let text = v8::String::new(scope, "(step) => Promise.resolve().then(() => step())")?;
    let helper = v8::Script::compile(scope, text, None)?.run(scope)?;
    let helper = v8::Local::<v8::Function>::try_from(helper).ok()?;
    let promise = helper.call(scope, v8::undefined(scope).into(), &[step_local])?;
    v8::Local::<v8::Promise>::try_from(promise).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup() {
        if !is_initialized() {
            init();
        }
    }

    #[test]
    fn evaluates_and_calls() {
        setup();
        let value = eval("1 + 2", "test.js").unwrap();
        assert_eq!(as_number(&value), Some(3.0));
        let function = eval("(a, b) => a * b", "test.js").unwrap();
        let product = call(&function, None, &[number(6.0), number(7.0)]).unwrap();
        assert_eq!(as_number(&product), Some(42.0));
        let thrown = eval("throw new TypeError('nope')", "test.js").unwrap_err();
        assert_eq!((thrown.name.as_str(), thrown.message.as_str()), ("TypeError", "nope"));
    }

    #[test]
    fn host_functions_and_reentry() {
        setup();
        let inner = eval("(x) => x + 1", "inner.js").unwrap();
        let host = host_function("twice", 1, Rc::new(move |args| {
            let once = call(&inner, None, &[args[0].clone()]).unwrap();
            let twice = call(&inner, None, &[once]).unwrap();
            HostResult::Number(as_number(&twice).unwrap())
        }));
        let global_object = global();
        set(&global_object, "twice", &host).unwrap();
        let out = eval("twice(40)", "test.js").unwrap();
        assert_eq!(as_number(&out), Some(42.0));
        let throwing = host_function("boom", 0, Rc::new(|_| HostResult::Throw(Error { name: "RangeError".into(), message: "too far".into(), code: Some("ERR_FAR".into()), stack: None, value: None })));
        set(&global_object, "boom", &throwing).unwrap();
        let caught = eval("try { boom() } catch (e) { e.name + ':' + e.message + ':' + e.code }", "test.js").unwrap();
        assert_eq!(as_string(&caught).as_deref(), Some("RangeError:too far:ERR_FAR"));
    }

    #[test]
    fn modules_static_and_dynamic() {
        setup();
        set_module_resolver(Rc::new(|referrer, specifier| match (referrer, specifier) {
            (_, "main") => Ok(ModuleSource { key: "main".into(), source: "import { v } from './dep'; import data from './data.json'; export const out = v * 2 + data.n; export const lazy = import('./dep');".into(), json: false, code_cache: None }),
            ("main", "./dep") | ("", "./dep") => Ok(ModuleSource { key: "dep".into(), source: "export const v = 20;".into(), json: false, code_cache: None }),
            ("main", "./data.json") => Ok(ModuleSource { key: "data.json".into(), source: "{\"n\": 2}".into(), json: true, code_cache: None }),
            (r, s) => Err(format!("cannot resolve {s} from {r}")),
        }));
        let namespace = import_module("main").unwrap().expect("settled");
        let out = get(&namespace, "out").unwrap();
        assert_eq!(as_number(&out), Some(42.0));
        run_microtasks();
        let lazy = get(&namespace, "lazy").unwrap();
        match promise_state(&lazy).unwrap() {
            PromiseState::Fulfilled(ns) => assert_eq!(as_number(&get(&ns, "v").unwrap()), Some(20.0)),
            _ => panic!("dynamic import did not settle"),
        }
        let missing = import_module("nope").unwrap_err();
        assert_eq!(missing.name, "ReferenceError");
    }

    #[test]
    fn code_cache_round_trips_across_isolates() {
        setup();
        let source = "export function f(n) { return n * 3; } export const v = f(14);";
        set_module_resolver(Rc::new(move |_, specifier| match specifier {
            "cached" => Ok(ModuleSource { key: "cached".into(), source: source.into(), json: false, code_cache: None }),
            other => Err(format!("no {other}")),
        }));
        let ns = import_module("cached").unwrap().unwrap();
        assert_eq!(as_number(&get(&ns, "v").unwrap()), Some(42.0));
        let caches = module_code_caches();
        assert_eq!(caches.len(), 1);
        assert_eq!(caches[0].0, "cached");
        assert!(!caches[0].1.is_empty());
        assert!(module_code_caches().is_empty(), "each miss is reported once");
        let bytes = Rc::new(caches.into_iter().next().unwrap().1);
        finish();
        init();
        set_module_resolver(Rc::new(move |_, specifier| match specifier {
            "cached" => Ok(ModuleSource { key: "cached".into(), source: source.into(), json: false, code_cache: Some(bytes.clone()) }),
            other => Err(format!("no {other}")),
        }));
        let ns = import_module("cached").unwrap().unwrap();
        assert_eq!(as_number(&get(&ns, "v").unwrap()), Some(42.0));
        assert!(module_code_caches().is_empty(), "the consumed cache was accepted");
        let stale = Rc::new(vec![1u8, 2, 3, 4]);
        set_module_resolver(Rc::new(move |_, specifier| match specifier {
            "stale" => Ok(ModuleSource { key: "stale".into(), source: "export const s = 1;".into(), json: false, code_cache: Some(stale.clone()) }),
            other => Err(format!("no {other}")),
        }));
        let ns = import_module("stale").unwrap().unwrap();
        assert_eq!(as_number(&get(&ns, "s").unwrap()), Some(1.0));
        assert_eq!(module_code_caches().len(), 1, "a rejected cache is regenerated");
    }

    #[test]
    fn import_meta_url_of_a_path_key() {
        setup();
        set_module_resolver(Rc::new(|_, specifier| match specifier {
            "/tmp/scriptc meta/mod.js" => Ok(ModuleSource { key: specifier.into(), source: "export const u = import.meta.url;".into(), json: false, code_cache: None }),
            other => Err(format!("no {other}")),
        }));
        let ns = import_module("/tmp/scriptc meta/mod.js").unwrap().unwrap();
        assert_eq!(as_string(&get(&ns, "u").unwrap()).as_deref(), Some("file:///tmp/scriptc%20meta/mod.js"));
    }

    #[test]
    fn dynamic_import_of_pending_and_cyclic_modules() {
        setup();
        set_module_resolver(Rc::new(|_, specifier| match specifier {
            "tla-root" => Ok(ModuleSource { key: "tla-root".into(), source: "export const later = import('./tla'); export const cyc = import('./cycle-a');".into(), json: false, code_cache: None }),
            "./tla" => Ok(ModuleSource { key: "tla".into(), source: "await Promise.resolve(); export const v = 'after await';".into(), json: false, code_cache: None }),
            "./cycle-a" => Ok(ModuleSource { key: "cycle-a".into(), source: "import './cycle-b'; export const a = 1;".into(), json: false, code_cache: None }),
            "./cycle-b" => Ok(ModuleSource { key: "cycle-b".into(), source: "export const b = import('./cycle-a');".into(), json: false, code_cache: None }),
            other => Err(format!("no {other}")),
        }));
        let ns = import_module("tla-root").unwrap().expect("root settles");
        run_microtasks();
        run_microtasks();
        match promise_state(&get(&ns, "later").unwrap()).unwrap() {
            PromiseState::Fulfilled(tla) => assert_eq!(as_string(&get(&tla, "v").unwrap()).as_deref(), Some("after await")),
            PromiseState::Rejected(reason) => panic!("rejected: {}", to_string(&reason).unwrap()),
            PromiseState::Pending => panic!("tla import pending"),
        }
        let cyc = get(&ns, "cyc").unwrap();
        let cyc_ns = match promise_state(&cyc).unwrap() { PromiseState::Fulfilled(v) => v, _ => panic!("cycle import did not settle") };
        let inner = get(&cyc_ns, "a").unwrap();
        assert_eq!(as_number(&inner), Some(1.0));
    }

    #[test]
    fn promises_bytes_and_json() {
        setup();
        let (promise, resolver) = promise_new();
        let seen = Rc::new(Cell::new(0.0));
        let seen_in = seen.clone();
        promise_then(&promise, Rc::new(move |args| { seen_in.set(as_number(&args[0]).unwrap()); HostResult::Undefined }), Rc::new(|_| HostResult::Undefined)).unwrap();
        resolver.resolve(&number(7.0));
        run_microtasks();
        assert_eq!(seen.get(), 7.0);
        let buffer = bytes(&[1, 2, 3]);
        assert_eq!(as_bytes(&buffer), Some(vec![1, 2, 3]));
        let parsed = json_parse("{\"a\":[1,true,null]}").unwrap();
        assert_eq!(json_stringify(&parsed).unwrap().as_deref(), Some("{\"a\":[1,true,null]}"));
        assert_eq!(type_of(&parsed), "object");
        let re = regexp("a+", "g").unwrap();
        assert_eq!(type_of(&re), "object");
        let d = date(0.0);
        assert!(instance_of(&d, &get(&global(), "Date").unwrap()).unwrap());
        let unhandled = eval("Promise.reject(new Error('late'))", "test.js").unwrap();
        let _ = unhandled;
        run_microtasks();
        let rejections = take_unhandled_rejections();
        assert_eq!(rejections.len(), 1);
    }

    #[test]
    fn host_unwind_is_parked_and_reraised() {
        setup();
        let bomb = host_function("bomb", 0, Rc::new(|_| -> HostResult { std::panic::resume_unwind(Box::new("scriptc-unwind")) }));
        set(&global(), "bomb", &bomb).unwrap();
        let outcome = std::panic::catch_unwind(|| eval("try { bomb() } catch (e) { 'swallowed' }", "test.js"));
        let payload = outcome.expect_err("the unwind must come back out");
        assert_eq!(payload.downcast_ref::<&str>(), Some(&"scriptc-unwind"));
        assert!(!unwind_parked());
        assert_eq!(as_number(&eval("1 + 1", "after.js").unwrap()), Some(2.0));
    }
}
