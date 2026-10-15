/// Bun's non-stream subprocess slice. Spawn failures throw synchronously;
/// Node's child_process path continues to report them through its error event.
pub fn bun_spawn(
    argv: &JsArray<JsString>,
    stdin: f64,
    stdout: f64,
    stderr: f64,
    has_env: bool,
    env_pairs: &JsArray<JsString>,
    cwd: &JsString,
) -> JsChild {
    use std::io::Write;
    use std::process::Stdio;

    let values = argv.with(|array| array.elements().to_vec());
    let Some(command) = values.first() else {
        throw_type_error_code("cmd must not be empty".to_owned(), "ERR_INVALID_ARG_TYPE");
    };
    for (index, value) in values.iter().enumerate() {
        if value.to_utf8_lossy().contains('\0') {
            let received = if index == 0 { json_stringify(value).to_string() } else { format!("\"{value}\"") };
            throw_type_error_code(format!("The argument 'args[{index}]' must be a string without null bytes. Received {received}"), "ERR_INVALID_ARG_VALUE");
        }
    }
    if command.is_empty() {
        throw_value(error_new_code("Error", string("Executable not found in $PATH: \"\""), "ENOENT"));
    }
    let cwd = string(cwd.to_utf8_lossy().split('\0').next().unwrap_or(""));
    let arguments = array_new(values[1..].to_vec());
    let normalized_env = if has_env {
        let mut normalized = Vec::new();
        env_pairs.with(|pairs| {
            for pair in pairs.elements().as_chunks::<2>().0 {
                let key = pair[0].to_utf8_lossy();
                let value = pair[1].to_utf8_lossy();
                if let Some(invalid) = if key.contains('\0') { Some(key) } else if value.contains('\0') { Some(value) } else { None } {
                    throw_type_error_code(format!("The property 'options.env['{key}']' must be a string without null bytes. Received \"{invalid}\""), "ERR_INVALID_ARG_VALUE");
                }
                // Bun passes key=value entries to the OS. The first '=' owns
                // the boundary even when it appeared in the supplied key.
                if let Some((name, prefix)) = key.split_once('=') {
                    normalized.extend([string(name), string(&format!("{prefix}={value}"))]);
                } else { normalized.extend([pair[0].clone(), pair[1].clone()]); }
            }
        });
        Some(array_new(normalized))
    } else { None };
    #[cfg(unix)]
    let executable = if command.to_utf8_lossy().contains('/') { command.clone() } else {
        // Bun 1.3.14 getArgv0 uses _PATH_DEFPATH for an explicit env whose
        // PATH is absent or empty (js_bun_spawn_bindings.zig / c-bindings.cpp).
        let default_path = if cfg!(target_os = "freebsd") { "/sbin:/bin:/usr/sbin:/usr/bin:/usr/local/sbin:/usr/local/bin" } else { "/usr/bin:/bin" };
        let path = normalized_env.as_ref().map(|pairs| pairs.with(|pairs| pairs.elements().as_chunks::<2>().0.iter()
            .find(|pair| pair[0].to_utf8_lossy() == "PATH").map(|pair| pair[1].clone()))
            .filter(|path| !path.is_empty()).unwrap_or_else(|| string(default_path)));
        // Omitting options.env searches the startup PATH, independently of
        // later mutations of the JavaScript process.env object.
        bun_which(command, path.as_ref(), (!cwd.is_empty()).then_some(&cwd)).unwrap_or_else(||
            throw_value(error_new_code("Error", string(&format!("Executable not found in $PATH: \"{command}\"")), "ENOENT")))
    };
    #[cfg(not(unix))]
    let executable = command.clone();
    let mut process = child_command(&executable, &arguments, false, &cwd)
        .unwrap_or_else(|error| throw_value(child_spawn_error(command, error)));
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        process.arg0(command.to_utf8_lossy());
    }
    #[cfg(windows)]
    bun_spawn_check_windows_path(command, normalized_env.as_ref(), &cwd);
    // Bun 1.3.14 uses libuv's required Windows environment variables, just as
    // Node does. Omitting SYSTEMROOT can abort programs before user code runs.
    child_configure_environment(&mut process, normalized_env.as_ref());
    if !cwd.is_empty() { process.current_dir(cwd.to_utf8_lossy()); }
    let stdio = |mode| if mode == 1.0 { Stdio::inherit() } else { Stdio::null() };
    process.stdin(stdio(stdin)).stdout(stdio(stdout)).stderr(stdio(stderr));
    let _ = std::io::stdout().flush();
    let _ = std::io::stderr().flush();
    let spawned = process.spawn().unwrap_or_else(|error| {
        let code = fs_error_code(&error);
        let bare = !command.to_utf8_lossy().contains(['/', '\\']);
        let cwd_exists = cwd.is_empty() || std::path::Path::new(cwd.to_utf8_lossy()).is_dir();
        let message = if cfg!(windows) && code == "ENOENT" && bare && cwd_exists {
            format!("Executable not found in $PATH: \"{command}\"")
        } else {
            let description = match code { "ENOENT" => "no such file or directory", "EACCES" => "permission denied", _ => "failed to spawn process" };
            let syscall = if cfg!(windows) { "uv_spawn" } else { "posix_spawn" };
            format!("{code}: {description}, {syscall} '{command}'")
        };
        throw_value(error_new_code("Error", string(&message), code));
    });
    let child = child_register(command, Ok(spawned), false, false, false);
    child.with_mut(|child| child.bun_exited = Some(promise_new()));
    child
}

/// std::process::Command may fall back to the parent's PATH on Windows.
/// Resolving a different executable into Command::new would also change argv[0],
/// which the safe standard API cannot override on Windows. Refuse that form
/// rather than silently executing a different program or changing its arguments.
#[cfg(windows)]
fn bun_spawn_check_windows_path(command: &JsString, env: Option<&JsArray<JsString>>, cwd: &JsString) {
    if command.to_utf8_lossy().contains(['/', '\\']) { return; }
    let supplied = env.and_then(|pairs| pairs.with(|pairs| pairs.elements().as_chunks::<2>().0.iter()
        .find(|pair| pair[0].to_utf8_lossy().eq_ignore_ascii_case("PATH"))
        .map(|pair| pair[1].clone())));
    let Some(path) = supplied else { return };
    let cwd = (!cwd.is_empty()).then_some(cwd);
    let empty_path = path.is_empty();
    let path = if empty_path {
        let root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".to_owned());
        let working = cwd.cloned().unwrap_or_else(process_cwd);
        string(&format!("{working};{root}\\System32;{root}"))
    } else { path };
    let Some(selected) = bun_which(command, Some(&path), cwd) else {
        if empty_path {
            throw_value(error_new_code("Error", string(&format!("ENOENT: no such file or directory, uv_spawn '{command}'")), "ENOENT"));
        }
        throw_value(error_new_code("Error", string(&format!("Executable not found in $PATH: \"{command}\"")), "ENOENT"));
    };
    let inherited = std::env::var_os("PATH").map(|path| string(&path.to_string_lossy()));
    let default = bun_which(command, inherited.as_ref(), cwd);
    let canonical = |path: &JsString| std::fs::canonicalize(path.to_utf8_lossy()).ok();
    let matches = canonical(&selected).zip(default.as_ref().and_then(canonical))
        .is_some_and(|(left, right)| left.to_string_lossy().eq_ignore_ascii_case(&right.to_string_lossy()));
    if !matches {
        throw_error_code("Bun.spawn with a different Windows executable search path is not supported yet; pass an absolute executable path to preserve argv[0]".to_owned(), "SC3001");
    }
}

pub fn bun_subprocess_exited(child: &JsChild) -> JsPromise<f64> {
    child.with(|child| child.bun_exited.clone().expect("Bun subprocess promise"))
}

pub fn bun_subprocess_exit_code(child: &JsChild) -> Option<f64> {
    // Bun's getter observes an already terminated OS process even before the
    // next loop turn. Retain its outcome for normal event-loop settlement.
    if let Some(ChildOutcome::Exit(code, signal)) = child_poll(child) {
        child.with_mut(|child| child.pending_exit = Some((code, signal)));
    }
    child.with(|child| child.exit_code)
}
