#[derive(Clone, Default)]
pub struct JsAsyncContext {
    values: HashMap<usize, Rc<dyn Any>>,
}

thread_local! {
    static ASYNC_LOCAL_NEXT_ID: Cell<usize> = const { Cell::new(1) };
    static ASYNC_LOCAL_TYPES: RefCell<HashMap<usize, std::any::TypeId>> = RefCell::new(HashMap::new());
    static ASYNC_LOCAL_CONTEXT: RefCell<JsAsyncContext> = RefCell::new(JsAsyncContext::default());
}

fn async_local_id<D: 'static>(handle: f64) -> usize {
    if !handle.is_finite() || handle.fract() != 0.0 || handle < 1.0 {
        panic!("scriptc: invalid AsyncLocalStorage handle");
    }
    let id = handle as usize;
    let valid = ASYNC_LOCAL_TYPES.with(|types| {
        types
            .borrow()
            .get(&id)
            .is_some_and(|stored| *stored == std::any::TypeId::of::<D>())
    });
    if !valid {
        panic!("scriptc: invalid AsyncLocalStorage handle type");
    }
    id
}

pub fn async_local_new<D: 'static>() -> f64 {
    let id = ASYNC_LOCAL_NEXT_ID.with(|next| {
        let id = next.get();
        next.set(id.checked_add(1).expect("scriptc: exhausted AsyncLocalStorage handles"));
        id
    });
    ASYNC_LOCAL_TYPES.with(|types| {
        types.borrow_mut().insert(id, std::any::TypeId::of::<D>());
    });
    id as f64
}

pub fn async_local_get<D: Clone + 'static>(handle: f64) -> Option<D> {
    let id = async_local_id::<D>(handle);
    ASYNC_LOCAL_CONTEXT.with(|context| {
        context
            .borrow()
            .values
            .get(&id)
            .map(|value| {
                value
                    .downcast_ref::<D>()
                    .expect("scriptc: AsyncLocalStorage value type mismatch")
                    .clone()
            })
    })
}

pub struct JsAsyncContextGuard {
    previous: Option<JsAsyncContext>,
}

impl Drop for JsAsyncContextGuard {
    fn drop(&mut self) {
        let previous = self
            .previous
            .take()
            .expect("scriptc: AsyncLocalStorage guard dropped twice");
        ASYNC_LOCAL_CONTEXT.with(|context| *context.borrow_mut() = previous);
    }
}

pub fn async_context_capture() -> JsAsyncContext {
    ASYNC_LOCAL_CONTEXT.with(|context| context.borrow().clone())
}

pub fn async_context_install(context: JsAsyncContext) -> JsAsyncContextGuard {
    let previous = ASYNC_LOCAL_CONTEXT.with(|active| std::mem::replace(&mut *active.borrow_mut(), context));
    JsAsyncContextGuard {
        previous: Some(previous),
    }
}

pub fn async_local_run<D: 'static>(handle: f64, value: D) -> JsAsyncContextGuard {
    let id = async_local_id::<D>(handle);
    let mut next = async_context_capture();
    next.values.insert(id, Rc::new(value));
    async_context_install(next)
}

pub fn async_local_run_many<D: 'static>(entries: Vec<(f64, D)>) -> JsAsyncContextGuard {
    let mut next = async_context_capture();
    for (handle, value) in entries {
        let id = async_local_id::<D>(handle);
        next.values.insert(id, Rc::new(value));
    }
    async_context_install(next)
}

pub fn async_local_exit<D: 'static>(handle: f64) -> JsAsyncContextGuard {
    let id = async_local_id::<D>(handle);
    let mut next = async_context_capture();
    next.values.remove(&id);
    async_context_install(next)
}

pub fn async_local_enter_with<D: 'static>(handle: f64, value: D) {
    let id = async_local_id::<D>(handle);
    ASYNC_LOCAL_CONTEXT.with(|context| {
        context.borrow_mut().values.insert(id, Rc::new(value));
    });
}

pub fn async_local_disable<D: 'static>(handle: f64) {
    let id = async_local_id::<D>(handle);
    ASYNC_LOCAL_CONTEXT.with(|context| {
        context.borrow_mut().values.remove(&id);
    });
}

fn async_local_finish() {
    ASYNC_LOCAL_CONTEXT.with(|context| context.borrow_mut().values.clear());
    ASYNC_LOCAL_TYPES.with(|types| types.borrow_mut().clear());
    ASYNC_LOCAL_NEXT_ID.with(|next| next.set(1));
}
