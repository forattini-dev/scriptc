thread_local! {
    static LIVE_DYN_REFS: RefCell<HashMap<usize, Box<dyn Any>>> = RefCell::new(HashMap::new());
}

pub fn live_dyn_ref_store<T: 'static>(mirror_identity: usize, value: T) {
    LIVE_DYN_REFS.with(|refs| {
        refs.borrow_mut().insert(mirror_identity, Box::new(value));
    });
}

pub fn live_dyn_ref_get<T: Clone + 'static>(mirror_identity: usize) -> Option<T> {
    LIVE_DYN_REFS.with(|refs| {
        refs.borrow()
            .get(&mirror_identity)
            .and_then(|value| value.downcast_ref::<T>())
            .cloned()
    })
}

fn live_dyn_refs_clear() {
    LIVE_DYN_REFS.with(|refs| refs.borrow_mut().clear());
}
