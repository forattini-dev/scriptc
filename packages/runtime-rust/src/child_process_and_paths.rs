struct SyncChildOutput {
    status: std::process::ExitStatus,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    timed_out: bool,
    max_buffer_exceeded: bool,
}

fn read_sync_child_output<R: std::io::Read>(
    mut reader: R,
    max_buffer: Option<usize>,
    exceeded: &std::sync::atomic::AtomicBool,
) -> std::io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    let mut chunk = [0u8; 8192];
    loop {
        let count = reader.read(&mut chunk)?;
        if count == 0 {
            break;
        }
        let capture_limit = max_buffer.map_or(usize::MAX, |max| max.saturating_add(65_536));
        let room = capture_limit.saturating_sub(bytes.len());
        bytes.extend_from_slice(&chunk[..count.min(room)]);
        if max_buffer.is_some_and(|max| bytes.len() > max) {
            exceeded.store(true, std::sync::atomic::Ordering::Relaxed);
        }
    }
    Ok(bytes)
}

fn run_sync_child(
    mut command: std::process::Command,
    input: Option<&[u8]>,
    timeout_ms: f64,
    max_buffer: Option<usize>,
) -> std::io::Result<SyncChildOutput> {
    use std::io::Write;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;

    let mut child = command.spawn()?;
    let exceeded = Arc::new(AtomicBool::new(false));
    let stdout_reader = child.stdout.take().map(|mut stdout| {
        let exceeded = exceeded.clone();
        std::thread::spawn(move || {
            read_sync_child_output(&mut stdout, max_buffer, &exceeded)
        })
    });
    let stderr_reader = child.stderr.take().map(|mut stderr| {
        let exceeded = exceeded.clone();
        std::thread::spawn(move || {
            read_sync_child_output(&mut stderr, max_buffer, &exceeded)
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
    let mut exceeded_at = None;
    let status = loop {
        if exceeded.load(Ordering::Relaxed) && exceeded_at.is_none() {
            exceeded_at = Some(std::time::Instant::now());
        }
        match child.try_wait()? {
            Some(status) => break status,
            None if exceeded_at.is_some_and(|at: std::time::Instant| at.elapsed() >= std::time::Duration::from_millis(5)) => {
                let _ = child.kill();
                break child.wait()?;
            }
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
        max_buffer_exceeded: exceeded.load(Ordering::Relaxed),
    })
}

fn is_self_reexec(command: &JsString, arguments: &JsArray<JsString>) -> bool {
    let Some(first) = arguments.with(|arguments| arguments.elements().first().cloned()) else {
        return false;
    };
    let Ok(executable) = std::env::current_exe() else {
        return false;
    };
    let resolve = |path: &str| std::fs::canonicalize(path).unwrap_or_else(|_| path.into());
    let executable = resolve(executable.to_string_lossy().as_ref());
    resolve(command) == executable
        && (resolve(first.to_utf8_lossy()) == executable
            || process_entry_script().is_some_and(|script| first.to_utf8_lossy() == script))
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

    child_validate_self_invocation(command, arguments);
    let mut child_command = Command::new(command.to_utf8_lossy());
    arguments.with(|arguments| {
        child_command.args(
            arguments
                .elements()
                .iter()
                .map(|value| value.to_utf8_lossy()),
        );
    });
    if !cwd.is_empty() {
        child_command.current_dir(cwd.to_utf8_lossy());
    }
    child_configure_environment(&mut child_command, has_env.then_some(env_pairs));

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
        None,
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
                    .elements()
                    .get(1)
                    .cloned()
                    .unwrap_or_else(|| command.clone())
            })
        } else {
            let mut display = command.to_string();
            arguments.with(|arguments| {
                for argument in arguments.elements().iter() {
                    display.push(' ');
                    display.push_str(argument);
                }
            });
            JsString::from(display)
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
    JsString::from(String::from_utf8_lossy(&output.stdout).as_ref())
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

    child_validate_self_invocation(command, arguments);
    let mut child_command = Command::new(command.to_utf8_lossy());
    arguments.with(|arguments| {
        child_command.args(
            arguments
                .elements()
                .iter()
                .map(|value| value.to_utf8_lossy()),
        );
    });
    if !cwd.is_empty() {
        child_command.current_dir(cwd.to_utf8_lossy());
    }
    child_configure_environment(&mut child_command, has_env.then_some(env_pairs));
    child_command.stdin(Stdio::null());
    child_command.stdout(Stdio::piped());
    child_command.stderr(Stdio::piped());

    let output = run_sync_child(child_command, None, timeout_ms, None).unwrap_or_else(|error| {
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
            for argument in arguments.elements().iter() {
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
        stdout: JsString::from(String::from_utf8_lossy(&output.stdout).as_ref()),
        stderr: JsString::from(String::from_utf8_lossy(&output.stderr).as_ref()),
        stdout_bytes: output.stdout,
        stderr_bytes: output.stderr,
        error: None,
    })
}

pub struct SpawnResultData {
    status: Option<f64>,
    signal: Option<JsString>,
    stdout: JsString,
    stderr: JsString,
    stdout_bytes: Vec<u8>,
    stderr_bytes: Vec<u8>,
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
    cwd: &JsString,
    input: Option<&JsBytes<u8>>,
    max_buffer: usize,
) -> JsSpawnResult {
    use std::process::{Command, Stdio};

    child_validate_self_invocation(command, arguments);
    let mut child_command = Command::new(command.to_utf8_lossy());
    if !cwd.is_empty() {
        child_command.current_dir(cwd.to_utf8_lossy());
    }
    child_configure_environment(&mut child_command, env_pairs);
    if is_self_reexec(command, arguments) {
        child_command.arg(SELF_REEXEC_MARKER);
    }
    arguments.with(|arguments| {
        child_command.args(
            arguments
                .elements()
                .iter()
                .map(|value| value.to_utf8_lossy()),
        );
    });
    child_command.stdin(if input.is_some() {
        Stdio::piped()
    } else if to_int32(stdin_mode) == 2 {
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

    let input_bytes = input.map(ffi_bytes_snapshot);
    match run_sync_child(child_command, input_bytes.as_deref(), timeout_ms, Some(max_buffer)) {
        Err(error) => {
            let code = fs_error_code(&error);
            Gc::new(SpawnResultData {
                status: None,
                signal: None,
                stdout: string(""),
                stderr: string(""),
                stdout_bytes: Vec::new(),
                stderr_bytes: Vec::new(),
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
            let signal = if output.timed_out || output.max_buffer_exceeded {
                Some(if kill_signal.is_empty() {
                    string("SIGTERM")
                } else {
                    kill_signal.clone()
                })
            } else {
                child_exit_signal(&output.status)
            };
            Gc::new(SpawnResultData {
                status: if output.timed_out || output.max_buffer_exceeded {
                    None
                } else {
                    output.status.code().map(f64::from)
                },
                signal,
                stdout: JsString::from(String::from_utf8_lossy(&output.stdout).as_ref()),
                stderr: JsString::from(String::from_utf8_lossy(&output.stderr).as_ref()),
                stdout_bytes: output.stdout,
                stderr_bytes: output.stderr,
                error: (output.timed_out || output.max_buffer_exceeded).then(|| JsError {
                    identity: Rc::new(()),
                    name: "Error".to_owned(),
                    message: format!("spawnSync {command} {}", if output.max_buffer_exceeded { "ENOBUFS" } else { "ETIMEDOUT" }),
                    code: Some(if output.max_buffer_exceeded { "ENOBUFS" } else { "ETIMEDOUT" }.to_owned()),
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
        &string(""),
        None,
        1_048_576,
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
        &string(""),
        None,
        1_048_576,
    )
}

/// The island's spawnSync: every knob at once (cwd included), no throw
/// on a non-zero exit — the result carries status/signal/error.
#[allow(clippy::too_many_arguments)]
pub fn child_spawn_sync_full(
    command: &JsString,
    arguments: &JsArray<JsString>,
    timeout_ms: f64,
    kill_signal: &JsString,
    stdin_mode: f64,
    stdout_mode: f64,
    stderr_mode: f64,
    env_pairs: Option<&JsArray<JsString>>,
    cwd: &JsString,
) -> JsSpawnResult {
    child_spawn_sync_core(
        command,
        arguments,
        timeout_ms,
        kill_signal,
        stdin_mode,
        stdout_mode,
        stderr_mode,
        env_pairs,
        cwd,
        None,
        1_048_576,
    )
}

#[allow(clippy::too_many_arguments)]
pub fn child_spawn_sync_full_input(
    command: &JsString,
    arguments: &JsArray<JsString>,
    timeout_ms: f64,
    kill_signal: &JsString,
    stdin_mode: f64,
    stdout_mode: f64,
    stderr_mode: f64,
    env_pairs: Option<&JsArray<JsString>>,
    cwd: &JsString,
    input: Option<&JsBytes<u8>>,
    max_buffer: f64,
) -> JsSpawnResult {
    if !max_buffer.is_finite() || max_buffer < 0.0 || max_buffer > usize::MAX as f64 {
        throw_type_error("spawnSync maxBuffer must be a finite nonnegative number".into());
    }
    child_spawn_sync_core(command, arguments, timeout_ms, kill_signal, stdin_mode, stdout_mode, stderr_mode, env_pairs, cwd, input, max_buffer as usize)
}

pub fn child_spawn_sync_stdio(
    command: &JsString,
    arguments: &JsArray<JsString>,
    timeout_ms: f64,
    kill_signal: &JsString,
    stdio: &JsString,
) -> JsSpawnResult {
    let (stdin_mode, stdout_mode, stderr_mode) = match stdio.to_utf8_lossy() {
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

pub fn spawn_result_stdout_bytes(result: &JsSpawnResult) -> JsBytes<u8> {
    ffi_bytes_copy_in(&result.with(|result| result.stdout_bytes.clone()))
}

pub fn spawn_result_stderr_bytes(result: &JsSpawnResult) -> JsBytes<u8> {
    ffi_bytes_copy_in(&result.with(|result| result.stderr_bytes.clone()))
}

pub fn spawn_result_error(result: &JsSpawnResult) -> Option<JsError> {
    result.with(|result| result.error.clone())
}

pub struct StatsData {
    is_file: bool,
    is_directory: bool,
    is_symlink: bool,
    is_socket: bool,
    size: f64,
    mode: f64,
    uid: f64,
    gid: f64,
    blocks: f64,
    nlink: f64,
    atime_ms: f64,
    mtime_ms: f64,
    identity: Option<(f64, f64)>,
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
fn stats_platform_fields(metadata: &std::fs::Metadata) -> (f64, f64, f64, f64, f64) {
    use std::os::unix::fs::MetadataExt;
    (
        metadata.blocks() as f64,
        metadata.nlink() as f64,
        metadata.mode() as f64,
        metadata.uid() as f64,
        metadata.gid() as f64,
    )
}

#[cfg(unix)]
fn stats_is_socket_kind(metadata: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::FileTypeExt;
    metadata.file_type().is_socket()
}

#[cfg(not(unix))]
fn stats_is_socket_kind(_metadata: &std::fs::Metadata) -> bool {
    false
}

#[cfg(not(unix))]
fn stats_platform_fields(metadata: &std::fs::Metadata) -> (f64, f64, f64, f64, f64) {
    let kind = if metadata.is_dir() {
        0o040000
    } else {
        0o100000
    };
    let permissions = if metadata.permissions().readonly() {
        0o444
    } else {
        0o666
    };
    (0.0, 1.0, (kind | permissions) as f64, 0.0, 0.0)
}

pub fn fs_stat(path: &JsString, follow: bool) -> JsStats {
    if path.contains('\0') {
        throw_invalid_arg_value(
            "The argument 'path' must be a string, Uint8Array, or URL without null bytes. Received ",
            path,
        );
    }
    if !path.is_well_formed() {
        throw_type_error("scriptc: lone UTF-16 filesystem paths are not ported".into());
    }
    #[cfg(not(windows))]
    let result = if follow {
        std::fs::metadata(path.to_utf8_lossy())
    } else {
        std::fs::symlink_metadata(path.to_utf8_lossy())
    };
    #[cfg(windows)]
    let result = (|| -> std::io::Result<(std::fs::Metadata, (f64, f64))> {
        use std::os::windows::fs::OpenOptionsExt;
        // Open the reparse point itself for lstat. Query both metadata and
        // identity through this same handle, so replacement cannot mix files.
        let flags = 0x02000000 | if follow { 0 } else { 0x00200000 };
        let file = std::fs::OpenOptions::new()
            .access_mode(0)
            .share_mode(7)
            .custom_flags(flags)
            .open(path.to_utf8_lossy())?;
        let metadata = file.metadata()?;
        let info = winapi_util::file::information(&file)?;
        Ok((
            metadata,
            (info.volume_serial_number() as f64, info.file_index() as f64),
        ))
    })();
    let result = match result {
        Ok(metadata) => metadata,
        Err(error) => {
            #[cfg(windows)]
            let resolved = if path.is_empty() {
                path.clone()
            } else {
                path_win32_resolve(&array_new(vec![path.clone()]))
            };
            #[cfg(windows)]
            let path = &resolved;
            throw_fs_error(if follow { "stat" } else { "lstat" }, path, error)
        }
    };
    #[cfg(windows)]
    let (metadata, identity) = result;
    #[cfg(not(windows))]
    let metadata = result;
    #[cfg(windows)]
    return stats_from_metadata(metadata, !follow, Some(identity));
    #[cfg(not(windows))]
    stats_from_metadata(metadata, !follow, None)
}

pub fn fs_stat_sync(path: &JsString) -> JsStats {
    fs_stat(path, true)
}

pub fn fs_stat_promise(path: &JsString) -> JsPromise<JsStats> {
    let path = path.clone();
    promise_from_sync(move || fs_stat_sync(&path))
}

pub fn fs_lstat_sync(path: &JsString) -> JsStats {
    fs_stat(path, false)
}

pub fn fs_statfs_sync(path: &JsString) -> JsArray<f64> {
    if path.contains('\0') {
        throw_invalid_arg_value(
            "The argument 'path' must be a string, Uint8Array, or URL without null bytes. Received ",
            path,
        );
    }
    if !path.is_well_formed() {
        throw_type_error("scriptc: lone UTF-16 filesystem paths are not ported".into());
    }
    let path_value = path.to_utf8_lossy();
    let stats = fs2::statvfs(std::path::Path::new(path_value))
        .unwrap_or_else(|error| throw_fs_error("statfs", path, error));
    let bsize = stats.allocation_granularity().max(1);
    let blocks = stats.total_space() / bsize;
    let bfree = stats.free_space() / bsize;
    let bavail = stats.available_space() / bsize;
    array_new(vec![
        0.0,
        bsize as f64,
        blocks as f64,
        bfree as f64,
        bavail as f64,
        0.0,
        0.0,
    ])
}

fn stats_from_metadata(
    metadata: std::fs::Metadata,
    is_symlink: bool,
    _identity: Option<(f64, f64)>,
) -> JsStats {
    let (blocks, nlink, mode, uid, gid) = stats_platform_fields(&metadata);
    #[cfg(unix)]
    let identity = {
        use std::os::unix::fs::MetadataExt;
        Some((metadata.dev() as f64, metadata.ino() as f64))
    };
    #[cfg(not(unix))]
    let identity = _identity;
    Gc::new(StatsData {
        is_file: metadata.is_file(),
        is_directory: metadata.is_dir(),
        is_symlink: is_symlink && metadata.file_type().is_symlink(),
        is_socket: stats_is_socket_kind(&metadata),
        size: metadata.len() as f64,
        mode,
        uid,
        gid,
        blocks,
        nlink,
        atime_ms: system_time_ms(metadata.accessed()),
        mtime_ms: system_time_ms(metadata.modified()),
        identity,
    })
}

pub fn file_handle_stat(handle: &JsFileHandle) -> JsStats {
    let fd = file_handle_require_open(handle);
    fs_fstat(fd)
}

/// `fs.fstatSync(fd)` on a runtime-owned descriptor (the island's fd
/// bridge; the static lowering goes through `file_handle_stat`).
pub fn fs_fstat(fd: f64) -> JsStats {
    with_open_file(fd, "fstat", |file| {
        let metadata = file.metadata()?;
        #[cfg(windows)]
        let identity = {
            let info = winapi_util::file::information(&*file)?;
            Some((info.volume_serial_number() as f64, info.file_index() as f64))
        };
        #[cfg(not(windows))]
        let identity = None;
        Ok(stats_from_metadata(metadata, false, identity))
    })
}

/// `fs.ftruncateSync(fd, length)`: a negative length reads as 0, as in
/// Node.
pub fn fs_ftruncate(fd: f64, length: f64) {
    let received = bytes_received_number(length);
    if !length.is_finite() || length.fract() != 0.0 {
        throw_out_of_range(format!(
            "The value of \"len\" is out of range. It must be an integer. Received {received}"
        ));
    }
    if !(-9_007_199_254_740_991.0..=9_007_199_254_740_991.0).contains(&length) {
        throw_out_of_range(format!(
            "The value of \"len\" is out of range. It must be >= -9007199254740991 && <= 9007199254740991. Received {received}"
        ));
    }
    validate_write_fd(fd);
    let length = if length > 0.0 { length as u64 } else { 0 };
    with_open_file(fd, "ftruncate", |file| file.set_len(length));
}

/// `fs.fsyncSync(fd)`.
pub fn fs_fsync(fd: f64) {
    with_open_file(fd, "fsync", |file| file.sync_all());
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
pub fn stats_is_socket(stats: &JsStats) -> bool {
    stats.with(|stats| stats.is_socket)
}
pub fn stats_size(stats: &JsStats) -> f64 {
    stats.with(|stats| stats.size)
}
pub fn stats_mode(stats: &JsStats) -> f64 {
    stats.with(|stats| stats.mode)
}
pub fn stats_uid(stats: &JsStats) -> f64 {
    stats.with(|stats| stats.uid)
}
pub fn stats_gid(stats: &JsStats) -> f64 {
    stats.with(|stats| stats.gid)
}
pub fn stats_dev(stats: &JsStats) -> f64 {
    stats
        .with(|stats| stats.identity.map(|identity| identity.0))
        .unwrap_or_else(|| {
            throw_type_error("scriptc: filesystem identity unavailable on this platform".into())
        })
}
pub fn stats_ino(stats: &JsStats) -> f64 {
    stats
        .with(|stats| stats.identity.map(|identity| identity.1))
        .unwrap_or_else(|| {
            throw_type_error("scriptc: filesystem identity unavailable on this platform".into())
        })
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
    JsString::from(normalize_posix(path))
}

pub fn path_posix_sep() -> JsString {
    JsString::from("/")
}

pub fn path_win32_sep() -> JsString {
    JsString::from("\\")
}

pub fn path_posix_delimiter() -> JsString {
    JsString::from(":")
}

pub fn path_win32_delimiter() -> JsString {
    JsString::from(";")
}

pub fn path_selected_join(windows: bool, parts: &JsArray<JsString>) -> JsString {
    if windows {
        path_win32_join(parts)
    } else {
        path_join(parts)
    }
}

pub fn path_selected_is_absolute(windows: bool, path: &JsString) -> bool {
    if windows {
        path_win32_is_absolute(path)
    } else {
        path_is_absolute(path)
    }
}

pub fn path_selected_resolve(windows: bool, parts: &JsArray<JsString>) -> JsString {
    if windows {
        path_win32_resolve(parts)
    } else {
        path_resolve(parts)
    }
}

pub fn path_selected_normalize(windows: bool, path: &JsString) -> JsString {
    if windows {
        path_win32_normalize(path)
    } else {
        path_normalize(path)
    }
}

pub fn path_selected_dirname(windows: bool, path: &JsString) -> JsString {
    if windows {
        path_win32_dirname(path)
    } else {
        path_dirname(path)
    }
}

pub fn path_selected_basename(windows: bool, path: &JsString, suffix: &JsString) -> JsString {
    if windows {
        path_win32_basename(path, suffix)
    } else {
        path_basename(path, suffix)
    }
}

pub fn path_selected_extname(windows: bool, path: &JsString) -> JsString {
    if windows {
        path_win32_extname(path)
    } else {
        path_extname(path)
    }
}

pub fn path_selected_relative(windows: bool, from: &JsString, to: &JsString) -> JsString {
    if windows {
        path_win32_relative(from, to)
    } else {
        path_relative(from, to)
    }
}

pub fn path_selected_sep(windows: bool) -> JsString {
    if windows {
        path_win32_sep()
    } else {
        path_posix_sep()
    }
}

pub fn path_selected_delimiter(windows: bool) -> JsString {
    if windows {
        path_win32_delimiter()
    } else {
        path_posix_delimiter()
    }
}

pub fn path_join(parts: &JsArray<JsString>) -> JsString {
    let joined = parts.with(|data| {
        data.elements()
            .iter()
            .filter(|part| !part.is_empty())
            .map(|part| part.to_utf8_lossy())
            .collect::<Vec<_>>()
            .join("/")
    });
    JsString::from(normalize_posix(&joined))
}

pub fn path_resolve(parts: &JsArray<JsString>) -> JsString {
    let mut inputs = parts.with(|data| {
        data.elements()
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
    JsString::from(if normalized.starts_with('/') {
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
        Some(end) => JsString::from(&path[..end]),
    }
}

pub fn path_basename(path: &JsString, suffix: &JsString) -> JsString {
    let trimmed = path.trim_end_matches('/');
    if !suffix.is_empty() && trimmed == suffix {
        return empty_string();
    }
    let mut basename = trimmed.rsplit('/').next().unwrap_or("");
    if !suffix.is_empty()
        && suffix.len() < basename.len()
        && basename.ends_with(suffix.to_utf8_lossy())
    {
        basename = &basename[..basename.len() - suffix.len()];
    }
    JsString::from(basename)
}

pub fn path_extname(path: &JsString) -> JsString {
    let basename = path.trim_end_matches('/').rsplit('/').next().unwrap_or("");
    let Some(dot) = basename.rfind('.') else {
        return empty_string();
    };
    if dot == 0 || basename == ".." {
        return empty_string();
    }
    JsString::from(&basename[dot..])
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
    JsString::from(result.join("/"))
}
