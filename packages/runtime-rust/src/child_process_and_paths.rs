struct SyncChildOutput {
    status: std::process::ExitStatus,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    timed_out: bool,
}

fn run_sync_child(
    mut command: std::process::Command,
    input: Option<&[u8]>,
    timeout_ms: f64,
) -> std::io::Result<SyncChildOutput> {
    use std::io::{Read, Write};

    let mut child = command.spawn()?;
    let stdout_reader = child.stdout.take().map(|mut stdout| {
        std::thread::spawn(move || {
            let mut bytes = Vec::new();
            stdout.read_to_end(&mut bytes).map(|_| bytes)
        })
    });
    let stderr_reader = child.stderr.take().map(|mut stderr| {
        std::thread::spawn(move || {
            let mut bytes = Vec::new();
            stderr.read_to_end(&mut bytes).map(|_| bytes)
        })
    });
    if let Some(input) = input
        && let Err(error) = child
            .stdin
            .take()
            .expect("scriptc: piped child stdin missing")
            .write_all(input)
    {
        let _ = child.kill();
        let _ = child.wait();
        return Err(error);
    }
    let timeout = if timeout_ms.is_finite() && timeout_ms > 0.0 {
        Some(std::time::Duration::from_secs_f64(timeout_ms / 1000.0))
    } else {
        None
    };
    let started = std::time::Instant::now();
    let mut timed_out = false;
    let status = loop {
        match child.try_wait()? {
            Some(status) => break status,
            None if timeout.is_some_and(|timeout| started.elapsed() >= timeout) => {
                timed_out = true;
                let _ = child.kill();
                break child.wait()?;
            }
            None => std::thread::sleep(std::time::Duration::from_millis(1)),
        }
    };
    let join_reader = |reader: Option<std::thread::JoinHandle<std::io::Result<Vec<u8>>>>| {
        reader.map_or_else(
            || Ok(Vec::new()),
            |reader| match reader.join() {
                Ok(result) => result,
                Err(_) => Err(std::io::Error::other("child output reader panicked")),
            },
        )
    };
    Ok(SyncChildOutput {
        status,
        stdout: join_reader(stdout_reader)?,
        stderr: join_reader(stderr_reader)?,
        timed_out,
    })
}

fn is_self_reexec(command: &JsString, arguments: &JsArray<JsString>) -> bool {
    let Some(first) = arguments.with(|arguments| arguments.elements.first().cloned()) else {
        return false;
    };
    let Ok(executable) = std::env::current_exe() else {
        return false;
    };
    let resolve = |path: &str| std::fs::canonicalize(path).unwrap_or_else(|_| path.into());
    let executable = resolve(executable.to_string_lossy().as_ref());
    resolve(command.as_ref()) == executable && resolve(first.as_ref()) == executable
}

#[allow(clippy::too_many_arguments)]
pub fn child_exec_sync(
    command: &JsString,
    arguments: &JsArray<JsString>,
    shell: bool,
    input: &JsString,
    has_input: bool,
    cwd: &JsString,
    has_env: bool,
    env_pairs: &JsArray<JsString>,
    timeout_ms: f64,
    stdout_mode: f64,
    stderr_mode: f64,
) -> JsString {
    use std::io::Write;
    use std::process::{Command, Stdio};

    let mut child_command = Command::new(command.as_ref());
    arguments.with(|arguments| {
        child_command.args(arguments.elements.iter().map(|value| value.as_ref()));
    });
    if !cwd.is_empty() {
        child_command.current_dir(cwd.as_ref());
    }
    if has_env {
        child_command.env_clear();
        env_pairs.with(|pairs| {
            for pair in pairs.elements.as_chunks::<2>().0 {
                child_command.env(pair[0].as_ref(), pair[1].as_ref());
            }
        });
    } else {
        process_env_apply(&mut child_command);
    }

    let stdout_mode = to_int32(stdout_mode);
    let stdin_inherit = stdout_mode & 4 != 0;
    let stdout_mode = stdout_mode & 3;
    child_command.stdin(if has_input {
        Stdio::piped()
    } else if stdin_inherit {
        Stdio::inherit()
    } else {
        Stdio::null()
    });
    child_command.stdout(match stdout_mode {
        0 => Stdio::null(),
        2 => Stdio::inherit(),
        _ => Stdio::piped(),
    });
    let stderr_mode = to_int32(stderr_mode);
    child_command.stderr(match stderr_mode {
        2 => Stdio::null(),
        3 => Stdio::inherit(),
        _ => Stdio::piped(),
    });

    let output = match run_sync_child(
        child_command,
        has_input.then_some(input.as_bytes()),
        timeout_ms,
    ) {
        Ok(output) => output,
        Err(error) => {
            let code = fs_error_code(&error);
            throw_value(JsError {
                identity: Rc::new(()),
                name: "Error".to_owned(),
                message: format!("spawnSync {command} {code}"),
                code: Some(code.to_owned()),
                cause: None,
                dom: None,
            })
        }
    };
    if stderr_mode == 0 {
        let _ = std::io::stderr().write_all(&output.stderr);
    }
    if output.timed_out {
        throw_value(JsError {
            identity: Rc::new(()),
            name: "Error".to_owned(),
            message: format!("spawnSync {command} ETIMEDOUT"),
            code: Some("ETIMEDOUT".to_owned()),
            cause: None,
            dom: None,
        });
    }
    if !output.status.success() {
        let display = if shell {
            arguments.with(|arguments| {
                arguments
                    .elements
                    .get(1)
                    .cloned()
                    .unwrap_or_else(|| command.clone())
            })
        } else {
            let mut display = command.to_string();
            arguments.with(|arguments| {
                for argument in &arguments.elements {
                    display.push(' ');
                    display.push_str(argument);
                }
            });
            Rc::from(display)
        };
        let stderr = String::from_utf8_lossy(&output.stderr);
        let message = if stderr.is_empty() {
            format!("Command failed: {display}")
        } else {
            format!("Command failed: {display}\n{stderr}")
        };
        throw_value(JsError {
            identity: Rc::new(()),
            name: "Error".to_owned(),
            message,
            code: None,
            cause: None,
            dom: None,
        });
    }
    Rc::from(String::from_utf8_lossy(&output.stdout).as_ref())
}

pub fn child_exec_capture(
    command: &JsString,
    arguments: &JsArray<JsString>,
    cwd: &JsString,
    has_env: bool,
    env_pairs: &JsArray<JsString>,
    timeout_ms: f64,
) -> JsSpawnResult {
    use std::process::{Command, Stdio};

    let mut child_command = Command::new(command.as_ref());
    arguments.with(|arguments| {
        child_command.args(arguments.elements.iter().map(|value| value.as_ref()));
    });
    if !cwd.is_empty() {
        child_command.current_dir(cwd.as_ref());
    }
    if has_env {
        child_command.env_clear();
        env_pairs.with(|pairs| {
            for pair in pairs.elements.as_chunks::<2>().0 {
                child_command.env(pair[0].as_ref(), pair[1].as_ref());
            }
        });
    } else {
        process_env_apply(&mut child_command);
    }
    child_command.stdin(Stdio::null());
    child_command.stdout(Stdio::piped());
    child_command.stderr(Stdio::piped());

    let output = run_sync_child(child_command, None, timeout_ms).unwrap_or_else(|error| {
        let code = fs_error_code(&error);
        throw_value(JsError {
            identity: Rc::new(()),
            name: "Error".to_owned(),
            message: format!("spawn {command} {code}"),
            code: Some(code.to_owned()),
            cause: None,
            dom: None,
        })
    });
    if output.timed_out || !output.status.success() {
        let mut display = command.to_string();
        arguments.with(|arguments| {
            for argument in &arguments.elements {
                display.push(' ');
                display.push_str(argument);
            }
        });
        throw_value(JsError {
            identity: Rc::new(()),
            name: "Error".to_owned(),
            message: format!(
                "Command failed: {display}\n{}",
                String::from_utf8_lossy(&output.stderr),
            ),
            code: None,
            cause: None,
            dom: None,
        });
    }
    Gc::new(SpawnResultData {
        status: Some(0.0),
        signal: None,
        stdout: Rc::from(String::from_utf8_lossy(&output.stdout).as_ref()),
        stderr: Rc::from(String::from_utf8_lossy(&output.stderr).as_ref()),
        error: None,
    })
}

pub struct SpawnResultData {
    status: Option<f64>,
    signal: Option<JsString>,
    stdout: JsString,
    stderr: JsString,
    error: Option<JsError>,
}

impl Trace for SpawnResultData {
    fn trace(&self, _tracer: &mut Tracer<'_>) {}
}

impl ClearEdges for SpawnResultData {
    fn clear_edges(&mut self) {}
}

pub type JsSpawnResult = Gc<SpawnResultData>;

#[cfg(unix)]
fn child_exit_signal(status: &std::process::ExitStatus) -> Option<JsString> {
    use std::os::unix::process::ExitStatusExt;
    status.signal().map(|signal| {
        string(match signal {
            1 => "SIGHUP",
            2 => "SIGINT",
            3 => "SIGQUIT",
            4 => "SIGILL",
            6 => "SIGABRT",
            9 => "SIGKILL",
            11 => "SIGSEGV",
            13 => "SIGPIPE",
            14 => "SIGALRM",
            15 => "SIGTERM",
            _ => "SIGUNKNOWN",
        })
    })
}

#[cfg(not(unix))]
fn child_exit_signal(_status: &std::process::ExitStatus) -> Option<JsString> {
    None
}

#[allow(clippy::too_many_arguments)]
fn child_spawn_sync_core(
    command: &JsString,
    arguments: &JsArray<JsString>,
    timeout_ms: f64,
    kill_signal: &JsString,
    stdin_mode: f64,
    stdout_mode: f64,
    stderr_mode: f64,
    env_pairs: Option<&JsArray<JsString>>,
) -> JsSpawnResult {
    use std::process::{Command, Stdio};

    let mut child_command = Command::new(command.as_ref());
    if let Some(pairs) = env_pairs {
        child_command.env_clear();
        pairs.with(|pairs| {
            for pair in pairs.elements.as_chunks::<2>().0 {
                child_command.env(pair[0].as_ref(), pair[1].as_ref());
            }
        });
    } else {
        process_env_apply(&mut child_command);
    }
    if is_self_reexec(command, arguments) {
        child_command.arg(SELF_REEXEC_MARKER);
    }
    arguments.with(|arguments| {
        child_command.args(arguments.elements.iter().map(|value| value.as_ref()));
    });
    child_command.stdin(if to_int32(stdin_mode) == 2 {
        Stdio::inherit()
    } else {
        Stdio::null()
    });
    child_command.stdout(match to_int32(stdout_mode) {
        1 => Stdio::null(),
        2 => Stdio::inherit(),
        _ => Stdio::piped(),
    });
    child_command.stderr(match to_int32(stderr_mode) {
        1 => Stdio::null(),
        2 => Stdio::inherit(),
        _ => Stdio::piped(),
    });

    match run_sync_child(child_command, None, timeout_ms) {
        Err(error) => {
            let code = fs_error_code(&error);
            Gc::new(SpawnResultData {
                status: None,
                signal: None,
                stdout: string(""),
                stderr: string(""),
                error: Some(JsError {
                    identity: Rc::new(()),
                    name: "Error".to_owned(),
                    message: format!("spawnSync {command} {code}"),
                    code: Some(code.to_owned()),
                    cause: None,
                    dom: None,
                }),
            })
        }
        Ok(output) => {
            let signal = if output.timed_out {
                Some(if kill_signal.is_empty() {
                    string("SIGTERM")
                } else {
                    kill_signal.clone()
                })
            } else {
                child_exit_signal(&output.status)
            };
            Gc::new(SpawnResultData {
                status: if output.timed_out {
                    None
                } else {
                    output.status.code().map(f64::from)
                },
                signal,
                stdout: Rc::from(String::from_utf8_lossy(&output.stdout).as_ref()),
                stderr: Rc::from(String::from_utf8_lossy(&output.stderr).as_ref()),
                error: output.timed_out.then(|| JsError {
                    identity: Rc::new(()),
                    name: "Error".to_owned(),
                    message: format!("spawnSync {command} ETIMEDOUT"),
                    code: Some("ETIMEDOUT".to_owned()),
                    cause: None,
                    dom: None,
                }),
            })
        }
    }
}

pub fn child_spawn_sync(
    command: &JsString,
    arguments: &JsArray<JsString>,
    timeout_ms: f64,
    kill_signal: &JsString,
    stdin_mode: f64,
    stdout_mode: f64,
    stderr_mode: f64,
) -> JsSpawnResult {
    child_spawn_sync_core(
        command,
        arguments,
        timeout_ms,
        kill_signal,
        stdin_mode,
        stdout_mode,
        stderr_mode,
        None,
    )
}

#[allow(clippy::too_many_arguments)]
pub fn child_spawn_sync_env(
    command: &JsString,
    arguments: &JsArray<JsString>,
    timeout_ms: f64,
    kill_signal: &JsString,
    stdin_mode: f64,
    stdout_mode: f64,
    stderr_mode: f64,
    env_pairs: &JsArray<JsString>,
) -> JsSpawnResult {
    child_spawn_sync_core(
        command,
        arguments,
        timeout_ms,
        kill_signal,
        stdin_mode,
        stdout_mode,
        stderr_mode,
        Some(env_pairs),
    )
}

pub fn child_spawn_sync_stdio(
    command: &JsString,
    arguments: &JsArray<JsString>,
    timeout_ms: f64,
    kill_signal: &JsString,
    stdio: &JsString,
) -> JsSpawnResult {
    let (stdin_mode, stdout_mode, stderr_mode) = match stdio.as_ref() {
        "pipe" => (0.0, 0.0, 0.0),
        "ignore" => (0.0, 1.0, 1.0),
        "inherit" => (2.0, 2.0, 2.0),
        other => throw_type_error(format!(
            "spawnSync stdio \"{other}\" has no static lowering"
        )),
    };
    child_spawn_sync(
        command,
        arguments,
        timeout_ms,
        kill_signal,
        stdin_mode,
        stdout_mode,
        stderr_mode,
    )
}

pub fn spawn_result_status(result: &JsSpawnResult) -> Option<f64> {
    result.with(|result| result.status)
}

pub fn spawn_result_signal(result: &JsSpawnResult) -> Option<JsString> {
    result.with(|result| result.signal.clone())
}

pub fn spawn_result_stdout(result: &JsSpawnResult) -> JsString {
    result.with(|result| result.stdout.clone())
}

pub fn spawn_result_stderr(result: &JsSpawnResult) -> JsString {
    result.with(|result| result.stderr.clone())
}

pub fn spawn_result_error(result: &JsSpawnResult) -> Option<JsError> {
    result.with(|result| result.error.clone())
}

pub struct StatsData {
    is_file: bool,
    is_directory: bool,
    is_symlink: bool,
    size: f64,
    blocks: f64,
    nlink: f64,
    atime_ms: f64,
    mtime_ms: f64,
}

impl Trace for StatsData {
    fn trace(&self, _tracer: &mut Tracer<'_>) {}
}

impl ClearEdges for StatsData {
    fn clear_edges(&mut self) {}
}

pub type JsStats = Gc<StatsData>;

fn system_time_ms(value: std::io::Result<std::time::SystemTime>) -> f64 {
    match value {
        Ok(value) => match value.duration_since(std::time::UNIX_EPOCH) {
            Ok(duration) => duration.as_secs_f64() * 1000.0,
            Err(error) => -error.duration().as_secs_f64() * 1000.0,
        },
        Err(_) => 0.0,
    }
}

#[cfg(unix)]
fn stats_platform_fields(metadata: &std::fs::Metadata) -> (f64, f64) {
    use std::os::unix::fs::MetadataExt;
    (metadata.blocks() as f64, metadata.nlink() as f64)
}

#[cfg(not(unix))]
fn stats_platform_fields(_metadata: &std::fs::Metadata) -> (f64, f64) {
    (0.0, 1.0)
}

pub fn fs_stat(path: &JsString, follow: bool) -> JsStats {
    let result = if follow {
        std::fs::metadata(path.as_ref())
    } else {
        std::fs::symlink_metadata(path.as_ref())
    };
    let metadata = match result {
        Ok(metadata) => metadata,
        Err(error) => throw_fs_error(if follow { "stat" } else { "lstat" }, path, error),
    };
    stats_from_metadata(metadata, !follow)
}

fn stats_from_metadata(metadata: std::fs::Metadata, is_symlink: bool) -> JsStats {
    let (blocks, nlink) = stats_platform_fields(&metadata);
    Gc::new(StatsData {
        is_file: metadata.is_file(),
        is_directory: metadata.is_dir(),
        is_symlink: is_symlink && metadata.file_type().is_symlink(),
        size: metadata.len() as f64,
        blocks,
        nlink,
        atime_ms: system_time_ms(metadata.accessed()),
        mtime_ms: system_time_ms(metadata.modified()),
    })
}

pub fn file_handle_stat(handle: &JsFileHandle) -> JsStats {
    let fd = file_handle_require_open(handle);
    let metadata = with_open_file(fd, "fstat", |file| file.metadata());
    stats_from_metadata(metadata, false)
}

pub fn stats_is_file(stats: &JsStats) -> bool {
    stats.with(|stats| stats.is_file)
}
pub fn stats_is_directory(stats: &JsStats) -> bool {
    stats.with(|stats| stats.is_directory)
}
pub fn stats_is_symlink(stats: &JsStats) -> bool {
    stats.with(|stats| stats.is_symlink)
}
pub fn stats_size(stats: &JsStats) -> f64 {
    stats.with(|stats| stats.size)
}
pub fn stats_blocks(stats: &JsStats) -> f64 {
    stats.with(|stats| stats.blocks)
}
pub fn stats_nlink(stats: &JsStats) -> f64 {
    stats.with(|stats| stats.nlink)
}
pub fn stats_atime_ms(stats: &JsStats) -> f64 {
    stats.with(|stats| stats.atime_ms)
}
pub fn stats_mtime_ms(stats: &JsStats) -> f64 {
    stats.with(|stats| stats.mtime_ms)
}

fn normalize_posix(path: &str) -> String {
    if path.is_empty() {
        return ".".to_owned();
    }
    let absolute = path.starts_with('/');
    let trailing = path.ends_with('/');
    let mut parts: Vec<&str> = Vec::new();
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                if parts.last().is_some_and(|last| *last != "..") {
                    parts.pop();
                } else if !absolute {
                    parts.push(part);
                }
            }
            _ => parts.push(part),
        }
    }
    let mut result = parts.join("/");
    if result.is_empty() && !absolute {
        result.push('.');
    }
    if trailing && !result.is_empty() && result != "/" {
        result.push('/');
    }
    if absolute {
        result.insert(0, '/');
    }
    result
}

pub fn path_normalize(path: &JsString) -> JsString {
    Rc::from(normalize_posix(path))
}

pub fn path_join(parts: &JsArray<JsString>) -> JsString {
    let joined = parts.with(|data| {
        data.elements
            .iter()
            .filter(|part| !part.is_empty())
            .map(|part| part.as_ref())
            .collect::<Vec<_>>()
            .join("/")
    });
    Rc::from(normalize_posix(&joined))
}

pub fn path_resolve(parts: &JsArray<JsString>) -> JsString {
    let mut inputs = parts.with(|data| {
        data.elements
            .iter()
            .map(|part| part.to_string())
            .collect::<Vec<_>>()
    });
    inputs.insert(0, process_cwd().to_string());
    let mut combined = String::new();
    for part in inputs.iter().rev() {
        if part.is_empty() {
            continue;
        }
        combined = if combined.is_empty() {
            part.clone()
        } else {
            format!("{part}/{combined}")
        };
        if part.starts_with('/') {
            break;
        }
    }
    let mut normalized = normalize_posix(&combined);
    if normalized.len() > 1 {
        normalized.truncate(normalized.trim_end_matches('/').len());
    }
    Rc::from(if normalized.starts_with('/') {
        normalized
    } else {
        format!("/{normalized}")
    })
}

pub fn path_is_absolute(path: &JsString) -> bool {
    path.starts_with('/')
}

pub fn path_dirname(path: &JsString) -> JsString {
    let bytes = path.as_bytes();
    if bytes.is_empty() {
        return string(".");
    }
    let root = bytes[0] == b'/';
    let mut end = None;
    let mut matched_slash = true;
    for index in (1..bytes.len()).rev() {
        if bytes[index] == b'/' {
            if !matched_slash {
                end = Some(index);
                break;
            }
        } else {
            matched_slash = false;
        }
    }
    match end {
        None => string(if root { "/" } else { "." }),
        Some(1) if root => string("//"),
        Some(end) => Rc::from(&path[..end]),
    }
}

pub fn path_basename(path: &JsString, suffix: &JsString) -> JsString {
    let trimmed = path.trim_end_matches('/');
    if !suffix.is_empty() && trimmed == suffix.as_ref() {
        return empty_string();
    }
    let mut basename = trimmed.rsplit('/').next().unwrap_or("");
    if !suffix.is_empty() && suffix.len() < basename.len() && basename.ends_with(suffix.as_ref()) {
        basename = &basename[..basename.len() - suffix.len()];
    }
    Rc::from(basename)
}

pub fn path_extname(path: &JsString) -> JsString {
    let basename = path.trim_end_matches('/').rsplit('/').next().unwrap_or("");
    let Some(dot) = basename.rfind('.') else {
        return empty_string();
    };
    if dot == 0 || basename == ".." {
        return empty_string();
    }
    Rc::from(&basename[dot..])
}

pub fn path_relative(from: &JsString, to: &JsString) -> JsString {
    let from_parts = path_resolve(&array_new(vec![from.clone()]));
    let to_parts = path_resolve(&array_new(vec![to.clone()]));
    let from_parts: Vec<_> = from_parts
        .split('/')
        .filter(|part| !part.is_empty())
        .collect();
    let to_parts: Vec<_> = to_parts
        .split('/')
        .filter(|part| !part.is_empty())
        .collect();
    let common = from_parts
        .iter()
        .zip(&to_parts)
        .take_while(|(left, right)| left == right)
        .count();
    let mut result = vec![".."; from_parts.len() - common];
    result.extend(to_parts[common..].iter().copied());
    Rc::from(result.join("/"))
}
