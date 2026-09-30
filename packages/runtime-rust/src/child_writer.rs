const CHILD_WRITER_HIGH_WATER_MARK: usize = 64 * 1024;

type ChildWriterTrace = Rc<dyn for<'a> Fn(&mut Tracer<'a>)>;

#[derive(Clone)]
struct ChildWriterVoidListener {
    invoke: Rc<dyn Fn()>,
    trace: ChildWriterTrace,
    once: bool,
}

#[derive(Clone)]
struct ChildWriterErrorListener {
    invoke: Rc<dyn Fn(JsError)>,
    trace: ChildWriterTrace,
}

enum ChildWriterCommand {
    Write(Vec<u8>),
    End,
    Destroy,
}

enum ChildWriterEvent {
    Wrote(usize),
    Finished,
    Error,
}

pub struct ChildWriterData {
    sender: Option<std::sync::mpsc::Sender<ChildWriterCommand>>,
    receiver: Option<std::sync::mpsc::Receiver<ChildWriterEvent>>,
    queued: usize,
    needs_drain: bool,
    writable: bool,
    finished: bool,
    drain_listeners: Vec<ChildWriterVoidListener>,
    finish_listeners: Vec<ChildWriterVoidListener>,
    error_listeners: Vec<ChildWriterErrorListener>,
}

impl Trace for ChildWriterData {
    fn trace(&self, tracer: &mut Tracer<'_>) {
        for listener in &self.drain_listeners {
            (listener.trace)(tracer);
        }
        for listener in &self.finish_listeners {
            (listener.trace)(tracer);
        }
        for listener in &self.error_listeners {
            (listener.trace)(tracer);
        }
    }
}

impl ClearEdges for ChildWriterData {
    fn clear_edges(&mut self) {
        if let Some(sender) = self.sender.take() {
            let _ = sender.send(ChildWriterCommand::Destroy);
        }
        self.receiver = None;
        self.queued = 0;
        self.needs_drain = false;
        self.writable = false;
        self.drain_listeners.clear();
        self.finish_listeners.clear();
        self.error_listeners.clear();
    }
}

pub type JsChildWriter = Gc<ChildWriterData>;

thread_local! {
    static ASYNC_CHILD_WRITERS: RefCell<Vec<JsChildWriter>> = const { RefCell::new(Vec::new()) };
}

fn child_writer_new(mut stdin: std::process::ChildStdin) -> JsChildWriter {
    use std::io::Write;

    let (command_sender, command_receiver) = std::sync::mpsc::channel();
    let (event_sender, event_receiver) = std::sync::mpsc::channel();
    let _ = std::thread::Builder::new()
        .name("scriptc-child-stdin".to_owned())
        .spawn(move || {
            while let Ok(command) = command_receiver.recv() {
                match command {
                    ChildWriterCommand::Write(data) => {
                        let length = data.len();
                        if stdin.write_all(&data).is_err() {
                            let _ = event_sender.send(ChildWriterEvent::Error);
                            return;
                        }
                        if event_sender.send(ChildWriterEvent::Wrote(length)).is_err() {
                            return;
                        }
                    }
                    ChildWriterCommand::End => {
                        drop(stdin);
                        let _ = event_sender.send(ChildWriterEvent::Finished);
                        return;
                    }
                    ChildWriterCommand::Destroy => return,
                }
            }
        });
    let writer = Gc::new(ChildWriterData {
        sender: Some(command_sender),
        receiver: Some(event_receiver),
        queued: 0,
        needs_drain: false,
        writable: true,
        finished: false,
        drain_listeners: Vec::new(),
        finish_listeners: Vec::new(),
        error_listeners: Vec::new(),
    });
    ASYNC_CHILD_WRITERS.with(|writers| writers.borrow_mut().push(writer.clone()));
    writer
}

/// The stdin handle of a child whose SPAWN failed. Node hands back a live
/// ChildProcess with a writable stdin and reports the failure on a later
/// turn, so the husk starts WRITABLE: a read before the error lands must
/// answer `true`, exactly like Node's. `children_dispatch_one` destroys it
/// just before it delivers the error, so a read from inside the `error`
/// listener answers `false`.
fn child_writer_husk() -> JsChildWriter {
    Gc::new(ChildWriterData {
        sender: None,
        receiver: None,
        queued: 0,
        needs_drain: false,
        writable: true,
        finished: false,
        drain_listeners: Vec::new(),
        finish_listeners: Vec::new(),
        error_listeners: Vec::new(),
    })
}

fn child_writer_error(message: &str, code: &str) -> JsError {
    JsError {
        identity: Rc::new(()),
        name: "Error".to_owned(),
        message: message.to_owned(),
        code: Some(code.to_owned()),
        cause: None,
        dom: None,
    }
}

fn child_writer_fail(writer: &JsChildWriter, error: JsError) {
    let listeners = writer.with_mut(|writer| {
        writer.sender = None;
        writer.receiver = None;
        writer.queued = 0;
        writer.needs_drain = false;
        writer.writable = false;
        writer.drain_listeners.clear();
        writer.finish_listeners.clear();
        std::mem::take(&mut writer.error_listeners)
    });
    child_writer_remove(writer);
    process_next_tick(Box::new(move || {
        if listeners.is_empty() {
            throw_value(error);
        }
        for listener in listeners {
            (listener.invoke)(error.clone());
        }
    }));
}

fn child_writer_write(writer: &JsChildWriter, data: Vec<u8>) -> bool {
    let result = writer.with_mut(|writer| {
        if !writer.writable {
            return Err(Box::new(child_writer_error(
                "write after end",
                "ERR_STREAM_WRITE_AFTER_END",
            )));
        }
        let Some(sender) = &writer.sender else {
            return Err(Box::new(child_writer_error("write EPIPE", "EPIPE")));
        };
        let length = data.len();
        if sender.send(ChildWriterCommand::Write(data)).is_err() {
            return Err(Box::new(child_writer_error("write EPIPE", "EPIPE")));
        }
        writer.queued = writer.queued.saturating_add(length);
        let ready = writer.queued < CHILD_WRITER_HIGH_WATER_MARK;
        writer.needs_drain |= !ready;
        Ok(ready)
    });
    match result {
        Ok(ready) => ready,
        Err(error) => {
            child_writer_fail(writer, *error);
            false
        }
    }
}

/// The island hosts' `childStdinWrite(id, bytes)`: false once the child's stdin is gone.
pub fn child_stdin_write(child: &JsChild, data: &JsBytes<u8>) -> bool {
    child_stdin(child).is_some_and(|writer| child_writer_write_bytes(&writer, data))
}

/// The island hosts' `childStdinEnd(id)`.
pub fn child_stdin_end(child: &JsChild) {
    if let Some(writer) = child_stdin(child) {
        child_writer_end(&writer);
    }
}

pub fn child_writer_write_string(writer: &JsChildWriter, data: &JsString) -> bool {
    child_writer_write(writer, data.as_bytes().to_vec())
}

pub fn child_writer_write_bytes(writer: &JsChildWriter, data: &JsBytes<u8>) -> bool {
    child_writer_write(writer, bytes_u8_values(data))
}

pub fn child_writer_end(writer: &JsChildWriter) {
    let error = writer.with_mut(|writer| {
        if !writer.writable {
            return None;
        }
        writer.writable = false;
        match writer.sender.as_ref() {
            Some(sender) if sender.send(ChildWriterCommand::End).is_ok() => None,
            _ => Some(child_writer_error("write EPIPE", "EPIPE")),
        }
    });
    if let Some(error) = error {
        child_writer_fail(writer, error);
    }
}

pub fn child_writer_destroy(writer: &JsChildWriter) {
    writer.with_mut(ClearEdges::clear_edges);
    child_writer_remove(writer);
}

pub fn child_writer_writable(writer: &JsChildWriter) -> bool {
    writer.with(|writer| writer.writable)
}

pub fn child_writer_on_drain(
    writer: &JsChildWriter,
    callback: Rc<dyn Fn()>,
    trace: ChildWriterTrace,
    once: bool,
) {
    writer.with_mut(|writer| {
        if writer.writable {
            writer.drain_listeners.push(ChildWriterVoidListener {
                invoke: callback,
                trace,
                once,
            });
        }
    });
}

pub fn child_writer_on_finish(
    writer: &JsChildWriter,
    callback: Rc<dyn Fn()>,
    trace: ChildWriterTrace,
    _once: bool,
) {
    writer.with_mut(|writer| {
        if !writer.finished {
            writer.finish_listeners.push(ChildWriterVoidListener {
                invoke: callback,
                trace,
                once: true,
            });
        }
    });
}

pub fn child_writer_on_error(
    writer: &JsChildWriter,
    callback: Rc<dyn Fn(JsError)>,
    trace: ChildWriterTrace,
    _once: bool,
) {
    writer.with_mut(|writer| {
        writer.error_listeners.push(ChildWriterErrorListener {
            invoke: callback,
            trace,
        });
    });
}

fn child_writer_poll(writer: &JsChildWriter) -> Option<ChildWriterEvent> {
    writer.with(|writer| {
        let receiver = writer.receiver.as_ref()?;
        match receiver.try_recv() {
            Ok(event) => Some(event),
            Err(std::sync::mpsc::TryRecvError::Empty) => None,
            Err(std::sync::mpsc::TryRecvError::Disconnected) => Some(ChildWriterEvent::Error),
        }
    })
}

fn child_writer_remove(writer: &JsChildWriter) {
    ASYNC_CHILD_WRITERS.with(|writers| {
        writers
            .borrow_mut()
            .retain(|candidate| !candidate.ptr_eq(writer));
    });
}

fn child_writers_dispatch_one() -> bool {
    let ready = ASYNC_CHILD_WRITERS.with(|writers| {
        writers
            .borrow()
            .iter()
            .rev()
            .find_map(|writer| child_writer_poll(writer).map(|event| (writer.clone(), event)))
    });
    let Some((writer, event)) = ready else {
        return false;
    };
    match event {
        ChildWriterEvent::Wrote(length) => {
            let listeners = writer.with_mut(|writer| {
                writer.queued = writer.queued.saturating_sub(length);
                if !writer.needs_drain || writer.queued >= CHILD_WRITER_HIGH_WATER_MARK {
                    return Vec::new();
                }
                writer.needs_drain = false;
                let snapshot = writer.drain_listeners.clone();
                writer.drain_listeners.retain(|listener| !listener.once);
                snapshot
            });
            for listener in listeners {
                (listener.invoke)();
            }
        }
        ChildWriterEvent::Finished => {
            let listeners = writer.with_mut(|writer| {
                writer.sender = None;
                writer.receiver = None;
                writer.queued = 0;
                writer.needs_drain = false;
                writer.finished = true;
                writer.drain_listeners.clear();
                // The error listeners SURVIVE finish. A `write` performed
                // from inside the finish listener is Node's
                // ERR_STREAM_WRITE_AFTER_END, reported on the stream's
                // error event — clearing them here left
                // `child_writer_fail` with nobody to call, so it threw the
                // error uncaught and killed the program mid-output.
                std::mem::take(&mut writer.finish_listeners)
            });
            child_writer_remove(&writer);
            for listener in listeners {
                (listener.invoke)();
            }
        }
        ChildWriterEvent::Error => {
            child_writer_fail(&writer, child_writer_error("write EPIPE", "EPIPE"));
        }
    }
    true
}

fn child_writers_pending() -> bool {
    ASYNC_CHILD_WRITERS.with(|writers| !writers.borrow().is_empty())
}

fn child_writers_finish() {
    let writers = ASYNC_CHILD_WRITERS.with(|writers| std::mem::take(&mut *writers.borrow_mut()));
    for writer in writers {
        writer.with_mut(ClearEdges::clear_edges);
    }
}
