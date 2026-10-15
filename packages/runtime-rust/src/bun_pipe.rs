// A child pipe owns one cached WHATWG stream. Its source delivers one captured
// chunk per pull; it never installs flowing Node listeners.
trait ChildWebCache: Trace {
    fn as_any(&self) -> &dyn Any;
}
struct ChildWebStream<T: HeapValue>(JsWebStream<T>);
impl<T: HeapValue> Trace for ChildWebStream<T> {
    fn trace(&self, tracer: &mut Tracer<'_>) { tracer.edge(&self.0); }
}
impl<T: HeapValue> ChildWebCache for ChildWebStream<T> {
    fn as_any(&self) -> &dyn Any { self }
}

trait ChildWebPull: Trace {
    fn settle(self: Box<Self>, value: Result<Option<JsBytes<u8>>, Caught>);
    fn cancel(self: Box<Self>);
}
struct ChildWebRequest<T: HeapValue> {
    stream: JsWebStream<T>,
    promise: JsPromise<T>,
    project: fn(JsBytes<u8>) -> T,
    empty: T,
}
impl<T: HeapValue> Trace for ChildWebRequest<T> {
    fn trace(&self, tracer: &mut Tracer<'_>) {
        tracer.edge(&self.stream); tracer.edge(&self.promise); self.empty.trace_value(tracer);
    }
}
impl<T: HeapValue> ChildWebPull for ChildWebRequest<T> {
    fn settle(self: Box<Self>, value: Result<Option<JsBytes<u8>>, Caught>) {
        match value {
            Ok(chunk) => promise_run_segment(&self.promise, || {
                match chunk {
                    Some(chunk) => web_stream_enqueue(&self.stream, (self.project)(chunk)),
                    None => web_stream_close(&self.stream),
                }
                promise_fulfill(&self.promise, self.empty.clone());
            }),
            Err(error) => { promise_reject(&self.promise, error); }
        }
    }
    fn cancel(self: Box<Self>) { promise_fulfill(&self.promise, self.empty); }
}

struct BunPipeSource<T: HeapValue> {
    pipe: JsChildStream,
    project: fn(JsBytes<u8>) -> T,
    empty: T,
}
impl<T: HeapValue> Trace for BunPipeSource<T> {
    fn trace(&self, tracer: &mut Tracer<'_>) { tracer.edge(&self.pipe); self.empty.trace_value(tracer); }
}
impl<T: HeapValue> WebStreamSource<T> for BunPipeSource<T> {
    fn has_pull(&self) -> bool { true }
    fn pull(&self, stream: &JsWebStream<T>) -> JsPromise<T> {
        if let Some(error) = self.pipe.with(|s| s.read_error.clone()) {
            return promise_rejected(caught_value(error_new("Error", string(&error))));
        }
        if self.pipe.with(|s| s.eof) {
            web_stream_close(stream);
            return promise_resolved(self.empty.clone());
        }
        let promise = promise_new();
        self.pipe.with_mut(|s| s.web_pull = Some(Box::new(ChildWebRequest {
            stream: stream.clone(), promise: promise.clone(), project: self.project, empty: self.empty.clone(),
        })));
        child_stream_start(&self.pipe);
        promise
    }
    fn cancel(&self, _: T) -> JsPromise<T> {
        let pending = self.pipe.with_mut(|s| {
            s.eof = true; s.reader = None; s.receiver = None; s.web_pull.take()
        });
        if let Some(pending) = pending { pending.cancel(); }
        child_stream_remove(&self.pipe);
        promise_resolved(self.empty.clone())
    }
}

pub fn bun_subprocess_output<T: HeapValue>(
    child: &JsChild, stderr: bool, project: fn(JsBytes<u8>) -> T, empty: T,
) -> Option<JsWebStream<T>> {
    let pipe = if stderr { child_stderr(child) } else { child_stdout(child) }?;
    if let Some(stream) = pipe.with(|s| s.web_cache.as_ref().map(|cache|
        cache.as_any().downcast_ref::<ChildWebStream<T>>().expect("scriptc: pipe projection changed").0.clone())) {
        return Some(stream);
    }
    let stream = web_stream_new_with_prefetch(Rc::new(BunPipeSource { pipe: pipe.clone(), project, empty: empty.clone() }), false);
    stream.with_mut(|s| s.bun_pipe = true);
    pipe.with_mut(|s| s.web_cache = Some(Box::new(ChildWebStream(stream.clone()))));
    web_stream_start(&stream, &promise_resolved(empty));
    Some(stream)
}
