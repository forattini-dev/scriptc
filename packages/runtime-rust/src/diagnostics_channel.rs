use std::any::TypeId;

struct DiagnosticsSubscriber<D> {
    identity: usize,
    callback: D,
}

struct DiagnosticsChannel<D> {
    name: JsString,
    subscribers: Vec<DiagnosticsSubscriber<D>>,
}

struct DiagnosticsRegistry<D> {
    channels: Vec<DiagnosticsChannel<D>>,
    by_name: HashMap<JsString, usize>,
}

impl<D> Default for DiagnosticsRegistry<D> {
    fn default() -> Self {
        Self {
            channels: Vec::new(),
            by_name: HashMap::new(),
        }
    }
}

thread_local! {
    static DIAGNOSTICS_REGISTRIES: RefCell<HashMap<TypeId, Box<dyn Any>>> = RefCell::new(HashMap::new());
}

fn with_diagnostics_registry<D: 'static, R>(
    operation: impl FnOnce(&mut DiagnosticsRegistry<D>) -> R,
) -> R {
    DIAGNOSTICS_REGISTRIES.with(|registries| {
        let mut registries = registries.borrow_mut();
        let registry = registries
            .entry(TypeId::of::<D>())
            .or_insert_with(|| Box::new(DiagnosticsRegistry::<D>::default()))
            .downcast_mut::<DiagnosticsRegistry<D>>()
            .expect("scriptc: diagnostics_channel registry type mismatch");
        operation(registry)
    })
}

fn diagnostics_intern<D: 'static>(registry: &mut DiagnosticsRegistry<D>, name: &JsString) -> usize {
    if let Some(index) = registry.by_name.get(name) {
        return *index;
    }
    let index = registry.channels.len();
    registry.channels.push(DiagnosticsChannel {
        name: name.clone(),
        subscribers: Vec::new(),
    });
    registry.by_name.insert(name.clone(), index);
    index
}

fn diagnostics_index<D>(registry: &DiagnosticsRegistry<D>, handle: f64) -> usize {
    if !handle.is_finite() || handle.fract() != 0.0 || handle < 1.0 {
        panic!("scriptc: invalid diagnostics_channel handle");
    }
    let index = handle as usize - 1;
    if index >= registry.channels.len() {
        panic!("scriptc: invalid diagnostics_channel handle");
    }
    index
}

pub fn diagnostics_channel<D: 'static>(name: &JsString) -> f64 {
    with_diagnostics_registry(|registry| (diagnostics_intern::<D>(registry, name) + 1) as f64)
}

pub fn diagnostics_subscribe<D: Clone + 'static>(name: &JsString, identity: usize, callback: D) {
    with_diagnostics_registry(|registry| {
        let index = diagnostics_intern::<D>(registry, name);
        registry.channels[index]
            .subscribers
            .push(DiagnosticsSubscriber { identity, callback });
    });
}

pub fn diagnostics_chan_subscribe<D: Clone + 'static>(handle: f64, identity: usize, callback: D) {
    with_diagnostics_registry(|registry| {
        let index = diagnostics_index(registry, handle);
        registry.channels[index]
            .subscribers
            .push(DiagnosticsSubscriber { identity, callback });
    });
}

fn diagnostics_remove<D>(channel: &mut DiagnosticsChannel<D>, identity: usize) -> bool {
    let Some(index) = channel
        .subscribers
        .iter()
        .position(|subscriber| subscriber.identity == identity)
    else {
        return false;
    };
    channel.subscribers.remove(index);
    true
}

pub fn diagnostics_unsubscribe<D: 'static>(name: &JsString, identity: usize) -> bool {
    with_diagnostics_registry(|registry: &mut DiagnosticsRegistry<D>| {
        let Some(index) = registry.by_name.get(name).copied() else {
            return false;
        };
        diagnostics_remove(&mut registry.channels[index], identity)
    })
}

pub fn diagnostics_chan_unsubscribe<D: 'static>(handle: f64, identity: usize) -> bool {
    with_diagnostics_registry(|registry: &mut DiagnosticsRegistry<D>| {
        let index = diagnostics_index(registry, handle);
        diagnostics_remove(&mut registry.channels[index], identity)
    })
}

pub fn diagnostics_has_subscribers<D: 'static>(name: &JsString) -> bool {
    with_diagnostics_registry(|registry: &mut DiagnosticsRegistry<D>| {
        registry
            .by_name
            .get(name)
            .is_some_and(|index| !registry.channels[*index].subscribers.is_empty())
    })
}

pub fn diagnostics_chan_has_subscribers<D: 'static>(handle: f64) -> bool {
    with_diagnostics_registry(|registry: &mut DiagnosticsRegistry<D>| {
        let index = diagnostics_index(registry, handle);
        !registry.channels[index].subscribers.is_empty()
    })
}

pub fn diagnostics_chan_name<D: 'static>(handle: f64) -> JsString {
    with_diagnostics_registry(|registry: &mut DiagnosticsRegistry<D>| {
        let index = diagnostics_index(registry, handle);
        registry.channels[index].name.clone()
    })
}

/// Returns an owned publish snapshot so callbacks may mutate the registry.
pub fn diagnostics_snapshot<D: Clone + 'static>(handle: f64) -> (JsString, Vec<D>) {
    with_diagnostics_registry(|registry: &mut DiagnosticsRegistry<D>| {
        let index = diagnostics_index(registry, handle);
        let channel = &registry.channels[index];
        (
            channel.name.clone(),
            channel
                .subscribers
                .iter()
                .map(|subscriber| subscriber.callback.clone())
                .collect(),
        )
    })
}

fn diagnostics_finish() {
    DIAGNOSTICS_REGISTRIES.with(|registries| registries.borrow_mut().clear());
}

#[cfg(test)]
mod diagnostics_channel_tests {
    use super::*;

    #[test]
    fn channel_identity_unsubscribe_and_snapshot_are_stable() {
        diagnostics_finish();
        let name = string("test:channel");
        let handle = diagnostics_channel::<usize>(&name);
        assert_eq!(handle, diagnostics_channel::<usize>(&name));
        assert!(!diagnostics_has_subscribers::<usize>(&name));

        diagnostics_chan_subscribe(handle, 7, 70_usize);
        diagnostics_subscribe(&name, 8, 80_usize);
        assert!(diagnostics_chan_has_subscribers::<usize>(handle));
        assert_eq!(diagnostics_snapshot::<usize>(handle).1, vec![70, 80]);

        let snapshot = diagnostics_snapshot::<usize>(handle).1;
        assert!(diagnostics_chan_unsubscribe::<usize>(handle, 7));
        assert_eq!(snapshot, vec![70, 80]);
        assert_eq!(diagnostics_snapshot::<usize>(handle).1, vec![80]);
        assert!(!diagnostics_unsubscribe::<usize>(&string("missing"), 8));
        diagnostics_finish();
    }
}
