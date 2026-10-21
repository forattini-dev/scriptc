// Asynchronous execFile capture. Output ownership and error metadata are
// independent of a compiler's callback or Promise value representation.
pub struct ExecFileOptions {
    pub cwd: JsString,
    pub env: Option<JsArray<JsString>>,
    pub timeout_ms: f64,
    pub windows_hide: bool,
    pub max_buffer: usize,
}
impl Default for ExecFileOptions {
    fn default() -> Self {
        Self {
            cwd: string(""),
            env: None,
            timeout_ms: 0.0,
            windows_hide: false,
            max_buffer: 1024 * 1024,
        }
    }
}

pub struct ExecFileError {
    pub error: JsError,
    pub exit_code: Option<f64>,
    pub signal: Option<JsString>,
    pub killed: bool,
}
pub struct ExecFileOutput {
    pub stdout: JsString,
    pub stderr: JsString,
    pub command: JsString,
    pub error: Option<ExecFileError>,
}

struct ExecFileCapture {
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    failure: Option<ExecFileError>,
    timer: Option<f64>,
    called: bool,
}

fn exec_file_error(message: String, code: Option<&str>) -> ExecFileError {
    ExecFileError {
        error: JsError {
            identity: Rc::new(()),
            name: "Error".into(),
            message,
            code: code.map(str::to_owned),
            cause: None,
            dom: None,
        },
        exit_code: None,
        signal: None,
        killed: false,
    }
}

fn exec_file_capture_chunk(
    capture: &Rc<RefCell<ExecFileCapture>>,
    child: &GcWeak<ChildData>,
    chunk: JsBytes<u8>,
    stderr: bool,
    max: usize,
) {
    let bytes = bytes_u8_values(&chunk);
    let overflow = {
        let mut state = capture.borrow_mut();
        if state.called || state.failure.is_some() {
            return;
        }
        let target = if stderr {
            &mut state.stderr
        } else {
            &mut state.stdout
        };
        let remaining = max.saturating_sub(target.len());
        target.extend(bytes.iter().take(remaining));
        if bytes.len() <= remaining {
            return;
        }
        let name = if stderr { "stderr" } else { "stdout" };
        let mut error = exec_file_error(
            format!("{name} maxBuffer length exceeded"),
            Some("ERR_CHILD_PROCESS_STDIO_MAXBUFFER"),
        );
        error.error.name = "RangeError".into();
        error.killed = true;
        state.failure = Some(error);
        true
    };
    if overflow && let Some(child) = child.upgrade() {
        child_kill(&child, &string("SIGTERM"));
    }
}

pub fn child_exec_file_options(
    command: &JsString,
    arguments: &JsArray<JsString>,
    options: ExecFileOptions,
    callback: Rc<dyn Fn(ExecFileOutput)>,
    trace: ChildTrace,
) -> JsChild {
    let child = child_spawn_configured(
        command,
        arguments,
        0.0,
        3.0,
        3.0,
        0.0,
        0.0,
        false,
        options.env.is_some(),
        options.env.as_ref().unwrap_or(&array_new(Vec::new())),
        &options.cwd,
        options.windows_hide,
    );
    let capture = Rc::new(RefCell::new(ExecFileCapture {
        stdout: Vec::new(),
        stderr: Vec::new(),
        failure: None,
        timer: None,
        called: false,
    }));
    for (stream, stderr) in [(child_stdout(&child), false), (child_stderr(&child), true)] {
        if let Some(stream) = stream {
            let capture = capture.clone();
            let weak = child.downgrade();
            child_stream_on_data(
                &stream,
                Rc::new(move |chunk| {
                    exec_file_capture_chunk(&capture, &weak, chunk, stderr, options.max_buffer);
                }),
                Rc::new(|_| {}),
                false,
            );
        }
    }
    if options.timeout_ms > 0.0 {
        let weak = child.downgrade();
        let state = capture.clone();
        let id = timer_set_timeout_handle(
            Box::new(move || {
                if !state.borrow().called
                    && let Some(child) = weak.upgrade()
                {
                    child_kill(&child, &string("SIGTERM"));
                }
            }),
            options.timeout_ms,
        );
        capture.borrow_mut().timer = Some(id);
    }
    let display = arguments.with(|args| {
        let mut display = command.to_string();
        for arg in args.elements().iter() {
            display.push(' ');
            display.push_str(arg);
        }
        string(&display)
    });
    let state = capture.clone();
    let error_callback = callback.clone();
    let error_trace = trace.clone();
    let error_display = display.clone();
    child_on_error(
        &child,
        Rc::new(move |error| {
            let mut state = state.borrow_mut();
            if std::mem::replace(&mut state.called, true) {
                return;
            }
            if let Some(timer) = state.timer.take() {
                timer_clear(timer);
            }
            drop(state);
            error_callback(ExecFileOutput {
                stdout: string(""),
                stderr: string(""),
                command: error_display.clone(),
                error: Some(ExecFileError {
                    error,
                    exit_code: None,
                    signal: None,
                    killed: false,
                }),
            });
        }),
        error_trace,
    );
    let weak = child.downgrade();
    child_on_close(
        &child,
        Rc::new(move |code, signal| {
            let mut state = capture.borrow_mut();
            if std::mem::replace(&mut state.called, true) {
                return;
            }
            if let Some(timer) = state.timer.take() {
                timer_clear(timer);
            }
            let stdout = string(&String::from_utf8_lossy(&state.stdout));
            let stderr = string(&String::from_utf8_lossy(&state.stderr));
            let killed = weak.upgrade().is_some_and(|child| child_killed(&child));
            let error = state.failure.take().or_else(|| {
                (code != Some(0.0) || signal.is_some()).then(|| {
                    let mut error =
                        exec_file_error(format!("Command failed: {display}\n{stderr}"), None);
                    error.exit_code = code;
                    error.signal = signal;
                    error.killed = killed;
                    error
                })
            });
            drop(state);
            callback(ExecFileOutput {
                stdout,
                stderr,
                command: display.clone(),
                error,
            });
        }),
        trace,
    );
    child
}
