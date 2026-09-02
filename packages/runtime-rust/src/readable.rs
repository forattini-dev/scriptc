pub type ReadableTrace = Rc<dyn Fn(&mut Tracer<'_>)>;
pub type ReadableNotify = Rc<dyn Fn()>;
pub type ReadableBackpressure = Rc<dyn Fn(ReadableNotify, ReadableTrace)>;

#[derive(Clone)]
struct ReadablePipe {
    identity: usize,
    end: bool,
    write: Rc<dyn Fn(JsBytes<u8>) -> bool>,
    finish: ReadableNotify,
    unpipe: ReadableNotify,
    resume: ReadableNotify,
    resume_trace: ReadableTrace,
    backpressure: ReadableBackpressure,
    trace: ReadableTrace,
}

#[derive(Clone)]
struct ReadableWaiter {
    settle: Rc<dyn Fn(Result<Option<ReadableChunk>, Caught>)>,
    trace: Rc<dyn Fn(&mut Tracer<'_>)>,
}

#[derive(Clone)]
pub enum ReadableChunk {
    Bytes(JsBytes<u8>),
    String(JsString),
}

pub struct ReadableData<L, R>
where
    L: Clone + Trace + 'static,
    R: Clone + Trace + 'static,
{
    emitter: Option<JsEventEmitter<L>>,
    read_callback: Option<R>,
    destroy_callback: Option<R>,
    errored: Option<JsError>,
    chunks: VecDeque<ReadableChunk>,
    encoding: Option<JsString>,
    decoder_pending: f64,
    push_encoding: Option<JsString>,
    buffered_length: usize,
    high_water_mark: usize,
    flowing: Option<bool>,
    eof: bool,
    ended: bool,
    scheduled: bool,
    draining: bool,
    push_after_eof: bool,
    resume_pending: bool,
    resume_after_data: bool,
    readable_scheduled: bool,
    emitted_readable: bool,
    object_mode: bool,
    auto_destroy: bool,
    async_iterator: bool,
    next_waiter: Option<ReadableWaiter>,
    pipes: Vec<ReadablePipe>,
    destroyed: bool,
    closed: bool,
    emit_close: bool,
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
        if let Some(callback) = &self.destroy_callback {
            callback.trace(tracer);
        }
        if let Some(error) = &self.errored {
            error.trace(tracer);
        }
        for chunk in &self.chunks {
            if let ReadableChunk::Bytes(bytes) = chunk {
                tracer.edge(bytes);
            }
        }
        for pipe in &self.pipes {
            (pipe.trace)(tracer);
            (pipe.resume_trace)(tracer);
        }
        if let Some(waiter) = &self.next_waiter {
            (waiter.trace)(tracer);
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
        self.destroy_callback = None;
        self.errored = None;
        self.chunks.clear();
        self.encoding = None;
        self.decoder_pending = 0.0;
        self.push_encoding = None;
        self.buffered_length = 0;
        self.next_waiter = None;
        self.pipes.clear();
    }
}

pub type JsReadable<L, R> = Gc<ReadableData<L, R>>;

fn stream_default_byte_high_water_mark() -> usize {
    if cfg!(target_os = "windows") {
        16 * 1024
    } else {
        64 * 1024
    }
}

pub fn readable_new<L, R>(
    high_water_mark: f64,
    auto_destroy: bool,
    emit_close: bool,
    read_callback: Option<R>,
    destroy_callback: Option<R>,
) -> JsReadable<L, R>
where
    L: Clone + Trace + 'static,
    R: Clone + Trace + 'static,
{
    let high_water_mark = if high_water_mark.is_finite() && high_water_mark >= 0.0 {
        high_water_mark.trunc() as usize
    } else {
        stream_default_byte_high_water_mark()
    };
    Gc::new(ReadableData {
        emitter: Some(emitter_new_shaped(&[
            "close", "error", "data", "end", "readable",
        ])),
        read_callback,
        destroy_callback,
        errored: None,
        chunks: VecDeque::new(),
        encoding: None,
        decoder_pending: 0.0,
        push_encoding: None,
        buffered_length: 0,
        high_water_mark,
        flowing: None,
        eof: false,
        ended: false,
        scheduled: false,
        draining: false,
        push_after_eof: false,
        resume_pending: false,
        resume_after_data: false,
        readable_scheduled: false,
        emitted_readable: false,
        object_mode: false,
        auto_destroy,
        async_iterator: false,
        next_waiter: None,
        pipes: Vec::new(),
        destroyed: false,
        closed: false,
        emit_close,
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

pub fn readable_set_emitter<L, R>(readable: &JsReadable<L, R>, emitter: JsEventEmitter<L>)
where
    L: Clone + Trace + 'static,
    R: Clone + Trace + 'static,
{
    readable.with_mut(|data| data.emitter = Some(emitter));
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

fn readable_take_next<L, R>(data: &mut ReadableData<L, R>) -> Option<ReadableChunk>
where
    L: Clone + Trace + 'static,
    R: Clone + Trace + 'static,
{
    let chunk = data.chunks.pop_front()?;
    if data.object_mode {
        data.buffered_length = data.buffered_length.saturating_sub(1);
        return Some(chunk);
    }

    // Node's Readable async iterator obtains each value with read(), whose
    // absent size consumes all content buffered at that instant. Preserve
    // object-mode boundaries above, but join byte/string pushes that arrived
    // before this next() settles. Chunks produced in later event-loop turns
    // are still delivered by later next() calls.
    let joined = match chunk {
        ReadableChunk::Bytes(first) => {
            let mut pieces = vec![first];
            while matches!(data.chunks.front(), Some(ReadableChunk::Bytes(_))) {
                let Some(ReadableChunk::Bytes(piece)) = data.chunks.pop_front() else {
                    unreachable!("scriptc: checked buffered Readable byte chunk")
                };
                pieces.push(piece);
            }
            ReadableChunk::Bytes(if pieces.len() == 1 {
                pieces.pop().expect("scriptc: first Readable byte chunk")
            } else {
                buffer_concat(&array_new(pieces))
            })
        }
        ReadableChunk::String(mut text) => {
            while matches!(data.chunks.front(), Some(ReadableChunk::String(_))) {
                let Some(ReadableChunk::String(piece)) = data.chunks.pop_front() else {
                    unreachable!("scriptc: checked buffered Readable string chunk")
                };
                text = string_concat(&text, &piece);
            }
            ReadableChunk::String(text)
        }
    };
    data.buffered_length = data.chunks.iter().fold(0, |length, chunk| {
        length
            + match chunk {
                ReadableChunk::Bytes(bytes) => bytes_len(bytes) as usize,
                ReadableChunk::String(text) => text.encode_utf16().count(),
            }
    });
    Some(joined)
}

fn readable_settle_next<L, R>(readable: &JsReadable<L, R>)
where
    L: Clone + Trace + 'static,
    R: Clone + Trace + 'static,
{
    let ready = readable.with_mut(|data| {
        data.next_waiter.as_ref()?;
        let outcome = if let Some(error) = &data.errored {
            Some(Err(caught_value(error.clone())))
        } else if !data.chunks.is_empty() {
            Some(Ok(readable_take_next(data)))
        } else if data.eof || data.destroyed {
            data.ended = data.eof;
            if data.auto_destroy && data.eof {
                data.destroyed = true;
                data.closed = data.emit_close;
            }
            Some(Ok(None))
        } else {
            None
        };
        outcome.map(|outcome| {
            let waiter = data
                .next_waiter
                .take()
                .expect("scriptc: checked Readable waiter");
            (waiter, outcome)
        })
    });
    if let Some((waiter, outcome)) = ready {
        (waiter.settle)(outcome);
    }
}

pub fn readable_set_next_waiter<L, R>(
    readable: &JsReadable<L, R>,
    settle: Rc<dyn Fn(Result<Option<ReadableChunk>, Caught>)>,
    trace: Rc<dyn Fn(&mut Tracer<'_>)>,
) -> bool
where
    L: Clone + Trace + 'static,
    R: Clone + Trace + 'static,
{
    let registered = readable.with_mut(|data| {
        if data.next_waiter.is_some() {
            return false;
        }
        data.async_iterator = true;
        data.next_waiter = Some(ReadableWaiter { settle, trace });
        true
    });
    if registered {
        readable_settle_next(readable);
    }
    registered
}

pub fn readable_has_async_iterator<L, R>(readable: &JsReadable<L, R>) -> bool
where
    L: Clone + Trace + 'static,
    R: Clone + Trace + 'static,
{
    readable.with(|data| data.async_iterator)
}

pub fn readable_reject_next<L, R>(readable: &JsReadable<L, R>, reason: Caught)
where
    L: Clone + Trace + 'static,
    R: Clone + Trace + 'static,
{
    let waiter = readable.with_mut(|data| data.next_waiter.take());
    if let Some(waiter) = waiter {
        (waiter.settle)(Err(reason));
    }
}

pub fn readable_set_object_mode<L, R>(readable: &JsReadable<L, R>)
where
    L: Clone + Trace + 'static,
    R: Clone + Trace + 'static,
{
    readable.with_mut(|data| data.object_mode = true);
}

pub fn readable_push_object_string<L, R>(readable: &JsReadable<L, R>, chunk: JsString)
where
    L: Clone + Trace + 'static,
    R: Clone + Trace + 'static,
{
    readable.with_mut(|data| {
        if data.eof {
            data.push_after_eof = true;
            return;
        }
        data.buffered_length = data.buffered_length.saturating_add(1);
        data.chunks.push_back(ReadableChunk::String(chunk));
    });
    readable_settle_next(readable);
}

pub fn readable_push<L, R>(readable: &JsReadable<L, R>, chunk: JsBytes<u8>) -> bool
where
    L: Clone + Trace + 'static,
    R: Clone + Trace + 'static,
{
    let below_high_water_mark = readable.with_mut(|data| {
        if data.eof {
            data.push_after_eof = true;
            return false;
        }
        if let Some(encoding) = &data.encoding {
            let text = string_decoder_write(encoding, data.decoder_pending, &chunk);
            data.decoder_pending = string_decoder_next(encoding, data.decoder_pending, &chunk);
            let length = text.encode_utf16().count();
            if length > 0 {
                data.buffered_length = data.buffered_length.saturating_add(length);
                data.chunks.push_back(ReadableChunk::String(text));
            }
        } else {
            let length = if data.object_mode {
                1
            } else {
                bytes_len(&chunk) as usize
            };
            data.buffered_length = data.buffered_length.saturating_add(length);
            data.chunks.push_back(ReadableChunk::Bytes(chunk));
        }
        data.buffered_length < data.high_water_mark
    });
    readable_settle_next(readable);
    below_high_water_mark
}

pub fn readable_push_string<L, R>(readable: &JsReadable<L, R>, chunk: &JsString) -> bool
where
    L: Clone + Trace + 'static,
    R: Clone + Trace + 'static,
{
    let encoding = readable.with(|data| data.push_encoding.clone());
    let bytes = buffer_from_string(chunk, encoding.as_ref().unwrap_or(&string("utf8")));
    readable_push(readable, bytes)
}

pub fn readable_push_string_encoding<L, R>(
    readable: &JsReadable<L, R>,
    chunk: &JsString,
    encoding: &JsString,
) -> bool
where
    L: Clone + Trace + 'static,
    R: Clone + Trace + 'static,
{
    readable_push(readable, buffer_from_string(chunk, encoding))
}

pub fn readable_set_push_encoding<L, R>(readable: &JsReadable<L, R>, encoding: &JsString)
where
    L: Clone + Trace + 'static,
    R: Clone + Trace + 'static,
{
    readable.with_mut(|data| data.push_encoding = Some(encoding.clone()));
}

pub fn readable_set_encoding<L, R>(readable: &JsReadable<L, R>, encoding: &JsString)
where
    L: Clone + Trace + 'static,
    R: Clone + Trace + 'static,
{
    readable.with_mut(|data| {
        let previous_encoding = data.encoding.clone();
        let mut content = None;
        let old_chunks = std::mem::take(&mut data.chunks);
        let mut pending = 0.0;
        for chunk in old_chunks {
            let piece = match chunk {
                ReadableChunk::Bytes(bytes) => {
                    let piece = string_decoder_write(encoding, pending, &bytes);
                    pending = string_decoder_next(encoding, pending, &bytes);
                    piece
                }
                ReadableChunk::String(text) => text,
            };
            if piece.is_empty() {
                continue;
            }
            content = Some(match content {
                Some(previous) => string_concat(&previous, &piece),
                None => piece,
            });
        }
        if let Some(previous) = previous_encoding {
            let tail = string_decoder_end(&previous, data.decoder_pending);
            if !tail.is_empty() {
                content = Some(match content {
                    Some(previous) => string_concat(&previous, &tail),
                    None => tail,
                });
            }
        }
        data.encoding = Some(encoding.clone());
        data.decoder_pending = pending;
        data.buffered_length = 0;
        if let Some(content) = content {
            data.buffered_length = content.encode_utf16().count();
            data.chunks.push_back(ReadableChunk::String(content));
        }
    });
}

pub fn readable_push_null<L, R>(readable: &JsReadable<L, R>) -> bool
where
    L: Clone + Trace + 'static,
    R: Clone + Trace + 'static,
{
    readable.with_mut(|data| {
        if let Some(encoding) = &data.encoding {
            let tail = string_decoder_end(encoding, data.decoder_pending);
            data.decoder_pending = 0.0;
            let length = tail.encode_utf16().count();
            if length > 0 {
                data.buffered_length = data.buffered_length.saturating_add(length);
                data.chunks.push_back(ReadableChunk::String(tail));
            }
        }
        data.eof = true;
    });
    readable_settle_next(readable);
    false
}

pub fn readable_unshift<L, R>(readable: &JsReadable<L, R>, chunk: JsBytes<u8>)
where
    L: Clone + Trace + 'static,
    R: Clone + Trace + 'static,
{
    readable.with_mut(|data| {
        if let Some(encoding) = &data.encoding {
            let mut text = string_decoder_write(encoding, 0.0, &chunk);
            let tail = string_decoder_end(encoding, string_decoder_next(encoding, 0.0, &chunk));
            if !tail.is_empty() {
                text = string_concat(&text, &tail);
            }
            let length = text.encode_utf16().count();
            if length > 0 {
                data.buffered_length = data.buffered_length.saturating_add(length);
                data.chunks.push_front(ReadableChunk::String(text));
            }
        } else {
            data.buffered_length = data
                .buffered_length
                .saturating_add(bytes_len(&chunk) as usize);
            data.chunks.push_front(ReadableChunk::Bytes(chunk));
        }
    });
}

pub fn readable_read<L, R>(readable: &JsReadable<L, R>, size: f64) -> Option<JsBytes<u8>>
where
    L: Clone + Trace + 'static,
    R: Clone + Trace + 'static,
{
    let (available, eof, encoded) = readable.with_mut(|data| {
        // Node clears emittedReadable for every read except read(0).
        // The absent read() form arrives as -1 and therefore clears too.
        if size != 0.0 {
            data.emitted_readable = false;
        }
        (data.buffered_length, data.eof, data.encoding.is_some())
    });
    if encoded {
        throw_error("read() on a stream with an encoding set is not supported yet (consume 'data' events, which deliver strings)".to_owned());
    }
    if available == 0 {
        return None;
    }
    // howMuchToRead(NaN). THE semantics of read() follow
    // NODE_COMPAT_MATRIX.primary: a compiled binary reproduces ONE Node,
    // and the two majors disagree on the bare form.
    //
    //   Node 24 (primary today):  flowing && length ? head : state.length
    //   Node 26 (nodejs#60441):   !decoder ? head : state.length
    //
    // An encoded stream throws above and flowing delivers through 'data',
    // so this is the paused raw-Buffer path and 24 collapses the queue.
    // Promoting the primary to 26 means asking for the head chunk's length
    // (`data.chunks.front()`) instead of `available`; this expression is
    // the single point of change. See nodejs#60441.
    let requested = if size.is_finite() && size >= 0.0 {
        size.trunc() as usize
    } else {
        available
    };
    if requested == 0 || (requested > available && !eof) {
        return None;
    }
    let wanted = requested.min(available);
    let mut remaining = wanted;
    let mut pieces = Vec::new();
    readable.with_mut(|data| {
        while remaining > 0 {
            let ReadableChunk::Bytes(chunk) = data
                .chunks
                .pop_front()
                .expect("scriptc: Readable length without chunks")
            else {
                unreachable!("scriptc: encoded Readable reached byte read");
            };
            let length = bytes_len(&chunk) as usize;
            if length <= remaining {
                remaining -= length;
                pieces.push(chunk);
            } else {
                pieces.push(bytes_slice(&chunk, 0.0, remaining as f64, false));
                data.chunks.push_front(ReadableChunk::Bytes(bytes_slice(
                    &chunk,
                    remaining as f64,
                    length as f64,
                    false,
                )));
                remaining = 0;
            }
        }
        data.buffered_length -= wanted;
    });
    if pieces.len() == 1 {
        pieces.pop()
    } else {
        Some(buffer_concat(&array_new(pieces)))
    }
}

pub fn readable_schedule_notification<L, R>(readable: &JsReadable<L, R>) -> bool
where
    L: Clone + Trace + 'static,
    R: Clone + Trace + 'static,
{
    readable.with_mut(|data| {
        if data.readable_scheduled || (data.chunks.is_empty() && !data.eof) {
            return false;
        }
        data.readable_scheduled = true;
        data.emitted_readable = true;
        true
    })
}

pub fn readable_begin_notification<L, R>(readable: &JsReadable<L, R>)
where
    L: Clone + Trace + 'static,
    R: Clone + Trace + 'static,
{
    readable.with_mut(|data| data.readable_scheduled = false);
}

pub fn readable_end_notification<L, R>(readable: &JsReadable<L, R>)
where
    L: Clone + Trace + 'static,
    R: Clone + Trace + 'static,
{
    readable.with_mut(|data| data.emitted_readable = false);
}

pub fn readable_start_flowing<L, R>(readable: &JsReadable<L, R>)
where
    L: Clone + Trace + 'static,
    R: Clone + Trace + 'static,
{
    readable.with_mut(|data| {
        if data.flowing != Some(true) {
            data.flowing = Some(true);
            data.resume_pending = true;
            data.resume_after_data = false;
        }
    });
}

pub fn readable_pause<L, R>(readable: &JsReadable<L, R>) -> bool
where
    L: Clone + Trace + 'static,
    R: Clone + Trace + 'static,
{
    readable.with_mut(|data| {
        if data.flowing == Some(false) {
            return false;
        }
        data.flowing = Some(false);
        data.resume_pending = false;
        true
    })
}

pub fn readable_resume<L, R>(readable: &JsReadable<L, R>)
where
    L: Clone + Trace + 'static,
    R: Clone + Trace + 'static,
{
    readable.with_mut(|data| {
        if data.flowing != Some(true) {
            data.flowing = Some(true);
            data.resume_pending = true;
            data.resume_after_data = !data.chunks.is_empty();
        }
    });
}

pub fn readable_is_paused<L, R>(readable: &JsReadable<L, R>) -> bool
where
    L: Clone + Trace + 'static,
    R: Clone + Trace + 'static,
{
    readable.with(|data| data.flowing == Some(false))
}

pub fn readable_is_flowing<L, R>(readable: &JsReadable<L, R>) -> bool
where
    L: Clone + Trace + 'static,
    R: Clone + Trace + 'static,
{
    readable.with(|data| data.flowing == Some(true))
}

pub fn readable_take_resume<L, R>(readable: &JsReadable<L, R>, after_data: bool) -> bool
where
    L: Clone + Trace + 'static,
    R: Clone + Trace + 'static,
{
    readable.with_mut(|data| {
        if !data.resume_pending || data.resume_after_data != after_data {
            return false;
        }
        data.resume_pending = false;
        true
    })
}

pub fn readable_schedule<L, R>(readable: &JsReadable<L, R>) -> bool
where
    L: Clone + Trace + 'static,
    R: Clone + Trace + 'static,
{
    readable.with_mut(|data| {
        if data.flowing != Some(true)
            || data.scheduled
            || data.draining
            || data.ended
            || data.destroyed
        {
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

pub fn readable_pop<L, R>(readable: &JsReadable<L, R>) -> Option<ReadableChunk>
where
    L: Clone + Trace + 'static,
    R: Clone + Trace + 'static,
{
    readable.with_mut(|data| {
        let chunk = data.chunks.pop_front()?;
        let length = match &chunk {
            ReadableChunk::Bytes(bytes) => bytes_len(bytes) as usize,
            ReadableChunk::String(text) => text.encode_utf16().count(),
        };
        data.buffered_length = data.buffered_length.saturating_sub(length);
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

pub fn readable_set_read_callback<L, R>(readable: &JsReadable<L, R>, callback: R)
where
    L: Clone + Trace + 'static,
    R: Clone + Trace + 'static,
{
    readable.with_mut(|data| data.read_callback = Some(callback));
}

pub fn readable_destroy_callback<L, R>(readable: &JsReadable<L, R>) -> Option<R>
where
    L: Clone + Trace + 'static,
    R: Clone + Trace + 'static,
{
    readable.with(|data| data.destroy_callback.clone())
}

pub fn readable_destroy<L, R>(readable: &JsReadable<L, R>, error: Option<JsError>) -> bool
where
    L: Clone + Trace + 'static,
    R: Clone + Trace + 'static,
{
    let changed = readable.with_mut(|data| {
        if data.destroyed {
            return false;
        }
        data.destroyed = true;
        if data.errored.is_none() {
            data.errored = error;
        }
        true
    });
    readable_settle_next(readable);
    changed
}

pub fn readable_error<L, R>(readable: &JsReadable<L, R>) -> Option<JsError>
where
    L: Clone + Trace + 'static,
    R: Clone + Trace + 'static,
{
    readable.with(|data| data.errored.clone())
}

pub fn readable_take_destroy_close<L, R>(readable: &JsReadable<L, R>) -> bool
where
    L: Clone + Trace + 'static,
    R: Clone + Trace + 'static,
{
    readable.with_mut(|data| {
        if data.closed || !data.emit_close {
            return false;
        }
        data.closed = true;
        true
    })
}

pub fn readable_has_data_or_eof<L, R>(readable: &JsReadable<L, R>) -> bool
where
    L: Clone + Trace + 'static,
    R: Clone + Trace + 'static,
{
    readable.with(|data| !data.chunks.is_empty() || data.eof)
}

#[allow(clippy::too_many_arguments)]
pub fn readable_add_pipe<L, R>(
    readable: &JsReadable<L, R>,
    identity: usize,
    end: bool,
    write: Rc<dyn Fn(JsBytes<u8>) -> bool>,
    finish: ReadableNotify,
    unpipe: ReadableNotify,
    resume: ReadableNotify,
    resume_trace: ReadableTrace,
    backpressure: ReadableBackpressure,
    trace: ReadableTrace,
) where
    L: Clone + Trace + 'static,
    R: Clone + Trace + 'static,
{
    readable.with_mut(|data| {
        data.pipes.push(ReadablePipe {
            identity,
            end,
            write,
            finish,
            unpipe,
            resume,
            resume_trace,
            backpressure,
            trace,
        });
    });
}

pub fn readable_write_pipes<L, R>(readable: &JsReadable<L, R>, chunk: JsBytes<u8>)
where
    L: Clone + Trace + 'static,
    R: Clone + Trace + 'static,
{
    let pipes = readable.with(|data| data.pipes.clone());
    let mut paused = false;
    for pipe in pipes {
        if !(pipe.write)(chunk.clone()) {
            paused = true;
            (pipe.backpressure)(pipe.resume.clone(), pipe.resume_trace.clone());
        }
    }
    if paused {
        readable.with_mut(|data| data.flowing = Some(false));
    }
}

pub fn readable_end_pipes<L, R>(readable: &JsReadable<L, R>)
where
    L: Clone + Trace + 'static,
    R: Clone + Trace + 'static,
{
    let pipes = readable.with(|data| data.pipes.clone());
    for pipe in pipes {
        if pipe.end {
            (pipe.finish)();
        }
    }
}

pub fn readable_unpipe<L, R>(readable: &JsReadable<L, R>, identity: Option<usize>)
where
    L: Clone + Trace + 'static,
    R: Clone + Trace + 'static,
{
    let removed = readable.with_mut(|data| {
        let mut removed = Vec::new();
        let mut retained = Vec::with_capacity(data.pipes.len());
        for pipe in data.pipes.drain(..) {
            if identity.is_none_or(|candidate| candidate == pipe.identity) {
                removed.push(pipe);
            } else {
                retained.push(pipe);
            }
        }
        data.pipes = retained;
        if !removed.is_empty() {
            data.flowing = Some(false);
        }
        removed
    });
    for pipe in removed {
        (pipe.unpipe)();
    }
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

pub fn readable_take_close<L, R>(readable: &JsReadable<L, R>) -> bool
where
    L: Clone + Trace + 'static,
    R: Clone + Trace + 'static,
{
    readable.with_mut(|data| {
        if data.closed || !data.auto_destroy || !data.emit_close {
            return false;
        }
        data.closed = true;
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
        "readableLength" | "rs:length" => readable_length(readable),
        "readableHighWaterMark" | "rs:highWaterMark" => {
            readable.with(|data| data.high_water_mark as f64)
        }
        "readableEnded" => f64::from(readable.with(|data| data.ended)),
        "destroyed" => f64::from(readable.with(|data| data.destroyed)),
        _ => 0.0,
    }
}

pub fn readable_bool_prop<L, R>(readable: &JsReadable<L, R>, name: &JsString) -> bool
where
    L: Clone + Trace + 'static,
    R: Clone + Trace + 'static,
{
    readable.with(|data| match name.as_ref() {
        "readable" => !data.ended && !data.destroyed && data.errored.is_none(),
        "readableEnded" => data.ended,
        "rs:ended" => data.eof,
        "rs:endEmitted" => data.ended,
        "destroyed" => data.destroyed,
        "closed" => data.closed,
        "readableObjectMode" => data.object_mode,
        "rs:emittedReadable" => data.emitted_readable,
        _ => false,
    })
}

pub fn readable_flowing<L, R>(readable: &JsReadable<L, R>) -> Option<bool>
where
    L: Clone + Trace + 'static,
    R: Clone + Trace + 'static,
{
    readable.with(|data| data.flowing)
}
