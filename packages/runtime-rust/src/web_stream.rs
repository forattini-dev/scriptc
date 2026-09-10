// Native default ReadableStreams. Queue entries retain their original identity;
// the default strategy has a high-water mark of one entry (not one byte).
pub trait WebStreamSource<T: HeapValue>: Trace {
    fn pull(&self, stream: &JsWebStream<T>) -> JsPromise<T>;
    fn cancel(&self, reason: T) -> JsPromise<T>;
    fn has_pull(&self) -> bool;
}

pub struct WebStreamData<T: HeapValue> {
    queue: VecDeque<T>,
    reader: Option<JsWebReader<T>>,
    source: Option<Rc<dyn WebStreamSource<T>>>,
    started: bool,
    pulling: bool,
    prefetch: bool,
    pull_again: bool,
    close_requested: bool,
    closed: bool,
    error: Option<WebStreamFailure<T>>,
}

// Keep dynamic rejection values traceable instead of hiding their edges in Any.
#[derive(Clone)]
enum WebStreamFailure<T: HeapValue> { Value(T), Native(Caught) }
impl<T: HeapValue> WebStreamFailure<T> {
    fn caught(&self) -> Caught {
        match self { Self::Value(value) => caught_value(value.clone()), Self::Native(error) => error.clone() }
    }
}

pub struct WebReaderData<T: HeapValue> {
    stream: Option<JsWebStream<T>>,
    pending: VecDeque<Box<dyn WebReadRequest<T>>>,
    closed_promise: Option<JsPromise<()>>,
}

// Project into the compiler's typed read-result at settlement, without an
// extra Promise.then microtask between ReadableStream.read() and its caller.
trait WebReadRequest<T: HeapValue>: Trace {
    fn settle(self: Box<Self>, result: Result<Option<T>, Caught>);
}
struct WebReadProjection<T: HeapValue, U: HeapValue, F: FnOnce(Option<T>) -> U> {
    promise: JsPromise<U>,
    project: F,
    marker: std::marker::PhantomData<T>,
}
impl<T: HeapValue, U: HeapValue, F: FnOnce(Option<T>) -> U> Trace for WebReadProjection<T, U, F> {
    fn trace(&self, tracer: &mut Tracer<'_>) { tracer.edge(&self.promise); }
}
impl<T: HeapValue, U: HeapValue, F: FnOnce(Option<T>) -> U> WebReadRequest<T> for WebReadProjection<T, U, F> {
    fn settle(self: Box<Self>, result: Result<Option<T>, Caught>) {
        let Self { promise, project, .. } = *self;
        match result {
            Ok(value) => promise_run_segment(&promise, || {
                let _ = promise_fulfill(&promise, project(value));
            }),
            Err(error) => { let _ = promise_reject(&promise, error); }
        }
    }
}

pub type JsWebStream<T> = Gc<WebStreamData<T>>;
pub type JsWebReader<T> = Gc<WebReaderData<T>>;

impl<T: HeapValue> Trace for WebStreamData<T> {
    fn trace(&self, tracer: &mut Tracer<'_>) {
        for value in &self.queue { value.trace_value(tracer); }
        if let Some(reader) = &self.reader { tracer.edge(reader); }
        if let Some(source) = &self.source { source.trace(tracer); }
        if let Some(WebStreamFailure::Value(value)) = &self.error { value.trace_value(tracer); }
    }
}

impl<T: HeapValue> ClearEdges for WebStreamData<T> {
    fn clear_edges(&mut self) {
        self.queue.clear();
        self.reader = None;
        self.source = None;
        self.error = None;
    }
}

impl<T: HeapValue> Trace for WebReaderData<T> {
    fn trace(&self, tracer: &mut Tracer<'_>) {
        if let Some(stream) = &self.stream { tracer.edge(stream); }
        for request in &self.pending { request.trace(tracer); }
        if let Some(closed) = &self.closed_promise { tracer.edge(closed); }
    }
}

impl<T: HeapValue> ClearEdges for WebReaderData<T> {
    fn clear_edges(&mut self) { self.stream = None; self.pending.clear(); self.closed_promise = None; }
}

pub fn web_stream_new<T: HeapValue>(source: Rc<dyn WebStreamSource<T>>) -> JsWebStream<T> {
    web_stream_new_with_prefetch(source, true)
}

fn web_stream_new_with_prefetch<T: HeapValue>(
    source: Rc<dyn WebStreamSource<T>>, prefetch: bool,
) -> JsWebStream<T> {
    Gc::new(WebStreamData {
        queue: VecDeque::new(), reader: None, source: Some(source), started: false,
        pulling: false, prefetch, pull_again: false, close_requested: false, closed: false, error: None,
    })
}

fn web_stream_reader<T: HeapValue>(stream: &JsWebStream<T>) -> Option<JsWebReader<T>> {
    stream.with(|s| s.reader.clone())
}

pub fn web_stream_locked<T: HeapValue>(stream: &JsWebStream<T>) -> bool {
    web_stream_reader(stream).is_some()
}

pub fn web_stream_desired_size<T: HeapValue>(stream: &JsWebStream<T>) -> Option<f64> {
    stream.with(|s| if s.error.is_some() { None } else if s.closed { Some(0.0) }
        else { Some(f64::from(u8::from(s.prefetch)) - s.queue.len() as f64) })
}

pub fn web_stream_start<T: HeapValue>(stream: &JsWebStream<T>, start: &JsPromise<T>) {
    let stream = stream.clone();
    promise_then(start, Box::new(move |outcome| match outcome {
        Ok(_) => { stream.with_mut(|s| s.started = true); web_stream_pull(&stream); }
        Err(error) => web_stream_error(&stream, error),
    }));
}

fn web_stream_pull<T: HeapValue>(stream: &JsWebStream<T>) {
    let pending = web_stream_reader(stream).is_some_and(|r| r.with(|r| !r.pending.is_empty()));
    let source = stream.with_mut(|s| {
        if !s.started || s.close_requested || s.closed || s.error.is_some() ||
            (!pending && (!s.prefetch || !s.queue.is_empty())) { return None; }
        let source = s.source.as_ref()?.clone();
        if !source.has_pull() { return None; }
        if s.pulling { s.pull_again = true; return None; }
        s.pulling = true;
        Some(source)
    });
    let Some(source) = source else { return; };
    let promise = source.pull(stream);
    let stream = stream.clone();
    promise_then(&promise, Box::new(move |outcome| {
        let again = stream.with_mut(|s| {
            s.pulling = false;
            std::mem::take(&mut s.pull_again)
        });
        match outcome {
            Ok(_) => if again { web_stream_pull(&stream); },
            Err(error) => web_stream_error(&stream, error),
        }
    }));
}

fn web_stream_finish<T: HeapValue>(stream: &JsWebStream<T>) {
    stream.with_mut(|s| { s.closed = true; s.source = None; });
    if let Some(reader) = web_stream_reader(stream) {
        let _ = promise_fulfill(&web_reader_closed(&reader), ());
        let pending = reader.with_mut(|r| std::mem::take(&mut r.pending));
        for request in pending { request.settle(Ok(None)); }
    }
}

pub fn web_stream_close<T: HeapValue>(stream: &JsWebStream<T>) {
    let empty = stream.with_mut(|s| {
        if s.close_requested || s.closed || s.error.is_some() {
            throw_type_error("Invalid state: Controller is already closed".to_owned());
        }
        s.close_requested = true;
        s.queue.is_empty()
    });
    if empty { web_stream_finish(stream); }
}

pub fn web_stream_enqueue<T: HeapValue>(stream: &JsWebStream<T>, value: T) {
    stream.with(|s| {
        if s.close_requested || s.closed || s.error.is_some() {
            throw_type_error("Invalid state: Controller is already closed".to_owned());
        }
    });
    let pending = web_stream_reader(stream).and_then(|r| r.with_mut(|r| r.pending.pop_front()));
    if let Some(request) = pending { request.settle(Ok(Some(value))); }
    else { stream.with_mut(|s| s.queue.push_back(value)); }
    web_stream_pull(stream);
}

pub fn web_stream_error<T: HeapValue>(stream: &JsWebStream<T>, error: Caught) {
    let changed = stream.with_mut(|s| {
        if s.closed || s.error.is_some() { return false; }
        s.queue.clear(); s.source = None; s.error = Some(if caught_is::<T>(&error) { WebStreamFailure::Value(caught_narrow::<T>(&error)) }
            else { WebStreamFailure::Native(error.clone()) }); true
    });
    if changed && let Some(reader) = web_stream_reader(stream) {
        let _ = promise_reject(&web_reader_closed(&reader), error.clone());
        let pending = reader.with_mut(|r| std::mem::take(&mut r.pending));
        for request in pending { request.settle(Err(error.clone())); }
    }
}

pub fn web_stream_get_reader<T: HeapValue>(stream: &JsWebStream<T>) -> JsWebReader<T> {
    if web_stream_locked(stream) { throw_type_error("Invalid state: ReadableStream is locked".to_owned()); }
    let closed = promise_new();
    let _ = promise_poll(&closed); // Internal closed rejections are handled by the stream.
    if let Some(error) = stream.with(|s| s.error.as_ref().map(WebStreamFailure::caught)) { promise_reject(&closed, error); }
    else if stream.with(|s| s.closed) { promise_fulfill(&closed, ()); }
    let reader = Gc::new(WebReaderData { stream: Some(stream.clone()), pending: VecDeque::new(), closed_promise: Some(closed) });
    stream.with_mut(|s| s.reader = Some(reader.clone()));
    reader
}

fn web_reader_released() -> Caught {
    caught_value(error_new("TypeError", string("Invalid state: The reader is not attached to a stream")))
}

pub fn web_reader_read<T: HeapValue>(reader: &JsWebReader<T>) -> JsPromise<Option<T>> {
    web_reader_read_with(reader, |value| value)
}

pub fn web_reader_read_with<T: HeapValue, U: HeapValue>(
    reader: &JsWebReader<T>, project: fn(Option<T>) -> U,
) -> JsPromise<U> {
    let promise = promise_new();
    let request: Box<dyn WebReadRequest<T>> = Box::new(WebReadProjection {
        promise: promise.clone(), project, marker: std::marker::PhantomData,
    });
    let Some(stream) = reader.with(|r| r.stream.clone()) else {
        request.settle(Err(web_reader_released())); return promise;
    };
    if let Some(error) = stream.with(|s| s.error.as_ref().map(WebStreamFailure::caught)) {
        request.settle(Err(error)); return promise;
    }
    if stream.with(|s| s.closed) { request.settle(Ok(None)); return promise; }
    if let Some(value) = stream.with_mut(|s| s.queue.pop_front()) {
        if stream.with(|s| s.close_requested && s.queue.is_empty()) { web_stream_finish(&stream); }
        else { web_stream_pull(&stream); }
        request.settle(Ok(Some(value)));
    } else {
        reader.with_mut(|r| r.pending.push_back(request));
        web_stream_pull(&stream);
    }
    promise
}

fn web_stream_cancel_internal<T: HeapValue>(stream: &JsWebStream<T>, reason: T) -> JsPromise<()> {
    if let Some(error) = stream.with(|s| s.error.as_ref().map(WebStreamFailure::caught)) { return promise_rejected(error); }
    if stream.with(|s| s.closed) { return promise_resolved(()); }
    let source = stream.with_mut(|s| { s.queue.clear(); s.source.take() });
    web_stream_finish(stream);
    source.map_or_else(|| promise_resolved(()), |source| promise_map(&source.cancel(reason), |_| ()))
}

pub fn web_stream_cancel<T: HeapValue>(stream: &JsWebStream<T>, reason: T) -> JsPromise<()> {
    if web_stream_locked(stream) {
        return promise_rejected(caught_value(error_new("TypeError", string("Invalid state: ReadableStream is locked"))));
    }
    web_stream_cancel_internal(stream, reason)
}

pub fn web_reader_cancel<T: HeapValue>(reader: &JsWebReader<T>, reason: T) -> JsPromise<()> {
    let Some(stream) = reader.with(|r| r.stream.clone()) else { return promise_rejected(web_reader_released()); };
    web_stream_cancel_internal(&stream, reason)
}

pub fn web_reader_release<T: HeapValue>(reader: &JsWebReader<T>) {
    let (stream, pending) = reader.with_mut(|r| (r.stream.take(), std::mem::take(&mut r.pending)));
    if let Some(stream) = stream {
        if stream.with(|s| s.closed || s.error.is_some()) {
            let closed = promise_rejected(web_reader_released());
            let _ = promise_poll(&closed);
            reader.with_mut(|r| r.closed_promise = Some(closed));
        } else { let _ = promise_reject(&web_reader_closed(reader), web_reader_released()); }
        stream.with_mut(|s| s.reader = None);
    }
    for request in pending { request.settle(Err(web_reader_released())); }
}

pub fn web_reader_closed<T: HeapValue>(reader: &JsWebReader<T>) -> JsPromise<()> {
    reader.with(|r| r.closed_promise.as_ref().expect("scriptc: cleared reader").clone())
}
