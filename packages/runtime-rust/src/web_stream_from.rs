// ReadableStream.from uses a zero high-water mark and the async-from-sync
// iterator protocol. Retain the iterable; obtain each item only on demand.
struct WebIndexedSource<S: HeapValue, T: HeapValue> {
    state: S,
    index: Cell<usize>,
    next: fn(&S, &Cell<usize>) -> Option<T>,
    resolve: fn(T) -> JsPromise<T>,
    empty: T,
}

impl<S: HeapValue, T: HeapValue> Trace for WebIndexedSource<S, T> {
    fn trace(&self, tracer: &mut Tracer<'_>) {
        self.state.trace_value(tracer);
        self.empty.trace_value(tracer);
    }
}

impl<S: HeapValue, T: HeapValue> WebStreamSource<T> for WebIndexedSource<S, T> {
    fn has_pull(&self) -> bool { true }

    fn pull(&self, stream: &JsWebStream<T>) -> JsPromise<T> {
        let result = promise_new();
        promise_run_segment(&result, || {
            // Resolve the iterator's value, then deliver its iterator-result
            // through the next Promise job, as AsyncFromSyncIterator does.
            let next = match (self.next)(&self.state, &self.index) {
                Some(value) => promise_map(&(self.resolve)(value), Some),
                None => promise_map(&promise_resolved(self.empty.clone()), |_| None),
            };
            // Node 24 implements the sync adapter with an async generator's
            // yield*. Its delegation adds a job before next() delivers the
            // iterator-result to ReadableStream's pull algorithm.
            let next = promise_map(&next, |value| value);
            let output = result.clone();
            let stream = stream.clone();
            let empty = self.empty.clone();
            promise_then(&next, Box::new(move |outcome| match outcome {
                Ok(value) => promise_run_segment(&output, || {
                    match value {
                        Some(value) => web_stream_enqueue(&stream, value),
                        None => web_stream_close(&stream),
                    }
                    promise_fulfill(&output, empty);
                }),
                Err(error) => { promise_reject(&output, error); },
            }));
        });
        // Node's async pullAlgorithm returns the reaction Promise. Keep its
        // settlement boundary before the controller services another read.
        promise_map(&result, |value| value)
    }

    fn cancel(&self, _: T) -> JsPromise<T> { promise_resolved(self.empty.clone()) }
}

pub fn web_stream_from_indexed<S: HeapValue, T: HeapValue>(
    state: S,
    next: fn(&S, &Cell<usize>) -> Option<T>,
    resolve: fn(T) -> JsPromise<T>,
    empty: T,
) -> JsWebStream<T> {
    let start = promise_resolved(empty.clone());
    let stream = web_stream_new_with_prefetch(Rc::new(WebIndexedSource {
        state, index: Cell::new(0), next, resolve, empty,
    }), false);
    web_stream_start(&stream, &start);
    stream
}
