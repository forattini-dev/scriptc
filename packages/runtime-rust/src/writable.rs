struct WritableEntry<C>
where
    C: Clone + Trace + 'static,
{
    chunk: JsBytes<u8>,
    callback: C,
}

pub struct WritableData<L, W, F, C>
where
    L: Clone + Trace + 'static,
    W: Clone + Trace + 'static,
    F: Clone + Trace + 'static,
    C: Clone + Trace + 'static,
{
    emitter: Option<JsEventEmitter<L>>,
    write_callback: Option<W>,
    final_callback: Option<F>,
    queue: VecDeque<WritableEntry<C>>,
    high_water_mark: usize,
    writable_length: usize,
    writing: bool,
    need_drain: bool,
    ended: bool,
    prefinished: bool,
    finish_scheduled: bool,
    finished: bool,
    auto_destroy: bool,
    emit_close: bool,
    closed: bool,
}

impl<L, W, F, C> Trace for WritableData<L, W, F, C>
where
    L: Clone + Trace + 'static,
    W: Clone + Trace + 'static,
    F: Clone + Trace + 'static,
    C: Clone + Trace + 'static,
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
        for entry in &self.queue {
            tracer.edge(&entry.chunk);
            entry.callback.trace(tracer);
        }
    }
}

impl<L, W, F, C> ClearEdges for WritableData<L, W, F, C>
where
    L: Clone + Trace + 'static,
    W: Clone + Trace + 'static,
    F: Clone + Trace + 'static,
    C: Clone + Trace + 'static,
{
    fn clear_edges(&mut self) {
        self.emitter = None;
        self.write_callback = None;
        self.final_callback = None;
        self.queue.clear();
        self.writable_length = 0;
    }
}

pub type JsWritable<L, W, F, C> = Gc<WritableData<L, W, F, C>>;

pub fn writable_new<L, W, F, C>(
    high_water_mark: f64,
    auto_destroy: bool,
    emit_close: bool,
    write_callback: Option<W>,
    final_callback: Option<F>,
) -> JsWritable<L, W, F, C>
where
    L: Clone + Trace + 'static,
    W: Clone + Trace + 'static,
    F: Clone + Trace + 'static,
    C: Clone + Trace + 'static,
{
    let high_water_mark = if high_water_mark.is_finite() && high_water_mark >= 0.0 {
        high_water_mark.trunc() as usize
    } else {
        stream_default_byte_high_water_mark()
    };
    Gc::new(WritableData {
        emitter: Some(emitter_new()),
        write_callback,
        final_callback,
        queue: VecDeque::new(),
        high_water_mark,
        writable_length: 0,
        writing: false,
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

pub fn writable_emitter<L, W, F, C>(writable: &JsWritable<L, W, F, C>) -> JsEventEmitter<L>
where
    L: Clone + Trace + 'static,
    W: Clone + Trace + 'static,
    F: Clone + Trace + 'static,
    C: Clone + Trace + 'static,
{
    writable.with(|data| {
        data.emitter
            .as_ref()
            .expect("scriptc: cleared live Writable emitter")
            .clone()
    })
}

pub fn writable_trace<L, W, F, C>(
    writable: &JsWritable<L, W, F, C>,
    tracer: &mut Tracer<'_>,
) where
    L: Clone + Trace + 'static,
    W: Clone + Trace + 'static,
    F: Clone + Trace + 'static,
    C: Clone + Trace + 'static,
{
    tracer.edge(writable);
}

pub fn writable_ptr_eq<L, W, F, C>(
    left: &JsWritable<L, W, F, C>,
    right: &JsWritable<L, W, F, C>,
) -> bool
where
    L: Clone + Trace + 'static,
    W: Clone + Trace + 'static,
    F: Clone + Trace + 'static,
    C: Clone + Trace + 'static,
{
    left.ptr_eq(right)
}

pub fn writable_write_callback<L, W, F, C>(writable: &JsWritable<L, W, F, C>) -> Option<W>
where
    L: Clone + Trace + 'static,
    W: Clone + Trace + 'static,
    F: Clone + Trace + 'static,
    C: Clone + Trace + 'static,
{
    writable.with(|data| data.write_callback.clone())
}

pub fn writable_final_callback<L, W, F, C>(writable: &JsWritable<L, W, F, C>) -> Option<F>
where
    L: Clone + Trace + 'static,
    W: Clone + Trace + 'static,
    F: Clone + Trace + 'static,
    C: Clone + Trace + 'static,
{
    writable.with(|data| data.final_callback.clone())
}

pub fn writable_enqueue<L, W, F, C>(
    writable: &JsWritable<L, W, F, C>,
    chunk: JsBytes<u8>,
    callback: C,
) -> bool
where
    L: Clone + Trace + 'static,
    W: Clone + Trace + 'static,
    F: Clone + Trace + 'static,
    C: Clone + Trace + 'static,
{
    writable.with_mut(|data| {
        data.writable_length = data
            .writable_length
            .saturating_add(bytes_len(&chunk) as usize);
        data.queue.push_back(WritableEntry { chunk, callback });
        let below_high_water_mark = data.writable_length < data.high_water_mark;
        if !below_high_water_mark {
            data.need_drain = true;
        }
        below_high_water_mark
    })
}

pub fn writable_take_write<L, W, F, C>(
    writable: &JsWritable<L, W, F, C>,
) -> Option<(JsBytes<u8>, usize, C)>
where
    L: Clone + Trace + 'static,
    W: Clone + Trace + 'static,
    F: Clone + Trace + 'static,
    C: Clone + Trace + 'static,
{
    writable.with_mut(|data| {
        if data.writing {
            return None;
        }
        let entry = data.queue.pop_front()?;
        data.writing = true;
        let length = bytes_len(&entry.chunk) as usize;
        Some((entry.chunk, length, entry.callback))
    })
}

pub fn writable_complete_write<L, W, F, C>(
    writable: &JsWritable<L, W, F, C>,
    length: usize,
) where
    L: Clone + Trace + 'static,
    W: Clone + Trace + 'static,
    F: Clone + Trace + 'static,
    C: Clone + Trace + 'static,
{
    writable.with_mut(|data| {
        data.writing = false;
        data.writable_length = data.writable_length.saturating_sub(length);
    });
}

pub fn writable_take_drain<L, W, F, C>(writable: &JsWritable<L, W, F, C>) -> bool
where
    L: Clone + Trace + 'static,
    W: Clone + Trace + 'static,
    F: Clone + Trace + 'static,
    C: Clone + Trace + 'static,
{
    writable.with_mut(|data| {
        if !data.need_drain || data.writable_length != 0 || data.writing {
            return false;
        }
        data.need_drain = false;
        true
    })
}

pub fn writable_mark_ended<L, W, F, C>(writable: &JsWritable<L, W, F, C>)
where
    L: Clone + Trace + 'static,
    W: Clone + Trace + 'static,
    F: Clone + Trace + 'static,
    C: Clone + Trace + 'static,
{
    writable.with_mut(|data| data.ended = true);
}

pub fn writable_take_prefinish<L, W, F, C>(writable: &JsWritable<L, W, F, C>) -> bool
where
    L: Clone + Trace + 'static,
    W: Clone + Trace + 'static,
    F: Clone + Trace + 'static,
    C: Clone + Trace + 'static,
{
    writable.with_mut(|data| {
        if data.prefinished {
            return false;
        }
        data.prefinished = true;
        true
    })
}

pub fn writable_schedule_finish<L, W, F, C>(writable: &JsWritable<L, W, F, C>) -> bool
where
    L: Clone + Trace + 'static,
    W: Clone + Trace + 'static,
    F: Clone + Trace + 'static,
    C: Clone + Trace + 'static,
{
    writable.with_mut(|data| {
        if data.finish_scheduled || data.finished {
            return false;
        }
        data.finish_scheduled = true;
        true
    })
}

pub fn writable_mark_finished<L, W, F, C>(writable: &JsWritable<L, W, F, C>)
where
    L: Clone + Trace + 'static,
    W: Clone + Trace + 'static,
    F: Clone + Trace + 'static,
    C: Clone + Trace + 'static,
{
    writable.with_mut(|data| {
        data.finish_scheduled = false;
        data.finished = true;
    });
}

pub fn writable_take_close<L, W, F, C>(writable: &JsWritable<L, W, F, C>) -> bool
where
    L: Clone + Trace + 'static,
    W: Clone + Trace + 'static,
    F: Clone + Trace + 'static,
    C: Clone + Trace + 'static,
{
    writable.with_mut(|data| {
        if data.closed || !data.auto_destroy || !data.emit_close {
            return false;
        }
        data.closed = true;
        true
    })
}

pub fn writable_number_prop<L, W, F, C>(
    writable: &JsWritable<L, W, F, C>,
    name: &JsString,
) -> f64
where
    L: Clone + Trace + 'static,
    W: Clone + Trace + 'static,
    F: Clone + Trace + 'static,
    C: Clone + Trace + 'static,
{
    writable.with(|data| match name.as_ref() {
        "writableLength" => data.writable_length as f64,
        "writableHighWaterMark" => data.high_water_mark as f64,
        "writableCorked" => 0.0,
        _ => 0.0,
    })
}

pub fn writable_bool_prop<L, W, F, C>(
    writable: &JsWritable<L, W, F, C>,
    name: &JsString,
) -> bool
where
    L: Clone + Trace + 'static,
    W: Clone + Trace + 'static,
    F: Clone + Trace + 'static,
    C: Clone + Trace + 'static,
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
