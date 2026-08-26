thread_local! {
    static LIVE_DYN_REFS: RefCell<HashMap<usize, Box<dyn Any>>> = RefCell::new(HashMap::new());
    static DYN_FROM_STACK: RefCell<Vec<usize>> = const { RefCell::new(Vec::new()) };
}

pub struct DynFromGuard {
    identity: usize,
}

pub fn dyn_from_enter(identity: usize) -> DynFromGuard {
    DYN_FROM_STACK.with(|stack| {
        let mut stack = stack.borrow_mut();
        if stack.contains(&identity) {
            dyn_from_cycle_trap();
        }
        stack.push(identity);
    });
    DynFromGuard { identity }
}

fn dyn_from_cycle_trap() -> ! {
    const MESSAGE: &str = "scriptc: cannot convert a circular structure into a checked-dynamic value (unknown-typed slots deep-copy; break the cycle first)";
    #[cfg(test)]
    panic!("{MESSAGE}");
    #[cfg(not(test))]
    {
        eprintln!("{MESSAGE}");
        std::process::abort();
    }
}

impl Drop for DynFromGuard {
    fn drop(&mut self) {
        DYN_FROM_STACK.with(|stack| {
            let identity = stack
                .borrow_mut()
                .pop()
                .expect("scriptc: dynamic conversion stack underflow");
            assert_eq!(identity, self.identity);
        });
    }
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
