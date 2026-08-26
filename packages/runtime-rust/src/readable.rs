pub struct ReadableData<L, R>
where
    L: Clone + Trace + 'static,
    R: Clone + Trace + 'static,
{
    emitter: Option<JsEventEmitter<L>>,
    read_callback: Option<R>,
    chunks: VecDeque<JsBytes<u8>>,
    buffered_length: usize,
    high_water_mark: usize,
    flowing: Option<bool>,
    eof: bool,
    ended: bool,
    scheduled: bool,
    draining: bool,
    push_after_eof: bool,
}

impl<L, R> Trace for ReadableData<L, R>
where
    L: Clone + Trace + 'static,
    R: Clone + Trace + 'static,
{
    fn trace(&self, tracer: &mut Tracer<'_>) {
        if let Some(emitter) = &self.emitter {
            tracer.edge(emitter);
        }
        if let Some(callback) = &self.read_callback {
            callback.trace(tracer);
        }
        for chunk in &self.chunks {
            tracer.edge(chunk);
        }
    }
}

impl<L, R> ClearEdges for ReadableData<L, R>
where
    L: Clone + Trace + 'static,
    R: Clone + Trace + 'static,
{
    fn clear_edges(&mut self) {
        self.emitter = None;
        self.read_callback = None;
        self.chunks.clear();
        self.buffered_length = 0;
    }
}

pub type JsReadable<L, R> = Gc<ReadableData<L, R>>;

pub fn readable_new<L, R>(high_water_mark: f64, read_callback: R) -> JsReadable<L, R>
where
    L: Clone + Trace + 'static,
    R: Clone + Trace + 'static,
{
    let high_water_mark = if high_water_mark.is_finite() && high_water_mark >= 0.0 {
        high_water_mark.trunc() as usize
    } else {
        16 * 1024
    };
    Gc::new(ReadableData {
        emitter: Some(emitter_new()),
        read_callback: Some(read_callback),
        chunks: VecDeque::new(),
        buffered_length: 0,
        high_water_mark,
        flowing: None,
        eof: false,
        ended: false,
        scheduled: false,
        draining: false,
        push_after_eof: false,
    })
}

pub fn readable_emitter<L, R>(readable: &JsReadable<L, R>) -> JsEventEmitter<L>
where
    L: Clone + Trace + 'static,
    R: Clone + Trace + 'static,
{
    readable.with(|data| {
        data.emitter
            .as_ref()
            .expect("scriptc: cleared live Readable emitter")
            .clone()
    })
}

pub fn readable_trace<L, R>(readable: &JsReadable<L, R>, tracer: &mut Tracer<'_>)
where
    L: Clone + Trace + 'static,
    R: Clone + Trace + 'static,
{
    tracer.edge(readable);
}

pub fn readable_ptr_eq<L, R>(left: &JsReadable<L, R>, right: &JsReadable<L, R>) -> bool
where
    L: Clone + Trace + 'static,
    R: Clone + Trace + 'static,
{
    left.ptr_eq(right)
}

pub fn readable_push<L, R>(readable: &JsReadable<L, R>, chunk: JsBytes<u8>) -> bool
where
    L: Clone + Trace + 'static,
    R: Clone + Trace + 'static,
{
    readable.with_mut(|data| {
        if data.eof {
            data.push_after_eof = true;
            return false;
        }
        data.buffered_length = data.buffered_length.saturating_add(bytes_len(&chunk) as usize);
        data.chunks.push_back(chunk);
        data.buffered_length < data.high_water_mark
    })
}

pub fn readable_push_string<L, R>(readable: &JsReadable<L, R>, chunk: &JsString) -> bool
where
    L: Clone + Trace + 'static,
    R: Clone + Trace + 'static,
{
    readable_push(readable, buffer_from_string(chunk, &string("utf8")))
}

pub fn readable_push_null<L, R>(readable: &JsReadable<L, R>) -> bool
where
    L: Clone + Trace + 'static,
    R: Clone + Trace + 'static,
{
    readable.with_mut(|data| data.eof = true);
    false
}

pub fn readable_start_flowing<L, R>(readable: &JsReadable<L, R>)
where
    L: Clone + Trace + 'static,
    R: Clone + Trace + 'static,
{
    readable.with_mut(|data| data.flowing = Some(true));
}

pub fn readable_schedule<L, R>(readable: &JsReadable<L, R>) -> bool
where
    L: Clone + Trace + 'static,
    R: Clone + Trace + 'static,
{
    readable.with_mut(|data| {
        if data.flowing != Some(true) || data.scheduled || data.draining || data.ended {
            return false;
        }
        data.scheduled = true;
        true
    })
}

pub fn readable_begin_drain<L, R>(readable: &JsReadable<L, R>)
where
    L: Clone + Trace + 'static,
    R: Clone + Trace + 'static,
{
    readable.with_mut(|data| {
        data.scheduled = false;
        data.draining = true;
    });
}

pub fn readable_end_drain<L, R>(readable: &JsReadable<L, R>)
where
    L: Clone + Trace + 'static,
    R: Clone + Trace + 'static,
{
    readable.with_mut(|data| data.draining = false);
}

pub fn readable_pop<L, R>(readable: &JsReadable<L, R>) -> Option<JsBytes<u8>>
where
    L: Clone + Trace + 'static,
    R: Clone + Trace + 'static,
{
    readable.with_mut(|data| {
        let chunk = data.chunks.pop_front()?;
        data.buffered_length = data.buffered_length.saturating_sub(bytes_len(&chunk) as usize);
        Some(chunk)
    })
}

pub fn readable_read_callback<L, R>(readable: &JsReadable<L, R>) -> Option<R>
where
    L: Clone + Trace + 'static,
    R: Clone + Trace + 'static,
{
    readable.with(|data| data.read_callback.clone())
}

pub fn readable_has_data_or_eof<L, R>(readable: &JsReadable<L, R>) -> bool
where
    L: Clone + Trace + 'static,
    R: Clone + Trace + 'static,
{
    readable.with(|data| !data.chunks.is_empty() || data.eof)
}

pub fn readable_take_push_after_eof<L, R>(readable: &JsReadable<L, R>) -> bool
where
    L: Clone + Trace + 'static,
    R: Clone + Trace + 'static,
{
    readable.with_mut(|data| std::mem::take(&mut data.push_after_eof))
}

pub fn readable_take_end<L, R>(readable: &JsReadable<L, R>) -> bool
where
    L: Clone + Trace + 'static,
    R: Clone + Trace + 'static,
{
    readable.with_mut(|data| {
        if !data.eof || data.ended || !data.chunks.is_empty() {
            return false;
        }
        data.ended = true;
        true
    })
}

pub fn readable_length<L, R>(readable: &JsReadable<L, R>) -> f64
where
    L: Clone + Trace + 'static,
    R: Clone + Trace + 'static,
{
    readable.with(|data| data.buffered_length as f64)
}

pub fn readable_prop<L, R>(readable: &JsReadable<L, R>, name: &JsString) -> f64
where
    L: Clone + Trace + 'static,
    R: Clone + Trace + 'static,
{
    match name.as_ref() {
        "readableLength" => readable_length(readable),
        "readableHighWaterMark" => readable.with(|data| data.high_water_mark as f64),
        "readableEnded" => if readable.with(|data| data.ended) { 1.0 } else { 0.0 },
        "destroyed" => 0.0,
        _ => 0.0,
    }
}

pub fn readable_flowing<L, R>(readable: &JsReadable<L, R>) -> Option<bool>
where
    L: Clone + Trace + 'static,
    R: Clone + Trace + 'static,
{
    readable.with(|data| data.flowing)
}
