/* The host bridge the island's shared JavaScript bootstrap calls.
 *
 * packages/runtime/src/island-js/ is engine-agnostic: every place a shim
 * must reach outside JavaScript it calls `host.x(...)`, and this file is
 * the Rust answer to the same calls the C island answers in scr_island.c.
 * The two must agree on SHAPES, not just names — `host.env()` is an
 * object, `host.hrtime()` is `[seconds, nanoseconds]`, `host.versions()`
 * is `[node, openssl]`, `host.promiseState(p)` is `[state, result]` —
 * because one body of JavaScript reads both.
 *
 * Every function here delegates to a runtime primitive the static lane
 * already uses, so the island and compiled code answer identically: the
 * island's `process.cwd()` and a generated `process.cwd()` are the same
 * `process_cwd`.
 */

/// `arguments[index]`, or `undefined` past the end.
fn island_host_arg(arguments: &[JsValue], index: usize) -> JsValue {
    arguments
        .get(index)
        .cloned()
        .unwrap_or_else(JsValue::undefined)
}

/// `arguments[index]` as an owned Rust string.
fn island_host_arg_string(
    arguments: &[JsValue],
    index: usize,
    context: &mut Context,
) -> JsResult<String> {
    Ok(island_host_arg(arguments, index)
        .to_string(context)?
        .to_std_string_lossy())
}

/// `arguments[index]` as a number, with `undefined` reading as 0.
fn island_host_arg_number(
    arguments: &[JsValue],
    index: usize,
    context: &mut Context,
) -> JsResult<f64> {
    island_host_arg(arguments, index).to_number(context)
}

/// A crate `JsString` as an engine string value.
fn island_host_string(value: &JsString) -> JsValue {
    JsValue::from(boa_engine::JsString::from(&**value))
}

/// A crate string array as an engine array value.
fn island_host_string_array(values: &JsArray<JsString>, context: &mut Context) -> JsValue {
    let length = array_len(values) as usize;
    let items = (0..length).map(|index| island_host_string(&array_get(values, index as f64)));
    BoaJsArray::from_iter(items, context).into()
}

/* ── process ───────────────────────────────────────────────────────── */

fn island_host_platform(
    _this: &JsValue,
    _arguments: &[JsValue],
    _c: &mut Context,
) -> JsResult<JsValue> {
    Ok(island_host_string(&process_platform()))
}

fn island_host_pid(_this: &JsValue, _arguments: &[JsValue], _c: &mut Context) -> JsResult<JsValue> {
    Ok(JsValue::from(process_pid()))
}

fn island_host_cwd(_this: &JsValue, _arguments: &[JsValue], _c: &mut Context) -> JsResult<JsValue> {
    Ok(island_host_string(&process_cwd()))
}

fn island_host_argv(
    _this: &JsValue,
    _arguments: &[JsValue],
    context: &mut Context,
) -> JsResult<JsValue> {
    Ok(island_host_string_array(&process_argv(), context))
}

/// `host.env()` → a plain object, the same snapshot the static lane's
/// `process.env` builds from (the flat key/value pairs, overrides merged).
fn island_host_env(
    _this: &JsValue,
    _arguments: &[JsValue],
    context: &mut Context,
) -> JsResult<JsValue> {
    let pairs = process_env_pairs();
    let length = array_len(&pairs) as usize;
    let mut environment = ObjectInitializer::new(context);
    for index in (0..length.saturating_sub(1)).step_by(2) {
        let key = array_get(&pairs, index as f64);
        let value = array_get(&pairs, (index + 1) as f64);
        environment.property(
            boa_engine::JsString::from(&*key),
            island_host_string(&value),
            Attribute::WRITABLE | Attribute::ENUMERABLE | Attribute::CONFIGURABLE,
        );
    }
    Ok(environment.build().into())
}

fn island_host_exit(
    _this: &JsValue,
    arguments: &[JsValue],
    context: &mut Context,
) -> JsResult<JsValue> {
    process_exit(island_host_arg_number(arguments, 0, context)?)
}

fn island_host_set_exit_code(
    _this: &JsValue,
    arguments: &[JsValue],
    context: &mut Context,
) -> JsResult<JsValue> {
    process_exit_code_set(island_host_arg_number(arguments, 0, context)?);
    Ok(JsValue::undefined())
}

/// `host.hrtime()` → `[seconds, nanoseconds]` off the process-start
/// monotonic clock — the same source `process.uptime()` reads, so the
/// island's `process.hrtime()` and `process.uptime()` cannot disagree.
fn island_host_hrtime(
    _this: &JsValue,
    _arguments: &[JsValue],
    context: &mut Context,
) -> JsResult<JsValue> {
    let elapsed = process_elapsed();
    let parts = [
        JsValue::from(elapsed.as_secs() as f64),
        JsValue::from(f64::from(elapsed.subsec_nanos())),
    ];
    Ok(BoaJsArray::from_iter(parts, context).into())
}

fn island_host_isatty(
    _this: &JsValue,
    arguments: &[JsValue],
    context: &mut Context,
) -> JsResult<JsValue> {
    let fd = island_host_arg_number(arguments, 0, context)?;
    Ok(JsValue::from(process_is_tty(fd)))
}

/// `host.columns(fd)` → the terminal width, or `undefined` when the fd is
/// not a terminal (which is what makes `process.stdout.columns` absent).
fn island_host_columns(
    _this: &JsValue,
    arguments: &[JsValue],
    context: &mut Context,
) -> JsResult<JsValue> {
    let fd = island_host_arg_number(arguments, 0, context)?;
    Ok(process_columns(fd).map_or_else(JsValue::undefined, JsValue::from))
}

/// `host.umask()` reads without setting: the runtime's `process_umask`
/// treats a negative mask as the query, exactly as the C island's
/// `umask(0)`-then-restore does.
fn island_host_umask(
    _this: &JsValue,
    _arguments: &[JsValue],
    _c: &mut Context,
) -> JsResult<JsValue> {
    Ok(JsValue::from(process_umask(-1.0)))
}

fn island_host_versions(
    _this: &JsValue,
    _arguments: &[JsValue],
    context: &mut Context,
) -> JsResult<JsValue> {
    let parts = [
        island_host_string(&process_versions_node()),
        island_host_string(&process_versions_openssl()),
    ];
    Ok(BoaJsArray::from_iter(parts, context).into())
}

/// `host.write(fd, text)` — fd 2 is stderr, everything else stdout, the
/// same split the C island makes and the same writers generated code uses.
fn island_host_write(
    _this: &JsValue,
    arguments: &[JsValue],
    context: &mut Context,
) -> JsResult<JsValue> {
    let fd = island_host_arg_number(arguments, 0, context)?;
    let text: JsString = Rc::from(island_host_arg_string(arguments, 1, context)?.as_str());
    if fd == 2.0 {
        process_stderr_write(&text);
    } else {
        process_stdout_write(&text);
    }
    Ok(JsValue::undefined())
}

/// `host.readStdin()` drains stdin to end — the island's stdin is the
/// synchronous read, because it has no event source to stream one.
fn island_host_read_stdin(
    _this: &JsValue,
    _arguments: &[JsValue],
    _c: &mut Context,
) -> JsResult<JsValue> {
    let encoding: JsString = Rc::from("utf8");
    Ok(island_host_string(&fs_read_fd(0.0, &encoding)))
}

/* ── util.inspect's one engine question ────────────────────────────── */

/// `host.promiseState(p)` → `[state, result]`, with state 0 pending,
/// 1 fulfilled, 2 rejected — QuickJS's `JSPromiseStateEnum` ordering,
/// which the shared `util.inspect` reads. A non-promise answers
/// `undefined`, which is how inspect tells promises from other objects.
fn island_host_promise_state(
    _this: &JsValue,
    arguments: &[JsValue],
    context: &mut Context,
) -> JsResult<JsValue> {
    let value = island_host_arg(arguments, 0);
    let Some(object) = value.as_object() else {
        return Ok(JsValue::undefined());
    };
    let Ok(promise) = BoaJsPromise::from_object(object) else {
        return Ok(JsValue::undefined());
    };
    let (state, result) = match promise.state() {
        BoaPromiseState::Pending => (0, JsValue::undefined()),
        BoaPromiseState::Fulfilled(value) => (1, value),
        BoaPromiseState::Rejected(reason) => (2, reason),
    };
    Ok(BoaJsArray::from_iter([JsValue::from(state), result], context).into())
}

/* ── path ──────────────────────────────────────────────────────────── */

/// `host.path(op, win32, ...)` — the path shim keeps parse/format and the
/// separators in JavaScript and delegates the resolving operations here,
/// so both islands and compiled code share ONE implementation of Node's
/// path algebra (`path_*` for posix, `path_win32_*` for win32).
fn island_host_path(
    _this: &JsValue,
    arguments: &[JsValue],
    context: &mut Context,
) -> JsResult<JsValue> {
    let operation = island_host_arg_string(arguments, 0, context)?;
    let win32 = island_host_arg(arguments, 1).to_boolean();
    let text = |index: usize, context: &mut Context| -> JsResult<JsString> {
        Ok(Rc::from(
            island_host_arg_string(arguments, index, context)?.as_str(),
        ))
    };
    let parts = |context: &mut Context| -> JsResult<JsArray<JsString>> {
        let value = island_host_arg(arguments, 2);
        let array = BoaJsArray::from_object(value.as_object().ok_or_else(|| {
            boa_engine::JsNativeError::typ().with_message("host.path expects an argument list")
        })?)?;
        let length = array.length(context)?;
        let mut items = Vec::with_capacity(length as usize);
        for index in 0..length {
            items.push(Rc::from(
                array.at(index as i64, context)?.to_string(context)?.to_std_string_lossy().as_str(),
            ));
        }
        Ok(array_new(items))
    };
    let answer = match (operation.as_str(), win32) {
        ("join", false) => island_host_string(&path_join(&parts(context)?)),
        ("join", true) => island_host_string(&path_win32_join(&parts(context)?)),
        ("resolve", false) => island_host_string(&path_resolve(&parts(context)?)),
        ("resolve", true) => island_host_string(&path_win32_resolve(&parts(context)?)),
        ("normalize", false) => island_host_string(&path_normalize(&text(2, context)?)),
        ("normalize", true) => island_host_string(&path_win32_normalize(&text(2, context)?)),
        ("dirname", false) => island_host_string(&path_dirname(&text(2, context)?)),
        ("dirname", true) => island_host_string(&path_win32_dirname(&text(2, context)?)),
        ("basename", false) => {
            island_host_string(&path_basename(&text(2, context)?, &text(3, context)?))
        }
        ("basename", true) => {
            island_host_string(&path_win32_basename(&text(2, context)?, &text(3, context)?))
        }
        ("extname", false) => island_host_string(&path_extname(&text(2, context)?)),
        ("extname", true) => island_host_string(&path_win32_extname(&text(2, context)?)),
        ("isAbsolute", false) => JsValue::from(path_is_absolute(&text(2, context)?)),
        ("isAbsolute", true) => JsValue::from(path_win32_is_absolute(&text(2, context)?)),
        ("relative", false) => {
            island_host_string(&path_relative(&text(2, context)?, &text(3, context)?))
        }
        ("relative", true) => {
            island_host_string(&path_win32_relative(&text(2, context)?, &text(3, context)?))
        }
        // Node's posix toNamespacedPath is the identity.
        ("toNamespacedPath", false) => island_host_string(&text(2, context)?),
        ("toNamespacedPath", true) => {
            island_host_string(&path_win32_to_namespaced_path(&text(2, context)?))
        }
        _ => {
            return Err(boa_engine::JsNativeError::typ()
                .with_message(format!("the island has no path operation '{operation}'"))
                .into());
        }
    };
    Ok(answer)
}

/* ── URL file-path bridge ─────────────────────────────────────────── */

fn island_host_url_to_path(
    _this: &JsValue,
    arguments: &[JsValue],
    context: &mut Context,
) -> JsResult<JsValue> {
    let value: JsString = Rc::from(island_host_arg_string(arguments, 0, context)?.as_str());
    Ok(island_host_string(&url_string_to_path(&value)))
}

fn island_host_url_from_path(
    _this: &JsValue,
    arguments: &[JsValue],
    context: &mut Context,
) -> JsResult<JsValue> {
    let value: JsString = Rc::from(island_host_arg_string(arguments, 0, context)?.as_str());
    Ok(island_host_string(&url_href(&url_path_to_file_url(&value))))
}

/* ── the bridge object ─────────────────────────────────────────────── */

/// One `host` member: the JavaScript name, the Rust answer, and the
/// arity the shared bootstrap calls it with.
type IslandHostMember = (
    &'static str,
    fn(&JsValue, &[JsValue], &mut Context) -> JsResult<JsValue>,
    usize,
);

/// Every name the realm's JavaScript calls on `host` — the shared
/// bootstrap's `rust` manifest, plus the web prelude (island_web.js),
/// which is handed this same object.
///
/// `source` and `resolve` come from the module tables
/// (island_modules.rs), and the I/O members — fs, crypto, zlib, os —
/// from island_host_io.rs; everything else is this file. A name the shared
/// JavaScript calls but this table lacks is a TypeError at the CALL —
/// which is exactly why the manifest lists only parts whose host surface
/// is complete here.
const ISLAND_HOST_MEMBERS: [IslandHostMember; 66] = [
    ("source", island_host_source, 1),
    ("resolve", island_host_resolve, 2),
    ("platform", island_host_platform, 0),
    ("pid", island_host_pid, 0),
    ("cwd", island_host_cwd, 0),
    ("argv", island_host_argv, 0),
    ("env", island_host_env, 0),
    ("exit", island_host_exit, 1),
    ("setExitCode", island_host_set_exit_code, 1),
    ("hrtime", island_host_hrtime, 0),
    ("isatty", island_host_isatty, 1),
    ("columns", island_host_columns, 1),
    ("umask", island_host_umask, 0),
    ("versions", island_host_versions, 0),
    ("write", island_host_write, 2),
    ("readStdin", island_host_read_stdin, 0),
    ("promiseState", island_host_promise_state, 1),
    ("path", island_host_path, 4),
    ("urlToPath", island_host_url_to_path, 1),
    ("urlFromPath", island_host_url_from_path, 1),
    ("urlResolve", island_host_url_resolve, 2),
    // The I/O bridge (island_host_io.rs): the arities match the C
    // island's registrations, because one body of JavaScript calls both.
    ("fs", island_host_fs, 4),
    ("fsConstants", island_host_fs_constants, 0),
    ("digest", island_host_digest, 2),
    ("hmac", island_host_hmac, 3),
    ("fetch", island_host_fetch, 4),
    ("cancelFetch", island_host_fetch_cancel, 1),
    // The web prelude's randomness (island_web.js builds globalThis.crypto
    // over these); the C island registers the same pair as `fill`/`uuid`
    // on its own web host object.
    ("random", island_host_random, 1),
    ("uuid", island_host_uuid, 0),
    // The timer bridge the web prelude builds its Timeout class over.
    // Rust additionally carries Node's ref/unref liveness through to the
    // shared native timer heap.
    ("setTimer", island_timer_set, 3),
    ("clearTimer", island_timer_clear, 1),
    ("setTimerRef", island_timer_set_ref, 2),
    ("timerHasRef", island_timer_has_ref, 1),
    ("zlib", island_host_zlib, 4),
    ("arch", island_host_arch, 0),
    ("hostname", island_host_hostname, 0),
    ("homedir", island_host_homedir, 0),
    ("tmpdir", island_host_tmpdir, 0),
    ("ids", island_host_ids, 0),
    ("signals", island_host_signals, 0),
    // The SOCKET bridge (island_host_net.rs). Its presence is what opens
    // the shared bootstrap's real node:net — a build without it keeps the
    // load-but-fence shim, which is the honest answer, not a silent one.
    ("netConnect", island_host_net_connect, 3),
    ("netWrite", island_host_net_write, 2),
    ("netEnd", island_host_net_end, 2),
    ("netDestroy", island_host_net_destroy, 1),
    ("netFlow", island_host_net_flow, 2),
    ("netOption", island_host_net_option, 3),
    ("netPeer", island_host_net_peer, 1),
    ("netLocal", island_host_net_local, 1),
    ("netServerCreate", island_host_net_server_create, 1),
    ("netServerListen", island_host_net_server_listen, 3),
    ("netServerAddress", island_host_net_server_address, 1),
    ("netServerClose", island_host_net_server_close, 1),
    // The node:http SERVER leg, on the same registry: `srvListen`,
    // `srvAddress` and `srvClose` ARE the net ones, because an http
    // server is a net server that dispatches parsed requests.
    ("srvCreate", island_host_srv_create, 1),
    ("srvListen", island_host_net_server_listen, 3),
    ("srvAddress", island_host_net_server_address, 1),
    ("srvPort", island_host_srv_port, 1),
    ("srvClose", island_host_net_server_close, 1),
    ("srvResHead", island_host_srv_res_head, 4),
    ("srvResWrite", island_host_srv_res_write, 2),
    ("srvResEnd", island_host_srv_res_end, 2),
    ("srvResDestroy", island_host_srv_res_destroy, 1),
    // The node:http CLIENT leg. Its presence is what opens the shim's
    // `request`/`get` (and registers node:https, whose own requests still
    // fence — TLS is the leg after this one).
    ("httpStart", island_host_http_start, 8),
    ("httpWrite", island_host_http_write, 2),
    ("httpEnd", island_host_http_end, 2),
    ("httpDestroy", island_host_http_destroy, 1),
    ("httpSetTimeout", island_host_http_set_timeout, 2),
];

/// Build the `host` object the bootstrap arrow is called with.
pub(crate) fn island_host_object(context: &mut Context) -> boa_engine::JsObject {
    let mut host = ObjectInitializer::new(context);
    for (name, function, arity) in ISLAND_HOST_MEMBERS {
        host.function(
            NativeFunction::from_fn_ptr(function),
            boa_engine::JsString::from(name),
            arity,
        );
    }
    host.build()
}
