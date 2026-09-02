pub struct AbortSignalData {
    aborted: bool,
}

impl Trace for AbortSignalData {
    fn trace(&self, _tracer: &mut Tracer<'_>) {}
}

impl ClearEdges for AbortSignalData {
    fn clear_edges(&mut self) {}
}

pub type JsAbortSignal = Gc<AbortSignalData>;

pub fn abort_controller_new() -> JsAbortSignal {
    Gc::new(AbortSignalData { aborted: false })
}

pub fn abort_signal_aborted(signal: &JsAbortSignal) -> bool {
    signal.with(|signal| signal.aborted)
}
