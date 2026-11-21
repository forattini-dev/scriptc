// Promise payloads retain native owning values and use the shared Rust job queue.
impl runtime::HeapValue for NativeValue {
    fn trace_value(&self, tracer: &mut runtime::Tracer<'_>) {
        self.trace_native(tracer);
    }
}
fn native_promise_resolved(value: NativeValue) -> runtime::JsPromise<NativeValue> {
    if let NativeValue::Promise(promise) = value {
        return promise;
    }
    if !matches!(value, NativeValue::Undefined | NativeValue::Null) {
        let then = native_value_get(value.clone(), "then".into());
        if native_value_test(&then, "function") {
            let promise = runtime::promise_new();
            let _ = native_value_call_with_this(
                then,
                value,
                vec![
                    NativeValue::PromiseResolve(promise.clone()),
                    NativeValue::PromiseReject(promise.clone()),
                ],
                "thenable assimilation",
            );
            return promise;
        }
    }
    runtime::promise_resolved(value)
}
fn native_promise_plain(value: &NativeValue) {
    if matches!(value, NativeValue::Undefined | NativeValue::Null) {
        return;
    }
    let then = native_value_get(value.clone(), "then".into());
    if native_value_test(&then, "function") {
        runtime::throw_type_error("scriptc: native thenable assimilation is not ported".into());
    }
}
fn native_promise_then(
    source: runtime::JsPromise<NativeValue>,
    args: Vec<NativeValue>,
) -> runtime::JsPromise<NativeValue> {
    if args.len() > 2 {
        runtime::throw_type_error(
            "scriptc: native Promise.then extra arguments are not ported".into(),
        );
    }
    let callback = args.first().cloned().unwrap_or(NativeValue::Undefined);
    let rejected = args.get(1).cloned().unwrap_or(NativeValue::Undefined);
    let target = runtime::promise_new();
    let result = target.clone();
    runtime::promise_then(
        &source,
        Box::new(move |outcome| {
            let destination = target.clone();
            runtime::promise_run_segment(&destination, move || {
                let (callback, value) = match outcome {
                    Err(reason) if !native_value_test(&rejected, "function") => {
                        let _ = runtime::promise_reject(&target, reason);
                        return;
                    }
                    Err(reason) => (rejected, native_caught(reason)),
                    Ok(value) => (callback, value),
                };
                {
                    let value = if native_value_test(&callback, "function") {
                        native_value_call(callback, vec![value], "Promise reaction")
                    } else {
                        value
                    };
                    if let NativeValue::Promise(inner) = value {
                        if runtime::promise_view_identity(&inner)
                            == runtime::promise_view_identity(&target)
                        {
                            runtime::throw_type_error(
                                "Chaining cycle detected for promise #<Promise>".into(),
                            );
                        }
                        runtime::promise_adopt_return(&target, &inner, |value| value);
                    } else {
                        native_promise_plain(&value);
                        let _ = runtime::promise_fulfill(&target, value);
                    }
                }
            });
        }),
    );
    result
}

fn native_promise_settle_original(
    target: &runtime::JsPromise<NativeValue>,
    outcome: Result<NativeValue, runtime::Caught>,
) {
    match outcome {
        Ok(value) => {
            let _ = runtime::promise_fulfill(target, value);
        }
        Err(reason) => {
            let _ = runtime::promise_reject(target, reason);
        }
    }
}

fn native_promise_finally(
    source: runtime::JsPromise<NativeValue>,
    args: Vec<NativeValue>,
) -> runtime::JsPromise<NativeValue> {
    if args.len() > 1 {
        runtime::throw_type_error(
            "scriptc: native Promise.finally extra arguments are not ported".into(),
        );
    }
    let callback = args.first().cloned().unwrap_or(NativeValue::Undefined);
    let target = runtime::promise_new();
    let result = target.clone();
    runtime::promise_then(
        &source,
        Box::new(move |outcome| {
            let destination = target.clone();
            runtime::promise_run_segment(&destination, move || {
                if !native_value_test(&callback, "function") {
                    native_promise_settle_original(&target, outcome);
                    return;
                }
                let cleanup = native_value_call(callback, vec![], "Promise finally reaction");
                if let NativeValue::Promise(inner) = cleanup {
                    if runtime::promise_view_identity(&inner)
                        == runtime::promise_view_identity(&target)
                    {
                        runtime::throw_type_error(
                            "Chaining cycle detected for promise #<Promise>".into(),
                        );
                    }
                    let continuation = target.clone();
                    runtime::promise_then(
                        &inner,
                        Box::new(move |cleanup_outcome| match cleanup_outcome {
                            Ok(_) => native_promise_settle_original(&continuation, outcome),
                            Err(reason) => {
                                let _ = runtime::promise_reject(&continuation, reason);
                            }
                        }),
                    );
                } else {
                    native_promise_plain(&cleanup);
                    native_promise_settle_original(&target, outcome);
                }
            });
        }),
    );
    result
}
