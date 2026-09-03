pub struct AbortSignalData<T: HeapValue> {
    aborted: bool,
    reason: Option<T>,
}

impl<T: HeapValue> Trace for AbortSignalData<T> {
    fn trace(&self, tracer: &mut Tracer<'_>) {
        if let Some(reason) = &self.reason {
            reason.trace_value(tracer);
        }
    }
}

impl<T: HeapValue> ClearEdges for AbortSignalData<T> {
    fn clear_edges(&mut self) {
        self.reason = None;
    }
}

pub type JsAbortSignal<T> = Gc<AbortSignalData<T>>;

pub fn abort_controller_new<T: HeapValue>() -> JsAbortSignal<T> {
    Gc::new(AbortSignalData {
        aborted: false,
        reason: None,
    })
}

pub fn abort_signal_new_aborted<T: HeapValue>(reason: T) -> JsAbortSignal<T> {
    Gc::new(AbortSignalData {
        aborted: true,
        reason: Some(reason),
    })
}

pub fn abort_signal_timeout<T: HeapValue>(delay_ms: f64, reason: T) -> JsAbortSignal<T> {
    let signal = abort_controller_new();
    let pending = signal.clone();
    let timer = timer_set_timeout_handle(
        Box::new(move || abort_controller_abort(&pending, reason.clone())),
        delay_ms,
    );
    timer_set_ref(timer, false);
    signal
}

pub fn abort_signal_any<T: HeapValue>(signals: Vec<JsAbortSignal<T>>) -> JsAbortSignal<T> {
    let combined = abort_controller_new();
    for signal in signals {
        let reason = signal.with(|signal| {
            if signal.aborted {
                signal.reason.clone()
            } else {
                None
            }
        });
        if let Some(reason) = reason {
            abort_controller_abort(&combined, reason);
            break;
        }
    }
    combined
}

pub fn abort_signal_aborted<T: HeapValue>(signal: &JsAbortSignal<T>) -> bool {
    signal.with(|signal| signal.aborted)
}

pub fn abort_signal_reason<T: HeapValue>(signal: &JsAbortSignal<T>) -> Option<T> {
    signal.with(|signal| signal.reason.clone())
}

pub fn abort_controller_abort<T: HeapValue>(signal: &JsAbortSignal<T>, reason: T) {
    signal.with_mut(|signal| {
        if signal.aborted {
            return;
        }
        signal.aborted = true;
        signal.reason = Some(reason);
    });
}
