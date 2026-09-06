// The V8 island's host members: `host.*` as the bootstrap JavaScript
// calls them, over the same runtime primitives the boa bridge uses.
// Included by lib.rs right after v8_island.rs.

/* ── host members ──────────────────────────────────────────────────── */

type HostBody = fn(&[v8e::Value]) -> Result<v8e::HostResult, v8e::Error>;

fn member(name: &'static str, arity: i32, body: HostBody) -> (&'static str, v8e::Value) {
    let function = v8e::host_function(name, arity, Rc::new(move |args| match body(args) {
        Ok(result) => result,
        Err(error) => throw_result(error),
    }));
    (name, function)
}

fn not_on_v8(name: &str) -> Result<v8e::HostResult, v8e::Error> {
    Err(v8e::Error {
        name: "Error".to_owned(),
        message: format!("host.{name} is not available on the V8 island yet"),
        code: Some("ERR_NOT_SUPPORTED".to_owned()),
        stack: None,
        value: None,
    })
}

fn host_string(value: &JsString) -> Result<v8e::HostResult, v8e::Error> {
    Ok(v8e::HostResult::String(value.to_string()))
}

fn host_value(value: v8e::Value) -> Result<v8e::HostResult, v8e::Error> {
    Ok(v8e::HostResult::Value(value))
}

fn v8_host_object() -> v8e::Value {
    let host = v8e::object();
    let members: Vec<(&'static str, v8e::Value)> = vec![
        member("source", 1, |args| {
            let key = arg_string(args, 0)?;
            let Some(module) = island_module_find(&key) else { return Ok(v8e::HostResult::Undefined) };
            let format = match module.format {
                IslandModuleFormat::Esm => 0.0,
                IslandModuleFormat::Cjs => 1.0,
                IslandModuleFormat::Json => 2.0,
            };
            host_value(v8e::array(&[v8e::string(island_module_source(module)), v8e::number(format)]))
        }),
        member("resolve", 2, |args| {
            let from = arg_string(args, 0)?;
            let specifier = arg_string(args, 1)?;
            match island_edge_find(&from, &specifier, IslandEdgeKind::Require)
                .or_else(|| island_edge_find(&from, &specifier, IslandEdgeKind::Any))
            {
                Some(key) => Ok(v8e::HostResult::String(key.to_owned())),
                None => Ok(v8e::HostResult::Undefined),
            }
        }),
        member("platform", 0, |_| host_string(&process_platform())),
        member("pid", 0, |_| Ok(v8e::HostResult::Number(process_pid()))),
        member("cwd", 0, |_| host_string(&process_cwd())),
        member("argv", 0, |_| host_value(string_array(&process_argv()))),
        member("env", 0, |_| {
            let pairs = process_env_pairs();
            let length = array_len(&pairs) as usize;
            let environment = v8e::object();
            for index in (0..length.saturating_sub(1)).step_by(2) {
                let key = array_get(&pairs, index as f64);
                let value = array_get(&pairs, (index + 1) as f64);
                v8e::set(&environment, key.as_ref(), &js_string(&value))?;
            }
            host_value(environment)
        }),
        member("exit", 1, |args| {
            let code = arg_number(args, 0)?;
            process_exit(code)
        }),
        member("setExitCode", 1, |args| {
            process_exit_code_set(arg_number(args, 0)?);
            Ok(v8e::HostResult::Undefined)
        }),
        member("hrtime", 0, |_| {
            let elapsed = process_elapsed();
            host_value(v8e::array(&[v8e::number(elapsed.as_secs() as f64), v8e::number(f64::from(elapsed.subsec_nanos()))]))
        }),
        member("isatty", 1, |args| Ok(v8e::HostResult::Bool(process_is_tty(arg_number(args, 0)?)))),
        member("columns", 1, |args| Ok(match process_columns(arg_number(args, 0)?) {
            Some(columns) => v8e::HostResult::Number(columns),
            None => v8e::HostResult::Undefined,
        })),
        member("umask", 0, |_| Ok(v8e::HostResult::Number(process_umask(-1.0)))),
        member("versions", 0, |_| host_value(v8e::array(&[js_string(&process_versions_node()), js_string(&process_versions_openssl())]))),
        member("write", 2, |args| {
            let fd = arg_number(args, 0)?;
            let text = arg_js_string(args, 1)?;
            if fd == 2.0 { process_stderr_write(&text); } else { process_stdout_write(&text); }
            Ok(v8e::HostResult::Undefined)
        }),
        member("readStdin", 0, |_| {
            let encoding: JsString = Rc::from("utf8");
            host_string(&fs_read_fd(0.0, &encoding))
        }),
        member("promiseState", 1, |args| {
            let value = arg(args, 0);
            Ok(match v8e::promise_state(&value) {
                None => v8e::HostResult::Undefined,
                Some(v8e::PromiseState::Pending) => v8e::HostResult::Value(v8e::array(&[v8e::number(0.0), v8e::undefined()])),
                Some(v8e::PromiseState::Fulfilled(result)) => v8e::HostResult::Value(v8e::array(&[v8e::number(1.0), result])),
                Some(v8e::PromiseState::Rejected(reason)) => v8e::HostResult::Value(v8e::array(&[v8e::number(2.0), reason])),
            })
        }),
        member("path", 4, host_path),
        member("urlToPath", 1, |args| host_string(&url_string_to_path(&arg_js_string(args, 0)?))),
        member("urlFromPath", 1, |args| host_string(&url_href(&url_path_to_file_url(&arg_js_string(args, 0)?)))),
        member("urlResolve", 2, |args| {
            let base = arg_string(args, 0)?;
            let input = arg_string(args, 1)?;
            match url::Url::parse(&base).ok().and_then(|b| b.join(&input).ok()) {
                Some(url) => Ok(v8e::HostResult::String(url.to_string())),
                None => Ok(v8e::HostResult::Null),
            }
        }),
        member("urlParse", 2, host_url_parse),
        member("fs", 4, host_fs),
        member("childSpawn", 4, host_child_spawn),
        member("childKill", 2, |args| {
            let Some(child) = v8_child(arg_number(args, 0)?) else { return Ok(v8e::HostResult::Bool(false)) };
            let signal = arg_js_string(args, 1)?;
            Ok(v8e::HostResult::Bool(v8_guard(|| child_kill(&child, &signal))?))
        }),
        member("childStdinWrite", 2, |args| {
            let Some(child) = v8_child(arg_number(args, 0)?) else { return Ok(v8e::HostResult::Bool(false)) };
            let bytes = arg_bytes(args, 1)?;
            Ok(v8e::HostResult::Bool(child_stdin_write(&child, &bytes)))
        }),
        member("childStdinEnd", 1, |args| {
            if let Some(child) = v8_child(arg_number(args, 0)?) { child_stdin_end(&child); }
            Ok(v8e::HostResult::Undefined)
        }),
        member("childUnref", 1, |args| {
            if let Some(child) = v8_child(arg_number(args, 0)?) { child_unref(&child); }
            Ok(v8e::HostResult::Undefined)
        }),
        member("childSpawnSync", 3, host_child_spawn_sync),
        member("fsConstants", 0, host_fs_constants),
        member("digest", 2, |args| {
            let algorithm = arg_js_string(args, 0)?;
            let data = arg_bytes(args, 1)?;
            Ok(match v8_guard(|| crypto_digest_raw(&algorithm, &data))? {
                Some(digest) => v8e::HostResult::Bytes(bytes_values(&digest)),
                None => v8e::HostResult::Undefined,
            })
        }),
        member("hmac", 3, |args| {
            let algorithm = arg_js_string(args, 0)?;
            let key = arg_bytes(args, 1)?;
            let data = arg_bytes(args, 2)?;
            Ok(match v8_guard(|| crypto_hmac_raw(&algorithm, &key, &data))? {
                Some(tag) => v8e::HostResult::Bytes(bytes_values(&tag)),
                None => v8e::HostResult::Undefined,
            })
        }),
        member("fetch", 4, |_| not_on_v8("fetch")),
        member("cancelFetch", 1, |_| Ok(v8e::HostResult::Undefined)),
        member("random", 1, |args| {
            let size = arg_number(args, 0)?;
            Ok(v8e::HostResult::Bytes(bytes_values(&v8_guard(|| crypto_random_bytes(size))?)))
        }),
        member("uuid", 0, |_| host_string(&v8_guard(crypto_random_uuid)?)),
        member("setTimer", 3, |args| {
            let callback = arg(args, 0);
            if !v8e::is_function(&callback) { return Ok(v8e::HostResult::Number(0.0)); }
            let delay = arg_number(args, 1)?;
            let repeat = arg_bool(args, 2);
            let fire: Box<dyn FnMut()> = Box::new(move || {
                ok(v8e::call(&callback, None, &[]));
                v8e::run_microtasks();
            });
            let id = if repeat { timer_set_interval(fire, delay) } else { timer_set_timeout_handle(fire, delay) };
            Ok(v8e::HostResult::Number(id))
        }),
        member("clearTimer", 1, |args| {
            timer_clear(arg_number(args, 0)?);
            Ok(v8e::HostResult::Undefined)
        }),
        member("setTimerRef", 2, |args| {
            let id = arg_number(args, 0)?;
            let referenced = args.get(1).is_none_or(v8e::truthy);
            Ok(v8e::HostResult::Number(timer_set_ref(id, referenced)))
        }),
        member("timerHasRef", 1, |args| Ok(v8e::HostResult::Bool(timer_has_ref(arg_number(args, 0)?)))),
        member("zlib", 4, |_| not_on_v8("zlib")),
        member("arch", 0, |_| host_string(&process_arch())),
        member("hostname", 0, |_| host_string(&os_hostname())),
        member("homedir", 0, |_| host_string(&v8_guard(os_homedir)?)),
        member("tmpdir", 0, |_| host_string(&os_tmpdir())),
        member("ids", 0, |_| host_value(v8e::array(&[v8e::number(process_getuid()), v8e::number(process_getgid())]))),
        member("signals", 0, host_signals),
        member("netConnect", 3, |_| not_on_v8("netConnect")),
        member("netWrite", 2, |_| not_on_v8("netWrite")),
        member("netEnd", 2, |_| not_on_v8("netEnd")),
        member("netDestroy", 1, |_| not_on_v8("netDestroy")),
        member("netFlow", 2, |_| not_on_v8("netFlow")),
        member("netOption", 3, |_| not_on_v8("netOption")),
        member("netPeer", 1, |_| not_on_v8("netPeer")),
        member("netLocal", 1, |_| not_on_v8("netLocal")),
        member("netServerCreate", 1, |_| not_on_v8("netServerCreate")),
        member("netServerListen", 3, |_| not_on_v8("netServerListen")),
        member("netServerAddress", 1, |_| not_on_v8("netServerAddress")),
        member("netServerClose", 1, |_| not_on_v8("netServerClose")),
        member("srvCreate", 1, |_| not_on_v8("srvCreate")),
        member("srvListen", 3, |_| not_on_v8("srvListen")),
        member("srvAddress", 1, |_| not_on_v8("srvAddress")),
        member("srvPort", 1, |_| not_on_v8("srvPort")),
        member("srvClose", 1, |_| not_on_v8("srvClose")),
        member("srvResHead", 4, |_| not_on_v8("srvResHead")),
        member("srvResWrite", 2, |_| not_on_v8("srvResWrite")),
        member("srvResEnd", 2, |_| not_on_v8("srvResEnd")),
        member("srvResDestroy", 1, |_| not_on_v8("srvResDestroy")),
        member("httpStart", 8, |_| not_on_v8("httpStart")),
        member("httpWrite", 2, |_| not_on_v8("httpWrite")),
        member("httpEnd", 2, |_| not_on_v8("httpEnd")),
        member("httpDestroy", 1, |_| not_on_v8("httpDestroy")),
        member("httpSetTimeout", 2, |_| not_on_v8("httpSetTimeout")),
    ];
    #[cfg(feature = "sqlite")]
    let members = {
        let mut members = members;
        members.push(member("sqlite", 6, host_sqlite));
        members
    };
    for (name, function) in members {
        ok(v8e::set(&host, name, &function));
    }
    host
}

fn host_path(args: &[v8e::Value]) -> Result<v8e::HostResult, v8e::Error> {
    let operation = arg_string(args, 0)?;
    let win32 = arg_bool(args, 1);
    let text = |index: usize| arg_js_string(args, index);
    let answer = match (operation.as_str(), win32) {
        ("join", false) => path_join(&arg_strings(args, 2)?),
        ("join", true) => path_win32_join(&arg_strings(args, 2)?),
        ("resolve", false) => path_resolve(&arg_strings(args, 2)?),
        ("resolve", true) => path_win32_resolve(&arg_strings(args, 2)?),
        ("normalize", false) => path_normalize(&text(2)?),
        ("normalize", true) => path_win32_normalize(&text(2)?),
        ("dirname", false) => path_dirname(&text(2)?),
        ("dirname", true) => path_win32_dirname(&text(2)?),
        ("basename", false) => path_basename(&text(2)?, &text(3)?),
        ("basename", true) => path_win32_basename(&text(2)?, &text(3)?),
        ("extname", false) => path_extname(&text(2)?),
        ("extname", true) => path_win32_extname(&text(2)?),
        ("isAbsolute", false) => return Ok(v8e::HostResult::Bool(path_is_absolute(&text(2)?))),
        ("isAbsolute", true) => return Ok(v8e::HostResult::Bool(path_win32_is_absolute(&text(2)?))),
        ("relative", false) => path_relative(&text(2)?, &text(3)?),
        ("relative", true) => path_win32_relative(&text(2)?, &text(3)?),
        ("toNamespacedPath", false) => text(2)?,
        ("toNamespacedPath", true) => path_win32_to_namespaced_path(&text(2)?),
        _ => return Err(type_error(format!("the island has no path operation '{operation}'"))),
    };
    host_string(&answer)
}

fn host_url_parse(args: &[v8e::Value]) -> Result<v8e::HostResult, v8e::Error> {
    let input = arg_string(args, 0)?;
    let base = arg(args, 1);
    let parsed = if v8e::is_undefined(&base) || v8e::is_null(&base) {
        url::Url::parse(&input).ok()
    } else {
        let base = arg_string(args, 1)?;
        url::Url::parse(&base).ok().and_then(|b| b.join(&input).ok())
    };
    let Some(url) = parsed else { return Ok(v8e::HostResult::Null) };
    let hostname = url.host_str().unwrap_or("");
    let port = url.port().map(|p| p.to_string()).unwrap_or_default();
    let host = if port.is_empty() { hostname.to_owned() } else { format!("{hostname}:{port}") };
    let search = match url.query() { Some(q) if !q.is_empty() => format!("?{q}"), _ => String::new() };
    let hash = match url.fragment() { Some(f) if !f.is_empty() => format!("#{f}"), _ => String::new() };
    let origin = match url.origin() {
        url::Origin::Tuple(..) => url.origin().ascii_serialization(),
        url::Origin::Opaque(_) => "null".to_owned(),
    };
    let object = v8e::object();
    for (key, value) in [
        ("href", url.as_str().to_owned()),
        ("protocol", format!("{}:", url.scheme())),
        ("username", url.username().to_owned()),
        ("password", url.password().unwrap_or("").to_owned()),
        ("host", host),
        ("hostname", hostname.to_owned()),
        ("port", port),
        ("pathname", url.path().to_owned()),
        ("search", search),
        ("hash", hash),
        ("origin", origin),
    ] {
        v8e::set(&object, key, &v8e::string(&value))?;
    }
    host_value(object)
}

fn host_signals(_args: &[v8e::Value]) -> Result<v8e::HostResult, v8e::Error> {
    #[cfg(target_os = "macos")]
    const SIGNALS: [(&str, i32); 29] = [
        ("SIGHUP", 1), ("SIGINT", 2), ("SIGQUIT", 3), ("SIGILL", 4), ("SIGTRAP", 5),
        ("SIGABRT", 6), ("SIGFPE", 8), ("SIGKILL", 9), ("SIGBUS", 10), ("SIGSEGV", 11),
        ("SIGSYS", 12), ("SIGPIPE", 13), ("SIGALRM", 14), ("SIGTERM", 15), ("SIGURG", 16),
        ("SIGSTOP", 17), ("SIGTSTP", 18), ("SIGCONT", 19), ("SIGCHLD", 20), ("SIGTTIN", 21),
        ("SIGTTOU", 22), ("SIGIO", 23), ("SIGXCPU", 24), ("SIGXFSZ", 25), ("SIGVTALRM", 26),
        ("SIGPROF", 27), ("SIGWINCH", 28), ("SIGUSR1", 30), ("SIGUSR2", 31),
    ];
    #[cfg(not(target_os = "macos"))]
    const SIGNALS: [(&str, i32); 28] = [
        ("SIGHUP", 1), ("SIGINT", 2), ("SIGQUIT", 3), ("SIGILL", 4), ("SIGTRAP", 5),
        ("SIGABRT", 6), ("SIGBUS", 7), ("SIGFPE", 8), ("SIGKILL", 9), ("SIGUSR1", 10),
        ("SIGSEGV", 11), ("SIGUSR2", 12), ("SIGPIPE", 13), ("SIGALRM", 14), ("SIGTERM", 15),
        ("SIGCHLD", 17), ("SIGCONT", 18), ("SIGSTOP", 19), ("SIGTSTP", 20), ("SIGTTIN", 21),
        ("SIGTTOU", 22), ("SIGURG", 23), ("SIGXCPU", 24), ("SIGXFSZ", 25), ("SIGVTALRM", 26),
        ("SIGPROF", 27), ("SIGWINCH", 28), ("SIGIO", 29),
    ];
    let object = v8e::object();
    for (name, number) in SIGNALS {
        v8e::set(&object, name, &v8e::number(f64::from(number)))?;
    }
    host_value(object)
}

fn host_fs_constants(_args: &[v8e::Value]) -> Result<v8e::HostResult, v8e::Error> {
    #[cfg(target_os = "macos")]
    const OPEN_FLAGS: [(&str, i32); 8] = [
        ("O_RDONLY", 0), ("O_WRONLY", 1), ("O_RDWR", 2), ("O_CREAT", 0x200),
        ("O_EXCL", 0x800), ("O_TRUNC", 0x400), ("O_APPEND", 8), ("O_NONBLOCK", 4),
    ];
    #[cfg(not(target_os = "macos"))]
    const OPEN_FLAGS: [(&str, i32); 8] = [
        ("O_RDONLY", 0), ("O_WRONLY", 1), ("O_RDWR", 2), ("O_CREAT", 64),
        ("O_EXCL", 128), ("O_TRUNC", 512), ("O_APPEND", 1024), ("O_NONBLOCK", 2048),
    ];
    const OTHER: [(&str, i32); 14] = [
        ("F_OK", 0), ("R_OK", 4), ("W_OK", 2), ("X_OK", 1),
        ("S_IFMT", 0o170000), ("S_IFREG", 0o100000), ("S_IFDIR", 0o040000), ("S_IFLNK", 0o120000),
        ("S_IFCHR", 0o020000), ("S_IFBLK", 0o060000), ("S_IFIFO", 0o010000), ("S_IFSOCK", 0o140000),
        ("COPYFILE_EXCL", 1), ("UV_FS_COPYFILE_EXCL", 1),
    ];
    let object = v8e::object();
    for (name, number) in OPEN_FLAGS.iter().chain(OTHER.iter()) {
        v8e::set(&object, name, &v8e::number(f64::from(*number)))?;
    }
    host_value(object)
}

/* ── fs ────────────────────────────────────────────────────────────── */

fn stats_row(stats: &JsStats) -> v8e::Value {
    v8e::array(&[
        v8e::boolean(stats_is_file(stats)),
        v8e::boolean(stats_is_directory(stats)),
        v8e::boolean(stats_is_symlink(stats)),
        v8e::number(stats_size(stats)),
        v8e::number(stats_mtime_ms(stats)),
        v8e::number(stats_blocks(stats)),
        v8e::number(stats_nlink(stats)),
        v8e::number(stats_atime_ms(stats)),
    ])
}

fn host_fs(args: &[v8e::Value]) -> Result<v8e::HostResult, v8e::Error> {
    let operation = arg_string(args, 0)?;
    let fd_op = matches!(operation.as_str(), "close" | "read" | "write" | "fstat" | "ftruncate" | "fsync");
    let path: JsString = if fd_op { Rc::from("") } else { arg_js_string(args, 1)? };
    let number = |index: usize| arg_number(args, index);
    let nothing = || Ok(v8e::HostResult::Undefined);
    match operation.as_str() {
        "readFile" => Ok(v8e::HostResult::Bytes(bytes_values(&v8_guard(|| fs_read_file_bytes(&path))?))),
        "writeFile" => { let data = arg_bytes(args, 2)?; v8_guard(|| fs_write_file_bytes(&path, &data))?; nothing() }
        "appendFile" => { let data = arg_bytes(args, 2)?; v8_guard(|| fs_append_file_bytes(&path, &data))?; nothing() }
        "exists" => Ok(v8e::HostResult::Bool(fs_exists(&path))),
        "realpath" => host_string(&v8_guard(|| fs_realpath(&path))?),
        "mkdir" => {
            let recursive = number(2)? != 0.0;
            let mode = number(3)?;
            v8_guard(|| if mode < 0.0 { if recursive { fs_mkdir_recursive(&path) } else { fs_mkdir(&path) } } else { fs_mkdir_mode(&path, mode, recursive) })?;
            nothing()
        }
        "rm" => { let recursive = number(2)? != 0.0; let force = number(3)? != 0.0; v8_guard(|| fs_rm_options(&path, recursive, force))?; nothing() }
        "rmdir" => { v8_guard(|| fs_rmdir(&path))?; nothing() }
        "unlink" => { v8_guard(|| fs_unlink(&path))?; nothing() }
        "readdir" => host_value(string_array(&v8_guard(|| fs_readdir(&path))?)),
        "scandir" => {
            let entries = v8_guard(|| fs_readdir_types(&path))?;
            let mut flat = Vec::with_capacity(entries.len() * 2);
            for entry in &entries {
                flat.push(js_string(&entry.name));
                flat.push(v8e::number(entry.kind));
            }
            host_value(v8e::array(&flat))
        }
        "stat" => host_value(stats_row(&v8_guard(|| fs_stat(&path, true))?)),
        "lstat" => host_value(stats_row(&v8_guard(|| fs_stat(&path, false))?)),
        "access" => { let mode = number(2)?; v8_guard(|| fs_access(&path, mode))?; nothing() }
        "mkdtemp" => host_string(&v8_guard(|| fs_mkdtemp(&path))?),
        "chmod" => { let mode = number(2)?; v8_guard(|| fs_chmod(&path, mode))?; nothing() }
        "readlink" => host_string(&v8_guard(|| fs_readlink(&path))?),
        "copyFile" => { let destination = arg_js_string(args, 2)?; v8_guard(|| fs_copy_file(&path, &destination))?; nothing() }
        "rename" => { let destination = arg_js_string(args, 2)?; v8_guard(|| fs_rename(&path, &destination))?; nothing() }
        "open" => { let flags = arg_js_string(args, 2)?; Ok(v8e::HostResult::Number(v8_guard(|| fs_open(&path, &flags))?)) }
        "close" => { let fd = number(1)?; v8_guard(|| fs_close(fd))?; nothing() }
        "read" => {
            let fd = number(1)?; let length = number(2)?; let position = number(3)?;
            let data = v8_guard(|| { let buffer = bytes_alloc::<u8>(length); let read = fs_read_sync(fd, &buffer, 0.0, length, position); bytes_u8_values(&buffer)[..read as usize].to_vec() })?;
            Ok(v8e::HostResult::Bytes(data))
        }
        "write" => {
            let fd = number(1)?; let data = arg_bytes(args, 2)?; let position = number(3)?;
            let written = v8_guard(|| { let length = data.with(|data| data.length) as f64; fs_write_sync(fd, &data, 0.0, length, position) })?;
            Ok(v8e::HostResult::Number(written))
        }
        "fstat" => { let fd = number(1)?; host_value(stats_row(&v8_guard(|| fs_fstat(fd))?)) }
        "ftruncate" => { let fd = number(1)?; let length = number(2)?; v8_guard(|| fs_ftruncate(fd, length))?; nothing() }
        "fsync" => { let fd = number(1)?; v8_guard(|| fs_fsync(fd))?; nothing() }
        _ => Err(v8e::Error { name: "ReferenceError".to_owned(), message: "unknown island fs op".to_owned(), code: None, stack: None, value: None }),
    }
}

/* ── child processes ───────────────────────────────────────────────── */

thread_local! {
    static V8_CHILDREN: RefCell<HashMap<u64, JsChild>> = RefCell::new(HashMap::new());
    static V8_CHILD_NEXT_ID: Cell<u64> = const { Cell::new(0) };
}

fn v8_child(id: f64) -> Option<JsChild> {
    if !id.is_finite() || id < 1.0 { return None; }
    V8_CHILDREN.with(|children| children.borrow().get(&(id as u64)).cloned())
}

/// Calls one method on a shim callbacks object from the loop, draining
/// the microtasks it queued (the socket bridge's reentry seam).
fn v8_callback(callbacks: &v8e::Value, name: &str, args: Vec<v8e::Value>) {
    let member = ok(v8e::get(callbacks, name));
    if !v8e::is_function(&member) { return; }
    ok(v8e::call(&member, Some(callbacks), &args));
    v8e::run_microtasks();
}

fn option_number(options: &v8e::Value, name: &str) -> Result<f64, v8e::Error> {
    let value = v8e::get(options, name)?;
    if v8e::is_undefined(&value) || v8e::is_null(&value) { Ok(0.0) } else { v8e::to_number(&value) }
}

fn option_string(options: &v8e::Value, name: &str) -> Result<JsString, v8e::Error> {
    let value = v8e::get(options, name)?;
    if v8e::is_undefined(&value) || v8e::is_null(&value) { Ok(Rc::from("")) } else { Ok(Rc::from(v8e::to_string(&value)?.as_str())) }
}

fn exit_arguments(code: Option<f64>, signal: Option<JsString>) -> Vec<v8e::Value> {
    vec![
        code.map_or_else(v8e::null, v8e::number),
        signal.map_or_else(v8e::null, |signal| js_string(&signal)),
    ]
}

fn host_child_spawn(args: &[v8e::Value]) -> Result<v8e::HostResult, v8e::Error> {
    let command = arg_js_string(args, 0)?;
    let argv = arg_strings(args, 1)?;
    let options = arg(args, 2);
    let callbacks = arg(args, 3);
    if !v8e::is_object(&callbacks) { return Err(type_error("the island child bridge expects a callbacks object")); }
    let stdin = option_number(&options, "stdin")?;
    let stdout = option_number(&options, "stdout")?;
    let stderr = option_number(&options, "stderr")?;
    let stdout_fd = option_number(&options, "stdoutFd")?;
    let stderr_fd = option_number(&options, "stderrFd")?;
    let detached = option_number(&options, "detached")? != 0.0;
    let cwd = option_string(&options, "cwd")?;
    let env_value = v8e::get(&options, "env")?;
    let has_env = !(v8e::is_undefined(&env_value) || v8e::is_null(&env_value));
    let env_pairs = arg_strings(&[env_value], 0)?;
    let child = v8_guard(|| child_spawn_options(&command, &argv, stdin, stdout, stderr, stdout_fd, stderr_fd, detached, has_env, &env_pairs, &cwd))?;
    let id = V8_CHILD_NEXT_ID.with(|slot| { let id = slot.get() + 1; slot.set(id); id });
    if v8_trace() {
        eprintln!("scriptc island: spawn #{id} {command} (pid {:?})", child_pid(&child));
    }
    V8_CHILDREN.with(|children| { children.borrow_mut().insert(id, child.clone()); });
    for (stream, on_data, on_end) in [(child_stdout(&child), "onStdout", "onStdoutEnd"), (child_stderr(&child), "onStderr", "onStderrEnd")] {
        let Some(stream) = stream else { continue };
        let data_callbacks = callbacks.clone();
        child_stream_on_data(&stream, Rc::new(move |chunk| { v8_callback(&data_callbacks, on_data, vec![v8e::bytes(&bytes_u8_values(&chunk))]); }), Rc::new(|_| {}), false);
        let end_callbacks = callbacks.clone();
        child_stream_on_end(&stream, Rc::new(move || { v8_callback(&end_callbacks, on_end, Vec::new()); }), Rc::new(|_| {}));
    }
    let exit_callbacks = callbacks.clone();
    child_on_exit(&child, Box::new(move |code, signal| { v8_callback(&exit_callbacks, "onExit", exit_arguments(code, signal)); }), Box::new(|_| {}));
    let close_callbacks = callbacks.clone();
    child_on_close(&child, Box::new(move |code, signal| { v8_callback(&close_callbacks, "onClose", exit_arguments(code, signal)); }), Box::new(|_| {}));
    let error_callbacks = callbacks.clone();
    child_on_error(&child, Box::new(move |error| {
        let message = error_message(&error).to_string();
        let code = error.code.clone().unwrap_or_default();
        v8_callback(&error_callbacks, "onError", vec![v8e::string(&message), v8e::string(&code)]);
    }), Box::new(|_| {}));
    let pid = child_pid(&child).map_or_else(v8e::null, v8e::number);
    host_value(v8e::array(&[v8e::number(id as f64), pid]))
}

fn host_child_spawn_sync(args: &[v8e::Value]) -> Result<v8e::HostResult, v8e::Error> {
    let command = arg_js_string(args, 0)?;
    let argv = arg_strings(args, 1)?;
    let options = arg(args, 2);
    let cwd = option_string(&options, "cwd")?;
    let timeout = option_number(&options, "timeout")?;
    let kill_signal = option_string(&options, "killSignal")?;
    let sync_mode = |mode: f64| match mode as i32 { 0 => 1.0, 1 => 2.0, _ => 0.0 };
    let stdin = if option_number(&options, "stdin")? as i32 == 1 { 2.0 } else { 0.0 };
    let stdout = sync_mode(option_number(&options, "stdout")?);
    let stderr = sync_mode(option_number(&options, "stderr")?);
    let env_value = v8e::get(&options, "env")?;
    let has_env = !(v8e::is_undefined(&env_value) || v8e::is_null(&env_value));
    let env_pairs = arg_strings(&[env_value], 0)?;
    let result = v8_guard(|| child_spawn_sync_full(&command, &argv, timeout, &kill_signal, stdin, stdout, stderr, has_env.then_some(&env_pairs), &cwd))?;
    let status = spawn_result_status(&result).map_or_else(v8e::null, v8e::number);
    let signal = spawn_result_signal(&result).map_or_else(v8e::null, |signal| js_string(&signal));
    let stdout = js_string(&spawn_result_stdout(&result));
    let stderr = js_string(&spawn_result_stderr(&result));
    let (message, code) = match spawn_result_error(&result) {
        Some(error) => (v8e::string(error_message(&error).as_ref()), v8e::string(&error.code.clone().unwrap_or_default())),
        None => (v8e::null(), v8e::null()),
    };
    host_value(v8e::array(&[status, signal, stdout, stderr, message, code]))
}

/* ── sqlite ────────────────────────────────────────────────────────── */

#[cfg(feature = "sqlite")]
fn sqlite_param_of(value: &v8e::Value) -> Result<SqliteValue, v8e::Error> {
    if v8e::is_undefined(value) || v8e::is_null(value) { return Ok(SqliteValue::Null); }
    if let Some(number) = v8e::as_number(value) {
        return Ok(if number.fract() == 0.0 && number.abs() <= 9_007_199_254_740_992.0 { SqliteValue::Integer(number as i64) } else { SqliteValue::Real(number) });
    }
    if let Some(flag) = v8e::as_bool(value) { return Ok(SqliteValue::Integer(i64::from(flag))); }
    if let Some(text) = v8e::as_string(value) { return Ok(SqliteValue::Text(text)); }
    if v8e::type_of(value) == "bigint" {
        return match v8e::to_string(value)?.parse::<i64>() {
            Ok(integer) => Ok(SqliteValue::Integer(integer)),
            Err(_) => Err(v8e::Error { name: "RangeError".to_owned(), message: "BigInt value is out of range for a 64-bit SQLite integer".to_owned(), code: None, stack: None, value: None }),
        };
    }
    if let Some(bytes) = v8e::as_bytes(value) { return Ok(SqliteValue::Blob(bytes)); }
    Err(type_error("Binding value must be a string, number, bigint, boolean, null, or Uint8Array"))
}

#[cfg(feature = "sqlite")]
fn sqlite_params_of(value: &v8e::Value) -> Result<SqliteParams, v8e::Error> {
    if !v8e::is_object(value) { return Ok(SqliteParams::Positional(Vec::new())); }
    if v8e::is_array(value) {
        let length = v8e::to_number(&v8e::get(value, "length")?)? as usize;
        let mut values = Vec::with_capacity(length);
        for index in 0..length { values.push(sqlite_param_of(&v8e::get_index(value, index as u32)?)?); }
        return Ok(SqliteParams::Positional(values));
    }
    let mut entries = Vec::new();
    for key in v8e::own_keys(value)? {
        let item = v8e::get(value, &key)?;
        entries.push((key, sqlite_param_of(&item)?));
    }
    Ok(SqliteParams::Named(entries))
}

#[cfg(feature = "sqlite")]
fn sqlite_value(value: &SqliteValue, safe_integers: bool) -> Result<v8e::Value, v8e::Error> {
    Ok(match value {
        SqliteValue::Null => v8e::null(),
        SqliteValue::Integer(integer) => {
            if safe_integers {
                let big = helper("bigint", "(s) => BigInt(s)");
                v8e::call(&big, None, &[v8e::string(&integer.to_string())])?
            } else {
                v8e::number(*integer as f64)
            }
        }
        SqliteValue::Real(real) => v8e::number(*real),
        SqliteValue::Text(text) => v8e::string(text),
        SqliteValue::Blob(bytes) => v8e::bytes(bytes),
    })
}

#[cfg(feature = "sqlite")]
fn host_sqlite(args: &[v8e::Value]) -> Result<v8e::HostResult, v8e::Error> {
    let operation = arg_string(args, 0)?;
    let number = |index: usize| arg_number(args, index);
    match operation.as_str() {
        "open" => { let filename = arg_string(args, 1)?; let flags = number(2)?; Ok(v8e::HostResult::Number(v8_guard(|| sqlite_open(&filename, flags))?)) }
        "close" => { let id = number(1)?; v8_guard(|| sqlite_close(id))?; Ok(v8e::HostResult::Undefined) }
        "exec" => { let id = number(1)?; let sql = arg_string(args, 2)?; v8_guard(|| sqlite_exec(id, &sql))?; Ok(v8e::HostResult::Undefined) }
        "run" => {
            let id = number(1)?; let sql = arg_string(args, 2)?; let params = sqlite_params_of(&arg(args, 3))?; let safe = number(4)? != 0.0;
            let (changes, rowid) = v8_guard(|| sqlite_run(id, &sql, &params))?;
            host_value(v8e::array(&[v8e::number(changes), sqlite_value(&SqliteValue::Integer(rowid), safe)?]))
        }
        "rows" => {
            let id = number(1)?; let sql = arg_string(args, 2)?; let params = sqlite_params_of(&arg(args, 3))?; let safe = number(4)? != 0.0; let limit = number(5)?.max(0.0) as usize;
            let (columns, rows) = v8_guard(|| sqlite_rows(id, &sql, &params, limit))?;
            let mut out = Vec::with_capacity(rows.len());
            for row in &rows {
                let mut values = Vec::with_capacity(row.len());
                for value in row { values.push(sqlite_value(value, safe)?); }
                out.push(v8e::array(&values));
            }
            let columns: Vec<v8e::Value> = columns.iter().map(|name| v8e::string(name)).collect();
            host_value(v8e::array(&[v8e::array(&columns), v8e::array(&out)]))
        }
        "columns" => { let id = number(1)?; let sql = arg_string(args, 2)?; let columns = v8_guard(|| sqlite_columns(id, &sql))?; let columns: Vec<v8e::Value> = columns.iter().map(|name| v8e::string(name)).collect(); host_value(v8e::array(&columns)) }
        "paramsCount" => { let id = number(1)?; let sql = arg_string(args, 2)?; Ok(v8e::HostResult::Number(v8_guard(|| sqlite_params_count(id, &sql))?)) }
        "serialize" => { let id = number(1)?; Ok(v8e::HostResult::Bytes(v8_guard(|| sqlite_serialize(id))?)) }
        _ => Err(v8e::Error { name: "ReferenceError".to_owned(), message: "unknown island sqlite op".to_owned(), code: None, stack: None, value: None }),
    }
}
