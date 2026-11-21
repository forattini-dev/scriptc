// Structured async continuations nest protected segments of one `try` region
// inside each other's unwind frames. An exception raised by that region's
// handler (the catch body and everything after it) is logically outside the
// region, so frames of the same region must let it pass; frames of an outer
// region still observe it. The marker is removed at the runtime boundary.
struct NativeAsyncBypass {
    region: u64,
    payload: Box<dyn std::any::Any + Send>,
}

#[allow(dead_code)]
fn native_async_bypass<F: FnOnce()>(region: u64, body: F) {
    if let Err(payload) = std::panic::catch_unwind(std::panic::AssertUnwindSafe(body)) {
        std::panic::resume_unwind(Box::new(NativeAsyncBypass { region, payload }));
    }
}

/// The payload a frame of `region` should handle: a marked payload from this
/// region keeps unwinding; a marked payload from another region is unwrapped.
#[allow(dead_code)]
fn native_async_bypass_check(
    payload: Box<dyn std::any::Any + Send>,
    region: u64,
) -> Box<dyn std::any::Any + Send> {
    match payload.downcast::<NativeAsyncBypass>() {
        Ok(marked) if marked.region == region => std::panic::resume_unwind(marked),
        Ok(marked) => native_async_bypass_unwrap(marked.payload),
        Err(payload) => payload,
    }
}

fn native_async_bypass_unwrap(mut payload: Box<dyn std::any::Any + Send>) -> Box<dyn std::any::Any + Send> {
    loop {
        match payload.downcast::<NativeAsyncBypass>() {
            Ok(marked) => payload = marked.payload,
            Err(original) => return original,
        }
    }
}

#[allow(dead_code)]
fn native_async_segment<T: runtime::HeapValue, F: FnOnce()>(promise: &runtime::JsPromise<T>, body: F) {
    runtime::promise_run_segment(promise, || {
        if let Err(payload) = std::panic::catch_unwind(std::panic::AssertUnwindSafe(body)) {
            std::panic::resume_unwind(native_async_bypass_unwrap(payload));
        }
    });
}
