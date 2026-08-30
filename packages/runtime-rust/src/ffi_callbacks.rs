thread_local! {
    static FFI_CALLBACK_PANIC: RefCell<Option<Box<dyn Any + Send>>> = const {
        RefCell::new(None)
    };
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
