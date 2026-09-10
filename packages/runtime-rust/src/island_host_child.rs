/* The island's CHILD PROCESS bridge: node:child_process over the compiled
 * runtime's own async child unit (child_process_async.rs) and its
 * synchronous capture primitive.
 *
 * The same rules as the socket bridge (island_host_net.rs): a host
 * function only spawns, files listener closures and answers an id; the
 * closures fire later from the child dispatch station on the loop's own
 * turn, re-entering through `island_net_call` (one method on the shim's
 * callbacks object, microtasks drained). Identity is an integer: the
 * realm never holds a Gc handle. Output crosses as Uint8Array chunks;
 * the shim owns the Readable/Writable objects and their encoding.
 */

thread_local! {
    static ISLAND_CHILDREN: RefCell<HashMap<u64, JsChild>> = RefCell::new(HashMap::new());
    static ISLAND_CHILD_NEXT_ID: Cell<u64> = const { Cell::new(0) };
}

fn island_child_next_id() -> u64 {
    ISLAND_CHILD_NEXT_ID.with(|slot| {
        let id = slot.get().checked_add(1).unwrap_or(1);
        slot.set(id);
        id
    })
}

fn island_child(id: u64) -> Option<JsChild> {
    ISLAND_CHILDREN.with(|children| children.borrow().get(&id).cloned())
}

/// Drop every island child on teardown (see island_net_reset).
fn island_child_reset() {
    ISLAND_CHILDREN.with(|children| children.borrow_mut().clear());
}

fn island_child_option_number(options: &boa_engine::JsObject, name: &str, context: &mut Context) -> JsResult<f64> {
    let value = options.get(boa_engine::JsString::from(name), context)?;
    if value.is_undefined() || value.is_null() {
        Ok(0.0)
    } else {
        value.to_number(context)
    }
}

fn island_child_option_string(options: &boa_engine::JsObject, name: &str, context: &mut Context) -> JsResult<JsString> {
    let value = options.get(boa_engine::JsString::from(name), context)?;
    if value.is_undefined() || value.is_null() {
        Ok(JsString::from(""))
    } else {
        Ok(JsString::from(value.to_string(context)?.to_std_string_lossy().as_str()))
    }
}

/// A JavaScript array of strings as a runtime string array.
fn island_child_strings(value: &JsValue, context: &mut Context) -> JsResult<JsArray<JsString>> {
    let mut out: Vec<JsString> = Vec::new();
    if let Some(object) = value.as_object()
        && let Ok(array) = BoaJsArray::from_object(object.clone())
    {
        let length = array.length(context)? as usize;
        for index in 0..length {
            let item = array.get(index as u64, context)?;
            out.push(JsString::from(item.to_string(context)?.to_std_string_lossy().as_str()));
        }
    }
    Ok(array_new(out))
}

fn island_child_exit_arguments(code: Option<f64>, signal: Option<JsString>) -> Vec<JsValue> {
    vec![
        code.map_or(JsValue::null(), JsValue::from),
        signal.map_or(JsValue::null(), |signal| island_host_string(&signal)),
    ]
}

/// File the shim's listeners on a spawned child: stdout/stderr chunks
/// and ends, exit, close, error. Every closure holds the callbacks object
/// (a Boa root) and runs only from the loop.
fn island_child_wire(child: &JsChild, callbacks: &boa_engine::JsObject) {
    for (stream, on_data, on_end) in [
        (child_stdout(child), "onStdout", "onStdoutEnd"),
        (child_stderr(child), "onStderr", "onStderrEnd"),
    ] {
        let Some(stream) = stream else { continue };
        let data_callbacks = callbacks.clone();
        child_stream_on_data(
            &stream,
            Rc::new(move |chunk| {
                island_net_call(&data_callbacks, on_data, |context| {
                    let bytes = BoaJsUint8Array::from_iter(bytes_u8_values(&chunk).iter().copied(), context)
                        .map(JsValue::from)
                        .unwrap_or_else(|error| island_eval_error(error, context));
                    vec![bytes]
                });
            }),
            Rc::new(|_| {}),
            false,
        );
        let end_callbacks = callbacks.clone();
        child_stream_on_end(
            &stream,
            Rc::new(move || {
                island_net_call(&end_callbacks, on_end, |_| Vec::new());
            }),
            Rc::new(|_| {}),
        );
    }
    let exit_callbacks = callbacks.clone();
    child_on_exit(
        child,
        Box::new(move |code, signal| {
            island_net_call(&exit_callbacks, "onExit", |_| island_child_exit_arguments(code, signal.clone()));
        }),
        Box::new(|_| {}),
    );
    let close_callbacks = callbacks.clone();
    child_on_close(
        child,
        Box::new(move |code, signal| {
            island_net_call(&close_callbacks, "onClose", |_| island_child_exit_arguments(code, signal.clone()));
        }),
        Box::new(|_| {}),
    );
    let error_callbacks = callbacks.clone();
    child_on_error(
        child,
        Box::new(move |error| {
            let message = error_message(&error).to_string();
            let code = error.code.clone().unwrap_or_default();
            island_net_call(&error_callbacks, "onError", |_| {
                vec![
                    JsValue::from(boa_engine::JsString::from(message.as_str())),
                    JsValue::from(boa_engine::JsString::from(code.as_str())),
                ]
            });
        }),
        Box::new(|_| {}),
    );
}

/// `host.childSpawn(command, args, options, callbacks)` → `[id, pid]`.
///
/// options: stdin/stdout/stderr modes (0 ignore, 1 inherit, 2 fd, 3
/// pipe), stdoutFd/stderrFd, cwd, env (flat [name, value, ...] array or
/// absent for the parent's), detached.
fn island_host_child_spawn(
    _this: &JsValue,
    arguments: &[JsValue],
    context: &mut Context,
) -> JsResult<JsValue> {
    let command: JsString = JsString::from(island_host_arg_string(arguments, 0, context)?.as_str());
    let args = island_child_strings(&island_host_arg(arguments, 1), context)?;
    let options = island_host_arg(arguments, 2)
        .as_object()
        .unwrap_or_else(boa_engine::JsObject::with_null_proto);
    let callbacks = island_net_arg_callbacks(arguments, 3)?;
    let stdin = island_child_option_number(&options, "stdin", context)?;
    let stdout = island_child_option_number(&options, "stdout", context)?;
    let stderr = island_child_option_number(&options, "stderr", context)?;
    let stdout_fd = island_child_option_number(&options, "stdoutFd", context)?;
    let stderr_fd = island_child_option_number(&options, "stderrFd", context)?;
    let detached = island_child_option_number(&options, "detached", context)? != 0.0;
    let cwd = island_child_option_string(&options, "cwd", context)?;
    let env_value = options.get(boa_engine::JsString::from("env"), context)?;
    let has_env = !(env_value.is_undefined() || env_value.is_null());
    let env_pairs = island_child_strings(&env_value, context)?;
    let child = child_spawn_options(
        &command, &args, stdin, stdout, stderr, stdout_fd, stderr_fd, detached, has_env, &env_pairs, &cwd,
    );
    let id = island_child_next_id();
    if std::env::var_os("SCRIPTC_ISLAND_TRACE").is_some() {
        eprintln!(
            "scriptc island: spawn #{id} {command} {:?} (pid {:?}, exit {:?})",
            args.with(|args| args.elements().iter().map(|value| value.to_string()).collect::<Vec<_>>()),
            child_pid(&child),
            child_exit_code(&child)
        );
    }
    ISLAND_CHILDREN.with(|children| {
        children.borrow_mut().insert(id, child.clone());
    });
    island_child_wire(&child, &callbacks);
    let pid = child_pid(&child).map_or(JsValue::null(), JsValue::from);
    Ok(BoaJsArray::from_iter([JsValue::from(id as f64), pid], context).into())
}

/// `host.childKill(id, signal)` → whether the signal was sent.
fn island_host_child_kill(
    _this: &JsValue,
    arguments: &[JsValue],
    context: &mut Context,
) -> JsResult<JsValue> {
    let Some(child) = island_child(island_net_arg_id(arguments, 0)) else {
        return Ok(JsValue::from(false));
    };
    let signal: JsString = JsString::from(island_host_arg_string(arguments, 1, context)?.as_str());
    Ok(JsValue::from(island_host_run(|| child_kill(&child, &signal), context)?))
}

/// `host.childStdinWrite(id, bytes)` → false once stdin is gone.
fn island_host_child_stdin_write(
    _this: &JsValue,
    arguments: &[JsValue],
    context: &mut Context,
) -> JsResult<JsValue> {
    let Some(child) = island_child(island_net_arg_id(arguments, 0)) else {
        return Ok(JsValue::from(false));
    };
    let bytes = island_host_arg_bytes(arguments, 1, context)?;
    Ok(JsValue::from(child_stdin_write(&child, &bytes)))
}

/// `host.childStdinEnd(id)`.
fn island_host_child_stdin_end(
    _this: &JsValue,
    arguments: &[JsValue],
    _context: &mut Context,
) -> JsResult<JsValue> {
    if let Some(child) = island_child(island_net_arg_id(arguments, 0)) {
        child_stdin_end(&child);
    }
    Ok(JsValue::undefined())
}

/// `host.childUnref(id)`: the child stops keeping the loop alive.
fn island_host_child_unref(
    _this: &JsValue,
    arguments: &[JsValue],
    _context: &mut Context,
) -> JsResult<JsValue> {
    if let Some(child) = island_child(island_net_arg_id(arguments, 0)) {
        child_unref(&child);
    }
    Ok(JsValue::undefined())
}

/// `host.childSpawnSync(command, args, options)` →
/// `[status, signal, stdout, stderr, errorMessage, errorCode]` over the
/// runtime's synchronous spawn (cwd, env, timeout, killSignal, the
/// shim's stdio modes: 0 ignore, 1 inherit, 3 pipe). A non-zero exit is
/// a status, never a throw. Output crosses as text (the primitive's
/// contract); the shim re-encodes.
fn island_host_child_spawn_sync(
    _this: &JsValue,
    arguments: &[JsValue],
    context: &mut Context,
) -> JsResult<JsValue> {
    let command: JsString = JsString::from(island_host_arg_string(arguments, 0, context)?.as_str());
    let args = island_child_strings(&island_host_arg(arguments, 1), context)?;
    let options = island_host_arg(arguments, 2)
        .as_object()
        .unwrap_or_else(boa_engine::JsObject::with_null_proto);
    let cwd = island_child_option_string(&options, "cwd", context)?;
    let timeout = island_child_option_number(&options, "timeout", context)?;
    let kill_signal = island_child_option_string(&options, "killSignal", context)?;
    let sync_mode = |mode: f64| match mode as i32 {
        0 => 1.0,
        1 => 2.0,
        _ => 0.0,
    };
    let stdin = if island_child_option_number(&options, "stdin", context)? as i32 == 1 { 2.0 } else { 0.0 };
    let stdout = sync_mode(island_child_option_number(&options, "stdout", context)?);
    let stderr = sync_mode(island_child_option_number(&options, "stderr", context)?);
    let env_value = options.get(boa_engine::JsString::from("env"), context)?;
    let has_env = !(env_value.is_undefined() || env_value.is_null());
    let env_pairs = island_child_strings(&env_value, context)?;
    let result = island_host_run(
        || {
            child_spawn_sync_full(
                &command,
                &args,
                timeout,
                &kill_signal,
                stdin,
                stdout,
                stderr,
                has_env.then_some(&env_pairs),
                &cwd,
            )
        },
        context,
    )?;
    let status = spawn_result_status(&result).map_or(JsValue::null(), JsValue::from);
    let signal = spawn_result_signal(&result).map_or(JsValue::null(), |signal| island_host_string(&signal));
    let stdout = island_host_string(&spawn_result_stdout(&result));
    let stderr = island_host_string(&spawn_result_stderr(&result));
    let (message, code) = match spawn_result_error(&result) {
        Some(error) => (
            JsValue::from(boa_engine::JsString::from(error_message(&error).to_string().as_str())),
            JsValue::from(boa_engine::JsString::from(error.code.clone().unwrap_or_default().as_str())),
        ),
        None => (JsValue::null(), JsValue::null()),
    };
    Ok(BoaJsArray::from_iter([status, signal, stdout, stderr, message, code], context).into())
}
