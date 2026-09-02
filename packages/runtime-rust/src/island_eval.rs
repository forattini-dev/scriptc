use boa_engine::{
    Context, JsError as BoaJsError, JsResult, JsSymbol as BoaJsSymbol, JsValue, Module,
    NativeFunction, Source,
    builtins::promise::PromiseState as BoaPromiseState,
    js_string,
    module::{ModuleRequest, Referrer},
    object::builtins::{
        JsArray as BoaJsArray, JsPromise as BoaJsPromise, JsUint8Array as BoaJsUint8Array,
    },
    object::{FunctionObjectBuilder, ObjectInitializer},
    property::Attribute,
};
use std::path::Path;

thread_local! {
    static ISLAND_STATE: RefCell<Option<IslandState>> = const { RefCell::new(None) };
    static ISLAND_HOST_CALLBACKS: RefCell<HashMap<u64, IslandHostCallback>> = RefCell::new(HashMap::new());
    static ISLAND_HOST_CALLBACK_ID: Cell<u64> = const { Cell::new(0) };
}

const ISLAND_WEB_BOOTSTRAP: &str = include_str!("island_web.js");
const ISLAND_STREAM_BOOTSTRAP: &str = include_str!("island_streams.js");

#[derive(Clone)]
pub struct IslandValue(JsValue);

/// One engine argument as the host closure sees it.
///
/// The raw value covers every primitive extraction. `bytes` is copied out
/// eagerly at the boundary because a Uint8Array cannot be read without
/// the engine context, and the context is only borrowable inside the
/// engine's own call — by the time the generated closure body runs, the
/// island state is already borrowed by the call that reached it.
#[derive(Clone)]
pub struct IslandHostArgument {
    value: IslandValue,
    bytes: Option<Rc<Vec<u8>>>,
}

/// What a marshaled scriptc closure hands back to the engine.
///
/// This mirrors the C island's host-call adapter returns (emit-island.ts's
/// `islandAdapter` tags): primitives by value, `Bytes` as a Uint8Array,
/// and `Json` as text the realm parses — the deep-copy stance the rest of
/// the boundary already takes for composites.
pub enum IslandHostResult {
    Undefined,
    Null,
    Bool(bool),
    Number(f64),
    String(JsString),
    Bytes(Vec<u8>),
    Json(JsString),
}

type IslandHostCallback = Rc<dyn Fn(&[IslandHostArgument]) -> IslandHostResult>;

pub fn island_value_undefined() -> IslandValue {
    IslandValue(JsValue::undefined())
}

pub fn island_value_null() -> IslandValue {
    IslandValue(JsValue::null())
}

pub fn island_value_number(value: f64) -> IslandValue {
    IslandValue(JsValue::from(value))
}

pub fn island_value_boolean(value: bool) -> IslandValue {
    IslandValue(JsValue::from(value))
}

pub fn island_value_string(value: &JsString) -> IslandValue {
    IslandValue(JsValue::from(boa_engine::JsString::from(value.as_ref())))
}

pub fn island_value_bytes(value: &JsBytes<u8>) -> IslandValue {
    with_island_state(|state| {
        let bytes = bytes_values(value);
        let array = BoaJsUint8Array::from_iter(bytes, &mut state.context)
            .unwrap_or_else(|error| island_eval_error(error, &mut state.context));
        IslandValue(array.into())
    })
}

pub fn island_exit_bytes(value: &IslandValue) -> JsBytes<u8> {
    with_island_state(|state| {
        let Some(object) = value.0.as_object() else {
            throw_type_error("expected Uint8Array from embedded module".to_owned());
        };
        let Ok(array) = BoaJsUint8Array::from_object(object) else {
            throw_type_error("expected Uint8Array from embedded module".to_owned());
        };
        let values = array
            .to_vec(&mut state.context)
            .unwrap_or_else(|error| island_eval_error(error, &mut state.context));
        bytes_from_vec(values)
    })
}

/* ── engine argument → native value ────────────────────────────────────
 * Strict, like the C adapters' `scr_jsval_exit_*`: a lying engine
 * argument throws a TypeError at the boundary instead of coercing. An
 * absent argument is `undefined` and fails the same way, matching the
 * wrapper's pad-with-undefined call semantics. */

pub fn island_host_argument_string(arguments: &[IslandHostArgument], index: usize) -> JsString {
    let Some(value) = arguments
        .get(index)
        .and_then(|argument| argument.value.0.as_string())
    else {
        throw_type_error(format!("expected string at argument {index}"));
    };
    string(&value.to_std_string_lossy())
}

pub fn island_host_argument_number(arguments: &[IslandHostArgument], index: usize) -> f64 {
    let Some(value) = arguments
        .get(index)
        .and_then(|argument| argument.value.0.as_number())
    else {
        throw_type_error(format!("expected number at argument {index}"));
    };
    value
}

pub fn island_host_argument_bool(arguments: &[IslandHostArgument], index: usize) -> bool {
    let Some(value) = arguments
        .get(index)
        .and_then(|argument| argument.value.0.as_boolean())
    else {
        throw_type_error(format!("expected boolean at argument {index}"));
    };
    value
}

pub fn island_host_argument_bytes(
    arguments: &[IslandHostArgument],
    index: usize,
) -> JsBytes<u8> {
    let Some(value) = arguments
        .get(index)
        .and_then(|argument| argument.bytes.as_ref())
    else {
        throw_type_error(format!("expected Uint8Array at argument {index}"));
    };
    bytes_from_vec(value.as_ref().clone())
}

/// Copy a runtime byte array out for an `IslandHostResult::Bytes`.
pub fn island_bytes_values(bytes: &JsBytes<u8>) -> Vec<u8> {
    bytes_values(bytes)
}

/// A `jsval` parameter: the engine handle passes straight through.
pub fn island_host_argument_value(
    arguments: &[IslandHostArgument],
    index: usize,
) -> IslandValue {
    arguments
        .get(index)
        .map_or_else(island_value_undefined, |argument| argument.value.clone())
}

pub fn island_value_host_function(
    arity: usize,
    callback: IslandHostCallback,
) -> IslandValue {
    let id = ISLAND_HOST_CALLBACK_ID.with(|next| {
        let id = next.get();
        next.set(id.wrapping_add(1));
        id
    });
    ISLAND_HOST_CALLBACKS.with(|callbacks| callbacks.borrow_mut().insert(id, callback));
    with_island_state(|state| {
        let native = NativeFunction::from_copy_closure(move |_this, arguments, context| {
            let arguments = arguments
                .iter()
                .cloned()
                .map(|value| island_host_argument(value, context))
                .collect::<JsResult<Vec<_>>>()?;
            let result = ISLAND_HOST_CALLBACKS.with(|callbacks| {
                let callbacks = callbacks.borrow();
                let callback = callbacks
                    .get(&id)
                    .expect("scriptc: missing island host callback");
                callback(&arguments)
            });
            island_host_result_value(result, context)
        });
        let function = FunctionObjectBuilder::new(state.context.realm(), native)
            .length(arity)
            .build();
        IslandValue(function.into())
    })
}

/// Wrap one borrowed engine argument, copying a Uint8Array out while the
/// engine context is still reachable.
fn island_host_argument(value: JsValue, context: &mut Context) -> JsResult<IslandHostArgument> {
    let bytes = value
        .as_object()
        .and_then(|object| BoaJsUint8Array::from_object(object).ok())
        .map(|array| array.to_vec(context))
        .transpose()?
        .map(Rc::new);
    Ok(IslandHostArgument { value: IslandValue(value), bytes })
}

/// Marshal a closure result back into the realm.
fn island_host_result_value(result: IslandHostResult, context: &mut Context) -> JsResult<JsValue> {
    Ok(match result {
        IslandHostResult::Undefined => JsValue::undefined(),
        IslandHostResult::Null => JsValue::null(),
        IslandHostResult::Bool(value) => JsValue::from(value),
        IslandHostResult::Number(value) => JsValue::from(value),
        IslandHostResult::String(value) => {
            JsValue::from(boa_engine::JsString::from(value.as_ref()))
        }
        IslandHostResult::Bytes(value) => BoaJsUint8Array::from_iter(value, context)?.into(),
        IslandHostResult::Json(value) => island_parse_json(&value, context)?,
    })
}

pub fn island_value_object(fields: Vec<(JsString, IslandValue)>) -> IslandValue {
    with_island_state(|state| {
        let mut object = ObjectInitializer::new(&mut state.context);
        for (key, value) in fields {
            object.property(
                boa_engine::JsString::from(key.as_ref()),
                value.0,
                Attribute::WRITABLE | Attribute::ENUMERABLE | Attribute::CONFIGURABLE,
            );
        }
        IslandValue(object.build().into())
    })
}

pub fn island_value_array(values: Vec<IslandValue>) -> IslandValue {
    with_island_state(|state| {
        IslandValue(
            BoaJsArray::from_iter(values.into_iter().map(|value| value.0), &mut state.context)
                .into(),
        )
    })
}

/// Copy one native JSON value into the embedded JavaScript realm.
///
/// Generated code serializes its typed record/array before this call, so the
/// engine receives ordinary JavaScript objects rather than an opaque host
/// handle. JSON.parse also keeps the boundary's existing deep-copy stance.
pub fn island_value_json(value: &JsString) -> IslandValue {
    with_island_state(|state| {
        let context = &mut state.context;
        let parsed = island_parse_json(value, context)
            .unwrap_or_else(|error| island_eval_error(error, context));
        IslandValue(parsed)
    })
}

/// Install the web-platform globals, before any embedded module parses.
///
/// The prelude is an arrow taking the same `host` bridge the module
/// bootstrap gets, because `globalThis.crypto` needs native randomness;
/// the C island's scr_island_web_boot has exactly this shape.
fn island_web_boot(context: &mut Context) -> JsResult<()> {
    let host = island_host_object(context);
    for source in [ISLAND_STREAM_BOOTSTRAP, ISLAND_WEB_BOOTSTRAP] {
        let boot = context.eval(Source::from_bytes(source))?;
        let Some(boot) = boot.as_callable() else {
            return Err(boa_engine::JsNativeError::typ()
                .with_message("scriptc: island web bootstrap is not callable")
                .into());
        };
        boot.call(&JsValue::undefined(), &[host.clone().into()], context)?;
    }
    Ok(())
}

/// Rebuild one native RegExp as a FRESH engine RegExp from its
/// source and flags — the pattern TEXT crosses, not the compiled
/// program (host and realm each compile the ES-spec grammar). Identity
/// and `lastIndex` state deliberately do not cross: every marshal mints
/// a new realm object, matching the C island's stance.
pub fn island_value_regexp(source: &JsString, flags: &JsString) -> IslandValue {
    with_island_state(|state| {
        let context = &mut state.context;
        let value = island_construct_regexp(source, flags, context)
            .unwrap_or_else(|error| island_eval_error(error, context));
        IslandValue(value)
    })
}

/// Run the realm's own `RegExp` constructor over host-produced text.
fn island_construct_regexp(
    source: &JsString,
    flags: &JsString,
    context: &mut Context,
) -> JsResult<JsValue> {
    let global = context.global_object();
    let regexp = global.get(js_string!("RegExp"), context)?;
    let Some(regexp) = regexp.as_constructor() else {
        return Err(boa_engine::JsNativeError::typ()
            .with_message("Embedded RegExp is not a constructor")
            .into());
    };
    let args = [
        JsValue::from(boa_engine::JsString::from(source.as_ref())),
        JsValue::from(boa_engine::JsString::from(flags.as_ref())),
    ];
    Ok(regexp.construct(&args, None, context)?.into())
}

/// Run the realm's own `JSON.parse` over host-produced text.
fn island_parse_json(value: &JsString, context: &mut Context) -> JsResult<JsValue> {
    let global = context.global_object();
    let json = global.get(js_string!("JSON"), context)?;
    let json = json.to_object(context)?;
    let parse = json.get(js_string!("parse"), context)?;
    let Some(parse) = parse.as_callable() else {
        return Err(boa_engine::JsNativeError::typ()
            .with_message("Embedded JSON.parse is not callable")
            .into());
    };
    let input = JsValue::from(boa_engine::JsString::from(value.as_ref()));
    parse.call(&JsValue::from(json), &[input], context)
}

pub fn island_is_nullish(value: &IslandValue) -> bool {
    value.0.is_null_or_undefined()
}

pub fn island_is_undefined(value: &IslandValue) -> bool {
    value.0.is_undefined()
}

pub fn island_is_null(value: &IslandValue) -> bool {
    value.0.is_null()
}

pub fn island_strict_equal_boolean(value: &IslandValue, other: bool) -> bool {
    value.0.strict_equals(&JsValue::from(other))
}

pub fn island_strict_equal_number(value: &IslandValue, other: f64) -> bool {
    value.0.strict_equals(&JsValue::from(other))
}

pub fn island_strict_equal_string(value: &IslandValue, other: &JsString) -> bool {
    value
        .0
        .strict_equals(&JsValue::from(boa_engine::JsString::from(other.as_ref())))
}

pub fn island_get_property(value: &IslandValue, name: &str) -> IslandValue {
    with_island_state(|state| {
        let object = value
            .0
            .to_object(&mut state.context)
            .unwrap_or_else(|error| island_eval_error(error, &mut state.context));
        let property = object
            .get(boa_engine::JsString::from(name), &mut state.context)
            .unwrap_or_else(|error| island_eval_error(error, &mut state.context));
        IslandValue(property)
    })
}

pub fn island_get_index(value: &IslandValue, key: &IslandValue) -> IslandValue {
    with_island_state(|state| {
        let object = value
            .0
            .to_object(&mut state.context)
            .unwrap_or_else(|error| island_eval_error(error, &mut state.context));
        let property_key = key
            .0
            .to_property_key(&mut state.context)
            .unwrap_or_else(|error| island_eval_error(error, &mut state.context));
        let property = object
            .get(property_key, &mut state.context)
            .unwrap_or_else(|error| island_eval_error(error, &mut state.context));
        IslandValue(property)
    })
}

pub fn island_set_index(value: &IslandValue, key: &IslandValue, field: &IslandValue) {
    with_island_state(|state| {
        let context = &mut state.context;
        let object = value
            .0
            .to_object(context)
            .unwrap_or_else(|error| island_eval_error(error, context));
        let property_key = key
            .0
            .to_property_key(context)
            .unwrap_or_else(|error| island_eval_error(error, context));
        object
            .set(property_key, field.0.clone(), true, context)
            .unwrap_or_else(|error| island_eval_error(error, context));
    });
}

pub fn island_global_get(name: &str) -> IslandValue {
    with_island_state(|state| {
        let global = state.context.global_object();
        let value = global
            .get(
                boa_engine::JsString::from(name),
                &mut state.context,
            )
            .unwrap_or_else(|error| island_eval_error(error, &mut state.context));
        IslandValue(value)
    })
}

pub fn island_is_function(value: &IslandValue) -> bool {
    value.0.as_callable().is_some()
}

pub fn island_truthy(value: &IslandValue) -> bool {
    value.0.to_boolean()
}

pub fn island_iter_new(value: &IslandValue) -> IslandValue {
    with_island_state(|state| {
        let context = &mut state.context;
        let object = value
            .0
            .to_object(context)
            .unwrap_or_else(|error| island_eval_error(error, context));
        let method = object
            .get(BoaJsSymbol::iterator(), context)
            .unwrap_or_else(|error| island_eval_error(error, context));
        let Some(method) = method.as_callable() else {
            throw_type_error("value is not iterable".to_owned());
        };
        let iterator = method
            .call(&value.0, &[], context)
            .unwrap_or_else(|error| island_eval_error(error, context));
        if !iterator.is_object() {
            throw_type_error("iterator method returned a non-object".to_owned());
        }
        IslandValue(iterator)
    })
}

/// Consume an embedded JavaScript value through its synchronous iterator.
///
/// `None` means the value has no callable `Symbol.iterator`; errors thrown by
/// getters or by the iterator itself retain their JavaScript exception path.
/// Generated spread code owns the Node-specific message for the `None` case.
pub fn island_spread_values(value: &IslandValue) -> Option<Vec<IslandValue>> {
    with_island_state(|state| {
        let context = &mut state.context;
        if value.0.is_null_or_undefined() {
            return None;
        }
        let object = value
            .0
            .to_object(context)
            .unwrap_or_else(|error| island_eval_error(error, context));
        let method = object
            .get(BoaJsSymbol::iterator(), context)
            .unwrap_or_else(|error| island_eval_error(error, context));
        let method = method.as_callable()?;
        let iterator = method
            .call(&value.0, &[], context)
            .unwrap_or_else(|error| island_eval_error(error, context));
        let Some(iterator) = iterator.as_object() else {
            throw_type_error("iterator method returned a non-object".to_owned());
        };
        let next = iterator
            .get(js_string!("next"), context)
            .unwrap_or_else(|error| island_eval_error(error, context));
        let Some(next) = next.as_callable() else {
            throw_type_error("iterator.next is not a function".to_owned());
        };
        let mut values = Vec::new();
        loop {
            let result = next
                .call(&iterator.clone().into(), &[], context)
                .unwrap_or_else(|error| island_eval_error(error, context));
            let Some(result) = result.as_object() else {
                throw_type_error("iterator result is not an object".to_owned());
            };
            let done = result
                .get(js_string!("done"), context)
                .unwrap_or_else(|error| island_eval_error(error, context))
                .to_boolean();
            if done {
                break;
            }
            let item = result
                .get(js_string!("value"), context)
                .unwrap_or_else(|error| island_eval_error(error, context));
            values.push(IslandValue(item));
        }
        Some(values)
    })
}

/// Apply JavaScript await adoption inside the embedded realm and return the
/// fulfilled value. Engine jobs run on this thread, while host-backed
/// promises may also require native timers or sockets; both are driven until
/// this promise settles, never by holding the island-state borrow.
pub fn island_await(value: &IslandValue) -> IslandValue {
    let promise = with_island_state(|state| {
        let promise = BoaJsPromise::resolve(value.0.clone(), &mut state.context)
            .unwrap_or_else(|error| island_eval_error(error, &mut state.context));
        island_run_jobs(state);
        promise
    });
    let settled = || {
        with_island_state(|_| !matches!(promise.state(), BoaPromiseState::Pending))
    };
    if !settled() && !run_event_loop_until(settled) {
        throw_error_code(
            "Embedded module promise did not settle".to_owned(),
            "ERR_MODULE_PROMISE_PENDING",
        );
    }
    with_island_state(|state| match promise.state() {
        BoaPromiseState::Fulfilled(value) => IslandValue(value),
        BoaPromiseState::Rejected(reason) => {
            island_eval_error(BoaJsError::from_opaque(reason), &mut state.context)
        }
        BoaPromiseState::Pending => unreachable!("settled island promise became pending"),
    })
}

/// Drain the realm's queued promise jobs.
///
/// Safe to call synchronously only because the island never enqueues a
/// boa clock job — island timers live on the native heap — so
/// `run_jobs` has nothing to block on and returns once the queue empties.
fn island_run_jobs(state: &mut IslandState) {
    state
        .context
        .run_jobs()
        .unwrap_or_else(|error| island_eval_error(error, &mut state.context));
}

struct IslandState {
    context: Context,
    loader: Rc<IslandModuleLoader>,
    modules: HashMap<&'static str, Module>,
    evaluated: HashSet<String>,
    /// `node:` wrappers synthesized on demand for `import()`. Keyed by
    /// specifier because builtin keys are not in the embedded table.
    builtins: HashMap<String, Module>,
}

/// Evaluate JavaScript in the persistent island realm and return String(result).
///
/// The context is thread-local because Boa values are deliberately single-threaded;
/// generated programs execute their JavaScript event loop on the main thread too.
pub fn island_eval(code: &JsString) -> JsString {
    with_island_state(|state| {
        let context = &mut state.context;
        let value = context
            .eval(Source::from_bytes(code.as_bytes()))
            .unwrap_or_else(|error| island_eval_error(error, context));
        island_render(value, context)
    })
}

/// Why an embedded module could not be made available.
///
/// `Coded` is a scriptc-level refusal carrying a Node error code (the key
/// is not in the build's table, or the module never finished evaluating);
/// `Engine` is the module's own thrown value. Static `island_import`
/// raises either as a throw at the import site; dynamic
/// `island_import_dyn` turns either into a rejection, which is where Node
/// puts a dynamic import's failure.
enum IslandImportFailure {
    Coded(String, &'static str),
    Engine(BoaJsError),
}

/// Evaluate one embedded module (once per realm) and answer its namespace.
///
/// Both import paths share this: the static form reads one export off the
/// namespace, the dynamic form hands the whole object across.
fn island_module_namespace(
    state: &mut IslandState,
    key: &str,
) -> Result<JsValue, IslandImportFailure> {
    let Some((&module_key, module)) = state.modules.get_key_value(key) else {
        // A `node:` specifier is never in the embedded table — the build
        // embeds npm sources, not builtins — so it takes the same
        // synthesized wrapper the ES loader hands the static graph.
        if key.starts_with("node:") {
            return island_builtin_namespace(state, key);
        }
        return Err(IslandImportFailure::Coded(
            format!("Cannot find embedded module '{key}'"),
            "ERR_MODULE_NOT_FOUND",
        ));
    };
    let module = module.clone();
    if !state.evaluated.contains(module_key) {
        island_module_evaluate(state, &module, key)?;
        // Cache only a successful lifecycle. Marking before evaluation
        // made a rejected first import expose an unevaluated namespace on
        // the second import instead of rejecting with the module failure.
        state.evaluated.insert(module_key.to_owned());
    }
    Ok(module.namespace(&mut state.context).into())
}

/// A `node:` builtin reached through `import()`.
///
/// The wrapper is the loader's own (`island_builtin_wrapper`): it only
/// calls `__scr_require`, so it links against nothing and can be parsed
/// and evaluated standalone. Cached per realm, so repeated imports of the
/// same builtin answer the same namespace, like Node's module cache.
fn island_builtin_namespace(
    state: &mut IslandState,
    key: &str,
) -> Result<JsValue, IslandImportFailure> {
    if let Some(module) = state.builtins.get(key).cloned() {
        return Ok(module.namespace(&mut state.context).into());
    }
    let source = island_builtin_wrapper(key);
    let mut bytes = source.as_bytes();
    let module = Module::parse(
        Source::from_reader(&mut bytes, Some(Path::new(key))),
        None,
        &mut state.context,
    )
    .map_err(IslandImportFailure::Engine)?;
    island_module_evaluate(state, &module, key)?;
    state.builtins.insert(key.to_owned(), module.clone());
    Ok(module.namespace(&mut state.context).into())
}

/// Load, link and evaluate one module, draining the jobs its evaluation
/// queues so a rejection is visible now rather than at the next turn.
fn island_module_evaluate(
    state: &mut IslandState,
    module: &Module,
    key: &str,
) -> Result<(), IslandImportFailure> {
    let promise = module.load_link_evaluate(&mut state.context);
    state
        .context
        .run_jobs()
        .map_err(IslandImportFailure::Engine)?;
    match promise.state() {
        BoaPromiseState::Fulfilled(_) => Ok(()),
        BoaPromiseState::Rejected(reason) => {
            Err(IslandImportFailure::Engine(BoaJsError::from_opaque(reason)))
        }
        BoaPromiseState::Pending => Err(IslandImportFailure::Coded(
            format!("Embedded module '{key}' did not finish evaluating"),
            "ERR_MODULE_EVALUATION_PENDING",
        )),
    }
}

/// Raise an import failure as a static scriptc throw.
fn island_import_throw(failure: IslandImportFailure, context: &mut Context) -> ! {
    match failure {
        IslandImportFailure::Coded(message, code) => throw_error_code(message, code),
        IslandImportFailure::Engine(error) => island_eval_error(error, context),
    }
}

/// The rejection reason the same failure carries into the realm.
fn island_import_reason(failure: IslandImportFailure, context: &mut Context) -> BoaJsError {
    match failure {
        IslandImportFailure::Coded(message, code) => {
            let error = boa_engine::JsNativeError::error()
                .with_message(message)
                .into_opaque(context);
            // Node's module errors are recognised by `.code`, so the
            // rejection reason carries it like the static throw does.
            let _ = error.set(
                js_string!("code"),
                boa_engine::JsString::from(code),
                false,
                context,
            );
            BoaJsError::from_opaque(error.into())
        }
        IslandImportFailure::Engine(error) => error,
    }
}

pub fn island_import(key: &JsString, export: &JsString) -> IslandValue {
    with_island_state(|state| {
        let namespace = island_module_namespace(state, key.as_ref())
            .unwrap_or_else(|failure| island_import_throw(failure, &mut state.context));
        let value = namespace
            .to_object(&mut state.context)
            .unwrap_or_else(|error| island_eval_error(error, &mut state.context))
            .get(
                boa_engine::JsString::from(export.as_ref()),
                &mut state.context,
            )
            .unwrap_or_else(|error| island_eval_error(error, &mut state.context));
        IslandValue(value)
    })
}

/// Dynamic `import(key)` — the embedded module's whole namespace object.
///
/// Node's dynamic import never throws at the call site: a load or
/// evaluation failure REJECTS the answered promise. So this answers the
/// realm's own promise and the static bridge (`jsBridgePromise`) adopts
/// the settlement exactly where `await import(...)` puts it.
pub fn island_import_dyn(key: &JsString) -> IslandValue {
    with_island_state(|state| {
        let promise = match island_module_namespace(state, key.as_ref()) {
            Ok(namespace) => BoaJsPromise::resolve(namespace, &mut state.context),
            Err(failure) => {
                let reason = island_import_reason(failure, &mut state.context);
                BoaJsPromise::reject(reason, &mut state.context)
            }
        };
        let promise = promise.unwrap_or_else(|error| island_eval_error(error, &mut state.context));
        IslandValue(promise.into())
    })
}

/// Dynamic `import(specifier)` for a runtime-computed external file URL.
/// The call still answers an engine promise: URL, I/O, parse and evaluation
/// failures reject it rather than throwing synchronously.
pub fn island_import_dyn_path(specifier: &JsString) -> IslandValue {
    with_island_state(|state| {
        let loaded: Result<JsValue, IslandImportFailure> = (|| {
            let url = url::Url::parse(specifier.as_ref()).map_err(|_| {
                IslandImportFailure::Coded(
                    format!("Only file: URLs can be imported at runtime: '{specifier}'"),
                    "ERR_UNSUPPORTED_ESM_URL_SCHEME",
                )
            })?;
            if url.scheme() != "file" {
                return Err(IslandImportFailure::Coded(
                    format!("Only file: URLs can be imported at runtime: '{specifier}'"),
                    "ERR_UNSUPPORTED_ESM_URL_SCHEME",
                ));
            }
            let path = url.to_file_path().map_err(|()| {
                IslandImportFailure::Coded(
                    format!("Invalid file URL '{specifier}'"),
                    "ERR_INVALID_FILE_URL_PATH",
                )
            })?;
            let key = path.to_string_lossy().into_owned();
            let module = state
                .loader
                .load_external(&path, &mut state.context)
                .map_err(IslandImportFailure::Engine)?;
            if !state.evaluated.contains(&key) {
                island_module_evaluate(state, &module, &key)?;
                state.evaluated.insert(key.clone());
            }
            Ok(module.namespace(&mut state.context).into())
        })();
        let promise = match loaded {
            Ok(namespace) => BoaJsPromise::resolve(namespace, &mut state.context),
            Err(failure) => {
                let reason = island_import_reason(failure, &mut state.context);
                BoaJsPromise::reject(reason, &mut state.context)
            }
        };
        let promise = promise.unwrap_or_else(|error| island_eval_error(error, &mut state.context));
        IslandValue(promise.into())
    })
}

pub fn island_call(callee: &IslandValue, args: &[IslandValue]) -> IslandValue {
    with_island_state(|state| {
        let Some(function) = callee.0.as_callable() else {
            throw_type_error("Embedded module export is not callable".to_owned());
        };
        let args = args.iter().map(|value| value.0.clone()).collect::<Vec<_>>();
        let value = function
            .call(&JsValue::undefined(), &args, &mut state.context)
            .unwrap_or_else(|error| island_eval_error(error, &mut state.context));
        IslandValue(value)
    })
}

/// `new Callee(...)` inside the realm — the spec's Construct.
///
/// A non-constructor RHS raises the engine's own refusal shape, and the
/// constructor's own throw crosses catchably like every other island op.
pub fn island_construct(callee: &IslandValue, args: &[IslandValue]) -> IslandValue {
    with_island_state(|state| {
        let Some(constructor) = callee.0.as_constructor() else {
            throw_type_error("Embedded module export is not a constructor".to_owned());
        };
        let args = args.iter().map(|value| value.0.clone()).collect::<Vec<_>>();
        let value = constructor
            .construct(&args, None, &mut state.context)
            .unwrap_or_else(|error| island_eval_error(error, &mut state.context));
        IslandValue(value.into())
    })
}

/// `value instanceof target` inside the realm — the spec's
/// InstanceofOperator, `Symbol.hasInstance` included. A non-object target
/// throws the engine's own TypeError, bridged catchably.
pub fn island_instance_of(value: &IslandValue, target: &IslandValue) -> bool {
    with_island_state(|state| {
        value
            .0
            .instance_of(&target.0, &mut state.context)
            .unwrap_or_else(|error| island_eval_error(error, &mut state.context))
    })
}

/// Call an already-read member with an explicit `this`.
///
/// `name` is only the spelling the non-callable TypeError uses; both the
/// plain and the optional method call reach the realm through here, so
/// the property is read exactly ONCE per call site.
fn island_call_with_this(
    callee: &IslandValue,
    this: &IslandValue,
    name: &str,
    args: &[IslandValue],
) -> IslandValue {
    with_island_state(|state| {
        let Some(function) = callee.0.as_callable() else {
            throw_type_error(format!("{name} is not a function"));
        };
        let args = args.iter().map(|value| value.0.clone()).collect::<Vec<_>>();
        let value = function
            .call(&this.0, &args, &mut state.context)
            .unwrap_or_else(|error| island_eval_error(error, &mut state.context));
        IslandValue(value)
    })
}

/// Call an already-read engine function with an explicit receiver.
///
/// Interface adapters read each method once when the namespace crosses the
/// checked boundary, then retain both handles and preserve member-call `this`.
pub fn island_call_this(
    callee: &IslandValue,
    receiver: &IslandValue,
    args: &[IslandValue],
) -> IslandValue {
    island_call_with_this(callee, receiver, "value", args)
}

pub fn island_call_method(receiver: &IslandValue, name: &str, args: &[IslandValue]) -> IslandValue {
    let member = island_get_property(receiver, name);
    island_call_with_this(&member, receiver, name, args)
}

/// `receiver.name?.(...)` — the optional METHOD call.
///
/// A nullish member answers the realm's `undefined` without calling;
/// anything else calls with `this = receiver`, so a non-callable member
/// still raises the TypeError `island_call_method` would.
pub fn island_opt_call_method(
    receiver: &IslandValue,
    name: &str,
    args: &[IslandValue],
) -> IslandValue {
    let member = island_get_property(receiver, name);
    if member.0.is_null_or_undefined() {
        return island_value_undefined();
    }
    island_call_with_this(&member, receiver, name, args)
}

pub fn island_json(value: &IslandValue) -> JsString {
    with_island_state(|state| {
        let json = value
            .0
            .to_json(&mut state.context)
            .unwrap_or_else(|error| island_eval_error(error, &mut state.context))
            .unwrap_or_else(|| {
                throw_type_error("Island value is not JSON-serializable".to_owned())
            });
        string(&json.to_string())
    })
}

pub fn island_json_node(value: &IslandValue) -> JsonNode {
    json_parse_node(&island_json(value)).unwrap_or_else(|message| throw_syntax_error(message))
}

pub fn island_to_string(value: &IslandValue) -> JsString {
    with_island_state(|state| island_render(value.0.clone(), &mut state.context))
}

/// Arm one island timer on the SHARED native timer heap.
///
/// Island `setTimeout`/`setInterval` ride `event_loop`'s `TIMER_TASKS` —
/// the very heap static code schedules on — so the two are one ordering
/// and one liveness account: an armed island timer keeps the process
/// alive, exactly as the C island's `host.setTimer` does (scr_web.c).
/// Scheduling through boa's own `TimeoutJob` was the alternative and is
/// wrong here: `SimpleJobExecutor::run_jobs` blocks on its private clock,
/// which would both stall the native loop and order island timers against
/// static ones by a second, unrelated clock.
///
/// A host function runs while `ISLAND_STATE` is ALREADY borrowed by the
/// call that reached it, so this must not re-enter — it only hands the
/// engine callback to the loop. The firing closure re-enters later, from
/// the timer phase, where no borrow is live.
fn island_timer_set(
    _this: &JsValue,
    arguments: &[JsValue],
    _context: &mut Context,
) -> JsResult<JsValue> {
    let Some(callback) = arguments.first().and_then(JsValue::as_callable) else {
        return Ok(JsValue::from(0.0));
    };
    let delay = arguments.get(1).and_then(JsValue::as_number).unwrap_or(0.0);
    let repeat = arguments.get(2).is_some_and(JsValue::to_boolean);
    let fire: Box<dyn FnMut()> = Box::new(move || island_timer_fire(&callback));
    let id = if repeat {
        timer_set_interval(fire, delay)
    } else {
        timer_set_timeout_handle(fire, delay)
    };
    Ok(JsValue::from(id))
}

fn island_timer_clear(
    _this: &JsValue,
    arguments: &[JsValue],
    _context: &mut Context,
) -> JsResult<JsValue> {
    if let Some(id) = arguments.first().and_then(JsValue::as_number) {
        timer_clear(id);
    }
    Ok(JsValue::undefined())
}

fn island_timer_set_ref(
    _this: &JsValue,
    arguments: &[JsValue],
    _context: &mut Context,
) -> JsResult<JsValue> {
    let id = arguments.first().and_then(JsValue::as_number).unwrap_or(0.0);
    let referenced = arguments.get(1).is_none_or(JsValue::to_boolean);
    Ok(JsValue::from(timer_set_ref(id, referenced)))
}

fn island_timer_has_ref(
    _this: &JsValue,
    arguments: &[JsValue],
    _context: &mut Context,
) -> JsResult<JsValue> {
    let id = arguments.first().and_then(JsValue::as_number).unwrap_or(0.0);
    Ok(JsValue::from(timer_has_ref(id)))
}

/// Run one island timer callback, then drain the microtasks it queued.
///
/// This is the island's macrotask boundary: the callback runs on the
/// loop's timer phase and its promise continuations settle before the
/// loop advances — Node's ordering, and what `web_timer_fire_cb` does on
/// the C side. Re-entering here is safe precisely because the loop owns
/// this call: no `ISLAND_STATE` borrow is live on the stack below it.
fn island_timer_fire(callback: &boa_engine::JsObject) {
    with_island_state(|state| {
        if let Err(error) = callback.call(&JsValue::undefined(), &[], &mut state.context) {
            island_eval_error(error, &mut state.context);
        }
        state
            .context
            .run_jobs()
            .unwrap_or_else(|error| island_eval_error(error, &mut state.context));
    });
}

/// The single funnel every island call passes through, so it is also the
/// one place that can catch an unwind crossing the realm and decide what
/// it means for `ISLAND_STATE`.
///
/// A scriptc `throw` reaching here (a `ScriptThrow`/`RuntimeTrap` marker)
/// is ordinary control flow — it is resumed untouched, and the realm's
/// globals stay live for a later `island_eval` call after the catch. Any
/// OTHER panic (an `assert!`/`.unwrap()` failure, a boa-internal bug) may
/// have left the engine's GC arena mid-mutation, so it gets `IslandState`
/// torn down right here, deterministically, before the unwind continues.
/// Previously that teardown never happened at all: the thread_local only
/// drops at uncontrolled thread-exit, by which point the corrupted
/// invariant had already turned into a glibc heap-corruption abort that
/// buried the original panic message.
fn with_island_state<T>(f: impl FnOnce(&mut IslandState) -> T) -> T {
    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        ISLAND_STATE.with(|slot| {
            let mut slot = slot.borrow_mut();
            let state = slot.get_or_insert_with(island_state);
            f(state)
        })
    }));
    match outcome {
        Ok(value) => value,
        Err(payload) => {
            if !is_scriptc_unwind(payload.as_ref()) {
                island_eval_finish();
            }
            std::panic::resume_unwind(payload)
        }
    }
}

fn island_state() -> IslandState {
    let loader = Rc::new(IslandModuleLoader::default());
    let mut context = Context::builder()
        .module_loader(loader.clone())
        .build()
        .unwrap_or_else(|error| panic!("scriptc: cannot create island context: {error}"));
    let console = ObjectInitializer::new(&mut context)
        .function(
            NativeFunction::from_fn_ptr(island_console_log),
            js_string!("log"),
            0,
        )
        .build();
    if let Err(error) = context.register_global_property(
        js_string!("console"),
        console,
        Attribute::WRITABLE | Attribute::CONFIGURABLE,
    ) {
        island_eval_error(error, &mut context);
    }
    island_web_boot(&mut context).unwrap_or_else(|error| island_eval_error(error, &mut context));
    // External modules loaded through a computed file URL can import Node
    // builtins even when the build embedded no npm modules. Install the
    // shared require/builtin bootstrap before parsing either graph.
    island_modules_boot(&mut context)
        .unwrap_or_else(|error| island_eval_error(error, &mut context));
    let embedded_modules = island_registered_modules();
    let mut modules = HashMap::new();
    for embedded in embedded_modules {
        // A JSON module keeps its native parse for the ES graph; CJS
        // files enter through their build-time facade over __scr_require.
        let module = if embedded.format == IslandModuleFormat::Json {
            Module::parse_json(boa_engine::JsString::from(embedded.source), &mut context)
        } else {
            let source = island_module_esm_source(embedded);
            let mut bytes = source.as_bytes();
            Module::parse(
                Source::from_reader(&mut bytes, Some(Path::new(embedded.key))),
                None,
                &mut context,
            )
        }
        .unwrap_or_else(|error| island_eval_error(error, &mut context));
        loader.insert(embedded.key, module.clone());
        modules.insert(embedded.key, module);
    }
    IslandState {
        context,
        loader,
        modules,
        evaluated: HashSet::new(),
        builtins: HashMap::new(),
    }
}

fn island_render(value: JsValue, context: &mut Context) -> JsString {
    if let Some(number) = value.as_number() {
        return string(&format_number(number));
    }
    if let Some(boolean) = value.as_boolean() {
        return string(if boolean { "true" } else { "false" });
    }
    let rendered = value
        .to_string(context)
        .unwrap_or_else(|error| island_eval_error(error, context));
    string(&rendered.to_std_string_lossy())
}

fn island_console_log(
    _this: &JsValue,
    arguments: &[JsValue],
    context: &mut Context,
) -> JsResult<JsValue> {
    let values = arguments
        .iter()
        .map(|argument| {
            argument
                .to_string(context)
                .map(|value| value.to_std_string_lossy())
        })
        .collect::<JsResult<Vec<_>>>()?;
    console_log(&values);
    Ok(JsValue::undefined())
}

fn island_eval_error(error: boa_engine::JsError, context: &mut Context) -> ! {
    if let Ok(native) = error.try_native(context) {
        let fallback = native.kind().to_string();
        let name = island_error_name(&error, context, &fallback);
        throw_value(error_new(&name, string(native.message())));
    }
    match error.into_opaque(context) {
        Ok(value) => match value.to_string(context) {
            Ok(reason) => throw_value(string(&reason.to_std_string_lossy())),
            Err(_) => throw_value(string("Error: unrepresentable island exception")),
        },
        Err(error) => throw_error(error.to_string()),
    }
}

fn island_error_name(error: &boa_engine::JsError, context: &mut Context, fallback: &str) -> String {
    let Ok(value) = error.clone().into_opaque(context) else {
        return fallback.to_owned();
    };
    let Some(object) = value.as_object() else {
        return fallback.to_owned();
    };
    let Ok(value) = object.get(js_string!("name"), context) else {
        return fallback.to_owned();
    };
    value
        .to_string(context)
        .map(|name| name.to_std_string_lossy())
        .unwrap_or_else(|_| fallback.to_owned())
}

/// Normal end-of-run teardown of the island realm and its host bridges.
///
/// Also reused as the panic-teardown path in `with_island_state`: an
/// unexpected panic (not a scriptc throw) crossing the realm calls this
/// too, so `ISLAND_STATE` never survives to an uncontrolled thread-exit
/// drop with the GC arena mid-mutation.
fn island_eval_finish() {
    ISLAND_STATE.with(|slot| *slot.borrow_mut() = None);
    island_modules_reset();
    ISLAND_HOST_CALLBACKS.with(|slot| slot.borrow_mut().clear());
    ISLAND_HOST_CALLBACK_ID.with(|slot| slot.set(0));
}
