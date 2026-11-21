// Included in emitted Rust for the represented Node stream class family.
fn native_node_stream_destroy(
    object: runtime::Gc<NativeInstance>,
    error: NativeValue,
) -> runtime::Gc<NativeInstance> {
    let first = object.with_mut(|object| {
        if object.stream_destroyed {
            false
        } else {
            object.stream_destroyed = true;
            true
        }
    });
    if first {
        let owner = object.clone();
        runtime::process_next_tick(Box::new(move || {
            let emitter =
                owner.with(|object| object.emitter.clone().expect("validated stream receiver"));
            if native_value_test(&error, "truthy") {
                let event = runtime::string("error");
                let listeners = runtime::emitter_snapshot(&emitter, &event);
                if listeners.is_empty() {
                    if matches!(&error, NativeValue::Instance(object) if object.with(|object| object.error.is_some()))
                    {
                        runtime::throw_value(error);
                    }
                    runtime::throw_error("Unhandled error.".into());
                }
                for listener in listeners {
                    if !runtime::emitter_listener_should_invoke(&listener) {
                        continue;
                    }
                    if listener.once {
                        runtime::emitter_remove_registration(
                            &emitter,
                            &event,
                            listener.registration,
                        );
                    }
                    native_value_call_with_this(
                        listener.callback,
                        NativeValue::Instance(owner.clone()),
                        vec![error.clone()],
                        "stream error listener",
                    );
                }
            }
            let event = runtime::string("close");
            for listener in runtime::emitter_snapshot(&emitter, &event) {
                if !runtime::emitter_listener_should_invoke(&listener) {
                    continue;
                }
                if listener.once {
                    runtime::emitter_remove_registration(&emitter, &event, listener.registration);
                }
                native_value_call_with_this(
                    listener.callback,
                    NativeValue::Instance(owner.clone()),
                    vec![],
                    "stream close listener",
                );
            }
        }));
    }
    object
}
