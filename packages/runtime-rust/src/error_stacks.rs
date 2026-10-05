#[derive(Clone)]
struct SourceStackFrame {
    function: &'static str,
    name: &'static str,
    file: &'static str,
    line: u32,
    column: u32,
}

struct ErrorStackCapture {
    frames: Vec<SourceStackFrame>,
    formatted: Option<JsString>,
}

thread_local! {
    static SOURCE_STACK: RefCell<Vec<SourceStackFrame>> = const { RefCell::new(Vec::new()) };
    static ERROR_STACKS: RefCell<Vec<(Weak<()>, ErrorStackCapture)>> = const { RefCell::new(Vec::new()) };
    static NATIVE_ERROR_STACKS: RefCell<Vec<NativeErrorStack>> = const { RefCell::new(Vec::new()) };
}

struct NativeErrorStack {
    identity: usize,
    alive: Box<dyn Fn() -> bool>,
    capture: ErrorStackCapture,
}

pub fn error_capture_stack_gc_if_active<T: Trace + ClearEdges + 'static>(error: &Gc<T>, constructor: &str) {
    if SOURCE_STACK.with(|stack| !stack.borrow().is_empty()) { error_capture_stack_gc(error, Some(constructor)); }
}

pub fn error_capture_stack_gc<T: Trace + ClearEdges + 'static>(error: &Gc<T>, exclude: Option<&str>) {
    let capture = source_stack_capture(exclude);
    NATIVE_ERROR_STACKS.with(|stacks| {
        let mut stacks = stacks.borrow_mut();
        stacks.retain(|entry| (entry.alive)());
        if let Some(entry) = stacks.iter_mut().find(|entry| entry.identity == error.identity()) {
            entry.capture = capture;
        } else {
            let weak = error.downgrade();
            stacks.push(NativeErrorStack { identity: error.identity(), alive: Box::new(move || weak.upgrade().is_some()), capture });
        }
    });
}

pub fn error_stack_gc<T: Trace + ClearEdges + 'static>(error: &Gc<T>, header: impl FnOnce() -> JsString) -> JsString {
    let frames = NATIVE_ERROR_STACKS.with(|stacks| {
        let mut stacks = stacks.borrow_mut();
        stacks.retain(|entry| (entry.alive)());
        let Some(entry) = stacks.iter().find(|entry| entry.identity == error.identity()) else {
            throw_error_code("scriptc SC1031: Error.stack requires an original-source native capture".to_owned(), "SC1031");
        };
        match &entry.capture.formatted {
            Some(formatted) => Err(formatted.clone()),
            None => Ok(entry.capture.frames.clone()),
        }
    });
    let frames = match frames { Ok(frames) => frames, Err(formatted) => return formatted };
    let mut text = header().to_string();
    for frame in frames {
        let location = format!("{}:{}:{}", frame.file, frame.line, frame.column);
        if frame.name.is_empty() { text.push_str(&format!("\n    at {location}")); }
        else { text.push_str(&format!("\n    at {} ({location})", frame.name)); }
    }
    let formatted = string(&text);
    NATIVE_ERROR_STACKS.with(|stacks| {
        if let Some(entry) = stacks.borrow_mut().iter_mut().find(|entry| entry.identity == error.identity()) { entry.capture.formatted = Some(formatted.clone()); }
    });
    formatted
}

pub struct SourceStackGuard { depth: usize }

impl Drop for SourceStackGuard {
    fn drop(&mut self) { SOURCE_STACK.with(|stack| stack.borrow_mut().truncate(self.depth)); }
}

/// Guards unwind with compiled throw/catch, so stale frames cannot leak into
/// subsequent captures. Only generated original-source callsites enter here.
pub fn source_stack_push(function: &'static str, name: &'static str, file: &'static str, line: u32, column: u32) -> SourceStackGuard {
    SOURCE_STACK.with(|stack| {
        let mut stack = stack.borrow_mut();
        let depth = stack.len();
        stack.push(SourceStackFrame { function, name, file, line, column });
        SourceStackGuard { depth }
    })
}

fn source_stack_capture(exclude: Option<&str>) -> ErrorStackCapture {
    ErrorStackCapture {
        frames: SOURCE_STACK.with(|stack| {
            let stack = stack.borrow();
            let end = exclude.map_or(stack.len(), |function| stack.iter().rposition(|frame| frame.function == function).unwrap_or(0));
            stack[..end].iter().rev().take(10).cloned().collect()
        }),
        formatted: None,
    }
}

pub fn error_capture_stack(error: &JsError) {
    error_capture_stack_impl(error, None);
}

fn error_capture_stack_if_active(error: &JsError) {
    if SOURCE_STACK.with(|stack| !stack.borrow().is_empty()) { error_capture_stack(error); }
}

pub fn error_capture_stack_excluding(error: &JsError, exclude: &JsString) {
    error_capture_stack_impl(error, Some(exclude));
}

fn error_capture_stack_impl(error: &JsError, exclude: Option<&str>) {
    let capture = source_stack_capture(exclude);
    ERROR_STACKS.with(|stacks| {
        let mut stacks = stacks.borrow_mut();
        stacks.retain(|(identity, _)| identity.strong_count() != 0);
        if let Some((_, previous)) = stacks.iter_mut().find(|(identity, _)| identity.as_ptr() == Rc::as_ptr(&error.identity)) {
            *previous = capture;
        } else {
            stacks.push((Rc::downgrade(&error.identity), capture));
        }
    });
}

pub fn error_stack(error: &JsError) -> JsString {
    ERROR_STACKS.with(|stacks| {
        let mut stacks = stacks.borrow_mut();
        stacks.retain(|(identity, _)| identity.strong_count() != 0);
        let Some((_, capture)) = stacks.iter_mut().find(|(identity, _)| identity.as_ptr() == Rc::as_ptr(&error.identity)) else {
            throw_error_code("scriptc SC1031: Error.stack requires an original-source native capture".to_owned(), "SC1031");
        };
        if let Some(formatted) = &capture.formatted { return formatted.clone(); }
        let mut text = error_to_string(error).to_string();
        for frame in &capture.frames {
            let location = format!("{}:{}:{}", frame.file, frame.line, frame.column);
            if frame.name.is_empty() { text.push_str(&format!("\n    at {location}")); }
            else { text.push_str(&format!("\n    at {} ({location})", frame.name)); }
        }
        let formatted = string(&text);
        capture.formatted = Some(formatted.clone());
        formatted
    })
}

fn error_stacks_finish() {
    NATIVE_ERROR_STACKS.with(|stacks| stacks.borrow_mut().clear());
    ERROR_STACKS.with(|stacks| stacks.borrow_mut().clear());
    SOURCE_STACK.with(|stack| stack.borrow_mut().clear());
}
