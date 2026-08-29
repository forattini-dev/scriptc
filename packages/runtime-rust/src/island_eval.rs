use boa_engine::{
    Context, JsResult, JsValue, NativeFunction, Source, js_string,
    object::ObjectInitializer,
    property::Attribute,
};

thread_local! {
    static ISLAND_CONTEXT: RefCell<Option<Context>> = const { RefCell::new(None) };
}

const ISLAND_WEB_BOOTSTRAP: &str = include_str!("island_web.js");

/// Evaluate JavaScript in the persistent island realm and return String(result).
///
/// The context is thread-local because Boa values are deliberately single-threaded;
/// generated programs execute their JavaScript event loop on the main thread too.
pub fn island_eval(code: &JsString) -> JsString {
    ISLAND_CONTEXT.with(|slot| {
        let mut slot = slot.borrow_mut();
        let context = slot.get_or_insert_with(island_context);
        let value = context
            .eval(Source::from_bytes(code.as_bytes()))
            .unwrap_or_else(|error| island_eval_error(error, context));
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
    })
}

fn island_context() -> Context {
    let mut context = Context::default();
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
    context
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
    ISLAND_CONTEXT.with(|slot| *slot.borrow_mut() = None);
}
