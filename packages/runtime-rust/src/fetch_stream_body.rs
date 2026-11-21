// Constructed Responses can own a native Web stream independently of HTTP.
// Erase only its chunk projection, keeping the stream and all GC edges intact.
trait FetchStreamBody: Trace {
    fn as_any(&self) -> &dyn Any;
    fn used(&self) -> bool;
    fn consume(&self) -> JsPromise<JsBytes<u8>>;
}
struct FetchWebBody<T: HeapValue> {
    stream: JsWebStream<T>,
    bytes: fn(T) -> JsBytes<u8>,
}
impl<T: HeapValue> Trace for FetchWebBody<T> {
    fn trace(&self, tracer: &mut Tracer<'_>) { tracer.edge(&self.stream); }
}
impl<T: HeapValue> FetchStreamBody for FetchWebBody<T> {
    fn as_any(&self) -> &dyn Any { self }
    fn used(&self) -> bool { web_stream_disturbed(&self.stream) }
    fn consume(&self) -> JsPromise<JsBytes<u8>> {
        if self.used() || web_stream_locked(&self.stream) {
            return promise_rejected(caught_value(error_new("TypeError", string("Body already used"))));
        }
        let reader = web_stream_get_reader(&self.stream);
        let result = promise_new();
        fetch_stream_consume(reader, result.clone(), Rc::new(RefCell::new(Vec::new())), self.bytes);
        result
    }
}

// Adapt an HTTP response to the same ReadableStream representation used by
// constructed Responses.  The native fetch reader keeps the socket paused
// until a read is pending, so exposing Response.body does not eagerly buffer
// the response or defeat backpressure.
struct FetchHttpBodySource {
    request: JsHttpRequest,
    reader: RefCell<Option<JsFetchReader>>,
}

impl Trace for FetchHttpBodySource {
    fn trace(&self, tracer: &mut Tracer<'_>) {
        tracer.edge(&self.request);
        if let Some(reader) = self.reader.borrow().as_ref() { tracer.edge(reader); }
    }
}

impl FetchHttpBodySource {
    fn reader(&self) -> JsFetchReader {
        if let Some(reader) = self.reader.borrow().as_ref() { return reader.clone(); }
        let reader = fetch_body_get_reader(&self.request);
        *self.reader.borrow_mut() = Some(reader.clone());
        reader
    }
}

impl WebStreamSource<JsBytes<u8>> for FetchHttpBodySource {
    fn has_pull(&self) -> bool { true }

    fn pull(&self, stream: &JsWebStream<JsBytes<u8>>) -> JsPromise<JsBytes<u8>> {
        let result = promise_new();
        let next = fetch_reader_read(&self.reader());
        let output = result.clone();
        let stream = stream.clone();
        promise_then(&next, Box::new(move |outcome| match outcome {
            Ok(Some(chunk)) => promise_run_segment(&output.clone(), || {
                let open = stream.with(|data| {
                    !data.close_requested && !data.closed && data.error.is_none()
                });
                if open { web_stream_enqueue(&stream, chunk.clone()); }
                let _ = promise_fulfill(&output, chunk);
            }),
            Ok(None) => promise_run_segment(&output.clone(), || {
                let open = stream.with(|data| {
                    !data.close_requested && !data.closed && data.error.is_none()
                });
                if open { web_stream_close(&stream); }
                let _ = promise_fulfill(&output, bytes_empty::<u8>());
            }),
            Err(error) => { let _ = promise_reject(&output, error); }
        }));
        result
    }

    fn cancel(&self, _reason: JsBytes<u8>) -> JsPromise<JsBytes<u8>> {
        promise_map(&fetch_reader_cancel(&self.reader()), |_| bytes_empty::<u8>())
    }
}

pub fn fetch_response_body_stream(
    response: &JsHttpRequest,
) -> Option<JsWebStream<JsBytes<u8>>> {
    if fetch_body_is_null(response) { return None; }
    if let Some(stream) = fetch_response_web_body::<JsBytes<u8>>(response) {
        return Some(stream);
    }
    let stream = web_stream_new_with_prefetch(Rc::new(FetchHttpBodySource {
        request: response.clone(),
        reader: RefCell::new(None),
    }), false);
    let start = promise_resolved(bytes_empty::<u8>());
    web_stream_start(&stream, &start);
    response.with_mut(|data| {
        data.fetch_stream_body = Some(Rc::new(FetchWebBody {
            stream: stream.clone(),
            bytes: |bytes| bytes,
        }));
    });
    Some(stream)
}

fn fetch_stream_consume<T: HeapValue>(
    reader: JsWebReader<T>, result: JsPromise<JsBytes<u8>>,
    buffer: Rc<RefCell<Vec<u8>>>, bytes: fn(T) -> JsBytes<u8>,
) {
    let next = web_reader_read(&reader);
    promise_then(&next, Box::new(move |outcome| match outcome {
        Ok(Some(chunk)) => promise_run_segment(&result.clone(), || {
            buffer.borrow_mut().extend(bytes_u8_values(&(bytes)(chunk)));
            fetch_stream_consume(reader, result, buffer, bytes);
        }),
        Ok(None) => { promise_fulfill(&result, bytes_from_vec(std::mem::take(&mut *buffer.borrow_mut()))); }
        Err(error) => { promise_reject(&result, error); }
    }));
}

pub fn fetch_response_new_stream<T: HeapValue>(stream: &JsWebStream<T>, bytes: fn(T) -> JsBytes<u8>) -> JsHttpRequest {
    let bun = target_runtime_id() == "bun";
    if web_stream_disturbed(stream) || (web_stream_locked(stream) && (!bun || stream.with(|s| s.bun_pipe))) {
        if bun { throw_value(error_new("Error", string("ReadableStream has already been used"))); }
        throw_type_error("Response body object should not be disturbed or locked".to_owned());
    }
    let response = fetch_response_new_text(&empty_string());
    response.with_mut(|r| {
        r.finish_pending = false;
        r.fetch_stream_body = Some(Rc::new(FetchWebBody { stream: stream.clone(), bytes }));
    });
    response
}

pub fn fetch_response_web_body<T: HeapValue>(response: &JsHttpRequest) -> Option<JsWebStream<T>> {
    response.with(|r| r.fetch_stream_body.as_ref().and_then(|body|
        body.as_any().downcast_ref::<FetchWebBody<T>>().map(|body| body.stream.clone())))
}
