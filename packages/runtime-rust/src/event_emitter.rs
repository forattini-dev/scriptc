pub struct EventListener<L> {
    pub registration: usize,
    pub callback: L,
    pub identity: usize,
    pub once: bool,
    once_fired: Rc<Cell<bool>>,
}

impl<L: Clone> Clone for EventListener<L> {
    fn clone(&self) -> Self {
        Self {
            registration: self.registration,
            callback: self.callback.clone(),
            identity: self.identity,
            once: self.once,
            once_fired: self.once_fired.clone(),
        }
    }
}

struct EventBucket<L> {
    name: JsString,
    listeners: Vec<EventListener<L>>,
}

pub struct EventEmitter<L> {
    events: Vec<EventBucket<L>>,
    next_registration: usize,
    max_listeners: Option<f64>,
}

thread_local! {
    static EVENT_EMITTER_DEFAULT_MAX: Cell<f64> = const { Cell::new(10.0) };
}

pub type JsEventEmitter<L> = Gc<EventEmitter<L>>;

impl<L: Trace> Trace for EventEmitter<L> {
    fn trace(&self, tracer: &mut Tracer<'_>) {
        for event in &self.events {
            for listener in &event.listeners {
                listener.callback.trace(tracer);
            }
        }
    }
}

impl<L> ClearEdges for EventEmitter<L> {
    fn clear_edges(&mut self) {
        self.events.clear();
    }
}

pub fn emitter_new<L>() -> JsEventEmitter<L>
where
    L: Clone + Trace + 'static,
{
    Gc::new(EventEmitter {
        events: Vec::new(),
        next_registration: 0,
        max_listeners: None,
    })
}

pub fn emitter_on<L>(
    emitter: &JsEventEmitter<L>,
    name: JsString,
    callback: L,
    identity: usize,
    once: bool,
    prepend: bool,
) where
    L: Clone + Trace + 'static,
{
    emitter.with_mut(|emitter| {
        let registration = emitter.next_registration;
        emitter.next_registration = emitter
            .next_registration
            .checked_add(1)
            .expect("scriptc: EventEmitter registration id overflow");
        let listener = EventListener {
            registration,
            callback,
            identity,
            once,
            once_fired: Rc::new(Cell::new(false)),
        };
        if let Some(event) = emitter
            .events
            .iter_mut()
            .find(|event| event.name.as_ref() == name.as_ref())
        {
            if prepend {
                event.listeners.insert(0, listener);
            } else {
                event.listeners.push(listener);
            }
        } else {
            emitter.events.push(EventBucket {
                name,
                listeners: vec![listener],
            });
        }
    })
}

pub fn emitter_listener_should_invoke<L>(listener: &EventListener<L>) -> bool {
    !listener.once || !listener.once_fired.replace(true)
}

pub fn emitter_snapshot<L>(
    emitter: &JsEventEmitter<L>,
    name: &JsString,
) -> Vec<EventListener<L>>
where
    L: Clone + Trace + 'static,
{
    emitter.with(|emitter| {
        emitter
            .events
            .iter()
            .find(|event| event.name.as_ref() == name.as_ref())
            .map_or_else(Vec::new, |event| event.listeners.clone())
    })
}

pub fn emitter_remove_registration<L>(
    emitter: &JsEventEmitter<L>,
    name: &JsString,
    registration: usize,
) -> bool
where
    L: Clone + Trace + 'static,
{
    emitter.with_mut(|emitter| {
        let Some(event_index) = emitter
            .events
            .iter()
            .position(|event| event.name.as_ref() == name.as_ref())
        else {
            return false;
        };
        let event = &mut emitter.events[event_index];
        let removed = if let Some(index) = event
            .listeners
            .iter()
            .position(|listener| listener.registration == registration)
        {
            event.listeners.remove(index);
            true
        } else {
            false
        };
        if event.listeners.is_empty() {
            emitter.events.remove(event_index);
        }
        removed
    })
}

pub fn emitter_off<L>(emitter: &JsEventEmitter<L>, name: &JsString, identity: usize) -> bool
where
    L: Clone + Trace + 'static,
{
    emitter.with_mut(|emitter| {
        let Some(event_index) = emitter
            .events
            .iter()
            .position(|event| event.name.as_ref() == name.as_ref())
        else {
            return false;
        };
        let event = &mut emitter.events[event_index];
        let removed = if let Some(index) = event
            .listeners
            .iter()
            .rposition(|listener| listener.identity == identity)
        {
            event.listeners.remove(index);
            true
        } else {
            false
        };
        if event.listeners.is_empty() {
            emitter.events.remove(event_index);
        }
        removed
    })
}

pub fn emitter_remove_last<L>(emitter: &JsEventEmitter<L>, name: &JsString) -> bool
where
    L: Clone + Trace + 'static,
{
    emitter.with_mut(|emitter| {
        let Some(event_index) = emitter
            .events
            .iter()
            .position(|event| event.name.as_ref() == name.as_ref())
        else {
            return false;
        };
        let removed = emitter.events[event_index].listeners.pop().is_some();
        if emitter.events[event_index].listeners.is_empty() {
            emitter.events.remove(event_index);
        }
        removed
    })
}

pub fn emitter_remove_all<L>(
    emitter: &JsEventEmitter<L>,
    name: &JsString,
    every_event: bool,
) where
    L: Clone + Trace + 'static,
{
    emitter.with_mut(|emitter| {
        if every_event {
            emitter.events.clear();
        } else if let Some(index) = emitter
            .events
            .iter()
            .position(|event| event.name.as_ref() == name.as_ref())
        {
            emitter.events.remove(index);
        }
    });
}

pub fn emitter_listener_count<L>(emitter: &JsEventEmitter<L>, name: &JsString) -> f64
where
    L: Clone + Trace + 'static,
{
    emitter.with(|emitter| {
        emitter
            .events
            .iter()
            .find(|event| event.name.as_ref() == name.as_ref())
            .map_or(0.0, |event| event.listeners.len() as f64)
    })
}

pub fn emitter_listener_count_identity<L>(
    emitter: &JsEventEmitter<L>,
    name: &JsString,
    identity: usize,
) -> f64
where
    L: Clone + Trace + 'static,
{
    emitter.with(|emitter| {
        emitter
            .events
            .iter()
            .find(|event| event.name.as_ref() == name.as_ref())
            .map_or(0.0, |event| {
                event
                    .listeners
                    .iter()
                    .filter(|listener| listener.identity == identity)
                    .count() as f64
            })
    })
}

pub fn emitter_event_names<L>(emitter: &JsEventEmitter<L>) -> JsArray<JsString>
where
    L: Clone + Trace + 'static,
{
    array_new(emitter.with(|emitter| {
        emitter
            .events
            .iter()
            .map(|event| event.name.clone())
            .collect()
    }))
}

pub fn emitter_event_names_snapshot<L>(emitter: &JsEventEmitter<L>) -> Vec<JsString>
where
    L: Clone + Trace + 'static,
{
    emitter.with(|emitter| {
        emitter
            .events
            .iter()
            .map(|event| event.name.clone())
            .collect()
    })
}

pub fn emitter_set_max<L>(emitter: &JsEventEmitter<L>, value: f64)
where
    L: Clone + Trace + 'static,
{
    validate_max_listeners(value, "setMaxListeners");
    emitter.with_mut(|emitter| emitter.max_listeners = Some(value));
}

pub fn emitter_get_max<L>(emitter: &JsEventEmitter<L>) -> f64
where
    L: Clone + Trace + 'static,
{
    emitter.with(|emitter| {
        emitter
            .max_listeners
            .unwrap_or_else(|| EVENT_EMITTER_DEFAULT_MAX.with(Cell::get))
    })
}

pub fn emitter_set_default_max(value: f64) {
    emitter_set_default_max_named(value, "setMaxListeners");
}

pub fn emitter_set_default_max_named(value: f64, name: &str) {
    validate_max_listeners(value, name);
    EVENT_EMITTER_DEFAULT_MAX.with(|current| current.set(value));
}

pub fn emitter_get_default_max() -> f64 {
    EVENT_EMITTER_DEFAULT_MAX.with(Cell::get)
}

fn validate_max_listeners(value: f64, name: &str) {
    if value >= 0.0 {
        return;
    }
    throw_range_error_code(
        format!(
            "The value of \"{name}\" is out of range. It must be >= 0. Received {}",
            format_number(value)
        ),
        "ERR_OUT_OF_RANGE",
    );
}
