enum StdinEvent {
    Data(Vec<u8>),
    End,
}

#[derive(Default)]
struct StdinState {
    receiver: Option<std::sync::mpsc::Receiver<StdinEvent>>,
    waiter: Option<JsPromise<JsBytes<u8>>>,
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
                    Err(_) => {
                        let _ = sender.send(StdinEvent::End);
                        break;
                    }
                }
            }
        });
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
        if state.waiter.is_none() {
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
    let waiter = STDIN_STATE.with(|state| {
        let mut state = state.borrow_mut();
        if matches!(&event, StdinEvent::End) {
            state.eof = true;
            state.receiver = None;
        }
        state.waiter.take()
    });
    let Some(waiter) = waiter else { return };
    let chunk = match event {
        StdinEvent::Data(bytes) => bytes_from_vec(bytes),
        StdinEvent::End => bytes_empty(),
    };
    let _ = promise_fulfill(&waiter, chunk);
}

fn stdin_dispatch_one() -> bool {
    let Some(event) = stdin_poll() else { return false };
    stdin_dispatch(event);
    true
}

fn stdin_pending() -> bool {
    STDIN_STATE.with(|state| {
        let state = state.borrow();
        state.waiter.is_some() && !state.eof && !state.destroyed
    })
}

fn stdin_wait(timeout: Option<std::time::Duration>) {
    let event = STDIN_STATE.with(|state| {
        let state = state.borrow();
        if state.waiter.is_none() {
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
        state.waiter.take()
    });
    if let Some(waiter) = waiter {
        let _ = promise_fulfill(&waiter, bytes_empty());
    }
}

fn stdin_finish() {
    STDIN_STATE.with(|state| *state.borrow_mut() = StdinState::default());
}
