use boa_engine::{
    Context, JsError as BoaJsError, JsResult, JsValue, Module, NativeFunction, Source, js_string,
    builtins::promise::PromiseState as BoaPromiseState,
    module::MapModuleLoader,
    object::ObjectInitializer,
    property::Attribute,
};
use std::path::Path;

thread_local! {
    static ISLAND_MODULES: RefCell<&'static [IslandModule]> = const { RefCell::new(&[]) };
    static ISLAND_STATE: RefCell<Option<IslandState>> = const { RefCell::new(None) };
}

const ISLAND_WEB_BOOTSTRAP: &str = include_str!("island_web.js");

#[derive(Clone, Copy)]
pub enum IslandModuleFormat {
    Esm,
    Json,
}

#[derive(Clone, Copy)]
pub struct IslandModule {
    pub key: &'static str,
    pub source: &'static str,
    pub format: IslandModuleFormat,
}

#[derive(Clone)]
pub struct IslandValue(JsValue);

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

pub fn island_is_nullish(value: &IslandValue) -> bool {
    value.0.is_null_or_undefined()
}

struct IslandState {
    context: Context,
    modules: HashMap<&'static str, Module>,
    evaluated: HashSet<&'static str>,
}

pub fn island_register_modules(modules: &'static [IslandModule]) {
    ISLAND_MODULES.with(|slot| *slot.borrow_mut() = modules);
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

pub fn island_import(key: &JsString, export: &JsString) -> IslandValue {
    with_island_state(|state| {
        let key = key.as_ref();
        let Some((&module_key, module)) = state.modules.get_key_value(key) else {
            throw_error_code(format!("Cannot find embedded module '{key}'"), "ERR_MODULE_NOT_FOUND");
        };
        if state.evaluated.insert(module_key) {
            let promise = module.load_link_evaluate(&mut state.context);
            state
                .context
                .run_jobs()
                .unwrap_or_else(|error| island_eval_error(error, &mut state.context));
            match promise.state() {
                BoaPromiseState::Fulfilled(_) => {}
                BoaPromiseState::Rejected(reason) => {
                    island_eval_error(BoaJsError::from_opaque(reason), &mut state.context);
                }
                BoaPromiseState::Pending => {
                    throw_error_code(
                        format!("Embedded module '{key}' did not finish evaluating"),
                        "ERR_MODULE_EVALUATION_PENDING",
                    );
                }
            }
        }
        let value = module
            .namespace(&mut state.context)
            .get(boa_engine::JsString::from(export.as_ref()), &mut state.context)
            .unwrap_or_else(|error| island_eval_error(error, &mut state.context));
        IslandValue(value)
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

pub fn island_call_method(receiver: &IslandValue, name: &str, args: &[IslandValue]) -> IslandValue {
    with_island_state(|state| {
        let object = receiver
            .0
            .to_object(&mut state.context)
            .unwrap_or_else(|error| island_eval_error(error, &mut state.context));
        let member = object
            .get(boa_engine::JsString::from(name), &mut state.context)
            .unwrap_or_else(|error| island_eval_error(error, &mut state.context));
        let Some(function) = member.as_callable() else {
            throw_type_error(format!("{name} is not a function"));
        };
        let args = args.iter().map(|value| value.0.clone()).collect::<Vec<_>>();
        let value = function
            .call(&receiver.0, &args, &mut state.context)
            .unwrap_or_else(|error| island_eval_error(error, &mut state.context));
        IslandValue(value)
    })
}

pub fn island_json(value: &IslandValue) -> JsString {
    with_island_state(|state| {
        let json = value
            .0
            .to_json(&mut state.context)
            .unwrap_or_else(|error| island_eval_error(error, &mut state.context))
            .unwrap_or_else(|| throw_type_error("Island value is not JSON-serializable".to_owned()));
        string(&json.to_string())
    })
}

pub fn island_json_node(value: &IslandValue) -> JsonNode {
    json_parse_node(&island_json(value)).unwrap_or_else(|message| throw_syntax_error(message))
}

pub fn island_to_string(value: &IslandValue) -> JsString {
    with_island_state(|state| island_render(value.0.clone(), &mut state.context))
}

fn with_island_state<T>(f: impl FnOnce(&mut IslandState) -> T) -> T {
    ISLAND_STATE.with(|slot| {
        let mut slot = slot.borrow_mut();
        let state = slot.get_or_insert_with(island_state);
        f(state)
    })
}

fn island_state() -> IslandState {
    let loader = Rc::new(MapModuleLoader::new());
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
    context
        .eval(Source::from_bytes(ISLAND_WEB_BOOTSTRAP))
        .unwrap_or_else(|error| island_eval_error(error, &mut context));
    let mut modules = HashMap::new();
    ISLAND_MODULES.with(|slot| {
        for embedded in slot.borrow().iter() {
            let module = match embedded.format {
                IslandModuleFormat::Esm => {
                    let mut bytes = embedded.source.as_bytes();
                    Module::parse(
                        Source::from_reader(&mut bytes, Some(Path::new(embedded.key))),
                        None,
                        &mut context,
                    )
                }
                IslandModuleFormat::Json => {
                    Module::parse_json(boa_engine::JsString::from(embedded.source), &mut context)
                }
            }
            .unwrap_or_else(|error| island_eval_error(error, &mut context));
            loader.insert(embedded.key, module.clone());
            modules.insert(embedded.key, module);
        }
    });
    IslandState { context, modules, evaluated: HashSet::new() }
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

fn island_eval_finish() {
    ISLAND_STATE.with(|slot| *slot.borrow_mut() = None);
    ISLAND_MODULES.with(|slot| *slot.borrow_mut() = &[]);
}
