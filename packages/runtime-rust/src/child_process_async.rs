type ChildTrace = Box<dyn for<'a> Fn(&mut Tracer<'a>)>;

struct ChildExitListener {
    invoke: Box<dyn Fn(Option<f64>, Option<JsString>)>,
    trace: ChildTrace,
}

struct ChildErrorListener {
    invoke: Box<dyn Fn(JsError)>,
    trace: ChildTrace,
}

pub struct ChildData {
    process: Option<std::process::Child>,
    spawn_error: Option<JsError>,
    spawn_errno: Option<i32>,
    pid: Option<u32>,
    exit_code: Option<f64>,
    killed: bool,
    settled: bool,
    referenced: bool,
    exit_listeners: Vec<ChildExitListener>,
    error_listeners: Vec<ChildErrorListener>,
}

impl Trace for ChildData {
    fn trace(&self, tracer: &mut Tracer<'_>) {
        for listener in &self.exit_listeners {
            (listener.trace)(tracer);
        }
        for listener in &self.error_listeners {
            (listener.trace)(tracer);
        }
    }
}

impl ClearEdges for ChildData {
    fn clear_edges(&mut self) {
        self.exit_listeners.clear();
        self.error_listeners.clear();
        self.spawn_error = None;
        self.spawn_errno = None;
        self.process = None;
        self.settled = true;
        self.referenced = false;
    }
}

pub type JsChild = Gc<ChildData>;

thread_local! {
    static ASYNC_CHILDREN: RefCell<Vec<JsChild>> = const { RefCell::new(Vec::new()) };
}

pub fn child_spawn(command: &JsString, arguments: &JsArray<JsString>) -> JsChild {
    use std::process::{Command, Stdio};

    let mut child_command = Command::new(command.as_ref());
    process_env_apply(&mut child_command);
    arguments.with(|arguments| {
        child_command.args(arguments.elements.iter().map(|value| value.as_ref()));
    });
    child_command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    let (process, spawn_error, spawn_errno, pid) = match child_command.spawn() {
        Ok(child) => {
            let pid = child.id();
            (Some(child), None, None, Some(pid))
        }
        Err(error) => {
            let code = fs_error_code(&error);
            (
                None,
                Some(JsError {
                    identity: Rc::new(()),
                    name: "Error".to_owned(),
                    message: format!("spawn {command} {code}"),
                    code: Some(code.to_owned()),
                    dom: None,
                }),
                error.raw_os_error(),
                None,
            )
        }
    };
    let child = Gc::new(ChildData {
        process,
        spawn_error,
        spawn_errno,
        pid,
        exit_code: None,
        killed: false,
        settled: false,
        referenced: true,
        exit_listeners: Vec::new(),
        error_listeners: Vec::new(),
    });
    ASYNC_CHILDREN.with(|children| children.borrow_mut().push(child.clone()));
    child
}

pub fn child_pid(child: &JsChild) -> Option<f64> {
    child.with(|child| child.pid.map(f64::from))
}

pub fn child_exit_code(child: &JsChild) -> Option<f64> {
    child.with(|child| child.exit_code)
}

pub fn child_killed(child: &JsChild) -> bool {
    child.with(|child| child.killed)
}

pub fn child_unref(child: &JsChild) {
    child.with_mut(|child| child.referenced = false);
}

#[cfg(unix)]
fn child_send_signal(pid: u32, signal: &str) -> bool {
    use std::process::{Command, Stdio};

    let argument = signal
        .strip_prefix("SIG")
        .map_or_else(|| format!("-{signal}"), |name| format!("-{name}"));
    let mut command = Command::new("kill");
    process_env_apply(&mut command);
    command
        .arg(argument)
        .arg(pid.to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|status| status.success())
}

#[cfg(not(unix))]
fn child_send_signal(_pid: u32, _signal: &str) -> bool {
    false
}

fn child_signal_number(name: &str) -> Option<i32> {
    Some(match name {
        "SIGHUP" => 1,
        "SIGINT" => 2,
        "SIGQUIT" => 3,
        "SIGILL" => 4,
        "SIGTRAP" => 5,
        "SIGABRT" => 6,
        "SIGBUS" => 7,
        "SIGFPE" => 8,
        "SIGKILL" => 9,
        "SIGUSR1" => 10,
        "SIGSEGV" => 11,
        "SIGUSR2" => 12,
        "SIGPIPE" => 13,
        "SIGALRM" => 14,
        "SIGTERM" => 15,
        "SIGCHLD" => 17,
        "SIGCONT" => 18,
        "SIGSTOP" => 19,
        "SIGTSTP" => 20,
        "SIGTTIN" => 21,
        "SIGTTOU" => 22,
        "SIGURG" => 23,
        "SIGXCPU" => 24,
        "SIGXFSZ" => 25,
        "SIGVTALRM" => 26,
        "SIGPROF" => 27,
        "SIGWINCH" => 28,
        "SIGIO" => 29,
        "SIGPWR" => 30,
        "SIGSYS" => 31,
        _ => return None,
    })
}

pub fn child_kill(child: &JsChild, signal: &JsString) -> bool {
    if child_signal_number(signal).is_none() {
        throw_type_error(format!("Unknown signal: {signal}"));
    }
    let Some(pid) = child.with(|child| child.process.as_ref().map(std::process::Child::id)) else {
        return false;
    };
    let sent = child_send_signal(pid, signal);
    if sent {
        child.with_mut(|child| child.killed = true);
    }
    sent
}

pub fn child_kill_num(child: &JsChild, signal: f64) -> bool {
    let Some(pid) = child.with(|child| child.process.as_ref().map(std::process::Child::id)) else {
        return false;
    };
    let sent = child_send_signal(pid, &(signal as i32).to_string());
    if sent {
        child.with_mut(|child| child.killed = true);
    }
    sent
}

pub fn child_on_exit(
    child: &JsChild,
    callback: Box<dyn Fn(Option<f64>, Option<JsString>)>,
    trace: ChildTrace,
) {
    child.with_mut(|child| {
        if !child.settled {
            child.exit_listeners.push(ChildExitListener {
                invoke: callback,
                trace,
            });
        }
    });
}

pub fn child_on_error(
    child: &JsChild,
    callback: Box<dyn Fn(JsError)>,
    trace: ChildTrace,
) {
    child.with_mut(|child| {
        if !child.settled {
            child.error_listeners.push(ChildErrorListener {
                invoke: callback,
                trace,
            });
        }
    });
}

enum ChildOutcome {
    Exit(Option<f64>, Option<JsString>),
    Error(JsError),
}

fn child_poll(child: &JsChild) -> Option<ChildOutcome> {
    child.with_mut(|child| {
        if let Some(error) = child.spawn_error.take() {
            child.exit_code = child.spawn_errno.map(|errno| -f64::from(errno));
            return Some(ChildOutcome::Error(error));
        }
        let status = match child.process.as_mut()?.try_wait() {
            Ok(Some(status)) => status,
            Ok(None) => return None,
            Err(_) => {
                child.process = None;
                return Some(ChildOutcome::Exit(None, None));
            }
        };
        child.process = None;
        child.exit_code = status.code().map(f64::from);
        Some(ChildOutcome::Exit(
            child.exit_code,
            child_exit_signal(&status),
        ))
    })
}

fn children_dispatch_one() -> bool {
    let ready = ASYNC_CHILDREN.with(|children| {
        children
            .borrow()
            .iter()
            .enumerate()
            .find_map(|(index, child)| child_poll(child).map(|outcome| (index, outcome)))
    });
    let Some((index, outcome)) = ready else {
        return false;
    };
    let child = ASYNC_CHILDREN.with(|children| children.borrow_mut().remove(index));
    let (exit_listeners, error_listeners) = child.with_mut(|child| {
        child.settled = true;
        child.referenced = false;
        (
            std::mem::take(&mut child.exit_listeners),
            std::mem::take(&mut child.error_listeners),
        )
    });
    match outcome {
        ChildOutcome::Exit(code, signal) => {
            drop(error_listeners);
            for listener in exit_listeners {
                (listener.invoke)(code, signal.clone());
            }
        }
        ChildOutcome::Error(error) => {
            drop(exit_listeners);
            if error_listeners.is_empty() {
                throw_value(error);
            }
            for listener in error_listeners {
                (listener.invoke)(error.clone());
            }
        }
    }
    true
}

fn children_referenced_pending() -> bool {
    ASYNC_CHILDREN.with(|children| {
        children
            .borrow()
            .iter()
            .any(|child| child.with(|child| child.referenced))
    })
}

fn children_failed_pending() -> bool {
    ASYNC_CHILDREN.with(|children| {
        children
            .borrow()
            .iter()
            .any(|child| child.with(|child| child.spawn_error.is_some()))
    })
}

fn children_wait(timeout: Option<std::time::Duration>) {
    let polling_interval = std::time::Duration::from_millis(1);
    let wait = timeout.map_or(polling_interval, |timeout| timeout.min(polling_interval));
    if !wait.is_zero() {
        std::thread::sleep(wait);
    }
}

fn children_finish() {
    let children = ASYNC_CHILDREN.with(|children| std::mem::take(&mut *children.borrow_mut()));
    for child in children {
        child.with_mut(ClearEdges::clear_edges);
    }
}
