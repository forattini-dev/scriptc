type ChildStreamTrace = Rc<dyn for<'a> Fn(&mut Tracer<'a>)>;

#[derive(Clone)]
struct ChildStreamDataListener {
    invoke: Rc<dyn Fn(JsBytes<u8>)>,
    trace: ChildStreamTrace,
    once: bool,
}

#[derive(Clone)]
struct ChildStreamEndListener {
    invoke: Rc<dyn Fn()>,
    trace: ChildStreamTrace,
}

enum ChildPipeReader {
    Stdout(std::process::ChildStdout),
    Stderr(std::process::ChildStderr),
}

impl std::io::Read for ChildPipeReader {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        match self {
            Self::Stdout(reader) => std::io::Read::read(reader, buffer),
            Self::Stderr(reader) => std::io::Read::read(reader, buffer),
        }
    }
}

enum ChildPipeEvent {
    Data(Vec<u8>),
    End,
    Error(String),
}

pub struct ChildStreamData {
    reader: Option<ChildPipeReader>,
    receiver: Option<std::sync::mpsc::Receiver<ChildPipeEvent>>,
    eof: bool,
    terminal_pending: bool,
    data_listeners: Vec<ChildStreamDataListener>,
    end_listeners: Vec<ChildStreamEndListener>,
    web_cache: Option<Box<dyn ChildWebCache>>,
    web_pull: Option<Box<dyn ChildWebPull>>,
    bun_buffered: bool,
    read_error: Option<String>,
}

impl Trace for ChildStreamData {
    fn trace(&self, tracer: &mut Tracer<'_>) {
        if let Some(cache) = &self.web_cache { cache.trace(tracer); }
        if let Some(pull) = &self.web_pull { pull.trace(tracer); }
        for listener in &self.data_listeners {
            (listener.trace)(tracer);
        }
        for listener in &self.end_listeners {
            (listener.trace)(tracer);
        }
    }
}

impl ClearEdges for ChildStreamData {
    fn clear_edges(&mut self) {
        self.reader = None;
        self.receiver = None;
        self.eof = true;
        self.terminal_pending = false;
        self.data_listeners.clear();
        self.end_listeners.clear();
        self.web_cache = None;
        self.web_pull = None;
        self.read_error = None;
    }
}

pub type JsChildStream = Gc<ChildStreamData>;

thread_local! {
    static ASYNC_CHILD_STREAMS: RefCell<Vec<JsChildStream>> = const { RefCell::new(Vec::new()) };
}

fn child_stream_new(reader: ChildPipeReader) -> JsChildStream {
    let stream = Gc::new(ChildStreamData {
        reader: Some(reader),
        receiver: None,
        eof: false,
        terminal_pending: false,
        data_listeners: Vec::new(),
        end_listeners: Vec::new(),
        web_cache: None,
        web_pull: None,
        bun_buffered: false,
        read_error: None,
    });
    ASYNC_CHILD_STREAMS.with(|streams| streams.borrow_mut().push(stream.clone()));
    stream
}

fn child_stream_husk() -> JsChildStream {
    Gc::new(ChildStreamData {
        reader: None,
        receiver: None,
        eof: false,
        terminal_pending: false,
        data_listeners: Vec::new(),
        end_listeners: Vec::new(),
        web_cache: None,
        web_pull: None,
        bun_buffered: false,
        read_error: None,
    })
}

fn child_stream_start(stream: &JsChildStream) {
    let reader = stream.with_mut(|stream| stream.reader.take());
    let Some(mut reader) = reader else {
        return;
    };
    let (send, receiver): (Box<dyn Fn(ChildPipeEvent) -> bool + Send>, _) =
        if stream.with(|s| s.bun_buffered) {
            // Bun eagerly captures output even before .stdout is read, so
            // awaiting exited before consuming a large pipe cannot deadlock.
            let (sender, receiver) = std::sync::mpsc::channel();
            (Box::new(move |event| sender.send(event).is_ok()), receiver)
        } else {
            let (sender, receiver) = std::sync::mpsc::sync_channel(1);
            (Box::new(move |event| sender.send(event).is_ok()), receiver)
        };
    stream.with_mut(|stream| stream.receiver = Some(receiver));
    // Node listeners retain their bounded one-chunk backpressure boundary.
    let worker = std::thread::Builder::new()
        .name("scriptc-child-pipe".to_owned())
        .spawn(move || {
            loop {
                let mut buffer = vec![0_u8; 65_536];
                match std::io::Read::read(&mut reader, &mut buffer) {
                    Ok(0) => {
                        send(ChildPipeEvent::End);
                        break;
                    }
                    Ok(length) => {
                        buffer.truncate(length);
                        if !send(ChildPipeEvent::Data(buffer)) {
                            break;
                        }
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(error) => {
                        send(ChildPipeEvent::Error(error.to_string()));
                        break;
                    }
                }
            }
        });
    if let Err(error) = worker {
        if let Some(pull) = stream.with_mut(|s| s.web_pull.take()) {
            pull.settle(Err(caught_value(error_new("Error", string(&error.to_string())))));
        }
        stream.with_mut(|s| s.read_error = Some(error.to_string()));
        if stream.with(|s| s.bun_buffered) {
            stream.with_mut(|s| { s.eof = true; s.receiver = None; });
            child_stream_remove(stream);
        }
    }
}

pub fn child_stream_on_data(
    stream: &JsChildStream,
    callback: Rc<dyn Fn(JsBytes<u8>)>,
    trace: ChildStreamTrace,
    once: bool,
) {
    let should_start = stream.with_mut(|stream| {
        if stream.eof {
            return false;
        }
        stream.data_listeners.push(ChildStreamDataListener {
            invoke: callback,
            trace,
            once,
        });
        stream.receiver.is_none() && stream.reader.is_some()
    });
    if should_start {
        child_stream_start(stream);
    }
}

pub fn child_stream_on_end(
    stream: &JsChildStream,
    callback: Rc<dyn Fn()>,
    trace: ChildStreamTrace,
) {
    stream.with_mut(|stream| {
        if !stream.eof {
            stream.end_listeners.push(ChildStreamEndListener {
                invoke: callback,
                trace,
            });
        }
    });
}

fn child_stream_poll(stream: &JsChildStream) -> Option<ChildPipeEvent> {
    stream.with(|stream| {
        if stream.eof {
            return None;
        }
        if stream.terminal_pending {
            return Some(ChildPipeEvent::End);
        }
        if stream.data_listeners.is_empty() && stream.web_pull.is_none() {
            return None;
        }
        let receiver = stream.receiver.as_ref()?;
        match receiver.try_recv() {
            Ok(event) => Some(event),
            Err(std::sync::mpsc::TryRecvError::Empty) => None,
            Err(std::sync::mpsc::TryRecvError::Disconnected) => Some(ChildPipeEvent::End),
        }
    })
}

fn child_stream_wait(
    stream: &JsChildStream,
    timeout: std::time::Duration,
) -> Option<ChildPipeEvent> {
    stream.with(|stream| {
        if stream.eof || (stream.data_listeners.is_empty() && stream.web_pull.is_none()) {
            return None;
        }
        let receiver = stream.receiver.as_ref()?;
        match receiver.recv_timeout(timeout) {
            Ok(event) => Some(event),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => None,
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => Some(ChildPipeEvent::End),
        }
    })
}

fn child_stream_dispatch(stream: &JsChildStream, event: ChildPipeEvent) -> bool {
    match event {
        ChildPipeEvent::Data(bytes) => {
            if let Some(pull) = stream.with_mut(|s| s.web_pull.take()) {
                pull.settle(Ok(Some(bytes_from_vec(bytes))));
                return false;
            }
            let listeners = stream.with_mut(|stream| {
                let snapshot = stream.data_listeners.clone();
                stream.data_listeners.retain(|listener| !listener.once);
                snapshot
            });
            let chunk = bytes_from_vec(bytes);
            for listener in listeners {
                (listener.invoke)(chunk.clone());
            }
            false
        }
        ChildPipeEvent::End => {
            if let Some(pull) = stream.with_mut(|s| s.web_pull.take()) { pull.settle(Ok(None)); }
            let listeners = stream.with_mut(|stream| {
                stream.eof = true;
                stream.terminal_pending = false;
                stream.reader = None;
                stream.receiver = None;
                stream.data_listeners.clear();
                std::mem::take(&mut stream.end_listeners)
            });
            for listener in listeners {
                (listener.invoke)();
            }
            true
        }
        ChildPipeEvent::Error(message) => {
            stream.with_mut(|s| s.read_error = Some(message.clone()));
            if let Some(pull) = stream.with_mut(|s| s.web_pull.take()) {
                pull.settle(Err(caught_value(error_new("Error", string(&message)))));
            }
            child_stream_dispatch(stream, ChildPipeEvent::End)
        }
    }
}

fn child_stream_remove(stream: &JsChildStream) {
    ASYNC_CHILD_STREAMS.with(|streams| {
        streams.borrow_mut().retain(|candidate| !candidate.ptr_eq(stream));
    });
}

fn child_streams_dispatch_one() -> bool {
    let ready = ASYNC_CHILD_STREAMS.with(|streams| {
        streams
            .borrow()
            .iter()
            .rev()
            .find_map(|stream| child_stream_poll(stream).map(|event| (stream.clone(), event)))
    });
    let Some((stream, event)) = ready else {
        return false;
    };
    if child_stream_dispatch(&stream, event) {
        child_stream_remove(&stream);
    }
    true
}

fn child_stream_drain_after_exit(stream: &JsChildStream) {
    // A direct nonblocking fd drain would require unsafe platform calls.
    // Give the safe reader worker one short, bounded scheduling window so
    // ordinary EOF precedes `exit`; inherited grandchild fds cannot stall us.
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(10);
    for _ in 0..256 {
        let event = child_stream_poll(stream).or_else(|| {
            deadline
                .checked_duration_since(std::time::Instant::now())
                .and_then(|remaining| child_stream_wait(stream, remaining))
        });
        let Some(event) = event else {
            break;
        };
        if child_stream_dispatch(stream, event) {
            child_stream_remove(stream);
            break;
        }
    }
}

fn child_stream_fail(stream: &JsChildStream) {
    let register = stream.with_mut(|stream| {
        if stream.eof || stream.terminal_pending {
            return false;
        }
        stream.terminal_pending = true;
        true
    });
    if register {
        ASYNC_CHILD_STREAMS.with(|streams| streams.borrow_mut().push(stream.clone()));
    }
}

fn child_streams_pending() -> bool {
    ASYNC_CHILD_STREAMS.with(|streams| {
        streams.borrow().iter().any(|stream| {
            stream.with(|stream| {
                !stream.eof && (stream.terminal_pending || !stream.data_listeners.is_empty() || stream.web_pull.is_some())
            })
        })
    })
}

fn child_streams_finish() {
    let streams = ASYNC_CHILD_STREAMS.with(|streams| std::mem::take(&mut *streams.borrow_mut()));
    for stream in streams {
        stream.with_mut(ClearEdges::clear_edges);
    }
}
