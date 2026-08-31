struct ReadlineInterface {
    id: u64,
    closed: bool,
    dead: bool,
    question: Option<Box<dyn FnOnce(JsString)>>,
    next_line: Option<Box<dyn FnOnce(Option<JsString>)>>,
    close_listeners: Vec<Box<dyn FnOnce()>>,
    buffer: Vec<u8>,
}

struct ReadlineState {
    next_id: u64,
    interfaces: Vec<ReadlineInterface>,
}

thread_local! {
    static READLINE_STATE: RefCell<ReadlineState> = const { RefCell::new(ReadlineState {
        next_id: 1,
        interfaces: Vec::new(),
    }) };
}

pub fn readline_create() -> f64 {
    let dead = !stdin_readline_start();
    READLINE_STATE.with(|state| {
        let mut state = state.borrow_mut();
        let id = state.next_id;
        state.next_id = id.checked_add(1).expect("scriptc: exhausted readline ids");
        state.interfaces.push(ReadlineInterface {
            id,
            closed: false,
            dead,
            question: None,
            next_line: None,
            close_listeners: Vec::new(),
            buffer: Vec::new(),
        });
        id as f64
    })
}

fn readline_id(id: f64) -> Option<u64> {
    (id.is_finite() && id.fract() == 0.0 && id >= 1.0 && id <= u64::MAX as f64)
        .then(|| id as u64)
}

enum ReadlineConsumer {
    Question(Box<dyn FnOnce(JsString)>),
    Iterator(Box<dyn FnOnce(Option<JsString>)>),
}

type ReadlineLine = (ReadlineConsumer, JsString);

fn readline_take_line(id: u64) -> Option<ReadlineLine> {
    READLINE_STATE.with(|state| {
        let mut state = state.borrow_mut();
        let interface = state.interfaces.iter_mut().find(|interface| interface.id == id)?;
        if interface.closed {
            return None;
        }
        if interface.question.is_none() && interface.next_line.is_none() {
            return None;
        }
        let (line_length, advance) = interface
            .buffer
            .iter()
            .enumerate()
            .find_map(|(index, byte)| match byte {
                b'\n' => Some((index, index + 1)),
                b'\r' if index + 1 < interface.buffer.len() => {
                    Some((index, index + usize::from(interface.buffer[index + 1] == b'\n') + 1))
                }
                _ => None,
            })?;
        let line = string(&String::from_utf8_lossy(&interface.buffer[..line_length]));
        interface.buffer.drain(..advance);
        let consumer = interface
            .question
            .take()
            .map(ReadlineConsumer::Question)
            .or_else(|| interface.next_line.take().map(ReadlineConsumer::Iterator))?;
        Some((consumer, line))
    })
}

fn readline_drain(id: u64) {
    while let Some((consumer, answer)) = readline_take_line(id) {
        match consumer {
            ReadlineConsumer::Question(callback) => callback(answer),
            ReadlineConsumer::Iterator(callback) => callback(Some(answer)),
        }
    }
}

pub fn readline_next_line(id: f64, callback: Box<dyn FnOnce(Option<JsString>)>) {
    let mut callback = Some(callback);
    let live_id = READLINE_STATE.with(|state| {
        let mut state = state.borrow_mut();
        let Some(interface) = readline_id(id)
            .and_then(|id| state.interfaces.iter_mut().find(|interface| interface.id == id))
        else {
            return None;
        };
        if interface.closed || interface.dead {
            return None;
        }
        if interface.next_line.is_some() {
            throw_error("readline already has a pending async iterator read".to_owned());
        }
        interface.next_line = callback.take();
        Some(interface.id)
    });
    if let Some(id) = live_id {
        readline_drain(id);
    } else if let Some(callback) = callback {
        callback(None);
    }
}

pub fn readline_question(id: f64, query: &JsString, callback: Box<dyn FnOnce(JsString)>) {
    let id = readline_id(id);
    let state = READLINE_STATE.with(|readlines| {
        let mut readlines = readlines.borrow_mut();
        let interface = id.and_then(|id| readlines.interfaces.iter_mut().find(|entry| entry.id == id));
        let Some(interface) = interface else { return 0_u8 };
        if interface.closed {
            return 0;
        }
        if interface.dead {
            return 1;
        }
        interface.question = Some(callback);
        2
    });
    match state {
        0 => throw_error("readline was closed".to_owned()),
        1 => {
            process_stdout_write(query);
        }
        _ => {
            process_stdout_write(query);
            readline_drain(id.expect("scriptc: live readline id"));
        }
    }
}

fn readline_settle_close(id: u64) {
    let (next_line, listeners) = READLINE_STATE.with(|state| {
        let mut state = state.borrow_mut();
        let Some(interface) = state.interfaces.iter_mut().find(|interface| interface.id == id) else {
            return (None, Vec::new());
        };
        if interface.closed {
            return (None, Vec::new());
        }
        interface.closed = true;
        interface.question = None;
        interface.buffer.clear();
        (
            interface.next_line.take(),
            std::mem::take(&mut interface.close_listeners),
        )
    });
    if let Some(next_line) = next_line {
        next_line(None);
    }
    for listener in listeners {
        listener();
    }
}

pub fn readline_close(id: f64) {
    if let Some(id) = readline_id(id) {
        readline_settle_close(id);
    }
}

pub fn readline_on_close(id: f64, callback: Box<dyn FnOnce()>) {
    READLINE_STATE.with(|state| {
        let mut state = state.borrow_mut();
        let Some(interface) = readline_id(id)
            .and_then(|id| state.interfaces.iter_mut().find(|interface| interface.id == id))
        else {
            return;
        };
        if !interface.closed {
            interface.close_listeners.push(callback);
        }
    });
}

fn readline_stdin_pending() -> bool {
    READLINE_STATE.with(|state| {
        state
            .borrow()
            .interfaces
            .iter()
            .any(|interface| !interface.closed && !interface.dead)
    })
}

fn readline_stdin_data(bytes: &[u8]) {
    let ids = READLINE_STATE.with(|state| {
        let mut state = state.borrow_mut();
        state
            .interfaces
            .iter_mut()
            .filter(|interface| !interface.closed && !interface.dead)
            .map(|interface| {
                interface.buffer.extend_from_slice(bytes);
                interface.id
            })
            .collect::<Vec<_>>()
    });
    for id in ids {
        readline_drain(id);
    }
}

fn readline_stdin_end() {
    let ids = READLINE_STATE.with(|state| {
        let mut state = state.borrow_mut();
        state
            .interfaces
            .iter_mut()
            .filter(|interface| !interface.closed && !interface.dead)
            .map(|interface| {
                if !interface.buffer.is_empty() && interface.buffer.last() != Some(&b'\n') {
                    interface.buffer.push(b'\n');
                }
                interface.id
            })
            .collect::<Vec<_>>()
    });
    for id in ids {
        readline_drain(id);
        readline_settle_close(id);
    }
}

fn readline_finish() {
    READLINE_STATE.with(|state| {
        *state.borrow_mut() = ReadlineState {
            next_id: 1,
            interfaces: Vec::new(),
        };
    });
}
