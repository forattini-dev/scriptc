pub struct WritableData<L, W, F>
where
    L: Clone + Trace + 'static,
    W: Clone + Trace + 'static,
    F: Clone + Trace + 'static,
{
    emitter: Option<JsEventEmitter<L>>,
    write_callback: Option<W>,
    final_callback: Option<F>,
    high_water_mark: usize,
    writable_length: usize,
    need_drain: bool,
    ended: bool,
    prefinished: bool,
    finish_scheduled: bool,
    finished: bool,
    auto_destroy: bool,
    emit_close: bool,
    closed: bool,
}

impl<L, W, F> Trace for WritableData<L, W, F>
where
    L: Clone + Trace + 'static,
    W: Clone + Trace + 'static,
    F: Clone + Trace + 'static,
{
    fn trace(&self, tracer: &mut Tracer<'_>) {
        if let Some(emitter) = &self.emitter {
            tracer.edge(emitter);
        }
        if let Some(callback) = &self.write_callback {
            callback.trace(tracer);
        }
        if let Some(callback) = &self.final_callback {
            callback.trace(tracer);
        }
    }
}

impl<L, W, F> ClearEdges for WritableData<L, W, F>
where
    L: Clone + Trace + 'static,
    W: Clone + Trace + 'static,
    F: Clone + Trace + 'static,
{
    fn clear_edges(&mut self) {
        self.emitter = None;
        self.write_callback = None;
        self.final_callback = None;
    }
}

pub type JsWritable<L, W, F> = Gc<WritableData<L, W, F>>;

pub fn writable_new<L, W, F>(
    high_water_mark: f64,
    auto_destroy: bool,
    emit_close: bool,
    write_callback: Option<W>,
    final_callback: Option<F>,
) -> JsWritable<L, W, F>
where
    L: Clone + Trace + 'static,
    W: Clone + Trace + 'static,
    F: Clone + Trace + 'static,
{
    let high_water_mark = if high_water_mark.is_finite() && high_water_mark >= 0.0 {
        high_water_mark.trunc() as usize
    } else {
        16 * 1024
    };
    Gc::new(WritableData {
        emitter: Some(emitter_new()),
        write_callback,
        final_callback,
        high_water_mark,
        writable_length: 0,
        need_drain: false,
        ended: false,
        prefinished: false,
        finish_scheduled: false,
        finished: false,
        auto_destroy,
        emit_close,
        closed: false,
    })
}

pub fn writable_emitter<L, W, F>(writable: &JsWritable<L, W, F>) -> JsEventEmitter<L>
where
    L: Clone + Trace + 'static,
    W: Clone + Trace + 'static,
    F: Clone + Trace + 'static,
{
    writable.with(|data| {
        data.emitter
            .as_ref()
            .expect("scriptc: cleared live Writable emitter")
            .clone()
    })
}

pub fn writable_trace<L, W, F>(writable: &JsWritable<L, W, F>, tracer: &mut Tracer<'_>)
where
    L: Clone + Trace + 'static,
    W: Clone + Trace + 'static,
    F: Clone + Trace + 'static,
{
    tracer.edge(writable);
}

pub fn writable_ptr_eq<L, W, F>(
    left: &JsWritable<L, W, F>,
    right: &JsWritable<L, W, F>,
) -> bool
where
    L: Clone + Trace + 'static,
    W: Clone + Trace + 'static,
    F: Clone + Trace + 'static,
{
    left.ptr_eq(right)
}

pub fn writable_write_callback<L, W, F>(writable: &JsWritable<L, W, F>) -> Option<W>
where
    L: Clone + Trace + 'static,
    W: Clone + Trace + 'static,
    F: Clone + Trace + 'static,
{
    writable.with(|data| data.write_callback.clone())
}

pub fn writable_final_callback<L, W, F>(writable: &JsWritable<L, W, F>) -> Option<F>
where
    L: Clone + Trace + 'static,
    W: Clone + Trace + 'static,
    F: Clone + Trace + 'static,
{
    writable.with(|data| data.final_callback.clone())
}

pub fn writable_begin_write<L, W, F>(
    writable: &JsWritable<L, W, F>,
    length: usize,
) -> bool
where
    L: Clone + Trace + 'static,
    W: Clone + Trace + 'static,
    F: Clone + Trace + 'static,
{
    writable.with_mut(|data| {
        data.writable_length = data.writable_length.saturating_add(length);
        let below_high_water_mark = data.writable_length < data.high_water_mark;
        if !below_high_water_mark {
            data.need_drain = true;
        }
        below_high_water_mark
    })
}

pub fn writable_complete_write<L, W, F>(writable: &JsWritable<L, W, F>, length: usize)
where
    L: Clone + Trace + 'static,
    W: Clone + Trace + 'static,
    F: Clone + Trace + 'static,
{
    writable.with_mut(|data| {
        data.writable_length = data.writable_length.saturating_sub(length);
    });
}

pub fn writable_mark_ended<L, W, F>(writable: &JsWritable<L, W, F>)
where
    L: Clone + Trace + 'static,
    W: Clone + Trace + 'static,
    F: Clone + Trace + 'static,
{
    writable.with_mut(|data| data.ended = true);
}

pub fn writable_take_prefinish<L, W, F>(writable: &JsWritable<L, W, F>) -> bool
where
    L: Clone + Trace + 'static,
    W: Clone + Trace + 'static,
    F: Clone + Trace + 'static,
{
    writable.with_mut(|data| {
        if data.prefinished {
            return false;
        }
        data.prefinished = true;
        true
    })
}

pub fn writable_schedule_finish<L, W, F>(writable: &JsWritable<L, W, F>) -> bool
where
    L: Clone + Trace + 'static,
    W: Clone + Trace + 'static,
    F: Clone + Trace + 'static,
{
    writable.with_mut(|data| {
        if data.finish_scheduled || data.finished {
            return false;
        }
        data.finish_scheduled = true;
        true
    })
}

pub fn writable_mark_finished<L, W, F>(writable: &JsWritable<L, W, F>)
where
    L: Clone + Trace + 'static,
    W: Clone + Trace + 'static,
    F: Clone + Trace + 'static,
{
    writable.with_mut(|data| {
        data.finish_scheduled = false;
        data.finished = true;
    });
}

pub fn writable_take_close<L, W, F>(writable: &JsWritable<L, W, F>) -> bool
where
    L: Clone + Trace + 'static,
    W: Clone + Trace + 'static,
    F: Clone + Trace + 'static,
{
    writable.with_mut(|data| {
        if data.closed || !data.auto_destroy || !data.emit_close {
            return false;
        }
        data.closed = true;
        true
    })
}

pub fn writable_number_prop<L, W, F>(
    writable: &JsWritable<L, W, F>,
    name: &JsString,
) -> f64
where
    L: Clone + Trace + 'static,
    W: Clone + Trace + 'static,
    F: Clone + Trace + 'static,
{
    writable.with(|data| match name.as_ref() {
        "writableLength" => data.writable_length as f64,
        "writableHighWaterMark" => data.high_water_mark as f64,
        "writableCorked" => 0.0,
        _ => 0.0,
    })
}

pub fn writable_bool_prop<L, W, F>(
    writable: &JsWritable<L, W, F>,
    name: &JsString,
) -> bool
where
    L: Clone + Trace + 'static,
    W: Clone + Trace + 'static,
    F: Clone + Trace + 'static,
{
    writable.with(|data| match name.as_ref() {
        "writable" => !data.ended,
        "writableEnded" => data.ended,
        "writableFinished" => data.finished,
        "writableNeedDrain" => data.need_drain,
        "destroyed" => data.closed,
        "closed" => data.closed,
        _ => false,
    })
}
