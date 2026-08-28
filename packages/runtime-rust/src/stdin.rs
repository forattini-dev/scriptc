enum StdinEvent {
    Data(Vec<u8>),
    End,
    Error(String),
}

#[derive(Clone)]
struct StdinDataListener {
    callback: Rc<dyn Fn(JsBytes<u8>)>,
    once: bool,
}

#[derive(Clone)]
struct StdinEndListener {
    callback: Rc<dyn Fn()>,
}

#[derive(Clone)]
struct StdinErrorListener {
    callback: Rc<dyn Fn(JsError)>,
}

#[derive(Default)]
struct StdinState {
    receiver: Option<std::sync::mpsc::Receiver<StdinEvent>>,
    waiter: Option<JsPromise<JsBytes<u8>>>,
    data_listeners: Vec<StdinDataListener>,
    end_listeners: Vec<StdinEndListener>,
    error_listeners: Vec<StdinErrorListener>,
    eof: bool,
    destroyed: bool,
}

thread_local! {
    static STDIN_STATE: RefCell<StdinState> = RefCell::new(StdinState::default());
}

fn stdin_start() {
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    STDIN_STATE.with(|state| state.borrow_mut().receiver = Some(receiver));
    let _ = std::thread::Builder::new()
        .name("scriptc-stdin".to_owned())
        .spawn(move || {
            let stdin = std::io::stdin();
            let mut input = stdin.lock();
            loop {
                let mut buffer = vec![0_u8; 65_536];
                match std::io::Read::read(&mut input, &mut buffer) {
                    Ok(0) => {
                        let _ = sender.send(StdinEvent::End);
                        break;
                    }
                    Ok(length) => {
                        buffer.truncate(length);
                        // One queued chunk is the backpressure boundary; the
                        // main-thread event loop owns all JavaScript values.
                        if sender.send(StdinEvent::Data(buffer)).is_err() {
                            break;
                        }
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(error) => {
                        let message = error
                            .raw_os_error()
                            .map_or_else(|| format!("read {error}"), |code| format!("read E{code}"));
                        let _ = sender.send(StdinEvent::Error(message));
                        break;
                    }
                }
            }
        });
}

pub fn stdin_on_data(callback: Rc<dyn Fn(JsBytes<u8>)>, once: bool) {
    let should_start = STDIN_STATE.with(|state| {
        let mut state = state.borrow_mut();
        if state.eof || state.destroyed {
            return false;
        }
        state.data_listeners.push(StdinDataListener { callback, once });
        state.receiver.is_none()
    });
    if should_start {
        stdin_start();
    }
}

pub fn stdin_on_end(callback: Rc<dyn Fn()>, _once: bool) {
    STDIN_STATE.with(|state| {
        let mut state = state.borrow_mut();
        if !state.eof && !state.destroyed {
            state.end_listeners.push(StdinEndListener { callback });
        }
    });
}

pub fn stdin_on_error(callback: Rc<dyn Fn(JsError)>, _once: bool) {
    STDIN_STATE.with(|state| {
        let mut state = state.borrow_mut();
        if !state.eof && !state.destroyed {
            state.error_listeners.push(StdinErrorListener { callback });
        }
    });
}

fn stdin_readline_start() -> bool {
    let live = STDIN_STATE.with(|state| {
        let state = state.borrow();
        !state.eof && !state.destroyed
    });
    if live && STDIN_STATE.with(|state| state.borrow().receiver.is_none()) {
        stdin_start();
    }
    live
}

/// Return the next stdin chunk, using empty bytes as the EOF sentinel.
/// Repeated requests made before delivery share the pending promise.
pub fn stdin_next_chunk() -> JsPromise<JsBytes<u8>> {
    if let Some(result) = STDIN_STATE.with(|state| {
        let state = state.borrow();
        if state.eof || state.destroyed {
            Some(promise_resolved(bytes_empty()))
        } else {
            state.waiter.clone()
        }
    }) {
        return result;
    }
    let should_start = STDIN_STATE.with(|state| state.borrow().receiver.is_none());
    if should_start {
        stdin_start();
    }
    let promise = promise_new();
    STDIN_STATE.with(|state| state.borrow_mut().waiter = Some(promise.clone()));
    promise
}

fn stdin_poll() -> Option<StdinEvent> {
    STDIN_STATE.with(|state| {
        let state = state.borrow();
        if state.waiter.is_none() && state.data_listeners.is_empty() && !readline_stdin_pending() {
            return None;
        }
        let receiver = state.receiver.as_ref()?;
        match receiver.try_recv() {
            Ok(event) => Some(event),
            Err(std::sync::mpsc::TryRecvError::Empty) => None,
            Err(std::sync::mpsc::TryRecvError::Disconnected) => Some(StdinEvent::End),
        }
    })
}

fn stdin_dispatch(event: StdinEvent) {
    match event {
        StdinEvent::Data(bytes) => {
            readline_stdin_data(&bytes);
            let (listeners, waiter) = STDIN_STATE.with(|state| {
                let mut state = state.borrow_mut();
                let listeners = state.data_listeners.clone();
                state.data_listeners.retain(|listener| !listener.once);
                let waiter = listeners.is_empty().then(|| state.waiter.take()).flatten();
                (listeners, waiter)
            });
            if listeners.is_empty() {
                if let Some(waiter) = waiter {
                    let _ = promise_fulfill(&waiter, bytes_from_vec(bytes));
                }
            } else {
                let chunk = bytes_from_vec(bytes);
                for listener in listeners {
                    (listener.callback)(chunk.clone());
                }
            }
        }
        StdinEvent::End => {
            let (listeners, waiter) = STDIN_STATE.with(|state| {
                let mut state = state.borrow_mut();
                state.eof = true;
                state.receiver = None;
                state.data_listeners.clear();
                state.error_listeners.clear();
                (std::mem::take(&mut state.end_listeners), state.waiter.take())
            });
            readline_stdin_end();
            for listener in listeners {
                (listener.callback)();
            }
            if let Some(waiter) = waiter {
                let _ = promise_fulfill(&waiter, bytes_empty());
            }
        }
        StdinEvent::Error(message) => {
            let has_error_listeners =
                STDIN_STATE.with(|state| !state.borrow().error_listeners.is_empty());
            if !has_error_listeners {
                stdin_dispatch(StdinEvent::End);
                return;
            }
            let (listeners, waiter) = STDIN_STATE.with(|state| {
                let mut state = state.borrow_mut();
                state.eof = true;
                state.receiver = None;
                state.data_listeners.clear();
                state.end_listeners.clear();
                (std::mem::take(&mut state.error_listeners), state.waiter.take())
            });
            let error = error_new("Error", string(&message));
            for listener in listeners {
                (listener.callback)(error.clone());
            }
            if let Some(waiter) = waiter {
                let _ = promise_fulfill(&waiter, bytes_empty());
            }
        }
    }
}

fn stdin_dispatch_one() -> bool {
    let Some(event) = stdin_poll() else { return false };
    stdin_dispatch(event);
    true
}

fn stdin_pending() -> bool {
    STDIN_STATE.with(|state| {
        let state = state.borrow();
        (state.waiter.is_some() || !state.data_listeners.is_empty() || readline_stdin_pending()) &&
            !state.eof && !state.destroyed
    })
}

fn stdin_wait(timeout: Option<std::time::Duration>) {
    let event = STDIN_STATE.with(|state| {
        let state = state.borrow();
        if state.waiter.is_none() && state.data_listeners.is_empty() && !readline_stdin_pending() {
            return None;
        }
        let receiver = state.receiver.as_ref()?;
        match timeout {
            Some(timeout) => match receiver.recv_timeout(timeout) {
                Ok(event) => Some(event),
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => None,
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => Some(StdinEvent::End),
            },
            None => match receiver.recv() {
                Ok(event) => Some(event),
                Err(_) => Some(StdinEvent::End),
            },
        }
    });
    if let Some(event) = event {
        stdin_dispatch(event);
    }
}

fn stdin_destroy() {
    let waiter = STDIN_STATE.with(|state| {
        let mut state = state.borrow_mut();
        state.destroyed = true;
        state.receiver = None;
        state.data_listeners.clear();
        state.end_listeners.clear();
        state.error_listeners.clear();
        state.waiter.take()
    });
    if let Some(waiter) = waiter {
        let _ = promise_fulfill(&waiter, bytes_empty());
    }
    readline_stdin_end();
}

fn stdin_finish() {
    STDIN_STATE.with(|state| *state.borrow_mut() = StdinState::default());
}
