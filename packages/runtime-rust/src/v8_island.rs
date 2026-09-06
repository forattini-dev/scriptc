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
    // A thrown primitive (`throw "reason"`) exits as a string-valued
    // Caught, exactly as the boa lane and the C island answer it; only
    // objects become native errors.
    if let Some(value) = &error.value
        && !v8e::is_object(value)
    {
        return caught_value(string(&error.message));
    }
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
    if v8_trace() {
        match &error.stack {
            Some(stack) => eprintln!("scriptc island (v8): {stack}"),
            None => eprintln!(
                "scriptc island (v8): {}: {} (code {:?}, no stack)",
                error.name, error.message, error.code
            ),
        }
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
    let function = ok(v8e::eval(source, &format!("scriptc:helper:{name}")));
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
    v8_net_reset();
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
    // A root import: the runtime's own request (empty referrer) or an
    // `import()` issued from one of its helper scripts.
    if specifier.starts_with("node:") || referrer.is_empty() || referrer.starts_with("scriptc:") {
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
