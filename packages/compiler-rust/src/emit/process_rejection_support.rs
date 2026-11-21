// Native listener values are external roots until process shutdown.
thread_local! {
    static NATIVE_REJECTION_LISTENERS: std::cell::RefCell<Vec<NativeValue>> = const { std::cell::RefCell::new(Vec::new()) };
    static NATIVE_UNCAUGHT_LISTENERS: std::cell::RefCell<Vec<NativeValue>> = const { std::cell::RefCell::new(Vec::new()) };
    static NATIVE_UNCAUGHT_MONITORS: std::cell::RefCell<Vec<NativeValue>> = const { std::cell::RefCell::new(Vec::new()) };
    static NATIVE_EXIT_LISTENERS: std::cell::RefCell<Vec<NativeValue>> = const { std::cell::RefCell::new(Vec::new()) };
    static NATIVE_UNCAUGHT_ACTIVE: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

fn native_process_uncaught_active() -> bool {
    NATIVE_UNCAUGHT_ACTIVE.with(std::cell::Cell::get)
}

fn native_process_on_unhandled_rejection(listener: NativeValue) {
    NATIVE_REJECTION_LISTENERS.with(|listeners| listeners.borrow_mut().push(listener));
    native_process_install_rejection_handler();
}

fn native_process_on_uncaught_exception(listener: NativeValue) {
    NATIVE_UNCAUGHT_LISTENERS.with(|listeners| listeners.borrow_mut().push(listener));
    native_process_install_rejection_handler();
}

fn native_listener_remove(listeners: &std::cell::RefCell<Vec<NativeValue>>, listener: &NativeValue) {
    let mut listeners = listeners.borrow_mut();
    if let Some(index) = listeners.iter().position(|stored| native_value_eq(stored, listener)) {
        listeners.remove(index);
    }
}

fn native_process_on_exit(listener: NativeValue) {
    NATIVE_EXIT_LISTENERS.with(|listeners| listeners.borrow_mut().push(listener));
}
fn native_process_off_exit(listener: NativeValue) {
    NATIVE_EXIT_LISTENERS.with(|listeners| native_listener_remove(listeners, &listener));
}
fn native_process_on_uncaught_monitor(listener: NativeValue) {
    NATIVE_UNCAUGHT_MONITORS.with(|listeners| listeners.borrow_mut().push(listener));
}
fn native_process_off_uncaught_monitor(listener: NativeValue) {
    NATIVE_UNCAUGHT_MONITORS.with(|listeners| native_listener_remove(listeners, &listener));
}

fn native_process_dispatch_exit() {
    let listeners = NATIVE_EXIT_LISTENERS.with(|listeners| listeners.borrow().clone());
    for listener in listeners {
        native_value_call(listener, Vec::new(), "exit listener");
    }
}

fn native_process_dispatch_uncaught(reason: runtime::Caught) -> bool {
    let monitors = NATIVE_UNCAUGHT_MONITORS.with(|listeners| listeners.borrow().clone());
    for listener in monitors {
        native_value_call(listener, Vec::new(), "uncaughtExceptionMonitor listener");
    }
    let listeners = NATIVE_UNCAUGHT_LISTENERS.with(|listeners| listeners.borrow().clone());
    if listeners.is_empty() { return false; }
    NATIVE_UNCAUGHT_ACTIVE.with(|active| active.set(true));
    let reason = native_caught(reason);
    for listener in listeners {
        native_value_call(listener, vec![reason.clone()], "uncaughtException listener");
    }
    NATIVE_UNCAUGHT_ACTIVE.with(|active| active.set(false));
    true
}

fn native_process_install_rejection_handler() {
    runtime::promise_set_unhandled_rejection_handler(Some(std::rc::Rc::new(|reason, _promise| {
        // EventEmitter dispatch uses a snapshot when listeners mutate the list.
        let listeners = NATIVE_REJECTION_LISTENERS.with(|listeners| listeners.borrow().clone());
        if listeners.is_empty() {
            let value = native_caught(reason.clone());
            let reason = match value {
                NativeValue::Instance(ref instance) if instance.with(|instance| instance.error.is_some()) => reason,
                value => {
                    let description = match value {
                        NativeValue::Object(_) | NativeValue::Record(..) => runtime::string("#<Object>"),
                        NativeValue::Array(_) => runtime::string("[object Array]"),
                        NativeValue::Symbol(symbol) => runtime::symbol_to_string(&symbol),
                        primitive @ (NativeValue::Undefined | NativeValue::Null | NativeValue::Number(_) | NativeValue::BigInt(_) | NativeValue::Boolean(_) | NativeValue::String(_)) => native_value_string(primitive),
                        _ => runtime::throw_error_code("scriptc SC1031: unhandled rejection reason formatting is not ported".into(), "SC1031"),
                    };
                    let message = format!("This error originated either by throwing inside of an async function without a catch block, or by rejecting a promise which was not handled with .catch(). The promise rejected with the reason \"{description}\".");
                    runtime::caught_value(runtime::error_new_code("UnhandledPromiseRejection", runtime::string(&message), "ERR_UNHANDLED_REJECTION"))
                }
            };
            if !native_process_dispatch_uncaught(reason.clone()) { runtime::rethrow_caught(reason); }
            return;
        }
        let reason = native_caught(reason);
        for listener in listeners {
            native_value_call(listener, vec![reason.clone()], "unhandledRejection listener");
        }
    })));
}

fn clear_native_rejection_listeners() {
    runtime::promise_set_unhandled_rejection_handler(None);
    NATIVE_REJECTION_LISTENERS.with(|listeners| listeners.borrow_mut().clear());
    NATIVE_UNCAUGHT_LISTENERS.with(|listeners| listeners.borrow_mut().clear());
    NATIVE_UNCAUGHT_MONITORS.with(|listeners| listeners.borrow_mut().clear());
    NATIVE_EXIT_LISTENERS.with(|listeners| listeners.borrow_mut().clear());
    NATIVE_UNCAUGHT_ACTIVE.with(|active| active.set(false));
}
