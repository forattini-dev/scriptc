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
