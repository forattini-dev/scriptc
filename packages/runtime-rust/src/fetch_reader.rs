// Demand-driven Fetch response readers. Pending reads own their promises;
// the HTTP socket is paused when no read is waiting, preserving backpressure.
pub struct FetchReaderData {
    request: Option<JsHttpRequest>,
    pending: std::collections::VecDeque<JsPromise<Option<JsBytes<u8>>>>,
    closed: bool,
    failed: bool,
}

pub type JsFetchReader = Gc<FetchReaderData>;

impl Trace for FetchReaderData {
    fn trace(&self, tracer: &mut Tracer<'_>) {
        if let Some(request) = &self.request { tracer.edge(request); }
        for promise in &self.pending { tracer.edge(promise); }
    }
}

impl ClearEdges for FetchReaderData {
    fn clear_edges(&mut self) {
        self.request = None;
        self.pending.clear();
    }
}

pub fn fetch_body_locked(request: &JsHttpRequest) -> bool {
    request.with(|request| request.fetch_body_locked)
}

pub fn fetch_body_is_null(request: &JsHttpRequest) -> bool {
    request.with(|request| matches!(request.status_code, Some(204.0 | 205.0 | 304.0)))
}

fn fetch_reader_error(message: &str) -> Caught {
    caught_value(error_new("TypeError", string(message)))
}

fn fetch_reader_finish(reader: &JsFetchReader, failed: bool) {
    let pending = reader.with_mut(|reader| {
        if reader.closed { return std::collections::VecDeque::new(); }
        reader.closed = true;
        reader.failed = failed;
        std::mem::take(&mut reader.pending)
    });
    for promise in pending {
        if failed {
            let _ = promise_reject(&promise, fetch_reader_error("terminated"));
        } else {
            let _ = promise_fulfill(&promise, None);
        }
    }
}

pub fn fetch_body_get_reader(request: &JsHttpRequest) -> JsFetchReader {
    request.with_mut(|request| {
        if request.fetch_body_locked { throw_type_error("ReadableStream is locked".to_owned()); }
        request.fetch_body_locked = true;
    });
    http_request_pause(request);
    let reader = Gc::new(FetchReaderData {
        request: Some(request.clone()),
        pending: std::collections::VecDeque::new(),
        closed: request.with(|request| request.ended),
        failed: request.with(|request| request.aborted),
    });
    let ended = reader.clone();
    let trace = reader.clone();
    http_request_on_end(request, Rc::new(move || fetch_reader_finish(&ended, false)),
        Rc::new(move |tracer| tracer.edge(&trace)), true);
    let aborted = reader.clone();
    let trace = reader.clone();
    http_request_on_aborted(request, Rc::new(move || fetch_reader_finish(&aborted, true)),
        Rc::new(move |tracer| tracer.edge(&trace)), true);
    let data = reader.clone();
    let trace = reader.clone();
    http_request_on_data(request, Rc::new(move |chunk, _| {
        let (pending, pause) = data.with_mut(|reader| {
            (reader.pending.pop_front(), reader.pending.is_empty())
        });
        if pause && let Some(request) = data.with(|reader| reader.request.clone()) {
            http_request_pause(&request);
        }
        if let Some(promise) = pending { let _ = promise_fulfill(&promise, Some(chunk)); }
    }), Rc::new(move |tracer| tracer.edge(&trace)), false);
    reader
}

pub fn fetch_reader_read(reader: &JsFetchReader) -> JsPromise<Option<JsBytes<u8>>> {
    let Some(request) = reader.with(|reader| reader.request.clone()) else {
        return promise_rejected(fetch_reader_error("Reader has been released"));
    };
    request.with_mut(|request| request.fetch_body_used = true);
    if reader.with(|reader| reader.failed) {
        return promise_rejected(fetch_reader_error("terminated"));
    }
    if reader.with(|reader| reader.closed) { return promise_resolved(None); }
    let result = promise_new();
    reader.with_mut(|reader| reader.pending.push_back(result.clone()));
    http_request_resume(&request);
    result
}

pub fn fetch_reader_cancel(reader: &JsFetchReader) -> JsPromise<()> {
    let Some(request) = reader.with(|reader| reader.request.clone()) else {
        return promise_rejected(fetch_reader_error("Reader has been released"));
    };
    request.with_mut(|request| request.fetch_body_used = true);
    if reader.with(|reader| reader.failed) {
        return promise_rejected(fetch_reader_error("terminated"));
    }
    fetch_reader_finish(reader, false);
    request.with_mut(|request| {
        request.body.clear();
        request.ended = true;
        request.finish_pending = false;
        request.data_listeners.clear();
        request.end_listeners.clear();
        request.aborted_listeners.clear();
    });
    http_request_destroy(&request);
    promise_resolved(())
}

pub fn fetch_reader_release(reader: &JsFetchReader) {
    let request = reader.with_mut(|reader| reader.request.take());
    let Some(request) = request else { return; };
    let pending = reader.with_mut(|reader| std::mem::take(&mut reader.pending));
    for promise in pending {
        let _ = promise_reject(&promise, fetch_reader_error("Reader has been released"));
    }
    http_request_pause(&request);
    request.with_mut(|request| {
        request.fetch_body_locked = false;
        request.data_listeners.clear();
        request.end_listeners.clear();
        request.aborted_listeners.clear();
    });
}
