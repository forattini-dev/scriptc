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
    stdout: Option<JsChildStream>,
    stderr: Option<JsChildStream>,
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
        if let Some(stream) = &self.stdout {
            tracer.edge(stream);
        }
        if let Some(stream) = &self.stderr {
            tracer.edge(stream);
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
        self.stdout = None;
        self.stderr = None;
        self.settled = true;
        self.referenced = false;
    }
}

pub type JsChild = Gc<ChildData>;

thread_local! {
    static ASYNC_CHILDREN: RefCell<Vec<JsChild>> = const { RefCell::new(Vec::new()) };
}

pub fn child_spawn(command: &JsString, arguments: &JsArray<JsString>) -> JsChild {
    child_spawn_options(
        command,
        arguments,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        false,
        false,
        &array_new(Vec::new()),
        &string(""),
    )
}

#[cfg(unix)]
fn detached_launcher() -> Option<&'static str> {
    ["/usr/bin/setsid", "/bin/setsid"]
        .into_iter()
        .find(|launcher| std::path::Path::new(launcher).is_file())
}

#[cfg(unix)]
fn detached_program(command: &JsString, cwd: &JsString) -> std::io::Result<std::path::PathBuf> {
    use std::os::unix::fs::PermissionsExt;

    let command_path = std::path::Path::new(command.as_ref());
    let candidates: Vec<std::path::PathBuf> = if command_path.components().count() > 1 {
        let candidate = if command_path.is_absolute() || cwd.is_empty() {
            command_path.to_path_buf()
        } else {
            std::path::Path::new(cwd.as_ref()).join(command_path)
        };
        vec![candidate]
    } else {
        let path = process_env_get(&string("PATH")).unwrap_or_else(|| string("/bin:/usr/bin"));
        std::env::split_paths(std::ffi::OsStr::new(path.as_ref()))
            .map(|directory| directory.join(command_path))
            .collect()
    };
    let mut permission_denied = false;
    for candidate in candidates {
        let Ok(metadata) = std::fs::metadata(&candidate) else {
            continue;
        };
        if metadata.is_file() && metadata.permissions().mode() & 0o111 != 0 {
            return Ok(candidate);
        }
        permission_denied = true;
    }
    Err(std::io::Error::from_raw_os_error(if permission_denied {
        13
    } else {
        2
    }))
}

fn child_command(
    command: &JsString,
    arguments: &JsArray<JsString>,
    detached: bool,
    cwd: &JsString,
) -> std::io::Result<std::process::Command> {
    use std::process::Command;

    #[cfg(unix)]
    if let Some(launcher) = detached.then(detached_launcher).flatten() {
        let program = detached_program(command, cwd)?;
        let mut child_command = Command::new(launcher);
        child_command.arg(program);
        arguments.with(|arguments| {
            child_command.args(arguments.elements.iter().map(|value| value.as_ref()));
        });
        return Ok(child_command);
    }
    #[cfg(not(unix))]
    {
        let _ = detached;
        let _ = cwd;
    }

    let mut child_command = Command::new(command.as_ref());
    arguments.with(|arguments| {
        child_command.args(arguments.elements.iter().map(|value| value.as_ref()));
    });
    #[cfg(unix)]
    if detached {
        use std::os::unix::process::CommandExt;
        child_command.process_group(0);
    }
    Ok(child_command)
}

fn child_spawn_error(command: &JsString, error: std::io::Error) -> JsError {
    let code = fs_error_code(&error);
    JsError {
        identity: Rc::new(()),
        name: "Error".to_owned(),
        message: format!("spawn {command} {code}"),
        code: Some(code.to_owned()),
        cause: None,
        dom: None,
    }
}

fn child_register(
    command: &JsString,
    spawned: std::io::Result<std::process::Child>,
    stdout_piped: bool,
    stderr_piped: bool,
) -> JsChild {
    let (process, spawn_error, spawn_errno, pid, stdout, stderr) = match spawned {
        Ok(mut child) => {
            let pid = child.id();
            let stdout = stdout_piped.then(|| {
                child_stream_new(ChildPipeReader::Stdout(
                    child.stdout.take().expect("scriptc: missing piped child stdout"),
                ))
            });
            let stderr = stderr_piped.then(|| {
                child_stream_new(ChildPipeReader::Stderr(
                    child.stderr.take().expect("scriptc: missing piped child stderr"),
                ))
            });
            (Some(child), None, None, Some(pid), stdout, stderr)
        }
        Err(error) => {
            let errno = error.raw_os_error();
            let stdout = stdout_piped.then(child_stream_husk);
            let stderr = stderr_piped.then(child_stream_husk);
            (
                None,
                Some(child_spawn_error(command, error)),
                errno,
                None,
                stdout,
                stderr,
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
        stdout,
        stderr,
        exit_listeners: Vec::new(),
        error_listeners: Vec::new(),
    });
    ASYNC_CHILDREN.with(|children| children.borrow_mut().push(child.clone()));
    child
}

fn child_stdio_from_fd(fd: f64) -> std::process::Stdio {
    let id =
        if fd.is_finite() && fd.fract() == 0.0 && fd >= i32::MIN as f64 && fd <= i32::MAX as f64 {
            fd as i32
        } else {
            throw_fs_fd_error("dup", "EBADF", "bad file descriptor")
        };
    OPEN_FILES.with(|files| {
        let files = files.borrow();
        let Some(file) = files.get(&id) else {
            throw_fs_fd_error("dup", "EBADF", "bad file descriptor")
        };
        std::process::Stdio::from(
            file.try_clone()
                .unwrap_or_else(|error| throw_fs_fd_io_error("dup", error)),
        )
    })
}

#[allow(clippy::too_many_arguments)]
pub fn child_spawn_options(
    command: &JsString,
    arguments: &JsArray<JsString>,
    stdin_mode: f64,
    stdout_mode: f64,
    stderr_mode: f64,
    stdout_fd: f64,
    stderr_fd: f64,
    detached: bool,
    has_env: bool,
    env_pairs: &JsArray<JsString>,
    cwd: &JsString,
) -> JsChild {
    use std::io::Write;
    use std::process::Stdio;

    let stdin_mode = to_int32(stdin_mode);
    let stdout_mode = to_int32(stdout_mode);
    let stderr_mode = to_int32(stderr_mode);
    if stdout_mode == 1 || stderr_mode == 1 {
        let _ = std::io::stdout().flush();
        let _ = std::io::stderr().flush();
    }
    let mut child_command = match child_command(command, arguments, detached, cwd) {
        Ok(child_command) => child_command,
        Err(error) => {
            return child_register(
                command,
                Err(error),
                stdout_mode == 3,
                stderr_mode == 3,
            );
        }
    };
    if has_env {
        child_command.env_clear();
        env_pairs.with(|pairs| {
            for pair in pairs.elements.chunks_exact(2) {
                child_command.env(pair[0].as_ref(), pair[1].as_ref());
            }
        });
    } else {
        process_env_apply(&mut child_command);
    }
    if !cwd.is_empty() {
        child_command.current_dir(cwd.as_ref());
    }
    child_command.stdin(if stdin_mode == 1 {
        Stdio::inherit()
    } else {
        Stdio::null()
    });
    child_command.stdout(match stdout_mode {
        1 => Stdio::inherit(),
        2 => child_stdio_from_fd(stdout_fd),
        3 => Stdio::piped(),
        _ => Stdio::null(),
    });
    child_command.stderr(match stderr_mode {
        1 => Stdio::inherit(),
        2 => child_stdio_from_fd(stderr_fd),
        3 => Stdio::piped(),
        _ => Stdio::null(),
    });

    child_register(
        command,
        child_command.spawn(),
        stdout_mode == 3,
        stderr_mode == 3,
    )
}

pub fn child_stdout(child: &JsChild) -> Option<JsChildStream> {
    child.with(|child| child.stdout.clone())
}

pub fn child_stderr(child: &JsChild) -> Option<JsChildStream> {
    child.with(|child| child.stderr.clone())
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
fn process_signal_send(pid: i32, signal: &str) -> Result<(), &'static str> {
    use std::process::{Command, Stdio};

    let launcher = ["/usr/bin/kill", "/bin/kill"]
        .into_iter()
        .find(|candidate| std::path::Path::new(candidate).is_file())
        .unwrap_or("kill");
    let mut command = Command::new(launcher);
    process_env_apply(&mut command);
    command
        .env("LC_ALL", "C")
        .arg("-s")
        .arg(signal.strip_prefix("SIG").unwrap_or(signal))
        .arg("--")
        .arg(pid.to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    let output = command.output().map_err(|_| "EIO")?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr).to_ascii_lowercase();
    if stderr.contains("no such process") {
        Err("ESRCH")
    } else if stderr.contains("operation not permitted") || stderr.contains("permission denied") {
        Err("EPERM")
    } else if stderr.contains("invalid argument") || stderr.contains("invalid signal") {
        Err("EINVAL")
    } else {
        Err("EIO")
    }
}

#[cfg(not(unix))]
fn process_signal_send(_pid: i32, _signal: &str) -> Result<(), &'static str> {
    Err("ENOSYS")
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
    let sent = process_signal_send(pid as i32, signal).is_ok();
    if sent {
        child.with_mut(|child| child.killed = true);
    }
    sent
}

pub fn child_kill_num(child: &JsChild, signal: f64) -> bool {
    let Some(pid) = child.with(|child| child.process.as_ref().map(std::process::Child::id)) else {
        return false;
    };
    let sent = process_signal_send(pid as i32, &(signal as i32).to_string()).is_ok();
    if sent {
        child.with_mut(|child| child.killed = true);
    }
    sent
}

fn process_kill_pid(pid: f64) -> i32 {
    if pid.is_finite() && pid.fract() == 0.0 && pid >= i32::MIN as f64 && pid <= i32::MAX as f64 {
        return pid as i32;
    }
    throw_type_error(format!(
        "The \"pid\" argument must be of type number. Received type number ({})",
        format_number(pid)
    ))
}

fn process_kill_send(pid: i32, signal: &str) -> bool {
    match process_signal_send(pid, signal) {
        Ok(()) => true,
        Err(code) => throw_error_code(format!("kill {code}"), code),
    }
}

pub fn process_kill_named(pid: f64, signal: &JsString) -> bool {
    let pid = process_kill_pid(pid);
    if child_signal_number(signal).is_none() {
        throw_type_error(format!("Unknown signal: {signal}"));
    }
    process_kill_send(pid, signal)
}

pub fn process_kill_num(pid: f64, signal: f64) -> bool {
    process_kill_send(process_kill_pid(pid), &(signal as i32).to_string())
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
            .rev()
            .find_map(|(index, child)| child_poll(child).map(|outcome| (index, outcome)))
    });
    let Some((index, outcome)) = ready else {
        return false;
    };
    let child = ASYNC_CHILDREN.with(|children| children.borrow()[index].clone());
    let (stdout, stderr) = child.with(|child| (child.stdout.clone(), child.stderr.clone()));
    if matches!(outcome, ChildOutcome::Exit(..)) {
        if let Some(stream) = &stdout {
            child_stream_drain_after_exit(stream);
        }
        if let Some(stream) = &stderr {
            child_stream_drain_after_exit(stream);
        }
    }
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
            if let Some(stream) = stdout {
                child_stream_fail(&stream);
            }
            if let Some(stream) = stderr {
                child_stream_fail(&stream);
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
