thread_local! {
    static FFI_CALLBACK_PANIC: RefCell<Option<Box<dyn Any + Send>>> = const {
        RefCell::new(None)
    };
    static FFI_RETAINED_CALLBACKS: RefCell<Vec<FfiRetainedCallback>> = const {
        RefCell::new(Vec::new())
    };
}

struct FfiRetainedCallback {
    key: &'static str,
    identity: usize,
    callback: *const std::ffi::c_void,
    context: *mut std::ffi::c_void,
    cleanup: Option<fn()>,
    _owner: Box<dyn Any>,
}

pub fn ffi_callback_panicked() -> bool {
    FFI_CALLBACK_PANIC.with(|slot| slot.borrow().is_some())
}

pub fn ffi_store_callback_panic(payload: Box<dyn Any + Send>) {
    FFI_CALLBACK_PANIC.with(|slot| {
        let mut slot = slot.borrow_mut();
        if slot.is_none() {
            *slot = Some(payload);
        }
    });
}

pub fn ffi_resume_callback_panic() {
    let payload = FFI_CALLBACK_PANIC.with(|slot| slot.take());
    if let Some(payload) = payload {
        std::panic::resume_unwind(payload);
    }
}

pub fn ffi_retained_context<T>(owner: &T) -> *mut std::ffi::c_void {
    std::ptr::from_ref(owner).cast_mut().cast::<std::ffi::c_void>()
}

pub fn ffi_commit_retained_callback<T: 'static>(
    key: &'static str,
    identity: usize,
    callback: *const std::ffi::c_void,
    context: *mut std::ffi::c_void,
    owner: Box<T>,
) {
    FFI_RETAINED_CALLBACKS.with(|callbacks| {
        callbacks.borrow_mut().push(FfiRetainedCallback {
            key,
            identity,
            callback,
            context,
            cleanup: None,
            _owner: owner,
        });
    });
}

pub fn ffi_commit_retained_raw_callback(
    key: &'static str,
    identity: usize,
    callback: *const std::ffi::c_void,
    cleanup: fn(),
) {
    FFI_RETAINED_CALLBACKS.with(|callbacks| {
        callbacks.borrow_mut().push(FfiRetainedCallback {
            key,
            identity,
            callback,
            context: std::ptr::null_mut(),
            cleanup: Some(cleanup),
            _owner: Box::new(()),
        });
    });
}

pub fn ffi_retire_retained_raw_callback(key: &str) {
    let cleanup = FFI_RETAINED_CALLBACKS.with(|callbacks| {
        let mut callbacks = callbacks.borrow_mut();
        callbacks
            .iter()
            .rposition(|entry| entry.key == key && entry.cleanup.is_some())
            .and_then(|index| callbacks.remove(index).cleanup)
    });
    if let Some(cleanup) = cleanup {
        cleanup();
    }
}

pub fn ffi_retained_callback(
    key: &str,
    identity: usize,
) -> Option<(*const std::ffi::c_void, *mut std::ffi::c_void)> {
    FFI_RETAINED_CALLBACKS.with(|callbacks| {
        callbacks
            .borrow()
            .iter()
            .find(|entry| entry.key == key && entry.identity == identity)
            .map(|entry| (entry.callback, entry.context))
    })
}

pub fn ffi_release_retained_callback(
    key: &str,
    identity: usize,
    context: *mut std::ffi::c_void,
) {
    let cleanup = FFI_RETAINED_CALLBACKS.with(|callbacks| {
        let mut callbacks = callbacks.borrow_mut();
        callbacks.iter().position(|entry| {
            entry.key == key && entry.identity == identity && entry.context == context
        }).and_then(|index| callbacks.remove(index).cleanup)
    });
    if let Some(cleanup) = cleanup {
        cleanup();
    }
}
