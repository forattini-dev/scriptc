const FORK_TARGET_ENV: &str = "SCRIPTC_FORK_TARGET";
const FORK_IPC_ENV: &str = "SCRIPTC_FORK_IPC";

type ChildIpcTrace = Rc<dyn for<'a> Fn(&mut Tracer<'a>)>;
type ChildIpcCallback = Rc<dyn Fn(Option<JsError>)>;
type ChildIpcCallbackRegistration = (ChildIpcCallback, ChildIpcTrace);

#[derive(Clone)]
struct ChildIpcMessageListener {
    invoke: Rc<dyn Fn(JsString)>,
    trace: ChildIpcTrace,
    once: bool,
}

#[derive(Clone)]
struct ChildIpcDisconnectListener {
    invoke: Rc<dyn Fn()>,
    trace: ChildIpcTrace,
}

struct ChildIpcSendCallback {
    invoke: Rc<dyn Fn(Option<JsError>)>,
    trace: ChildIpcTrace,
}

enum ChildIpcCommand {
    Send(u64, Vec<u8>),
    Disconnect,
}

enum ChildIpcEvent {
    Sent(u64, bool),
    Message(Vec<u8>),
    Disconnected,
}

pub struct ChildIpcData {
    sender: Option<std::sync::mpsc::Sender<ChildIpcCommand>>,
    receiver: Option<std::sync::mpsc::Receiver<ChildIpcEvent>>,
    /// The PUBLIC `connected` flag. Node clears it synchronously inside
    /// disconnect(), so a read or a send that follows must already see the
    /// channel as gone.
    connected: bool,
    /// Whether the channel is still DRAINING. It outlives `connected`: the
    /// worker thread may still hand over framed messages after a local
    /// disconnect, and the child exit event stays deferred until this
    /// clears, so an EOF cannot drop a message that was already framed.
    open: bool,
    next_send_id: u64,
    send_callbacks: HashMap<u64, ChildIpcSendCallback>,
    message_listeners: Vec<ChildIpcMessageListener>,
    disconnect_listeners: Vec<ChildIpcDisconnectListener>,
}

impl Trace for ChildIpcData {
    fn trace(&self, tracer: &mut Tracer<'_>) {
        for callback in self.send_callbacks.values() {
            (callback.trace)(tracer);
        }
        for listener in &self.message_listeners {
            (listener.trace)(tracer);
        }
        for listener in &self.disconnect_listeners {
            (listener.trace)(tracer);
        }
    }
}

impl ClearEdges for ChildIpcData {
    fn clear_edges(&mut self) {
        if let Some(sender) = self.sender.take() {
            let _ = sender.send(ChildIpcCommand::Disconnect);
        }
        self.receiver = None;
        self.connected = false;
        self.open = false;
        self.send_callbacks.clear();
        self.message_listeners.clear();
        self.disconnect_listeners.clear();
    }
}

pub type JsChildIpc = Gc<ChildIpcData>;

thread_local! {
    static CHILD_IPC_CHANNELS: RefCell<Vec<JsChildIpc>> = const { RefCell::new(Vec::new()) };
    static PROCESS_IPC_CHANNEL: RefCell<Option<JsChildIpc>> = const { RefCell::new(None) };
}

enum ChildIpcEndpoint {
    Listener(std::net::TcpListener),
    Stream(std::net::TcpStream),
}

fn child_ipc_error() -> JsError {
    JsError {
        identity: Rc::new(()),
        name: "Error".to_owned(),
        message: "Channel closed".to_owned(),
        code: Some("ERR_IPC_CHANNEL_CLOSED".to_owned()),
        cause: None,
        dom: None,
    }
}

fn child_ipc_frame(payload: &[u8]) -> Vec<u8> {
    let length = u32::try_from(payload.len())
        .unwrap_or_else(|_| throw_range_error("IPC message is too large".to_owned()));
    let mut frame = Vec::with_capacity(4 + payload.len());
    frame.extend_from_slice(&length.to_be_bytes());
    frame.extend_from_slice(payload);
    frame
}

fn child_ipc_worker(
    endpoint: ChildIpcEndpoint,
    commands: std::sync::mpsc::Receiver<ChildIpcCommand>,
    events: std::sync::mpsc::Sender<ChildIpcEvent>,
) {
    use std::io::{Read, Write};

    let mut pending_commands = VecDeque::new();
    let mut stream = match endpoint {
        ChildIpcEndpoint::Stream(stream) => stream,
        ChildIpcEndpoint::Listener(listener) => loop {
            match listener.accept() {
                Ok((stream, _)) => break stream,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    match commands.try_recv() {
                        Ok(ChildIpcCommand::Send(id, payload)) => {
                            pending_commands.push_back(ChildIpcCommand::Send(id, payload))
                        }
                        Ok(ChildIpcCommand::Disconnect)
                        | Err(std::sync::mpsc::TryRecvError::Disconnected) => {
                            let _ = events.send(ChildIpcEvent::Disconnected);
                            return;
                        }
                        Err(std::sync::mpsc::TryRecvError::Empty) => {}
                    }
                    std::thread::sleep(std::time::Duration::from_millis(1));
                }
                Err(_) => {
                    let _ = events.send(ChildIpcEvent::Disconnected);
                    return;
                }
            }
        },
    };
    if stream.set_nonblocking(true).is_err() {
        let _ = events.send(ChildIpcEvent::Disconnected);
        return;
    }
    let mut incoming = Vec::new();
    loop {
        loop {
            let command = pending_commands
                .pop_front()
                .map_or_else(|| commands.try_recv(), Ok);
            match command {
                Ok(ChildIpcCommand::Send(id, payload)) => {
                    let sent = stream.write_all(&child_ipc_frame(&payload)).is_ok();
                    let _ = events.send(ChildIpcEvent::Sent(id, sent));
                    if !sent {
                        let _ = events.send(ChildIpcEvent::Disconnected);
                        return;
                    }
                }
                Ok(ChildIpcCommand::Disconnect) => {
                    let _ = stream.shutdown(std::net::Shutdown::Both);
                    let _ = events.send(ChildIpcEvent::Disconnected);
                    return;
                }
                Err(std::sync::mpsc::TryRecvError::Empty) => break,
                Err(std::sync::mpsc::TryRecvError::Disconnected) => return,
            }
        }

        let mut chunk = [0_u8; 8192];
        match stream.read(&mut chunk) {
            Ok(0) => {
                let _ = events.send(ChildIpcEvent::Disconnected);
                return;
            }
            Ok(length) => {
                incoming.extend_from_slice(&chunk[..length]);
                loop {
                    if incoming.len() < 4 {
                        break;
                    }
                    let length =
                        u32::from_be_bytes(incoming[..4].try_into().expect("four-byte IPC header"))
                            as usize;
                    if incoming.len() < 4 + length {
                        break;
                    }
                    let payload = incoming[4..4 + length].to_vec();
                    incoming.drain(..4 + length);
                    if events.send(ChildIpcEvent::Message(payload)).is_err() {
                        return;
                    }
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {}
            Err(_) => {
                let _ = events.send(ChildIpcEvent::Disconnected);
                return;
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(1));
    }
}

fn child_ipc_new(endpoint: ChildIpcEndpoint) -> JsChildIpc {
    let (command_sender, command_receiver) = std::sync::mpsc::channel();
    let (event_sender, event_receiver) = std::sync::mpsc::channel();
    let _ = std::thread::Builder::new()
        .name("scriptc-child-ipc".to_owned())
        .spawn(move || child_ipc_worker(endpoint, command_receiver, event_sender));
    let channel = Gc::new(ChildIpcData {
        sender: Some(command_sender),
        receiver: Some(event_receiver),
        connected: true,
        open: true,
        next_send_id: 1,
        send_callbacks: HashMap::new(),
        message_listeners: Vec::new(),
        disconnect_listeners: Vec::new(),
    });
    CHILD_IPC_CHANNELS.with(|channels| channels.borrow_mut().push(channel.clone()));
    channel
}

pub fn child_ipc_connected(channel: &JsChildIpc) -> bool {
    channel.with(|channel| channel.connected)
}

/// Whether the channel still has to be drained — the liveness question, as
/// opposed to the public `connected` answer.
pub fn child_ipc_open(channel: &JsChildIpc) -> bool {
    channel.with(|channel| channel.open)
}

fn child_ipc_send_inner(
    channel: &JsChildIpc,
    message: &JsString,
    callback: Option<ChildIpcCallbackRegistration>,
) -> bool {
    channel.with_mut(|channel| {
        if !channel.connected {
            if let Some((invoke, _)) = callback {
                process_next_tick(Box::new(move || invoke(Some(child_ipc_error()))));
            }
            return false;
        }
        let id = channel.next_send_id;
        channel.next_send_id = channel
            .next_send_id
            .checked_add(1)
            .expect("scriptc: exhausted IPC send ids");
        if let Some((invoke, trace)) = callback {
            channel
                .send_callbacks
                .insert(id, ChildIpcSendCallback { invoke, trace });
        }
        let sent = channel.sender.as_ref().is_some_and(|sender| {
            sender
                .send(ChildIpcCommand::Send(id, message.as_bytes().to_vec()))
                .is_ok()
        });
        if !sent {
            channel.connected = false;
        }
        sent
    })
}

fn child_ipc_disconnect_inner(channel: &JsChildIpc) {
    channel.with_mut(|channel| {
        if !channel.connected {
            return;
        }
        // Node closes the channel INSIDE disconnect(): `connected` reads false
        // and a following send is refused on the spot. `open` stays set, so
        // the loop still drains whatever the worker thread already framed and
        // still defers the child exit event until it finishes.
        channel.connected = false;
        if let Some(sender) = &channel.sender {
            let _ = sender.send(ChildIpcCommand::Disconnect);
        }
        // Node emits `disconnect` on the tick after a LOCAL disconnect(),
        // not after a round trip to the channel thread. Taking the listeners
        // here and queueing them keeps that order: anything the caller does
        // after disconnect() — a refused send, whose callback also settles on
        // a later tick — is queued behind this. The Disconnected event still
        // arrives later and still fails the pending send callbacks, but finds
        // no disconnect listener left to call, so they fire exactly once.
        let listeners = std::mem::take(&mut channel.disconnect_listeners);
        if !listeners.is_empty() {
            process_next_tick(Box::new(move || {
                for listener in listeners {
                    (listener.invoke)();
                }
            }));
        }
    });
}

fn child_ipc_on_message_inner(
    channel: &JsChildIpc,
    callback: Rc<dyn Fn(JsString)>,
    trace: ChildIpcTrace,
    once: bool,
) {
    channel.with_mut(|channel| {
        channel.message_listeners.push(ChildIpcMessageListener {
            invoke: callback,
            trace,
            once,
        })
    });
}

fn child_ipc_on_disconnect_inner(
    channel: &JsChildIpc,
    callback: Rc<dyn Fn()>,
    trace: ChildIpcTrace,
    _once: bool,
) {
    channel.with_mut(|channel| {
        channel
            .disconnect_listeners
            .push(ChildIpcDisconnectListener {
                invoke: callback,
                trace,
            })
    });
}

fn child_ipc_dispatch(channel: &JsChildIpc, event: ChildIpcEvent) {
    match event {
        ChildIpcEvent::Sent(id, success) => {
            if let Some(callback) = channel.with_mut(|channel| channel.send_callbacks.remove(&id)) {
                (callback.invoke)((!success).then(child_ipc_error));
            }
        }
        ChildIpcEvent::Message(payload) => {
            let message = JsString::from(String::from_utf8_lossy(&payload).as_ref());
            let listeners = channel.with_mut(|channel| {
                let listeners = channel.message_listeners.clone();
                channel.message_listeners.retain(|listener| !listener.once);
                listeners
            });
            for listener in listeners {
                (listener.invoke)(message.clone());
            }
        }
        ChildIpcEvent::Disconnected => {
            let (callbacks, listeners) = channel.with_mut(|channel| {
                // Guarded on `open`, not `connected`: a local disconnect() has
                // already cleared `connected`, and the disconnect listeners must
                // still fire exactly once when the channel actually ends.
                if !channel.open {
                    return (Vec::new(), Vec::new());
                }
                channel.connected = false;
                channel.open = false;
                channel.sender = None;
                let callbacks = std::mem::take(&mut channel.send_callbacks)
                    .into_values()
                    .collect();
                let listeners = std::mem::take(&mut channel.disconnect_listeners);
                (callbacks, listeners)
            });
            for callback in callbacks {
                (callback.invoke)(Some(child_ipc_error()));
            }
            for listener in listeners {
                (listener.invoke)();
            }
        }
    }
}

fn child_ipc_dispatch_one() -> bool {
    let ready = CHILD_IPC_CHANNELS.with(|channels| {
        channels.borrow().iter().find_map(|channel| {
            channel
                .with(|state| {
                    state
                        .receiver
                        .as_ref()
                        .and_then(|receiver| receiver.try_recv().ok())
                })
                .map(|event| (channel.clone(), event))
        })
    });
    if let Some((channel, event)) = ready {
        child_ipc_dispatch(&channel, event);
        true
    } else {
        false
    }
}

fn child_ipc_pending() -> bool {
    CHILD_IPC_CHANNELS.with(|channels| channels.borrow().iter().any(child_ipc_open))
}

fn child_ipc_finish() {
    PROCESS_IPC_CHANNEL.with(|slot| *slot.borrow_mut() = None);
    let channels = CHILD_IPC_CHANNELS.with(|channels| std::mem::take(&mut *channels.borrow_mut()));
    for channel in channels {
        channel.with_mut(ClearEdges::clear_edges);
    }
}

pub fn child_connected(child: &JsChild) -> bool {
    child.with(|child| child.ipc.as_ref().is_some_and(child_ipc_connected))
}

pub fn child_send(child: &JsChild, message: &JsString) -> bool {
    child
        .with(|child| child.ipc.clone())
        .is_some_and(|channel| child_ipc_send_inner(&channel, message, None))
}

pub fn child_send_cb(
    child: &JsChild,
    message: &JsString,
    callback: ChildIpcCallback,
    trace: ChildIpcTrace,
) -> bool {
    child
        .with(|child| child.ipc.clone())
        .is_some_and(|channel| child_ipc_send_inner(&channel, message, Some((callback, trace))))
}

pub fn child_disconnect(child: &JsChild) {
    if let Some(channel) = child.with(|child| child.ipc.clone()) {
        child_ipc_disconnect_inner(&channel);
    }
}

pub fn child_on_message(
    child: &JsChild,
    callback: Rc<dyn Fn(JsString)>,
    trace: ChildIpcTrace,
    once: bool,
) {
    if let Some(channel) = child.with(|child| child.ipc.clone()) {
        child_ipc_on_message_inner(&channel, callback, trace, once);
    }
}

pub fn child_on_disconnect(
    child: &JsChild,
    callback: Rc<dyn Fn()>,
    trace: ChildIpcTrace,
    once: bool,
) {
    if let Some(channel) = child.with(|child| child.ipc.clone()) {
        child_ipc_on_disconnect_inner(&channel, callback, trace, once);
    }
}

pub fn process_fork_target(max_targets: f64) -> f64 {
    let Ok(raw_target) = std::env::var(FORK_TARGET_ENV) else {
        return -1.0;
    };
    let target = raw_target.parse::<usize>().unwrap_or(usize::MAX);
    let max_targets = if max_targets.is_finite() && max_targets >= 0.0 {
        max_targets as usize
    } else {
        0
    };
    if target >= max_targets {
        return -1.0;
    }
    let address = std::env::var(FORK_IPC_ENV).unwrap_or_default();
    let stream = std::net::TcpStream::connect(address)
        .unwrap_or_else(|error| panic!("scriptc: connect fork IPC: {error}"));
    let channel = child_ipc_new(ChildIpcEndpoint::Stream(stream));
    PROCESS_IPC_CHANNEL.with(|slot| *slot.borrow_mut() = Some(channel));
    target as f64
}

#[allow(clippy::too_many_arguments)]
pub fn child_fork(
    target: f64,
    arguments: &JsArray<JsString>,
    stdin_mode: f64,
    stdout_mode: f64,
    stderr_mode: f64,
    has_env: bool,
    env_pairs: &JsArray<JsString>,
    cwd: &JsString,
) -> JsChild {
    use std::process::Stdio;

    let listener = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
        .unwrap_or_else(|error| panic!("scriptc: bind fork IPC: {error}"));
    let address = listener.local_addr().expect("scriptc: fork IPC address");
    listener
        .set_nonblocking(true)
        .expect("scriptc: nonblocking fork IPC listener");
    let channel = child_ipc_new(ChildIpcEndpoint::Listener(listener));
    let executable = std::env::current_exe()
        .unwrap_or_else(|error| panic!("scriptc: current executable: {error}"));
    let mut command = std::process::Command::new(&executable);
    command.arg(SELF_REEXEC_MARKER).arg(&executable);
    arguments.with(|arguments| {
        command.args(
            arguments
                .elements()
                .iter()
                .map(|argument| argument.to_utf8_lossy()),
        )
    });
    if has_env {
        command.env_clear();
        env_pairs.with(|pairs| {
            for pair in pairs.elements().as_chunks::<2>().0 {
                command.env(pair[0].to_utf8_lossy(), pair[1].to_utf8_lossy());
            }
        });
    } else {
        process_env_apply(&mut command);
    }
    command.env(FORK_TARGET_ENV, (target as usize).to_string());
    command.env(FORK_IPC_ENV, address.to_string());
    if !cwd.is_empty() {
        command.current_dir(cwd.to_utf8_lossy());
    }
    let stdin_piped = to_int32(stdin_mode) == 3;
    let stdout_piped = to_int32(stdout_mode) == 3;
    let stderr_piped = to_int32(stderr_mode) == 3;
    let stdio = |mode: f64| match to_int32(mode) {
        1 => Stdio::inherit(),
        3 => Stdio::piped(),
        _ => Stdio::null(),
    };
    command
        .stdin(stdio(stdin_mode))
        .stdout(stdio(stdout_mode))
        .stderr(stdio(stderr_mode));
    let child = child_register(
        &string(&executable.to_string_lossy()),
        command.spawn(),
        stdin_piped,
        stdout_piped,
        stderr_piped,
    );
    child.with_mut(|child| child.ipc = Some(channel));
    child
}

fn process_ipc_channel() -> Option<JsChildIpc> {
    PROCESS_IPC_CHANNEL.with(|slot| slot.borrow().clone())
}

pub fn process_connected() -> bool {
    process_ipc_channel().is_some_and(|channel| child_ipc_connected(&channel))
}

pub fn process_send(message: &JsString) -> bool {
    process_ipc_channel().is_some_and(|channel| child_ipc_send_inner(&channel, message, None))
}

pub fn process_send_cb(
    message: &JsString,
    callback: ChildIpcCallback,
    trace: ChildIpcTrace,
) -> bool {
    process_ipc_channel()
        .is_some_and(|channel| child_ipc_send_inner(&channel, message, Some((callback, trace))))
}

pub fn process_disconnect() {
    if let Some(channel) = process_ipc_channel() {
        child_ipc_disconnect_inner(&channel);
    }
}

pub fn process_on_message(callback: Rc<dyn Fn(JsString)>, trace: ChildIpcTrace, once: bool) {
    if let Some(channel) = process_ipc_channel() {
        child_ipc_on_message_inner(&channel, callback, trace, once);
    }
}

pub fn process_on_disconnect(callback: Rc<dyn Fn()>, trace: ChildIpcTrace, once: bool) {
    if let Some(channel) = process_ipc_channel() {
        child_ipc_on_disconnect_inner(&channel, callback, trace, once);
    }
}
