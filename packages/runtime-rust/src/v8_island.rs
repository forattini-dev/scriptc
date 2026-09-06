// The V8 island: the runtime's island surface (the same `island_*`
// entry points, types and host members the boa lane serves) over the
// sibling crate scriptc_island_v8. Everything engine-specific is one call
// into that crate; everything runtime-specific — module tables, native
// promises, timers, fs/child/sqlite kernels — is the same code the boa
// lane calls.
//
// Realm creation is lazy (the first island use), so a program that
// never reaches island code never pays for the engine.

use scriptc_island_v8 as v8e;

#[derive(Clone)]
pub struct IslandValue(pub(crate) v8e::Value);

impl HeapValue for IslandValue {}

/// One engine argument as a host closure sees it (island_host_functions).
#[derive(Clone)]
pub struct IslandHostArgument {
    value: IslandValue,
    bytes: Option<Rc<Vec<u8>>>,
}

pub enum IslandHostResult {
    Undefined,
    Null,
    Bool(bool),
    Number(f64),
    String(JsString),
    Bytes(Vec<u8>),
    Json(JsString),
    Island(IslandValue),
}

type IslandHostCallback = Rc<dyn Fn(&[IslandHostArgument]) -> IslandHostResult>;

thread_local! {
    static V8_BOOTED: Cell<bool> = const { Cell::new(false) };
    /// Files imported through `import(new URL(...))`: their keys are
    /// absolute paths the resolver reads from disk.
    static V8_EXTERNAL: RefCell<HashSet<String>> = RefCell::new(HashSet::new());
    /// Cached JavaScript helpers (compiled once per realm).
    static V8_HELPERS: RefCell<HashMap<&'static str, v8e::Value>> = RefCell::new(HashMap::new());
}

fn v8_trace() -> bool {
    std::env::var_os("SCRIPTC_ISLAND_TRACE").is_some()
}

/* ── errors ────────────────────────────────────────────────────────── */

fn v8_caught(error: &v8e::Error) -> Caught {
    caught_value(JsError {
        identity: Rc::new(()),
        name: error.name.clone(),
        message: error.message.clone(),
        code: error.code.clone(),
        cause: None,
        dom: None,
    })
}

/// An engine failure thrown into static code.
fn v8_throw(error: v8e::Error) -> ! {
    if v8_trace()
        && let Some(stack) = &error.stack
    {
        eprintln!("scriptc island (v8): {}", stack);
    }
    rethrow_caught(v8_caught(&error))
}

fn ok<T>(result: Result<T, v8e::Error>) -> T {
    result.unwrap_or_else(|error| v8_throw(error))
}

/// A caught scriptc error as the engine's error (name, message, code).
fn v8_error_of_caught(caught: &Caught) -> v8e::Error {
    if !caught_is_error(caught) {
        return v8e::Error {
            name: "Error".to_owned(),
            message: caught_to_string(caught).to_string(),
            code: None,
            stack: None,
            value: None,
        };
    }
    v8e::Error {
        name: caught_error_name(caught).to_string(),
        message: caught_error_message(caught).to_string(),
        code: caught_error_code(caught).map(|code| code.to_string()),
        stack: None,
        value: None,
    }
}

/// Runs a runtime primitive under a host function: a scriptc throw
/// becomes the engine's exception; any other panic keeps unwinding.
fn v8_guard<T>(body: impl FnOnce() -> T) -> Result<T, v8e::Error> {
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(body)) {
        Ok(value) => Ok(value),
        Err(payload) => {
            if is_scriptc_unwind(payload.as_ref()) {
                Err(v8_error_of_caught(&caught_from_panic(payload)))
            } else {
                std::panic::resume_unwind(payload)
            }
        }
    }
}

fn throw_result(error: v8e::Error) -> v8e::HostResult {
    v8e::HostResult::Throw(error)
}

fn type_error(message: impl Into<String>) -> v8e::Error {
    v8e::Error { name: "TypeError".to_owned(), message: message.into(), code: None, stack: None, value: None }
}

/* ── helpers over engine values ────────────────────────────────────── */

fn helper(name: &'static str, source: &str) -> v8e::Value {
    if let Some(cached) = V8_HELPERS.with(|helpers| helpers.borrow().get(name).cloned()) {
        return cached;
    }
    let function = ok(v8e::eval(source, name));
    V8_HELPERS.with(|helpers| {
        helpers.borrow_mut().insert(name, function.clone());
    });
    function
}

fn js_string(value: &JsString) -> v8e::Value {
    v8e::string(value.as_ref())
}

fn js_string_of(value: &v8e::Value) -> JsString {
    Rc::from(ok(v8e::to_string(value)).as_str())
}

fn string_array(values: &JsArray<JsString>) -> v8e::Value {
    let length = array_len(values) as usize;
    let items: Vec<v8e::Value> = (0..length).map(|index| js_string(&array_get(values, index as f64))).collect();
    v8e::array(&items)
}

fn arg(args: &[v8e::Value], index: usize) -> v8e::Value {
    args.get(index).cloned().unwrap_or_else(v8e::undefined)
}

fn arg_string(args: &[v8e::Value], index: usize) -> Result<String, v8e::Error> {
    v8e::to_string(&arg(args, index))
}

fn arg_js_string(args: &[v8e::Value], index: usize) -> Result<JsString, v8e::Error> {
    Ok(Rc::from(arg_string(args, index)?.as_str()))
}

fn arg_number(args: &[v8e::Value], index: usize) -> Result<f64, v8e::Error> {
    let value = arg(args, index);
    if v8e::is_undefined(&value) {
        return Ok(0.0);
    }
    v8e::to_number(&value)
}

fn arg_bool(args: &[v8e::Value], index: usize) -> bool {
    v8e::truthy(&arg(args, index))
}

fn arg_bytes(args: &[v8e::Value], index: usize) -> Result<JsBytes<u8>, v8e::Error> {
    match v8e::as_bytes(&arg(args, index)) {
        Some(bytes) => Ok(bytes_from_vec(bytes)),
        None => Err(type_error("the island host expects a Uint8Array argument")),
    }
}

fn arg_strings(args: &[v8e::Value], index: usize) -> Result<JsArray<JsString>, v8e::Error> {
    let value = arg(args, index);
    let mut out: Vec<JsString> = Vec::new();
    if v8e::is_array(&value) {
        let length = v8e::to_number(&v8e::get(&value, "length")?)? as usize;
        for i in 0..length {
            out.push(Rc::from(v8e::to_string(&v8e::get_index(&value, i as u32)?)?.as_str()));
        }
    }
    Ok(array_new(out))
}

fn bytes_value(bytes: &JsBytes<u8>) -> v8e::Value {
    v8e::bytes(&bytes_u8_values(bytes))
}

/* ── realm boot ────────────────────────────────────────────────────── */

fn v8_ensure() {
    if V8_BOOTED.with(Cell::get) {
        return;
    }
    V8_BOOTED.with(|flag| flag.set(true));
    if v8_trace() {
        eprintln!("scriptc island: creating realm (v8) on {:?}", std::thread::current().name());
    }
    v8e::init();
    v8e::set_module_resolver(Rc::new(v8_resolve));
    let global = v8e::global();
    let console = v8e::object();
    let log = v8e::host_function("log", 0, Rc::new(|args| {
        let mut parts = Vec::with_capacity(args.len());
        for value in args {
            match v8e::to_string(value) {
                Ok(text) => parts.push(text),
                Err(error) => return throw_result(error),
            }
        }
        println!("{}", parts.join(" "));
        v8e::HostResult::Undefined
    }));
    ok(v8e::set(&console, "log", &log));
    ok(v8e::set(&global, "console", &console));
    ok(v8e::eval(&format!("globalThis.__scr_runtime_target = {:?};", target_runtime_id()), "scriptc:target"));
    let host = v8_host_object();
    for (name, source) in [
        ("scriptc:streams", ISLAND_STREAM_BOOTSTRAP),
        ("scriptc:web", ISLAND_WEB_BOOTSTRAP),
        ("scriptc:web-globals", ISLAND_WEB_GLOBALS_BOOTSTRAP),
        ("scriptc:modules", ISLAND_MODULE_BOOTSTRAP),
    ] {
        let boot = ok(v8e::eval(source, name));
        if !v8e::is_function(&boot) {
            throw_type_error(format!("scriptc: island bootstrap {name} is not callable"));
        }
        ok(v8e::call(&boot, None, std::slice::from_ref(&host)));
    }
}

/// End-of-run teardown (event_loop::finish).
fn island_eval_finish() {
    if !V8_BOOTED.with(Cell::get) {
        return;
    }
    V8_HELPERS.with(|helpers| helpers.borrow_mut().clear());
    V8_EXTERNAL.with(|external| external.borrow_mut().clear());
    V8_CHILDREN.with(|children| children.borrow_mut().clear());
    island_modules_reset();
    v8e::finish();
    V8_BOOTED.with(|flag| flag.set(false));
}

/* ── module resolution over the embedded tables ────────────────────── */

fn v8_source_of(key: &str) -> Result<v8e::ModuleSource, String> {
    if let Some(module) = island_module_find(key) {
        return Ok(v8e::ModuleSource {
            key: key.to_owned(),
            source: if module.format == IslandModuleFormat::Json {
                island_module_source(module).to_owned()
            } else {
                island_module_esm_source(module)
            },
            json: module.format == IslandModuleFormat::Json,
        });
    }
    if key.starts_with("node:") {
        return Ok(v8e::ModuleSource { key: key.to_owned(), source: island_builtin_wrapper(key), json: false });
    }
    if V8_EXTERNAL.with(|external| external.borrow().contains(key)) {
        return match std::fs::read_to_string(key) {
            Ok(source) => Ok(v8e::ModuleSource { key: key.to_owned(), source, json: key.ends_with(".json") }),
            Err(error) => Err(format!("could not open file `{key}`: {error}")),
        };
    }
    Err(format!("Cannot find embedded module '{key}'"))
}

fn v8_resolve(referrer: &str, specifier: &str) -> Result<v8e::ModuleSource, String> {
    if specifier.starts_with("node:") || referrer.is_empty() {
        return v8_source_of(specifier);
    }
    if let Some(key) = island_edge_find(referrer, specifier, IslandEdgeKind::Import) {
        return v8_source_of(key);
    }
    let external = V8_EXTERNAL.with(|external| external.borrow().contains(referrer));
    if external && (specifier.starts_with("./") || specifier.starts_with("../")) {
        let Some(parent) = std::path::Path::new(referrer).parent() else {
            return Err(format!("cannot resolve module '{specifier}' from '{referrer}'"));
        };
        let key = parent.join(specifier).to_string_lossy().into_owned();
        V8_EXTERNAL.with(|external| external.borrow_mut().insert(key.clone()));
        return v8_source_of(&key);
    }
    Err(format!("cannot resolve module '{specifier}' from '{referrer}' (scriptc embeds npm code at build time)"))
}

fn v8_namespace(key: &str) -> v8e::Value {
    v8_ensure();
    if v8_trace() {
        eprintln!("scriptc island: evaluate {key}");
    }
    match v8e::import_module(key) {
        Ok(Some(namespace)) => namespace,
        Ok(None) => throw_error_code(
            format!("Embedded module '{key}' did not finish evaluating"),
            "ERR_MODULE_EVALUATION_PENDING",
        ),
        Err(error) => v8_throw(error),
    }
}

pub fn island_import(key: &JsString, export: &JsString) -> IslandValue {
    let namespace = v8_namespace(key.as_ref());
    if export.as_ref() == "*" {
        return IslandValue(namespace);
    }
    IslandValue(ok(v8e::get(&namespace, export.as_ref())))
}

/// `import(key)` as the engine's own promise (a failure rejects it).
pub fn island_import_dyn(key: &JsString) -> IslandValue {
    v8_ensure();
    let import = helper("import", "(k) => import(k)");
    let promise = ok(v8e::call(&import, None, &[js_string(key)]));
    v8e::run_microtasks();
    IslandValue(promise)
}

pub fn island_import_dyn_path(specifier: &JsString) -> IslandValue {
    v8_ensure();
    let failure = |message: String, code: &str| -> IslandValue {
        let reject = helper("reject", "(e) => Promise.reject(e)");
        let error = v8e::error("Error", &message, Some(code));
        IslandValue(ok(v8e::call(&reject, None, &[error])))
    };
    let Ok(url) = url::Url::parse(specifier.as_ref()) else {
        return failure(format!("Only file: URLs can be imported at runtime: '{specifier}'"), "ERR_UNSUPPORTED_ESM_URL_SCHEME");
    };
    if url.scheme() != "file" {
        return failure(format!("Only file: URLs can be imported at runtime: '{specifier}'"), "ERR_UNSUPPORTED_ESM_URL_SCHEME");
    }
    let Ok(path) = url.to_file_path() else {
        return failure(format!("Invalid file URL '{specifier}'"), "ERR_INVALID_FILE_URL_PATH");
    };
    let key = path.to_string_lossy().into_owned();
    V8_EXTERNAL.with(|external| external.borrow_mut().insert(key.clone()));
    island_import_dyn(&Rc::from(key.as_str()))
}

pub fn island_register_modules(modules: &'static [IslandModule]) {
    island_tables_register_modules(modules);
}

pub fn island_register_edges(edges: &'static [IslandEdge]) {
    island_tables_register_edges(edges);
}

/* ── values ────────────────────────────────────────────────────────── */

pub fn island_value_undefined() -> IslandValue {
    v8_ensure();
    IslandValue(v8e::undefined())
}

pub fn island_value_null() -> IslandValue {
    v8_ensure();
    IslandValue(v8e::null())
}

pub fn island_value_number(value: f64) -> IslandValue {
    v8_ensure();
    IslandValue(v8e::number(value))
}

pub fn island_value_boolean(value: bool) -> IslandValue {
    v8_ensure();
    IslandValue(v8e::boolean(value))
}

pub fn island_value_string(value: &JsString) -> IslandValue {
    v8_ensure();
    IslandValue(js_string(value))
}

pub fn island_value_bytes(value: &JsBytes<u8>) -> IslandValue {
    v8_ensure();
    IslandValue(bytes_value(value))
}

pub fn island_bytes_values(bytes: &JsBytes<u8>) -> Vec<u8> {
    bytes_values(bytes)
}

pub fn island_value_typeof(value: &IslandValue) -> JsString {
    string(&v8e::type_of(&value.0))
}

pub fn island_value_array(values: Vec<IslandValue>) -> IslandValue {
    v8_ensure();
    let items: Vec<v8e::Value> = values.into_iter().map(|value| value.0).collect();
    IslandValue(v8e::array(&items))
}

pub fn island_value_object(fields: Vec<(JsString, IslandValue)>) -> IslandValue {
    v8_ensure();
    let object = v8e::object();
    for (name, value) in fields {
        ok(v8e::set(&object, name.as_ref(), &value.0));
    }
    IslandValue(object)
}

pub fn island_value_json(value: &JsString) -> IslandValue {
    v8_ensure();
    IslandValue(ok(v8e::json_parse(value.as_ref())))
}

pub fn island_value_regexp(source: &JsString, flags: &JsString) -> IslandValue {
    v8_ensure();
    IslandValue(ok(v8e::regexp(source.as_ref(), flags.as_ref())))
}

pub fn island_value_date(ms: f64) -> IslandValue {
    v8_ensure();
    IslandValue(v8e::date(ms))
}

pub fn island_value_error(caught: &Caught) -> IslandValue {
    v8_ensure();
    let error = v8_error_of_caught(caught);
    IslandValue(v8e::error(&error.name, &error.message, error.code.as_deref()))
}

pub fn island_value_pending_promise() -> (IslandValue, IslandValue, IslandValue) {
    v8_ensure();
    let make = helper("pending", "() => { let r, j; const p = new Promise((a, b) => { r = a; j = b; }); return [p, r, j]; }");
    let triple = ok(v8e::call(&make, None, &[]));
    (
        IslandValue(ok(v8e::get_index(&triple, 0))),
        IslandValue(ok(v8e::get_index(&triple, 1))),
        IslandValue(ok(v8e::get_index(&triple, 2))),
    )
}

/* ── host functions for static closures ────────────────────────────── */

pub fn island_host_argument_value(arguments: &[IslandHostArgument], index: usize) -> IslandValue {
    arguments.get(index).map_or_else(island_value_undefined, |argument| argument.value.clone())
}

pub fn island_host_argument_string(arguments: &[IslandHostArgument], index: usize) -> JsString {
    let value = island_host_argument_value(arguments, index);
    match v8e::as_string(&value.0) {
        Some(text) => Rc::from(text.as_str()),
        None => throw_type_error(format!("expected string at $, got {}", v8e::type_of(&value.0))),
    }
}

pub fn island_host_argument_number(arguments: &[IslandHostArgument], index: usize) -> f64 {
    let value = island_host_argument_value(arguments, index);
    match v8e::as_number(&value.0) {
        Some(number) => number,
        None => throw_type_error(format!("expected number at $, got {}", v8e::type_of(&value.0))),
    }
}

pub fn island_host_argument_bool(arguments: &[IslandHostArgument], index: usize) -> bool {
    let value = island_host_argument_value(arguments, index);
    match v8e::as_bool(&value.0) {
        Some(flag) => flag,
        None => throw_type_error(format!("expected boolean at $, got {}", v8e::type_of(&value.0))),
    }
}

pub fn island_host_argument_bytes(arguments: &[IslandHostArgument], index: usize) -> JsBytes<u8> {
    match arguments.get(index).and_then(|argument| argument.bytes.clone()) {
        Some(bytes) => bytes_from_vec((*bytes).clone()),
        None => throw_type_error("expected Uint8Array at $".to_owned()),
    }
}

fn host_result_value(result: IslandHostResult) -> Result<v8e::HostResult, v8e::Error> {
    Ok(match result {
        IslandHostResult::Undefined => v8e::HostResult::Undefined,
        IslandHostResult::Null => v8e::HostResult::Null,
        IslandHostResult::Bool(value) => v8e::HostResult::Bool(value),
        IslandHostResult::Number(value) => v8e::HostResult::Number(value),
        IslandHostResult::String(value) => v8e::HostResult::String(value.to_string()),
        IslandHostResult::Bytes(value) => v8e::HostResult::Bytes(value),
        IslandHostResult::Json(value) => v8e::HostResult::Value(v8e::json_parse(value.as_ref())?),
        IslandHostResult::Island(value) => v8e::HostResult::Value(value.0),
    })
}

pub fn island_value_host_function(arity: usize, callback: IslandHostCallback) -> IslandValue {
    v8_ensure();
    let function = v8e::host_function("", arity as i32, Rc::new(move |args| {
        let arguments: Vec<IslandHostArgument> = args
            .iter()
            .map(|value| IslandHostArgument {
                value: IslandValue(value.clone()),
                bytes: if v8e::is_uint8_array(value) { v8e::as_bytes(value).map(Rc::new) } else { None },
            })
            .collect();
        match v8_guard(|| callback(&arguments)) {
            Ok(result) => host_result_value(result).unwrap_or_else(throw_result),
            Err(error) => throw_result(error),
        }
    }));
    IslandValue(function)
}

/* ── the promise bridge ────────────────────────────────────────────── */

pub fn island_promise_bridge<T, F>(value: &IslandValue, map: F) -> JsPromise<T>
where
    T: HeapValue,
    F: FnOnce(IslandValue) -> T + 'static,
{
    v8_ensure();
    let target = promise_new();
    let resolve = helper("resolve", "(v) => Promise.resolve(v)");
    let promise = ok(v8e::call(&resolve, None, std::slice::from_ref(&value.0)));
    let map = Rc::new(RefCell::new(Some(map)));
    let fulfilled_target = target.clone();
    let rejected_target = target.clone();
    ok(v8e::promise_then(
        &promise,
        Rc::new(move |args| {
            let value = args.first().cloned().unwrap_or_else(v8e::undefined);
            if let Some(map) = map.borrow_mut().take() {
                let _ = promise_fulfill(&fulfilled_target, map(IslandValue(value)));
            }
            v8e::HostResult::Undefined
        }),
        Rc::new(move |args| {
            let reason = args.first().cloned().unwrap_or_else(v8e::undefined);
            let _ = promise_reject(&rejected_target, island_exit_error(&IslandValue(reason)));
            v8e::HostResult::Undefined
        }),
    ));
    v8e::run_microtasks();
    target
}

/* ── calls and reads ───────────────────────────────────────────────── */

pub fn island_eval(code: &JsString) -> JsString {
    v8_ensure();
    let value = ok(v8e::eval(code.as_ref(), "scriptc:eval"));
    js_string_of(&value)
}

pub fn island_global_get(name: &str) -> IslandValue {
    v8_ensure();
    IslandValue(ok(v8e::get(&v8e::global(), name)))
}

pub fn island_call(callee: &IslandValue, args: &[IslandValue]) -> IslandValue {
    if !v8e::is_function(&callee.0) {
        throw_type_error("Embedded module export is not callable".to_owned());
    }
    let arguments: Vec<v8e::Value> = args.iter().map(|value| value.0.clone()).collect();
    let result = ok(v8e::call(&callee.0, None, &arguments));
    v8e::run_microtasks();
    IslandValue(result)
}

fn island_call_with_this(callee: &IslandValue, receiver: &IslandValue, name: &str, args: &[IslandValue]) -> IslandValue {
    if !v8e::is_function(&callee.0) {
        throw_type_error(format!("{name} is not a function"));
    }
    let arguments: Vec<v8e::Value> = args.iter().map(|value| value.0.clone()).collect();
    let result = ok(v8e::call(&callee.0, Some(&receiver.0), &arguments));
    v8e::run_microtasks();
    IslandValue(result)
}

pub fn island_call_this(callee: &IslandValue, receiver: &IslandValue, args: &[IslandValue]) -> IslandValue {
    island_call_with_this(callee, receiver, "value", args)
}

pub fn island_call_method(receiver: &IslandValue, name: &str, args: &[IslandValue]) -> IslandValue {
    let member = island_get_property(receiver, name);
    island_call_with_this(&member, receiver, name, args)
}

pub fn island_opt_call_method(receiver: &IslandValue, name: &str, args: &[IslandValue]) -> IslandValue {
    let member = island_get_property(receiver, name);
    if v8e::is_undefined(&member.0) || v8e::is_null(&member.0) {
        return island_value_undefined();
    }
    island_call_with_this(&member, receiver, name, args)
}

pub fn island_construct(callee: &IslandValue, args: &[IslandValue]) -> IslandValue {
    let arguments: Vec<v8e::Value> = args.iter().map(|value| value.0.clone()).collect();
    IslandValue(ok(v8e::construct(&callee.0, &arguments)))
}

pub fn island_instance_of(value: &IslandValue, target: &IslandValue) -> bool {
    ok(v8e::instance_of(&value.0, &target.0))
}

pub fn island_get_property(value: &IslandValue, name: &str) -> IslandValue {
    IslandValue(ok(v8e::get(&value.0, name)))
}

pub fn island_get_index(value: &IslandValue, key: &IslandValue) -> IslandValue {
    if let Some(number) = v8e::as_number(&key.0)
        && number >= 0.0
        && number.fract() == 0.0
        && number <= f64::from(u32::MAX)
    {
        return IslandValue(ok(v8e::get_index(&value.0, number as u32)));
    }
    let name = ok(v8e::to_string(&key.0));
    IslandValue(ok(v8e::get(&value.0, &name)))
}

pub fn island_set_index(value: &IslandValue, key: &IslandValue, field: &IslandValue) {
    if let Some(number) = v8e::as_number(&key.0)
        && number >= 0.0
        && number.fract() == 0.0
        && number <= f64::from(u32::MAX)
    {
        ok(v8e::set_index(&value.0, number as u32, &field.0));
        return;
    }
    let name = ok(v8e::to_string(&key.0));
    ok(v8e::set(&value.0, &name, &field.0));
}

pub fn island_is_undefined(value: &IslandValue) -> bool {
    v8e::is_undefined(&value.0)
}

pub fn island_is_null(value: &IslandValue) -> bool {
    v8e::is_null(&value.0)
}

pub fn island_is_nullish(value: &IslandValue) -> bool {
    v8e::is_undefined(&value.0) || v8e::is_null(&value.0)
}

pub fn island_is_function(value: &IslandValue) -> bool {
    v8e::is_function(&value.0)
}

pub fn island_is_error(value: &IslandValue) -> bool {
    v8e::is_native_error(&value.0)
}

pub fn island_truthy(value: &IslandValue) -> bool {
    v8e::truthy(&value.0)
}

pub fn island_strict_equal(left: &IslandValue, right: &IslandValue) -> bool {
    v8e::strict_equal(&left.0, &right.0)
}

pub fn island_strict_equal_boolean(value: &IslandValue, other: bool) -> bool {
    v8e::as_bool(&value.0) == Some(other)
}

pub fn island_strict_equal_number(value: &IslandValue, other: f64) -> bool {
    v8e::as_number(&value.0) == Some(other)
}

pub fn island_strict_equal_string(value: &IslandValue, other: &JsString) -> bool {
    v8e::as_string(&value.0).as_deref() == Some(other.as_ref())
}

pub fn island_iter_new(value: &IslandValue) -> IslandValue {
    v8_ensure();
    let iterate = helper("iter", "(v) => { const m = v[Symbol.iterator]; if (typeof m !== 'function') throw new TypeError('value is not iterable'); const it = m.call(v); if (it === null || typeof it !== 'object') throw new TypeError('iterator method returned a non-object'); return it; }");
    IslandValue(ok(v8e::call(&iterate, None, std::slice::from_ref(&value.0))))
}

pub fn island_spread_values(value: &IslandValue) -> Option<Vec<IslandValue>> {
    v8_ensure();
    if island_is_nullish(value) {
        return None;
    }
    let spread = helper("spread", "(v) => { const m = v[Symbol.iterator]; if (typeof m !== 'function') return undefined; return Array.from(v); }");
    let array = ok(v8e::call(&spread, None, std::slice::from_ref(&value.0)));
    if v8e::is_undefined(&array) {
        return None;
    }
    let length = ok(v8e::to_number(&ok(v8e::get(&array, "length")))) as usize;
    Some((0..length).map(|index| IslandValue(ok(v8e::get_index(&array, index as u32)))).collect())
}

pub fn island_json(value: &IslandValue) -> JsString {
    match ok(v8e::json_stringify(&value.0)) {
        Some(text) => string(&text),
        None => string("undefined"),
    }
}

pub fn island_json_node(value: &IslandValue) -> JsonNode {
    json_parse_node(&island_json(value)).unwrap_or_else(|message| throw_syntax_error(message))
}

pub fn island_to_string(value: &IslandValue) -> JsString {
    if let Some(number) = v8e::as_number(&value.0) {
        return string(&format_number(number));
    }
    js_string_of(&value.0)
}

pub fn island_inspect(value: &IslandValue, _recurse: f64, _depth: f64) -> JsString {
    if v8e::is_undefined(&value.0) {
        return string("undefined");
    }
    if v8e::is_null(&value.0) {
        return string("null");
    }
    if let Some(number) = v8e::as_number(&value.0) {
        return inspect_number(number);
    }
    if let Some(text) = v8e::as_string(&value.0) {
        return inspect_string(&string(&text));
    }
    if let Some(boolean) = v8e::as_bool(&value.0) {
        return string(&display_bool(boolean));
    }
    throw_type_error(format!(
        "util.inspect of a composite 'any' value (typeof '{}') is not supported yet — validate with 'as <type>' first",
        v8e::type_of(&value.0)
    ))
}

/* ── exits ─────────────────────────────────────────────────────────── */

pub fn island_exit_error(value: &IslandValue) -> Caught {
    if v8e::is_native_error(&value.0) || v8e::is_object(&value.0) {
        let name = v8e::get(&value.0, "name").ok().and_then(|v| v8e::as_string(&v)).unwrap_or_else(|| "Error".to_owned());
        let message = v8e::get(&value.0, "message").ok().and_then(|v| v8e::as_string(&v)).unwrap_or_default();
        let code = v8e::get(&value.0, "code").ok().and_then(|v| v8e::as_string(&v));
        if v8e::is_native_error(&value.0) || !message.is_empty() {
            return caught_value(JsError {
                identity: Rc::new(()),
                name,
                message,
                code,
                cause: None,
                dom: None,
            });
        }
    }
    caught_value(js_string_of(&value.0))
}

pub fn island_exit_bytes(value: &IslandValue) -> JsBytes<u8> {
    match v8e::as_bytes(&value.0) {
        Some(bytes) => bytes_from_vec(bytes),
        None => throw_type_error(format!("expected Uint8Array at $, got {}", v8e::type_of(&value.0))),
    }
}

pub fn island_exit_number(value: &IslandValue) -> f64 {
    match v8e::as_number(&value.0) {
        Some(number) => number,
        None => throw_type_error(format!("expected number at $, got {}", v8e::type_of(&value.0))),
    }
}

pub fn island_exit_boolean(value: &IslandValue) -> bool {
    match v8e::as_bool(&value.0) {
        Some(flag) => flag,
        None => throw_type_error(format!("expected boolean at $, got {}", v8e::type_of(&value.0))),
    }
}

pub fn island_exit_string(value: &IslandValue) -> JsString {
    match v8e::as_string(&value.0) {
        Some(text) => string(&text),
        None => throw_type_error(format!("expected string at $, got {}", v8e::type_of(&value.0))),
    }
}

/* ── host members ──────────────────────────────────────────────────── */

type HostBody = fn(&[v8e::Value]) -> Result<v8e::HostResult, v8e::Error>;

fn member(name: &'static str, arity: i32, body: HostBody) -> (&'static str, v8e::Value) {
    let function = v8e::host_function(name, arity, Rc::new(move |args| match body(args) {
        Ok(result) => result,
        Err(error) => throw_result(error),
    }));
    (name, function)
}

fn not_on_v8(name: &str) -> Result<v8e::HostResult, v8e::Error> {
    Err(v8e::Error {
        name: "Error".to_owned(),
        message: format!("host.{name} is not available on the V8 island yet"),
        code: Some("ERR_NOT_SUPPORTED".to_owned()),
        stack: None,
        value: None,
    })
}

fn host_string(value: &JsString) -> Result<v8e::HostResult, v8e::Error> {
    Ok(v8e::HostResult::String(value.to_string()))
}

fn host_value(value: v8e::Value) -> Result<v8e::HostResult, v8e::Error> {
    Ok(v8e::HostResult::Value(value))
}

fn v8_host_object() -> v8e::Value {
    let host = v8e::object();
    let members: Vec<(&'static str, v8e::Value)> = vec![
        member("source", 1, |args| {
            let key = arg_string(args, 0)?;
            let Some(module) = island_module_find(&key) else { return Ok(v8e::HostResult::Undefined) };
            let format = match module.format {
                IslandModuleFormat::Esm => 0.0,
                IslandModuleFormat::Cjs => 1.0,
                IslandModuleFormat::Json => 2.0,
            };
            host_value(v8e::array(&[v8e::string(island_module_source(module)), v8e::number(format)]))
        }),
        member("resolve", 2, |args| {
            let from = arg_string(args, 0)?;
            let specifier = arg_string(args, 1)?;
            match island_edge_find(&from, &specifier, IslandEdgeKind::Require)
                .or_else(|| island_edge_find(&from, &specifier, IslandEdgeKind::Any))
            {
                Some(key) => Ok(v8e::HostResult::String(key.to_owned())),
                None => Ok(v8e::HostResult::Undefined),
            }
        }),
        member("platform", 0, |_| host_string(&process_platform())),
        member("pid", 0, |_| Ok(v8e::HostResult::Number(process_pid()))),
        member("cwd", 0, |_| host_string(&process_cwd())),
        member("argv", 0, |_| host_value(string_array(&process_argv()))),
        member("env", 0, |_| {
            let pairs = process_env_pairs();
            let length = array_len(&pairs) as usize;
            let environment = v8e::object();
            for index in (0..length.saturating_sub(1)).step_by(2) {
                let key = array_get(&pairs, index as f64);
                let value = array_get(&pairs, (index + 1) as f64);
                v8e::set(&environment, key.as_ref(), &js_string(&value))?;
            }
            host_value(environment)
        }),
        member("exit", 1, |args| {
            let code = arg_number(args, 0)?;
            process_exit(code)
        }),
        member("setExitCode", 1, |args| {
            process_exit_code_set(arg_number(args, 0)?);
            Ok(v8e::HostResult::Undefined)
        }),
        member("hrtime", 0, |_| {
            let elapsed = process_elapsed();
            host_value(v8e::array(&[v8e::number(elapsed.as_secs() as f64), v8e::number(f64::from(elapsed.subsec_nanos()))]))
        }),
        member("isatty", 1, |args| Ok(v8e::HostResult::Bool(process_is_tty(arg_number(args, 0)?)))),
        member("columns", 1, |args| Ok(match process_columns(arg_number(args, 0)?) {
            Some(columns) => v8e::HostResult::Number(columns),
            None => v8e::HostResult::Undefined,
        })),
        member("umask", 0, |_| Ok(v8e::HostResult::Number(process_umask(-1.0)))),
        member("versions", 0, |_| host_value(v8e::array(&[js_string(&process_versions_node()), js_string(&process_versions_openssl())]))),
        member("write", 2, |args| {
            let fd = arg_number(args, 0)?;
            let text = arg_js_string(args, 1)?;
            if fd == 2.0 { process_stderr_write(&text); } else { process_stdout_write(&text); }
            Ok(v8e::HostResult::Undefined)
        }),
        member("readStdin", 0, |_| {
            let encoding: JsString = Rc::from("utf8");
            host_string(&fs_read_fd(0.0, &encoding))
        }),
        member("promiseState", 1, |args| {
            let value = arg(args, 0);
            Ok(match v8e::promise_state(&value) {
                None => v8e::HostResult::Undefined,
                Some(v8e::PromiseState::Pending) => v8e::HostResult::Value(v8e::array(&[v8e::number(0.0), v8e::undefined()])),
                Some(v8e::PromiseState::Fulfilled(result)) => v8e::HostResult::Value(v8e::array(&[v8e::number(1.0), result])),
                Some(v8e::PromiseState::Rejected(reason)) => v8e::HostResult::Value(v8e::array(&[v8e::number(2.0), reason])),
            })
        }),
        member("path", 4, host_path),
        member("urlToPath", 1, |args| host_string(&url_string_to_path(&arg_js_string(args, 0)?))),
        member("urlFromPath", 1, |args| host_string(&url_href(&url_path_to_file_url(&arg_js_string(args, 0)?)))),
        member("urlResolve", 2, |args| {
            let base = arg_string(args, 0)?;
            let input = arg_string(args, 1)?;
            match url::Url::parse(&base).ok().and_then(|b| b.join(&input).ok()) {
                Some(url) => Ok(v8e::HostResult::String(url.to_string())),
                None => Ok(v8e::HostResult::Null),
            }
        }),
        member("urlParse", 2, host_url_parse),
        member("fs", 4, host_fs),
        member("childSpawn", 4, host_child_spawn),
        member("childKill", 2, |args| {
            let Some(child) = v8_child(arg_number(args, 0)?) else { return Ok(v8e::HostResult::Bool(false)) };
            let signal = arg_js_string(args, 1)?;
            Ok(v8e::HostResult::Bool(v8_guard(|| child_kill(&child, &signal))?))
        }),
        member("childStdinWrite", 2, |args| {
            let Some(child) = v8_child(arg_number(args, 0)?) else { return Ok(v8e::HostResult::Bool(false)) };
            let bytes = arg_bytes(args, 1)?;
            Ok(v8e::HostResult::Bool(child_stdin_write(&child, &bytes)))
        }),
        member("childStdinEnd", 1, |args| {
            if let Some(child) = v8_child(arg_number(args, 0)?) { child_stdin_end(&child); }
            Ok(v8e::HostResult::Undefined)
        }),
        member("childUnref", 1, |args| {
            if let Some(child) = v8_child(arg_number(args, 0)?) { child_unref(&child); }
            Ok(v8e::HostResult::Undefined)
        }),
        member("childSpawnSync", 3, host_child_spawn_sync),
        member("fsConstants", 0, host_fs_constants),
        member("digest", 2, |args| {
            let algorithm = arg_js_string(args, 0)?;
            let data = arg_bytes(args, 1)?;
            Ok(match v8_guard(|| crypto_digest_raw(&algorithm, &data))? {
                Some(digest) => v8e::HostResult::Bytes(bytes_values(&digest)),
                None => v8e::HostResult::Undefined,
            })
        }),
        member("hmac", 3, |args| {
            let algorithm = arg_js_string(args, 0)?;
            let key = arg_bytes(args, 1)?;
            let data = arg_bytes(args, 2)?;
            Ok(match v8_guard(|| crypto_hmac_raw(&algorithm, &key, &data))? {
                Some(tag) => v8e::HostResult::Bytes(bytes_values(&tag)),
                None => v8e::HostResult::Undefined,
            })
        }),
        member("fetch", 4, |_| not_on_v8("fetch")),
        member("cancelFetch", 1, |_| Ok(v8e::HostResult::Undefined)),
        member("random", 1, |args| {
            let size = arg_number(args, 0)?;
            Ok(v8e::HostResult::Bytes(bytes_values(&v8_guard(|| crypto_random_bytes(size))?)))
        }),
        member("uuid", 0, |_| host_string(&v8_guard(crypto_random_uuid)?)),
        member("setTimer", 3, |args| {
            let callback = arg(args, 0);
            if !v8e::is_function(&callback) { return Ok(v8e::HostResult::Number(0.0)); }
            let delay = arg_number(args, 1)?;
            let repeat = arg_bool(args, 2);
            let fire: Box<dyn FnMut()> = Box::new(move || {
                ok(v8e::call(&callback, None, &[]));
                v8e::run_microtasks();
            });
            let id = if repeat { timer_set_interval(fire, delay) } else { timer_set_timeout_handle(fire, delay) };
            Ok(v8e::HostResult::Number(id))
        }),
        member("clearTimer", 1, |args| {
            timer_clear(arg_number(args, 0)?);
            Ok(v8e::HostResult::Undefined)
        }),
        member("setTimerRef", 2, |args| {
            let id = arg_number(args, 0)?;
            let referenced = args.get(1).is_none_or(v8e::truthy);
            Ok(v8e::HostResult::Number(timer_set_ref(id, referenced)))
        }),
        member("timerHasRef", 1, |args| Ok(v8e::HostResult::Bool(timer_has_ref(arg_number(args, 0)?)))),
        member("zlib", 4, |_| not_on_v8("zlib")),
        member("arch", 0, |_| host_string(&process_arch())),
        member("hostname", 0, |_| host_string(&os_hostname())),
        member("homedir", 0, |_| host_string(&v8_guard(os_homedir)?)),
        member("tmpdir", 0, |_| host_string(&os_tmpdir())),
        member("ids", 0, |_| host_value(v8e::array(&[v8e::number(process_getuid()), v8e::number(process_getgid())]))),
        member("signals", 0, host_signals),
        member("netConnect", 3, |_| not_on_v8("netConnect")),
        member("netWrite", 2, |_| not_on_v8("netWrite")),
        member("netEnd", 2, |_| not_on_v8("netEnd")),
        member("netDestroy", 1, |_| not_on_v8("netDestroy")),
        member("netFlow", 2, |_| not_on_v8("netFlow")),
        member("netOption", 3, |_| not_on_v8("netOption")),
        member("netPeer", 1, |_| not_on_v8("netPeer")),
        member("netLocal", 1, |_| not_on_v8("netLocal")),
        member("netServerCreate", 1, |_| not_on_v8("netServerCreate")),
        member("netServerListen", 3, |_| not_on_v8("netServerListen")),
        member("netServerAddress", 1, |_| not_on_v8("netServerAddress")),
        member("netServerClose", 1, |_| not_on_v8("netServerClose")),
        member("srvCreate", 1, |_| not_on_v8("srvCreate")),
        member("srvListen", 3, |_| not_on_v8("srvListen")),
        member("srvAddress", 1, |_| not_on_v8("srvAddress")),
        member("srvPort", 1, |_| not_on_v8("srvPort")),
        member("srvClose", 1, |_| not_on_v8("srvClose")),
        member("srvResHead", 4, |_| not_on_v8("srvResHead")),
        member("srvResWrite", 2, |_| not_on_v8("srvResWrite")),
        member("srvResEnd", 2, |_| not_on_v8("srvResEnd")),
        member("srvResDestroy", 1, |_| not_on_v8("srvResDestroy")),
        member("httpStart", 8, |_| not_on_v8("httpStart")),
        member("httpWrite", 2, |_| not_on_v8("httpWrite")),
        member("httpEnd", 2, |_| not_on_v8("httpEnd")),
        member("httpDestroy", 1, |_| not_on_v8("httpDestroy")),
        member("httpSetTimeout", 2, |_| not_on_v8("httpSetTimeout")),
    ];
    #[cfg(feature = "sqlite")]
    let members = {
        let mut members = members;
        members.push(member("sqlite", 6, host_sqlite));
        members
    };
    for (name, function) in members {
        ok(v8e::set(&host, name, &function));
    }
    host
}

fn host_path(args: &[v8e::Value]) -> Result<v8e::HostResult, v8e::Error> {
    let operation = arg_string(args, 0)?;
    let win32 = arg_bool(args, 1);
    let text = |index: usize| arg_js_string(args, index);
    let answer = match (operation.as_str(), win32) {
        ("join", false) => path_join(&arg_strings(args, 2)?),
        ("join", true) => path_win32_join(&arg_strings(args, 2)?),
        ("resolve", false) => path_resolve(&arg_strings(args, 2)?),
        ("resolve", true) => path_win32_resolve(&arg_strings(args, 2)?),
        ("normalize", false) => path_normalize(&text(2)?),
        ("normalize", true) => path_win32_normalize(&text(2)?),
        ("dirname", false) => path_dirname(&text(2)?),
        ("dirname", true) => path_win32_dirname(&text(2)?),
        ("basename", false) => path_basename(&text(2)?, &text(3)?),
        ("basename", true) => path_win32_basename(&text(2)?, &text(3)?),
        ("extname", false) => path_extname(&text(2)?),
        ("extname", true) => path_win32_extname(&text(2)?),
        ("isAbsolute", false) => return Ok(v8e::HostResult::Bool(path_is_absolute(&text(2)?))),
        ("isAbsolute", true) => return Ok(v8e::HostResult::Bool(path_win32_is_absolute(&text(2)?))),
        ("relative", false) => path_relative(&text(2)?, &text(3)?),
        ("relative", true) => path_win32_relative(&text(2)?, &text(3)?),
        ("toNamespacedPath", false) => text(2)?,
        ("toNamespacedPath", true) => path_win32_to_namespaced_path(&text(2)?),
        _ => return Err(type_error(format!("the island has no path operation '{operation}'"))),
    };
    host_string(&answer)
}

fn host_url_parse(args: &[v8e::Value]) -> Result<v8e::HostResult, v8e::Error> {
    let input = arg_string(args, 0)?;
    let base = arg(args, 1);
    let parsed = if v8e::is_undefined(&base) || v8e::is_null(&base) {
        url::Url::parse(&input).ok()
    } else {
        let base = arg_string(args, 1)?;
        url::Url::parse(&base).ok().and_then(|b| b.join(&input).ok())
    };
    let Some(url) = parsed else { return Ok(v8e::HostResult::Null) };
    let hostname = url.host_str().unwrap_or("");
    let port = url.port().map(|p| p.to_string()).unwrap_or_default();
    let host = if port.is_empty() { hostname.to_owned() } else { format!("{hostname}:{port}") };
    let search = match url.query() { Some(q) if !q.is_empty() => format!("?{q}"), _ => String::new() };
    let hash = match url.fragment() { Some(f) if !f.is_empty() => format!("#{f}"), _ => String::new() };
    let origin = match url.origin() {
        url::Origin::Tuple(..) => url.origin().ascii_serialization(),
        url::Origin::Opaque(_) => "null".to_owned(),
    };
    let object = v8e::object();
    for (key, value) in [
        ("href", url.as_str().to_owned()),
        ("protocol", format!("{}:", url.scheme())),
        ("username", url.username().to_owned()),
        ("password", url.password().unwrap_or("").to_owned()),
        ("host", host),
        ("hostname", hostname.to_owned()),
        ("port", port),
        ("pathname", url.path().to_owned()),
        ("search", search),
        ("hash", hash),
        ("origin", origin),
    ] {
        v8e::set(&object, key, &v8e::string(&value))?;
    }
    host_value(object)
}

fn host_signals(_args: &[v8e::Value]) -> Result<v8e::HostResult, v8e::Error> {
    #[cfg(target_os = "macos")]
    const SIGNALS: [(&str, i32); 29] = [
        ("SIGHUP", 1), ("SIGINT", 2), ("SIGQUIT", 3), ("SIGILL", 4), ("SIGTRAP", 5),
        ("SIGABRT", 6), ("SIGFPE", 8), ("SIGKILL", 9), ("SIGBUS", 10), ("SIGSEGV", 11),
        ("SIGSYS", 12), ("SIGPIPE", 13), ("SIGALRM", 14), ("SIGTERM", 15), ("SIGURG", 16),
        ("SIGSTOP", 17), ("SIGTSTP", 18), ("SIGCONT", 19), ("SIGCHLD", 20), ("SIGTTIN", 21),
        ("SIGTTOU", 22), ("SIGIO", 23), ("SIGXCPU", 24), ("SIGXFSZ", 25), ("SIGVTALRM", 26),
        ("SIGPROF", 27), ("SIGWINCH", 28), ("SIGUSR1", 30), ("SIGUSR2", 31),
    ];
    #[cfg(not(target_os = "macos"))]
    const SIGNALS: [(&str, i32); 28] = [
        ("SIGHUP", 1), ("SIGINT", 2), ("SIGQUIT", 3), ("SIGILL", 4), ("SIGTRAP", 5),
        ("SIGABRT", 6), ("SIGBUS", 7), ("SIGFPE", 8), ("SIGKILL", 9), ("SIGUSR1", 10),
        ("SIGSEGV", 11), ("SIGUSR2", 12), ("SIGPIPE", 13), ("SIGALRM", 14), ("SIGTERM", 15),
        ("SIGCHLD", 17), ("SIGCONT", 18), ("SIGSTOP", 19), ("SIGTSTP", 20), ("SIGTTIN", 21),
        ("SIGTTOU", 22), ("SIGURG", 23), ("SIGXCPU", 24), ("SIGXFSZ", 25), ("SIGVTALRM", 26),
        ("SIGPROF", 27), ("SIGWINCH", 28), ("SIGIO", 29),
    ];
    let object = v8e::object();
    for (name, number) in SIGNALS {
        v8e::set(&object, name, &v8e::number(f64::from(number)))?;
    }
    host_value(object)
}

fn host_fs_constants(_args: &[v8e::Value]) -> Result<v8e::HostResult, v8e::Error> {
    #[cfg(target_os = "macos")]
    const OPEN_FLAGS: [(&str, i32); 8] = [
        ("O_RDONLY", 0), ("O_WRONLY", 1), ("O_RDWR", 2), ("O_CREAT", 0x200),
        ("O_EXCL", 0x800), ("O_TRUNC", 0x400), ("O_APPEND", 8), ("O_NONBLOCK", 4),
    ];
    #[cfg(not(target_os = "macos"))]
    const OPEN_FLAGS: [(&str, i32); 8] = [
        ("O_RDONLY", 0), ("O_WRONLY", 1), ("O_RDWR", 2), ("O_CREAT", 64),
        ("O_EXCL", 128), ("O_TRUNC", 512), ("O_APPEND", 1024), ("O_NONBLOCK", 2048),
    ];
    const OTHER: [(&str, i32); 14] = [
        ("F_OK", 0), ("R_OK", 4), ("W_OK", 2), ("X_OK", 1),
        ("S_IFMT", 0o170000), ("S_IFREG", 0o100000), ("S_IFDIR", 0o040000), ("S_IFLNK", 0o120000),
        ("S_IFCHR", 0o020000), ("S_IFBLK", 0o060000), ("S_IFIFO", 0o010000), ("S_IFSOCK", 0o140000),
        ("COPYFILE_EXCL", 1), ("UV_FS_COPYFILE_EXCL", 1),
    ];
    let object = v8e::object();
    for (name, number) in OPEN_FLAGS.iter().chain(OTHER.iter()) {
        v8e::set(&object, name, &v8e::number(f64::from(*number)))?;
    }
    host_value(object)
}

/* ── fs ────────────────────────────────────────────────────────────── */

fn stats_row(stats: &JsStats) -> v8e::Value {
    v8e::array(&[
        v8e::boolean(stats_is_file(stats)),
        v8e::boolean(stats_is_directory(stats)),
        v8e::boolean(stats_is_symlink(stats)),
        v8e::number(stats_size(stats)),
        v8e::number(stats_mtime_ms(stats)),
        v8e::number(stats_blocks(stats)),
        v8e::number(stats_nlink(stats)),
        v8e::number(stats_atime_ms(stats)),
    ])
}

fn host_fs(args: &[v8e::Value]) -> Result<v8e::HostResult, v8e::Error> {
    let operation = arg_string(args, 0)?;
    let fd_op = matches!(operation.as_str(), "close" | "read" | "write" | "fstat" | "ftruncate" | "fsync");
    let path: JsString = if fd_op { Rc::from("") } else { arg_js_string(args, 1)? };
    let number = |index: usize| arg_number(args, index);
    let nothing = || Ok(v8e::HostResult::Undefined);
    match operation.as_str() {
        "readFile" => Ok(v8e::HostResult::Bytes(bytes_values(&v8_guard(|| fs_read_file_bytes(&path))?))),
        "writeFile" => { let data = arg_bytes(args, 2)?; v8_guard(|| fs_write_file_bytes(&path, &data))?; nothing() }
        "appendFile" => { let data = arg_bytes(args, 2)?; v8_guard(|| fs_append_file_bytes(&path, &data))?; nothing() }
        "exists" => Ok(v8e::HostResult::Bool(fs_exists(&path))),
        "realpath" => host_string(&v8_guard(|| fs_realpath(&path))?),
        "mkdir" => {
            let recursive = number(2)? != 0.0;
            let mode = number(3)?;
            v8_guard(|| if mode < 0.0 { if recursive { fs_mkdir_recursive(&path) } else { fs_mkdir(&path) } } else { fs_mkdir_mode(&path, mode, recursive) })?;
            nothing()
        }
        "rm" => { let recursive = number(2)? != 0.0; let force = number(3)? != 0.0; v8_guard(|| fs_rm_options(&path, recursive, force))?; nothing() }
        "rmdir" => { v8_guard(|| fs_rmdir(&path))?; nothing() }
        "unlink" => { v8_guard(|| fs_unlink(&path))?; nothing() }
        "readdir" => host_value(string_array(&v8_guard(|| fs_readdir(&path))?)),
        "scandir" => {
            let entries = v8_guard(|| fs_readdir_types(&path))?;
            let mut flat = Vec::with_capacity(entries.len() * 2);
            for entry in &entries {
                flat.push(js_string(&entry.name));
                flat.push(v8e::number(entry.kind));
            }
            host_value(v8e::array(&flat))
        }
        "stat" => host_value(stats_row(&v8_guard(|| fs_stat(&path, true))?)),
        "lstat" => host_value(stats_row(&v8_guard(|| fs_stat(&path, false))?)),
        "access" => { let mode = number(2)?; v8_guard(|| fs_access(&path, mode))?; nothing() }
        "mkdtemp" => host_string(&v8_guard(|| fs_mkdtemp(&path))?),
        "chmod" => { let mode = number(2)?; v8_guard(|| fs_chmod(&path, mode))?; nothing() }
        "readlink" => host_string(&v8_guard(|| fs_readlink(&path))?),
        "copyFile" => { let destination = arg_js_string(args, 2)?; v8_guard(|| fs_copy_file(&path, &destination))?; nothing() }
        "rename" => { let destination = arg_js_string(args, 2)?; v8_guard(|| fs_rename(&path, &destination))?; nothing() }
        "open" => { let flags = arg_js_string(args, 2)?; Ok(v8e::HostResult::Number(v8_guard(|| fs_open(&path, &flags))?)) }
        "close" => { let fd = number(1)?; v8_guard(|| fs_close(fd))?; nothing() }
        "read" => {
            let fd = number(1)?; let length = number(2)?; let position = number(3)?;
            let data = v8_guard(|| { let buffer = bytes_alloc::<u8>(length); let read = fs_read_sync(fd, &buffer, 0.0, length, position); bytes_u8_values(&buffer)[..read as usize].to_vec() })?;
            Ok(v8e::HostResult::Bytes(data))
        }
        "write" => {
            let fd = number(1)?; let data = arg_bytes(args, 2)?; let position = number(3)?;
            let written = v8_guard(|| { let length = data.with(|data| data.length) as f64; fs_write_sync(fd, &data, 0.0, length, position) })?;
            Ok(v8e::HostResult::Number(written))
        }
        "fstat" => { let fd = number(1)?; host_value(stats_row(&v8_guard(|| fs_fstat(fd))?)) }
        "ftruncate" => { let fd = number(1)?; let length = number(2)?; v8_guard(|| fs_ftruncate(fd, length))?; nothing() }
        "fsync" => { let fd = number(1)?; v8_guard(|| fs_fsync(fd))?; nothing() }
        _ => Err(v8e::Error { name: "ReferenceError".to_owned(), message: "unknown island fs op".to_owned(), code: None, stack: None, value: None }),
    }
}

/* ── child processes ───────────────────────────────────────────────── */

thread_local! {
    static V8_CHILDREN: RefCell<HashMap<u64, JsChild>> = RefCell::new(HashMap::new());
    static V8_CHILD_NEXT_ID: Cell<u64> = const { Cell::new(0) };
}

fn v8_child(id: f64) -> Option<JsChild> {
    if !id.is_finite() || id < 1.0 { return None; }
    V8_CHILDREN.with(|children| children.borrow().get(&(id as u64)).cloned())
}

/// Calls one method on a shim callbacks object from the loop, draining
/// the microtasks it queued (the socket bridge's reentry seam).
fn v8_callback(callbacks: &v8e::Value, name: &str, args: Vec<v8e::Value>) {
    let member = ok(v8e::get(callbacks, name));
    if !v8e::is_function(&member) { return; }
    ok(v8e::call(&member, Some(callbacks), &args));
    v8e::run_microtasks();
}

fn option_number(options: &v8e::Value, name: &str) -> Result<f64, v8e::Error> {
    let value = v8e::get(options, name)?;
    if v8e::is_undefined(&value) || v8e::is_null(&value) { Ok(0.0) } else { v8e::to_number(&value) }
}

fn option_string(options: &v8e::Value, name: &str) -> Result<JsString, v8e::Error> {
    let value = v8e::get(options, name)?;
    if v8e::is_undefined(&value) || v8e::is_null(&value) { Ok(Rc::from("")) } else { Ok(Rc::from(v8e::to_string(&value)?.as_str())) }
}

fn exit_arguments(code: Option<f64>, signal: Option<JsString>) -> Vec<v8e::Value> {
    vec![
        code.map_or_else(v8e::null, v8e::number),
        signal.map_or_else(v8e::null, |signal| js_string(&signal)),
    ]
}

fn host_child_spawn(args: &[v8e::Value]) -> Result<v8e::HostResult, v8e::Error> {
    let command = arg_js_string(args, 0)?;
    let argv = arg_strings(args, 1)?;
    let options = arg(args, 2);
    let callbacks = arg(args, 3);
    if !v8e::is_object(&callbacks) { return Err(type_error("the island child bridge expects a callbacks object")); }
    let stdin = option_number(&options, "stdin")?;
    let stdout = option_number(&options, "stdout")?;
    let stderr = option_number(&options, "stderr")?;
    let stdout_fd = option_number(&options, "stdoutFd")?;
    let stderr_fd = option_number(&options, "stderrFd")?;
    let detached = option_number(&options, "detached")? != 0.0;
    let cwd = option_string(&options, "cwd")?;
    let env_value = v8e::get(&options, "env")?;
    let has_env = !(v8e::is_undefined(&env_value) || v8e::is_null(&env_value));
    let env_pairs = arg_strings(&[env_value], 0)?;
    let child = v8_guard(|| child_spawn_options(&command, &argv, stdin, stdout, stderr, stdout_fd, stderr_fd, detached, has_env, &env_pairs, &cwd))?;
    let id = V8_CHILD_NEXT_ID.with(|slot| { let id = slot.get() + 1; slot.set(id); id });
    if v8_trace() {
        eprintln!("scriptc island: spawn #{id} {command} (pid {:?})", child_pid(&child));
    }
    V8_CHILDREN.with(|children| { children.borrow_mut().insert(id, child.clone()); });
    for (stream, on_data, on_end) in [(child_stdout(&child), "onStdout", "onStdoutEnd"), (child_stderr(&child), "onStderr", "onStderrEnd")] {
        let Some(stream) = stream else { continue };
        let data_callbacks = callbacks.clone();
        child_stream_on_data(&stream, Rc::new(move |chunk| { v8_callback(&data_callbacks, on_data, vec![v8e::bytes(&bytes_u8_values(&chunk))]); }), Rc::new(|_| {}), false);
        let end_callbacks = callbacks.clone();
        child_stream_on_end(&stream, Rc::new(move || { v8_callback(&end_callbacks, on_end, Vec::new()); }), Rc::new(|_| {}));
    }
    let exit_callbacks = callbacks.clone();
    child_on_exit(&child, Box::new(move |code, signal| { v8_callback(&exit_callbacks, "onExit", exit_arguments(code, signal)); }), Box::new(|_| {}));
    let close_callbacks = callbacks.clone();
    child_on_close(&child, Box::new(move |code, signal| { v8_callback(&close_callbacks, "onClose", exit_arguments(code, signal)); }), Box::new(|_| {}));
    let error_callbacks = callbacks.clone();
    child_on_error(&child, Box::new(move |error| {
        let message = error_message(&error).to_string();
        let code = error.code.clone().unwrap_or_default();
        v8_callback(&error_callbacks, "onError", vec![v8e::string(&message), v8e::string(&code)]);
    }), Box::new(|_| {}));
    let pid = child_pid(&child).map_or_else(v8e::null, v8e::number);
    host_value(v8e::array(&[v8e::number(id as f64), pid]))
}

fn host_child_spawn_sync(args: &[v8e::Value]) -> Result<v8e::HostResult, v8e::Error> {
    let command = arg_js_string(args, 0)?;
    let argv = arg_strings(args, 1)?;
    let options = arg(args, 2);
    let cwd = option_string(&options, "cwd")?;
    let timeout = option_number(&options, "timeout")?;
    let kill_signal = option_string(&options, "killSignal")?;
    let sync_mode = |mode: f64| match mode as i32 { 0 => 1.0, 1 => 2.0, _ => 0.0 };
    let stdin = if option_number(&options, "stdin")? as i32 == 1 { 2.0 } else { 0.0 };
    let stdout = sync_mode(option_number(&options, "stdout")?);
    let stderr = sync_mode(option_number(&options, "stderr")?);
    let env_value = v8e::get(&options, "env")?;
    let has_env = !(v8e::is_undefined(&env_value) || v8e::is_null(&env_value));
    let env_pairs = arg_strings(&[env_value], 0)?;
    let result = v8_guard(|| child_spawn_sync_full(&command, &argv, timeout, &kill_signal, stdin, stdout, stderr, has_env.then_some(&env_pairs), &cwd))?;
    let status = spawn_result_status(&result).map_or_else(v8e::null, v8e::number);
    let signal = spawn_result_signal(&result).map_or_else(v8e::null, |signal| js_string(&signal));
    let stdout = js_string(&spawn_result_stdout(&result));
    let stderr = js_string(&spawn_result_stderr(&result));
    let (message, code) = match spawn_result_error(&result) {
        Some(error) => (v8e::string(error_message(&error).as_ref()), v8e::string(&error.code.clone().unwrap_or_default())),
        None => (v8e::null(), v8e::null()),
    };
    host_value(v8e::array(&[status, signal, stdout, stderr, message, code]))
}

/* ── sqlite ────────────────────────────────────────────────────────── */

#[cfg(feature = "sqlite")]
fn sqlite_param_of(value: &v8e::Value) -> Result<SqliteValue, v8e::Error> {
    if v8e::is_undefined(value) || v8e::is_null(value) { return Ok(SqliteValue::Null); }
    if let Some(number) = v8e::as_number(value) {
        return Ok(if number.fract() == 0.0 && number.abs() <= 9_007_199_254_740_992.0 { SqliteValue::Integer(number as i64) } else { SqliteValue::Real(number) });
    }
    if let Some(flag) = v8e::as_bool(value) { return Ok(SqliteValue::Integer(i64::from(flag))); }
    if let Some(text) = v8e::as_string(value) { return Ok(SqliteValue::Text(text)); }
    if v8e::type_of(value) == "bigint" {
        return match v8e::to_string(value)?.parse::<i64>() {
            Ok(integer) => Ok(SqliteValue::Integer(integer)),
            Err(_) => Err(v8e::Error { name: "RangeError".to_owned(), message: "BigInt value is out of range for a 64-bit SQLite integer".to_owned(), code: None, stack: None, value: None }),
        };
    }
    if let Some(bytes) = v8e::as_bytes(value) { return Ok(SqliteValue::Blob(bytes)); }
    Err(type_error("Binding value must be a string, number, bigint, boolean, null, or Uint8Array"))
}

#[cfg(feature = "sqlite")]
fn sqlite_params_of(value: &v8e::Value) -> Result<SqliteParams, v8e::Error> {
    if !v8e::is_object(value) { return Ok(SqliteParams::Positional(Vec::new())); }
    if v8e::is_array(value) {
        let length = v8e::to_number(&v8e::get(value, "length")?)? as usize;
        let mut values = Vec::with_capacity(length);
        for index in 0..length { values.push(sqlite_param_of(&v8e::get_index(value, index as u32)?)?); }
        return Ok(SqliteParams::Positional(values));
    }
    let mut entries = Vec::new();
    for key in v8e::own_keys(value)? {
        let item = v8e::get(value, &key)?;
        entries.push((key, sqlite_param_of(&item)?));
    }
    Ok(SqliteParams::Named(entries))
}

#[cfg(feature = "sqlite")]
fn sqlite_value(value: &SqliteValue, safe_integers: bool) -> Result<v8e::Value, v8e::Error> {
    Ok(match value {
        SqliteValue::Null => v8e::null(),
        SqliteValue::Integer(integer) => {
            if safe_integers {
                let big = helper("bigint", "(s) => BigInt(s)");
                v8e::call(&big, None, &[v8e::string(&integer.to_string())])?
            } else {
                v8e::number(*integer as f64)
            }
        }
        SqliteValue::Real(real) => v8e::number(*real),
        SqliteValue::Text(text) => v8e::string(text),
        SqliteValue::Blob(bytes) => v8e::bytes(bytes),
    })
}

#[cfg(feature = "sqlite")]
fn host_sqlite(args: &[v8e::Value]) -> Result<v8e::HostResult, v8e::Error> {
    let operation = arg_string(args, 0)?;
    let number = |index: usize| arg_number(args, index);
    match operation.as_str() {
        "open" => { let filename = arg_string(args, 1)?; let flags = number(2)?; Ok(v8e::HostResult::Number(v8_guard(|| sqlite_open(&filename, flags))?)) }
        "close" => { let id = number(1)?; v8_guard(|| sqlite_close(id))?; Ok(v8e::HostResult::Undefined) }
        "exec" => { let id = number(1)?; let sql = arg_string(args, 2)?; v8_guard(|| sqlite_exec(id, &sql))?; Ok(v8e::HostResult::Undefined) }
        "run" => {
            let id = number(1)?; let sql = arg_string(args, 2)?; let params = sqlite_params_of(&arg(args, 3))?; let safe = number(4)? != 0.0;
            let (changes, rowid) = v8_guard(|| sqlite_run(id, &sql, &params))?;
            host_value(v8e::array(&[v8e::number(changes), sqlite_value(&SqliteValue::Integer(rowid), safe)?]))
        }
        "rows" => {
            let id = number(1)?; let sql = arg_string(args, 2)?; let params = sqlite_params_of(&arg(args, 3))?; let safe = number(4)? != 0.0; let limit = number(5)?.max(0.0) as usize;
            let (columns, rows) = v8_guard(|| sqlite_rows(id, &sql, &params, limit))?;
            let mut out = Vec::with_capacity(rows.len());
            for row in &rows {
                let mut values = Vec::with_capacity(row.len());
                for value in row { values.push(sqlite_value(value, safe)?); }
                out.push(v8e::array(&values));
            }
            let columns: Vec<v8e::Value> = columns.iter().map(|name| v8e::string(name)).collect();
            host_value(v8e::array(&[v8e::array(&columns), v8e::array(&out)]))
        }
        "columns" => { let id = number(1)?; let sql = arg_string(args, 2)?; let columns = v8_guard(|| sqlite_columns(id, &sql))?; let columns: Vec<v8e::Value> = columns.iter().map(|name| v8e::string(name)).collect(); host_value(v8e::array(&columns)) }
        "paramsCount" => { let id = number(1)?; let sql = arg_string(args, 2)?; Ok(v8e::HostResult::Number(v8_guard(|| sqlite_params_count(id, &sql))?)) }
        "serialize" => { let id = number(1)?; Ok(v8e::HostResult::Bytes(v8_guard(|| sqlite_serialize(id))?)) }
        _ => Err(v8e::Error { name: "ReferenceError".to_owned(), message: "unknown island sqlite op".to_owned(), code: None, stack: None, value: None }),
    }
}
