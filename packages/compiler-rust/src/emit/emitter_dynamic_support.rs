// Dynamic EventEmitter dispatch: an erased receiver (`this` inside a mixin
// copied onto an EventEmitter subclass prototype, or an untyped parameter)
// still reaches the instance's native emitter registry.
fn native_emitter_owner(recv: &NativeValue) -> Option<runtime::Gc<NativeInstance>> {
    match recv {
        NativeValue::Instance(object) if object.with(|object| object.emitter.is_some()) => {
            Some(object.clone())
        }
        _ => None,
    }
}
fn native_weak_map_owner(recv: &NativeValue) -> Option<runtime::Gc<NativeInstance>> {
    match recv {
        NativeValue::Instance(object) if native_class_is_weak_map(object.with(|object| object.class)) => {
            Some(object.clone())
        }
        _ => None,
    }
}
fn native_weak_map_invoke(recv: &NativeValue, method: &str, args: &[NativeValue]) -> Option<NativeValue> {
    let receiver = native_weak_map_owner(recv)?;
    if !matches!(method, "get" | "set" | "has" | "delete") {
        return None;
    }
    let owner = runtime::WeakKey::new(&receiver);
    let key = match args.first().cloned().unwrap_or(NativeValue::Undefined) {
        NativeValue::Record(_, value) => Some(runtime::WeakKey::new(&value)),
        NativeValue::Object(value) => Some(runtime::WeakKey::new(&value)),
        NativeValue::Instance(value) => Some(runtime::WeakKey::new(&value)),
        NativeValue::Undefined
        | NativeValue::Null
        | NativeValue::Number(_)
        | NativeValue::Boolean(_)
        | NativeValue::String(_) => None,
        _ => runtime::throw_type_error("scriptc: WeakMap key representation is not ported".into()),
    };
    Some(match method {
        "get" => key
            .as_ref()
            .and_then(|key| runtime::weak_map_get::<NativeValue>(&owner, key))
            .unwrap_or(NativeValue::Undefined),
        "has" => NativeValue::Boolean(
            key.as_ref()
                .is_some_and(|key| runtime::weak_map_has::<NativeValue>(&owner, key)),
        ),
        "delete" => NativeValue::Boolean(
            key.as_ref()
                .is_some_and(|key| runtime::weak_map_delete::<NativeValue>(&owner, key)),
        ),
        _ => {
            let value = args.get(1).cloned().unwrap_or(NativeValue::Undefined);
            match key {
                Some(key) => runtime::weak_map_set(&owner, &key, value),
                None => runtime::throw_type_error("Invalid value used as weak map key".into()),
            }
            recv.clone()
        }
    })
}
fn native_emitter_method(recv: &NativeValue, method: &str) -> bool {
    if native_weak_map_owner(recv).is_some() {
        return matches!(method, "get" | "set" | "has" | "delete");
    }
    native_emitter_owner(recv).is_some()
        && matches!(
            method,
            "on" | "addListener"
                | "once"
                | "prependListener"
                | "prependOnceListener"
                | "off"
                | "removeListener"
                | "emit"
                | "listenerCount"
        )
}
fn native_emitter_invoke(recv: &NativeValue, method: &str, args: &[NativeValue]) -> Option<NativeValue> {
    if let Some(value) = native_weak_map_invoke(recv, method, args) {
        return Some(value);
    }
    if native_emitter_owner(recv).is_none() || !native_emitter_method(recv, method) {
        return None;
    }
    let owner = native_emitter_owner(recv)?;
    let emitter = owner.with(|object| object.emitter.clone().expect("checked EventEmitter owner"));
    let event = match args.first() {
        Some(NativeValue::String(event)) => event.clone(),
        Some(other) => native_value_string(other.clone()),
        None => runtime::string("undefined"),
    };
    match method {
        "on" | "addListener" | "once" | "prependListener" | "prependOnceListener" => {
            let callback = args.get(1).cloned().unwrap_or(NativeValue::Undefined);
            if !native_value_is_function(&callback) {
                runtime::throw_type_error("The listener argument must be of type function".into());
            }
            let once = matches!(method, "once" | "prependOnceListener");
            let prepend = matches!(method, "prependListener" | "prependOnceListener");
            runtime::emitter_on(&emitter, event, callback, 0, once, prepend);
            Some(recv.clone())
        }
        "off" | "removeListener" => {
            let callback = args.get(1).cloned().unwrap_or(NativeValue::Undefined);
            runtime::emitter_off_matching(&emitter, &event, |stored| native_value_eq(stored, &callback));
            Some(recv.clone())
        }
        "listenerCount" => Some(NativeValue::Number(
            runtime::emitter_snapshot(&emitter, &event).len() as f64,
        )),
        _ => {
            let payloads = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let listeners = runtime::emitter_snapshot(&emitter, &event);
            let handled = !listeners.is_empty();
            if !handled && event == "error" {
                if let Some(payload) = payloads.first() {
                    if matches!(payload, NativeValue::Instance(object) if object.with(|object| object.error.is_some())) {
                        runtime::throw_value(payload.clone());
                    }
                }
                runtime::throw_error("Unhandled error.".into());
            }
            for listener in listeners {
                if !runtime::emitter_listener_should_invoke(&listener) {
                    continue;
                }
                if listener.once {
                    runtime::emitter_remove_registration(&emitter, &event, listener.registration);
                }
                native_value_call_with_this(listener.callback, recv.clone(), payloads.clone(), "EventEmitter listener");
            }
            Some(NativeValue::Boolean(handled))
        }
    }
}

const NATIVE_EMITTER_METHODS: [&str; 9] = [
    "on",
    "addListener",
    "once",
    "prependListener",
    "prependOnceListener",
    "off",
    "removeListener",
    "emit",
    "listenerCount",
];
fn native_emitter_method_name(index: u8) -> &'static str {
    NATIVE_EMITTER_METHODS[index as usize]
}
/// `this.emit` read as a value on an EventEmitter instance: a callable bound
/// to the instance's native emitter (so `.bind`, `.call` and storing work).
fn native_emitter_property(value: &NativeValue, key: &runtime::JsString) -> Option<NativeValue> {
    native_emitter_owner(value)?;
    let name = key.well_formed_utf8()?;
    let index = NATIVE_EMITTER_METHODS.iter().position(|method| *method == name)?;
    Some(NativeValue::EmitterMethod(Box::new(value.clone()), index as u8))
}
