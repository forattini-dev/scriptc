// DOM EventTarget listener identity and dispatch state. Callers perform the
// JavaScript callback invocation; these structures keep its ownership and
// mutation rules independent from Node's EventEmitter semantics.

pub struct DomListener<V> {
    pub callback: V,
    pub capture: bool,
    pub once: bool,
    pub passive: bool,
    removed: Rc<Cell<bool>>,
}

impl<V: Clone> Clone for DomListener<V> {
    fn clone(&self) -> Self {
        Self {
            callback: self.callback.clone(),
            capture: self.capture,
            once: self.once,
            passive: self.passive,
            removed: self.removed.clone(),
        }
    }
}

pub struct DomTarget<V> {
    listeners: Vec<(JsString, DomListener<V>)>,
}

impl<V: Trace> Trace for DomTarget<V> {
    fn trace(&self, tracer: &mut Tracer<'_>) {
        for (_, listener) in &self.listeners {
            listener.callback.trace(tracer);
        }
    }
}

impl<V> ClearEdges for DomTarget<V> {
    fn clear_edges(&mut self) {
        for (_, listener) in &self.listeners {
            listener.removed.set(true);
        }
        self.listeners.clear();
    }
}

pub type JsDomTarget<V> = Gc<DomTarget<V>>;

pub fn dom_target_new<V: Trace + 'static>() -> JsDomTarget<V> {
    Gc::new(DomTarget {
        listeners: Vec::new(),
    })
}

pub fn dom_target_add<V: Trace + 'static>(
    target: &JsDomTarget<V>,
    name: JsString,
    callback: V,
    capture: bool,
    once: bool,
    passive: bool,
    same: impl Fn(&V, &V) -> bool,
) -> bool {
    target.with_mut(|target| {
        if target.listeners.iter().any(|(old_name, listener)| {
            *old_name == name && listener.capture == capture && same(&listener.callback, &callback)
        }) {
            return false;
        }
        target.listeners.push((
            name,
            DomListener {
                callback,
                capture,
                once,
                passive,
                removed: Rc::new(Cell::new(false)),
            },
        ));
        true
    })
}

pub fn dom_target_remove<V: Trace + 'static>(
    target: &JsDomTarget<V>,
    name: &JsString,
    callback: &V,
    capture: bool,
    same: impl Fn(&V, &V) -> bool,
) -> bool {
    target.with_mut(|target| {
        let Some(index) = target.listeners.iter().position(|(old_name, listener)| {
            old_name == name && listener.capture == capture && same(&listener.callback, callback)
        }) else {
            return false;
        };
        let (_, listener) = target.listeners.remove(index);
        listener.removed.set(true);
        true
    })
}

pub fn dom_target_snapshot<V: Clone + Trace + 'static>(
    target: &JsDomTarget<V>,
    name: &JsString,
) -> Vec<DomListener<V>> {
    target.with(|target| {
        target
            .listeners
            .iter()
            .filter(|(old_name, _)| old_name == name)
            .map(|(_, listener)| listener.clone())
            .collect()
    })
}

/// Claim immediately before invocation. Once listeners are removed before
/// calling them so a recursive dispatch cannot invoke them a second time.
pub fn dom_target_claim<V: Trace + 'static>(
    target: &JsDomTarget<V>,
    listener: &DomListener<V>,
) -> bool {
    if listener.removed.get() {
        return false;
    }
    if listener.once {
        listener.removed.set(true);
        target.with_mut(|target| {
            target
                .listeners
                .retain(|(_, entry)| !Rc::ptr_eq(&entry.removed, &listener.removed))
        });
    }
    true
}

pub struct DomEvent<V> {
    pub name: JsString,
    pub bubbles: bool,
    pub cancelable: bool,
    pub composed: bool,
    pub default_prevented: bool,
    pub propagation_stopped: bool,
    pub immediate_stopped: bool,
    pub dispatching: bool,
    in_passive_listener: bool,
    pub target: Option<V>,
    pub current_target: Option<V>,
}

impl<V: Trace> Trace for DomEvent<V> {
    fn trace(&self, tracer: &mut Tracer<'_>) {
        if let Some(value) = &self.target {
            value.trace(tracer);
        }
        if let Some(value) = &self.current_target {
            value.trace(tracer);
        }
    }
}

impl<V> ClearEdges for DomEvent<V> {
    fn clear_edges(&mut self) {
        self.target = None;
        self.current_target = None;
    }
}

pub type JsDomEvent<V> = Gc<DomEvent<V>>;

pub fn dom_event_new<V: Trace + 'static>(
    name: JsString,
    bubbles: bool,
    cancelable: bool,
    composed: bool,
) -> JsDomEvent<V> {
    Gc::new(DomEvent {
        name,
        bubbles,
        cancelable,
        composed,
        default_prevented: false,
        propagation_stopped: false,
        immediate_stopped: false,
        dispatching: false,
        in_passive_listener: false,
        target: None,
        current_target: None,
    })
}

pub fn dom_event_prevent_default<V: Trace + 'static>(event: &JsDomEvent<V>) {
    event.with_mut(|event| {
        if event.cancelable && !event.in_passive_listener {
            event.default_prevented = true;
        }
    });
}

pub struct DomListenerGuard<V: Trace + 'static> {
    event: JsDomEvent<V>,
    previous_passive: bool,
}

pub fn dom_event_enter_listener<V: Trace + 'static>(
    event: &JsDomEvent<V>,
    passive: bool,
) -> DomListenerGuard<V> {
    let previous_passive =
        event.with_mut(|event| std::mem::replace(&mut event.in_passive_listener, passive));
    DomListenerGuard {
        event: event.clone(),
        previous_passive,
    }
}

impl<V: Trace + 'static> Drop for DomListenerGuard<V> {
    fn drop(&mut self) {
        self.event
            .with_mut(|event| event.in_passive_listener = self.previous_passive);
    }
}

pub fn dom_event_stop_immediate<V: Trace + 'static>(event: &JsDomEvent<V>) {
    event.with_mut(|event| {
        event.propagation_stopped = true;
        event.immediate_stopped = true;
    });
}

pub fn dom_event_stop_propagation<V: Trace + 'static>(event: &JsDomEvent<V>) {
    event.with_mut(|event| event.propagation_stopped = true);
}

pub fn dom_event_leave_listener<V: Trace + 'static>(event: &JsDomEvent<V>) {
    event.with_mut(|event| event.current_target = None);
}

/// Scope guard restores currentTarget even if the callback unwinds.
pub struct DomDispatchGuard<V: Trace + 'static> {
    event: JsDomEvent<V>,
}

pub fn dom_event_begin<V: Clone + Trace + 'static>(
    event: &JsDomEvent<V>,
    target: V,
) -> Option<DomDispatchGuard<V>> {
    let started = event.with_mut(|event| {
        if event.dispatching {
            return false;
        }
        event.dispatching = true;
        event.target = Some(target.clone());
        event.current_target = Some(target);
        true
    });
    started.then(|| DomDispatchGuard {
        event: event.clone(),
    })
}

impl<V: Trace + 'static> Drop for DomDispatchGuard<V> {
    fn drop(&mut self) {
        self.event.with_mut(|event| {
            event.current_target = None;
            event.dispatching = false;
        });
    }
}

#[cfg(test)]
mod dom_event_tests {
    use super::*;

    #[derive(Clone, Debug, PartialEq, Eq)]
    struct Value(u8);
    impl Trace for Value {
        fn trace(&self, _: &mut Tracer<'_>) {}
    }

    #[test]
    fn identity_capture_once_and_removal_during_dispatch() {
        let target = dom_target_new();
        let name = string("message");
        let same = |a: &Value, b: &Value| a == b;
        assert!(dom_target_add(
            &target,
            name.clone(),
            Value(1),
            false,
            false,
            false,
            same
        ));
        assert!(!dom_target_add(
            &target,
            name.clone(),
            Value(1),
            false,
            true,
            true,
            same
        ));
        assert!(dom_target_add(
            &target,
            name.clone(),
            Value(1),
            true,
            true,
            true,
            same
        ));
        assert!(dom_target_add(
            &target,
            name.clone(),
            Value(2),
            false,
            false,
            false,
            same
        ));
        let snapshot = dom_target_snapshot(&target, &name);
        assert_eq!(snapshot.len(), 3);
        assert!(!snapshot[0].passive);
        assert!(snapshot[1].passive);
        assert!(dom_target_remove(&target, &name, &Value(2), false, same));
        assert!(dom_target_claim(&target, &snapshot[0]));
        assert!(dom_target_claim(&target, &snapshot[1]));
        assert!(!dom_target_claim(&target, &snapshot[1]));
        assert!(!dom_target_claim(&target, &snapshot[2]));
        assert_eq!(dom_target_snapshot(&target, &name).len(), 1);
        assert!(dom_target_remove(&target, &name, &Value(1), false, same));
        assert!(dom_target_snapshot(&target, &name).is_empty());
    }

    #[test]
    fn dispatch_guard_and_cancellation_preserve_event_state() {
        let event = dom_event_new(string("message"), false, true, false);
        let guard = dom_event_begin(&event, Value(7)).unwrap();
        assert!(dom_event_begin(&event, Value(8)).is_none());
        assert_eq!(event.with(|event| event.target.clone()), Some(Value(7)));
        assert_eq!(
            event.with(|event| event.current_target.clone()),
            Some(Value(7))
        );
        let listener = dom_event_enter_listener(&event, true);
        dom_event_prevent_default(&event);
        assert!(!event.with(|event| event.default_prevented));
        drop(listener);
        dom_event_prevent_default(&event);
        assert!(event.with(|event| event.default_prevented));
        dom_event_stop_immediate(&event);
        assert!(event.with(|event| event.propagation_stopped));
        drop(guard);
        assert!(!event.with(|event| event.dispatching));
        assert_eq!(event.with(|event| event.current_target.clone()), None);
        assert_eq!(event.with(|event| event.target.clone()), Some(Value(7)));
        assert!(event.with(|event| event.immediate_stopped));
        let _guard = dom_event_begin(&event, Value(8)).unwrap();
        assert_eq!(event.with(|event| event.target.clone()), Some(Value(8)));
        assert!(event.with(|event| event.default_prevented));
        let noncancelable = dom_event_new::<Value>(string("x"), false, false, false);
        dom_event_prevent_default(&noncancelable);
        assert!(!noncancelable.with(|event| event.default_prevented));
    }

    #[test]
    fn abrupt_listener_exit_restores_dispatch_and_passive_state() {
        let event = dom_event_new(string("x"), false, true, false);
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _dispatch = dom_event_begin(&event, Value(1)).unwrap();
            let _listener = dom_event_enter_listener(&event, true);
            panic!("listener exited abruptly");
        }));
        assert!(outcome.is_err());
        assert!(!event.with(|event| event.dispatching));
        assert!(event.with(|event| event.current_target.is_none()));
        dom_event_prevent_default(&event);
        assert!(event.with(|event| event.default_prevented));
        assert!(dom_event_begin(&event, Value(2)).is_some());
    }
}
