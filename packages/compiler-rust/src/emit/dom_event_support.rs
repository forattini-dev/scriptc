// Embedded in generated programs with class support.
fn native_dom_event_property(
    object: &runtime::Gc<NativeInstance>,
    key: &runtime::JsString,
) -> Option<NativeValue> {
    let event = object.with(|object| object.dom_event.clone())?;
    event.with(|event| {
        Some(match key.well_formed_utf8()? {
            "type" => NativeValue::String(event.name.clone()),
            "bubbles" => NativeValue::Boolean(event.bubbles),
            "cancelable" => NativeValue::Boolean(event.cancelable),
            "composed" => NativeValue::Boolean(event.composed),
            "defaultPrevented" => NativeValue::Boolean(event.default_prevented),
            "cancelBubble" => NativeValue::Boolean(event.propagation_stopped),
            "isTrusted" => NativeValue::Boolean(false),
            "eventPhase" => NativeValue::Number(if event.current_target.is_some() {
                2.0
            } else {
                0.0
            }),
            "target" | "srcElement" => event.target.clone().unwrap_or(NativeValue::Null),
            "currentTarget" => event.current_target.clone().unwrap_or(NativeValue::Null),
            _ => return None,
        })
    })
}

fn native_dom_event_method(receiver: &NativeValue, method: &str) -> bool {
    matches!(receiver, NativeValue::Instance(object) if object.with(|object| object.dom_event.is_some()))
        && matches!(
            method,
            "preventDefault" | "stopPropagation" | "stopImmediatePropagation"
        )
}

fn native_dom_event_invoke(receiver: &NativeValue, method: &str) -> Option<NativeValue> {
    if !native_dom_event_method(receiver, method) {
        return None;
    }
    let NativeValue::Instance(object) = receiver else {
        unreachable!()
    };
    let event = object.with(|object| object.dom_event.clone().expect("validated Event receiver"));
    match method {
        "preventDefault" => runtime::dom_event_prevent_default(&event),
        "stopPropagation" => runtime::dom_event_stop_propagation(&event),
        "stopImmediatePropagation" => runtime::dom_event_stop_immediate(&event),
        _ => unreachable!(),
    }
    Some(NativeValue::Undefined)
}

fn native_dom_target_listener(
    owner: runtime::Gc<NativeInstance>,
    name: runtime::JsString,
    callback: NativeValue,
    options: NativeValue,
    adding: bool,
) {
    let target = owner.with(|object| {
        object
            .dom_target
            .clone()
            .expect("validated EventTarget receiver")
    });
    if matches!(callback, NativeValue::Undefined | NativeValue::Null) {
        return;
    }
    if !native_value_is_function(&callback) && !native_value_test(&callback, "objectInstance") {
        runtime::throw_type_error("EventTarget listener must be a function or object".into());
    }
    let mut capture = false;
    let mut once = false;
    let mut passive = false;
    let mut signal = None;
    if let NativeValue::Boolean(value) = options {
        capture = value;
    } else if !matches!(options, NativeValue::Undefined | NativeValue::Null) {
        if !native_value_test(&options, "objectInstance") {
            runtime::throw_type_error("EventTarget options must be an object or boolean".into());
        }
        if adding {
            once = native_value_test(
                &native_value_get(options.clone(), runtime::string("once")),
                "truthy",
            );
        }
        capture = native_value_test(
            &native_value_get(options.clone(), runtime::string("capture")),
            "truthy",
        );
        if adding {
            passive = native_value_test(
                &native_value_get(options.clone(), runtime::string("passive")),
                "truthy",
            );
            signal = match native_value_get(options, runtime::string("signal")) {
                NativeValue::Undefined => None,
                NativeValue::AbortSignal(signal) => Some(signal),
                _ => runtime::throw_type_error("EventTarget signal must be an AbortSignal".into()),
            };
        }
    }
    if adding {
        if signal.as_ref().is_some_and(runtime::abort_signal_aborted) {
            return;
        }
        runtime::dom_target_add(
            &target,
            name.clone(),
            callback.clone(),
            capture,
            once,
            passive,
            native_value_eq,
        );
        if let Some(signal) = signal {
            let weak_target = target.downgrade();
            let listener = std::rc::Rc::new(callback);
            let trace_listener = listener.clone();
            let identity_token = std::rc::Rc::new(());
            let identity = std::rc::Rc::as_ptr(&identity_token) as usize;
            runtime::abort_signal_add_listener(
                &signal,
                identity,
                std::rc::Rc::new(move |source| {
                    let _keep_identity_alive = &identity_token;
                    if let Some(target) = weak_target.upgrade() {
                        runtime::dom_target_remove(
                            &target,
                            &name,
                            &listener,
                            capture,
                            native_value_eq,
                        );
                    }
                    runtime::abort_signal_remove_listener(source, identity);
                }),
                std::rc::Rc::new(move |tracer| trace_listener.trace_native(tracer)),
            );
        }
    } else {
        runtime::dom_target_remove(&target, &name, &callback, capture, native_value_eq);
    }
}

fn native_dom_target_dispatch(owner: runtime::Gc<NativeInstance>, value: NativeValue) -> bool {
    let target = owner.with(|object| {
        object
            .dom_target
            .clone()
            .expect("validated EventTarget receiver")
    });
    let NativeValue::Instance(object) = &value else {
        runtime::throw_type_error("The event argument must be an Event".into());
    };
    let Some(event) = object.with(|object| object.dom_event.clone()) else {
        runtime::throw_type_error("The event argument must be an Event".into());
    };
    let receiver = NativeValue::Instance(owner);
    let Some(_dispatch) = runtime::dom_event_begin(&event, receiver.clone()) else {
        runtime::throw_error_code(
            "The event is already being dispatched".into(),
            "ERR_EVENT_RECURSION",
        );
    };
    let name = event.with(|event| event.name.clone());
    for listener in runtime::dom_target_snapshot(&target, &name) {
        if event.with(|event| event.immediate_stopped) {
            break;
        }
        if !runtime::dom_target_claim(&target, &listener) {
            continue;
        }
        let _passive = runtime::dom_event_enter_listener(&event, listener.passive);
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            if native_value_is_function(&listener.callback) {
                native_value_call_with_this(
                    listener.callback.clone(),
                    receiver.clone(),
                    vec![value.clone()],
                    "EventTarget listener",
                )
            } else {
                let method =
                    native_value_get(listener.callback.clone(), runtime::string("handleEvent"));
                if !matches!(method, NativeValue::Undefined | NativeValue::Null) {
                    native_value_call_with_this(
                        method,
                        listener.callback.clone(),
                        vec![value.clone()],
                        "handleEvent",
                    )
                } else {
                    NativeValue::Undefined
                }
            }
        }));
        match result {
            Err(payload) => {
                let caught = runtime::caught_from_panic(payload);
                runtime::process_next_tick(Box::new(move || runtime::rethrow_caught(caught)));
            }
            Ok(NativeValue::Promise(promise)) => {
                runtime::promise_then(
                    &promise,
                    Box::new(|result| {
                        if let Err(caught) = result {
                            runtime::process_next_tick(Box::new(move || {
                                runtime::rethrow_caught(caught)
                            }));
                        }
                    }),
                );
            }
            Ok(_) => {}
        }
        runtime::dom_event_leave_listener(&event);
    }
    !event.with(|event| event.default_prevented)
}
