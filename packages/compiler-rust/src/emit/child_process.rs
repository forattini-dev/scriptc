//! Builtin function bodies dispatch to asynchronous native process primitives.
use super::*;
use std::fmt::Write;

pub(super) fn definitions(module: &Emission<'_>, out: &mut String) {
    let mut result = None;
    let mut used = false;
    let mut spawn_sync = false;
    let mut exec_file_sync = false;
    let mut bun_stdin_write = false;
    let mut child_spawn = false;
    let mut child_listener = false;
    let mut child_stdin_callback = false;
    module.visit_expressions(&mut |expr| {
        if let Expr::LibCall { r#fn, r#type, .. } = expr {
            used |= matches!(
                r#fn.as_str(),
                "cp.execFileNative" | "cp.execFilePromise" | "cp.execNative" | "cp.execPromise"
            );
            spawn_sync |= matches!(r#fn.as_str(), "cp.spawnSyncUtf8" | "bun.spawnSync");
            exec_file_sync |= r#fn == "cp.execFileSyncUtf8";
            bun_stdin_write |= r#fn == "bun.stdinWrite";
            child_spawn |= r#fn == "cp.spawn";
            child_listener |= matches!(r#fn.as_str(), "child.on" | "child.once");
            child_stdin_callback |= r#fn == "child.stdinWriteCallback";
            if matches!(r#fn.as_str(), "cp.execFilePromise" | "cp.execPromise")
                && let Type::Promise { inner } = r#type
            {
                result = Some((**inner).clone());
            }
        }
    });
    if bun_stdin_write {
        out.push_str("fn native_bun_stdin_write(child: runtime::JsChild, value: NativeValue) -> bool { match value { NativeValue::String(value) => runtime::child_stdin(&child).is_some_and(|writer| runtime::child_writer_write_string(&writer, &value)),\n");
        for (index, ty) in values::types(module).iter().enumerate() {
            if *ty == Type::bytes() {
                writeln!(
                    out,
                    "NativeValue::V{index}(value) => runtime::child_stdin_write(&child, &value),"
                )
                .unwrap();
            }
        }
        out.push_str("_ => runtime::throw_type_error(\"Bun subprocess stdin.write requires a string or Uint8Array\".into()), } }\n");
    }
    if child_spawn {
        out.push_str(r#"
fn native_child_stdio_mode(value: NativeValue, default: f64) -> f64 {
    match value {
        NativeValue::Undefined => default,
        NativeValue::String(value) if value == "ignore" => 0.0,
        NativeValue::String(value) if value == "inherit" => 1.0,
        NativeValue::String(value) if value == "pipe" => 3.0,
        _ => runtime::throw_type_error("child_process.spawn stdio must be pipe, ignore, or inherit".into()),
    }
}
fn native_child_spawn(command: runtime::JsString, args: runtime::JsArray<runtime::JsString>, options: NativeValue) -> runtime::JsChild {
    let option = |name: &str| if matches!(options, NativeValue::Undefined) { NativeValue::Undefined } else { native_value_get(options.clone(), runtime::string(name)) };
    let cwd = match option("cwd") {
        NativeValue::Undefined => runtime::string(""),
        NativeValue::String(value) => value,
        _ => runtime::throw_type_error("child_process.spawn cwd must be a string".into()),
    };
    let environment = option("env");
    let has_env = !matches!(environment, NativeValue::Undefined);
    let mut pairs = Vec::new();
    if has_env {
        for key in native_value_own_keys(&environment) {
            let value = native_value_get(environment.clone(), key.clone());
            if matches!(value, NativeValue::Undefined) { continue; }
            pairs.push(key);
            pairs.push(native_value_string(value));
        }
    }
    let boolean = |name: &str| match option(name) {
        NativeValue::Undefined | NativeValue::Boolean(false) => false,
        NativeValue::Boolean(true) => true,
        _ => runtime::throw_type_error(format!("child_process.spawn {name} must be a boolean")),
    };
    let stdio = option("stdio");
    let (stdin_mode, stdout_mode, stderr_mode) = if native_value_is_array(&stdio) {
        let modes = native_value_apply_arguments(&stdio);
        if modes.len() != 3 {
            runtime::throw_type_error("child_process.spawn stdio array requires three entries".into());
        }
        (
            native_child_stdio_mode(modes[0].clone(), 3.0),
            native_child_stdio_mode(modes[1].clone(), 3.0),
            native_child_stdio_mode(modes[2].clone(), 3.0),
        )
    } else {
        let mode = native_child_stdio_mode(stdio, 3.0);
        (mode, mode, mode)
    };
    runtime::child_spawn_node_options(
        &command,
        &args,
        stdin_mode,
        stdout_mode,
        stderr_mode,
        boolean("detached"),
        has_env,
        &runtime::array_new(pairs),
        &cwd,
        boolean("windowsHide"),
        boolean("shell"),
    )
}
"#);
    }
    if child_listener {
        out.push_str(r#"
fn native_child_listener(child: runtime::JsChild, event: runtime::JsString, callback: NativeValue, _once: bool) -> runtime::JsChild {
    if !native_value_is_function(&callback) {
        runtime::throw_type_error("The listener argument must be of type function".into());
    }
    match event.well_formed_utf8().unwrap_or("") {
        "exit" | "close" => {
            let invoke = callback.clone();
            let traced = callback.clone();
            let listener = std::rc::Rc::new(move |code: Option<f64>, signal: Option<runtime::JsString>| {
                let code = code.map(NativeValue::Number).unwrap_or(NativeValue::Null);
                let signal = signal.map(NativeValue::String).unwrap_or(NativeValue::Null);
                let _ = native_value_call(invoke.clone(), vec![code, signal], "ChildProcess listener");
            });
            let trace = std::rc::Rc::new(move |tracer: &mut runtime::Tracer| traced.trace_native(tracer));
            if event == "exit" { runtime::child_on_exit(&child, listener, trace); }
            else { runtime::child_on_close(&child, listener, trace); }
        }
        "error" => {
            let invoke = callback.clone();
            let traced = callback.clone();
            runtime::child_on_error(
                &child,
                std::rc::Rc::new(move |error| { let _ = native_value_call(invoke.clone(), vec![native_caught(runtime::caught_value(error))], "ChildProcess error listener"); }),
                std::rc::Rc::new(move |tracer| traced.trace_native(tracer)),
            );
        }
        name => runtime::throw_type_error(format!("scriptc: ChildProcess event '{name}' is not supported")),
    }
    child
}
"#);
    }
    if child_stdin_callback {
        out.push_str(r#"
fn native_child_stdin_write_callback(child: runtime::JsChild, bytes: runtime::JsBytes<u8>, callback: NativeValue) -> bool {
    if !native_value_is_function(&callback) {
        runtime::throw_type_error("ChildProcess stdin write callback must be a function".into());
    }
    let invoked = callback.clone();
    let traced = callback.clone();
    runtime::child_stdin_write_callback(
        &child,
        &bytes,
        std::rc::Rc::new(move |error| {
            let argument = error.map(|error| native_caught(runtime::caught_value(error))).unwrap_or(NativeValue::Undefined);
            let _ = native_value_call(invoked.clone(), vec![argument], "ChildProcess stdin write callback");
        }),
        std::rc::Rc::new(move |tracer| traced.trace_native(tracer)),
    )
}
"#);
    }
    if spawn_sync || exec_file_sync {
        out.push_str(r#"
fn native_sync_stdio_mode(value: NativeValue, default: f64) -> f64 {
    match value {
        NativeValue::Undefined => default,
        NativeValue::String(value) if value == "pipe" => 0.0,
        NativeValue::String(value) if value == "ignore" => 1.0,
        NativeValue::String(value) if value == "inherit" => 2.0,
        _ => runtime::throw_type_error("child process stdio must be pipe, ignore, or inherit".into()),
    }
}
fn native_spawn_sync_utf8(command: runtime::JsString, args: runtime::JsArray<runtime::JsString>, options: NativeValue) -> NativeValue {
    let buffer_output = match native_value_get(options.clone(), runtime::string("encoding")) {
        NativeValue::String(value) if value == "buffer" => true,
        _ => false,
    };
    let input = match native_value_get(options.clone(), runtime::string("input")) {
        NativeValue::Undefined | NativeValue::Null => None,
        NativeValue::String(value) => Some(runtime::buffer_from_string(&value, &runtime::string("utf8"))),
        value => Some(native_file_handle_bytes(value).unwrap_or_else(|| runtime::throw_type_error("spawnSync input must be a string or Buffer".into()))),
    };
    let cwd = match native_value_get(options.clone(), runtime::string("cwd")) {
        NativeValue::Undefined => runtime::string(""),
        NativeValue::String(value) => value,
        _ => runtime::throw_type_error("spawnSync cwd must be a string".into()),
    };
    let environment = native_value_get(options.clone(), runtime::string("env"));
    let pairs = if matches!(environment, NativeValue::Undefined) { None } else {
        let mut pairs = Vec::new();
        for key in native_value_own_keys(&environment) {
            let value = native_value_get(environment.clone(), key.clone());
            if matches!(value, NativeValue::Undefined) { continue; }
            pairs.push(key);
            pairs.push(native_value_string(value));
        }
        Some(runtime::array_new(pairs))
    };
    let timeout = match native_value_get(options.clone(), runtime::string("timeout")) {
        NativeValue::Undefined => 0.0,
        NativeValue::Number(value) => value,
        _ => runtime::throw_type_error("spawnSync timeout must be a number".into()),
    };
    let kill_signal = match native_value_get(options.clone(), runtime::string("killSignal")) {
        NativeValue::Undefined => runtime::string("SIGTERM"),
        NativeValue::String(value) => value,
        _ => runtime::throw_type_error("spawnSync killSignal must be a string".into()),
    };
    let max_buffer = match native_value_get(options.clone(), runtime::string("maxBuffer")) {
        NativeValue::Undefined => 1_048_576.0,
        NativeValue::Number(value) if value.is_finite() && value >= 0.0 => value,
        _ => runtime::throw_type_error("spawnSync maxBuffer must be a finite nonnegative number".into()),
    };
    let stdio = native_value_get(options.clone(), runtime::string("stdio"));
    let (stdin_mode, stdout_mode, stderr_mode) = if native_value_test(&stdio, "array") {
        (
            native_sync_stdio_mode(native_value_get(stdio.clone(), runtime::string("0")), 0.0),
            native_sync_stdio_mode(native_value_get(stdio.clone(), runtime::string("1")), 0.0),
            native_sync_stdio_mode(native_value_get(stdio, runtime::string("2")), 0.0),
        )
    } else {
        let mode = native_sync_stdio_mode(stdio, 0.0);
        (mode, mode, mode)
    };
    let shell = match native_value_get(options, runtime::string("shell")) {
        NativeValue::Undefined | NativeValue::Boolean(false) => false,
        NativeValue::Boolean(true) => true,
        _ => runtime::throw_type_error("spawnSync shell must be a boolean".into()),
    };
    let (command, args) = if shell {
        #[cfg(windows)]
        {
            (runtime::string("cmd.exe"), runtime::array_new(vec![runtime::string("/d"), runtime::string("/s"), runtime::string("/c"), command]))
        }
        #[cfg(not(windows))]
        {
            (runtime::string("sh"), runtime::array_new(vec![runtime::string("-c"), command]))
        }
    } else {
        (command, args)
    };
    let result = runtime::child_spawn_sync_full_input(&command, &args, timeout, &kill_signal, stdin_mode, stdout_mode, stderr_mode, pairs.as_ref(), &cwd, input.as_ref(), max_buffer);
    let error = runtime::spawn_result_error(&result);
    let fields = vec![
        (runtime::string("status"), runtime::spawn_result_status(&result).map(NativeValue::Number).unwrap_or(NativeValue::Null)),
        (runtime::string("signal"), runtime::spawn_result_signal(&result).map(NativeValue::String).unwrap_or(NativeValue::Null)),
        (runtime::string("stdout"), if stdout_mode == 1.0 || stdout_mode == 2.0 { NativeValue::Null } else if buffer_output { native_box_web_bytes(runtime::buffer_from_bytes(&runtime::spawn_result_stdout_bytes(&result))) } else { NativeValue::String(runtime::spawn_result_stdout(&result)) }),
        (runtime::string("stderr"), if stderr_mode == 1.0 || stderr_mode == 2.0 { NativeValue::Null } else if buffer_output { native_box_web_bytes(runtime::buffer_from_bytes(&runtime::spawn_result_stderr_bytes(&result))) } else { NativeValue::String(runtime::spawn_result_stderr(&result)) }),
        (runtime::string("error"), error.map(|error| native_caught(runtime::caught_value(error))).unwrap_or(NativeValue::Undefined)),
    ];
    NativeValue::Object(runtime::Gc::new(NativeMap { null_prototype: false, symbol_properties: None, entries: fields, hash_index: NativeHashIndex::default() }))
}
fn native_bun_spawn_sync(argv: runtime::JsArray<runtime::JsString>, stdin: f64, stdout: f64, stderr: f64) -> NativeValue {
    let length = runtime::array_len(&argv) as usize;
    if length == 0 {
        runtime::throw_type_error("cmd must not be empty".into());
    }
    let command = runtime::array_get(&argv, 0.0);
    let arguments = runtime::array_new((1..length).map(|index| runtime::array_get(&argv, index as f64)).collect());
    let input_mode = if stdin == 1.0 { 2.0 } else { 0.0 };
    let output_mode = |mode: f64| if mode == 2.0 { 0.0 } else if mode == 1.0 { 2.0 } else { 1.0 };
    let result = runtime::child_spawn_sync_full(&command, &arguments, 0.0, &runtime::string("SIGTERM"), input_mode, output_mode(stdout), output_mode(stderr), None, &runtime::string(""));
    let status = runtime::spawn_result_status(&result).unwrap_or(1.0);
    let fields = vec![
        (runtime::string("exitCode"), NativeValue::Number(status)),
        (runtime::string("success"), NativeValue::Boolean(status == 0.0)),
        (runtime::string("stdout"), NativeValue::String(runtime::spawn_result_stdout(&result))),
        (runtime::string("stderr"), NativeValue::String(runtime::spawn_result_stderr(&result))),
        (runtime::string("signalCode"), runtime::spawn_result_signal(&result).map(NativeValue::String).unwrap_or(NativeValue::Null)),
    ];
    NativeValue::Object(runtime::Gc::new(NativeMap { null_prototype: false, symbol_properties: None, entries: fields, hash_index: NativeHashIndex::default() }))
}
fn native_exec_file_sync_utf8(command: runtime::JsString, args: runtime::JsArray<runtime::JsString>, options: NativeValue) -> runtime::JsString {
    let cwd = match native_value_get(options.clone(), runtime::string("cwd")) {
        NativeValue::Undefined => runtime::string(""),
        NativeValue::String(value) => value,
        _ => runtime::throw_type_error("execFileSync cwd must be a string".into()),
    };
    let environment = native_value_get(options.clone(), runtime::string("env"));
    let pairs = if matches!(environment, NativeValue::Undefined) { None } else {
        let mut pairs = Vec::new();
        for key in native_value_own_keys(&environment) {
            let value = native_value_get(environment.clone(), key.clone());
            if matches!(value, NativeValue::Undefined) { continue; }
            pairs.push(key);
            pairs.push(native_value_string(value));
        }
        Some(runtime::array_new(pairs))
    };
    let timeout = match native_value_get(options.clone(), runtime::string("timeout")) {
        NativeValue::Undefined => 0.0,
        NativeValue::Number(value) => value,
        _ => runtime::throw_type_error("execFileSync timeout must be a number".into()),
    };
    let kill_signal = match native_value_get(options.clone(), runtime::string("killSignal")) {
        NativeValue::Undefined => runtime::string("SIGTERM"),
        NativeValue::String(value) => value,
        _ => runtime::throw_type_error("execFileSync killSignal must be a string".into()),
    };
    let max_buffer = match native_value_get(options.clone(), runtime::string("maxBuffer")) {
        NativeValue::Undefined => 1024.0 * 1024.0,
        NativeValue::Number(value) => value,
        _ => runtime::throw_type_error("execFileSync maxBuffer must be a number".into()),
    };
    let stdio = native_value_get(options, runtime::string("stdio"));
    // Node writes the captured child stderr to the parent when `stdio` is not
    // specified, on success and before reporting a failure.
    let inherit_stderr = matches!(stdio, NativeValue::Undefined);
    let (stdin_mode, stdout_mode, stderr_mode) = if native_value_test(&stdio, "array") {
        (
            native_sync_stdio_mode(native_value_get(stdio.clone(), runtime::string("0")), 0.0),
            native_sync_stdio_mode(native_value_get(stdio.clone(), runtime::string("1")), 0.0),
            native_sync_stdio_mode(native_value_get(stdio, runtime::string("2")), 0.0),
        )
    } else {
        let mode = native_sync_stdio_mode(stdio, 0.0);
        (mode, mode, mode)
    };
    let result = runtime::child_spawn_sync_full_input(&command, &args, timeout, &kill_signal, stdin_mode, stdout_mode, stderr_mode, pairs.as_ref(), &cwd, None, max_buffer);
    if inherit_stderr {
        let stderr = runtime::spawn_result_stderr(&result);
        if !stderr.to_utf8_lossy().is_empty() {
            runtime::process_stderr_write(&stderr);
        }
    }
    let status = runtime::spawn_result_status(&result);
    if runtime::spawn_result_error(&result).is_some() || status.is_some_and(|status| status != 0.0) {
        let stderr = runtime::spawn_result_stderr(&result);
        let error = runtime::spawn_result_error(&result).unwrap_or_else(|| runtime::error_new("Error", runtime::string(&format!("Command failed: {}\n{}", command.to_utf8_lossy(), stderr.to_utf8_lossy()))));
        let value = native_caught(runtime::caught_value(error));
        if let NativeValue::Instance(object) = &value {
            object.with_mut(|object| {
                let error = object.error.as_mut().expect("native Error header");
                error.own.extend([
                    ("status".into(), status.map(NativeValue::Number).unwrap_or(NativeValue::Null)),
                    ("stdout".into(), NativeValue::String(runtime::spawn_result_stdout(&result))),
                    ("stderr".into(), NativeValue::String(stderr)),
                ]);
            });
        }
        runtime::throw_value(value);
    }
    runtime::spawn_result_stdout(&result)
}
"#);
    }
    if !used {
        return;
    }
    out.push_str("fn native_exec_is_array(value: &NativeValue) -> bool { matches!(value, NativeValue::Array(_) ");
    for (index, ty) in values::types(module).iter().enumerate() {
        if matches!(ty, Type::Array { elem } if **elem != Type::Dyn) {
            write!(out, "| NativeValue::V{index}(_) ").unwrap();
        }
    }
    out.push_str(") }\n");
    out.push_str(include_str!("../child_process_support.rs"));
    if let Some(result) = result {
        let value = "runtime::Gc::new(NativeRecordData { null_prototype: false, symbol_properties: None, entries: vec![(\"stdout\".into(), NativeValue::String(output.stdout.clone())), (\"stderr\".into(), NativeValue::String(output.stderr.clone()))], hash_index: NativeHashIndex::default() })";
        let boxed = values::box_value(&result, value, module);
        writeln!(out, "fn native_exec_promise(args: runtime::JsArray<NativeValue>, shell: bool) -> runtime::JsPromise<NativeValue> {{ let request = native_exec_request(args, true, shell); let promise = runtime::promise_new(); let target = promise.clone(); let traced = target.clone(); let child = runtime::child_exec_file_options(&request.command, &request.arguments, &request.display, request.options, std::rc::Rc::new(move |output| {{ if output.error.is_some() {{ let _ = runtime::promise_reject(&target, runtime::caught_value(native_exec_error(&output, true))); }} else {{ let value = {boxed}; let _ = runtime::promise_fulfill(&target, value); }} }}), std::rc::Rc::new(move |tracer| tracer.edge(&traced))); runtime::promise_own_set(&promise, \"child\", child); promise }}").unwrap();
    }
}

pub(super) fn expression(
    value: &Expr,
    function: &Function,
    module: &Emission<'_>,
) -> Option<String> {
    let Expr::LibCall {
        r#fn, args, r#type, ..
    } = value
    else {
        return None;
    };
    let name = match r#fn.as_str() {
        "bun.spawnOptionsCwd" => {
            return Some(format!(
                "{{ let options = {}; let fallback = {}; match native_value_get(options, runtime::string(\"cwd\")) {{ NativeValue::Undefined => fallback, NativeValue::String(value) => value, _ => runtime::throw_type_error(\"Bun.spawn cwd must be a string\".into()), }} }}",
                expr(&args[0], function, module),
                expr(&args[1], function, module)
            ));
        }
        "bun.spawnOptionsEnv" => {
            return Some(format!(
                "{{ let options = {}; let fallback = {}; match native_value_get(options, runtime::string(\"env\")) {{ NativeValue::Undefined => fallback, value => value, }} }}",
                expr(&args[0], function, module),
                expr(&args[1], function, module)
            ));
        }
        "bun.envPresent" => {
            return Some(format!(
                "!matches!({}, NativeValue::Undefined)",
                expr(&args[0], function, module)
            ));
        }
        "bun.envPairs" => {
            return Some(format!(
                "{{ let environment = {}; let mut pairs = Vec::new(); if !matches!(environment, NativeValue::Undefined) {{ for key in native_value_own_keys(&environment) {{ let value = native_value_get(environment.clone(), key.clone()); if matches!(value, NativeValue::Undefined) {{ continue; }} pairs.push(key); pairs.push(native_value_string(value)); }} }} runtime::array_new(pairs) }}",
                expr(&args[0], function, module)
            ));
        }
        "cp.spawnSyncUtf8" => {
            return Some(format!(
                "native_spawn_sync_utf8({}, {}, {})",
                expr(&args[0], function, module),
                expr(&args[1], function, module),
                expr(&args[2], function, module)
            ));
        }
        "cp.spawn" => {
            return Some(format!(
                "native_child_spawn({}, {}, {})",
                expr(&args[0], function, module),
                expr(&args[1], function, module),
                expr(&args[2], function, module)
            ));
        }
        "child.on" | "child.once" => {
            return Some(format!(
                "native_child_listener({}, {}, {}, {})",
                expr(&args[0], function, module),
                expr(&args[1], function, module),
                expr(&args[2], function, module),
                r#fn == "child.once"
            ));
        }
        "child.stdinWriteCallback" => {
            return Some(format!(
                "native_child_stdin_write_callback({}, {}, {})",
                expr(&args[0], function, module),
                expr(&args[1], function, module),
                expr(&args[2], function, module)
            ));
        }
        "child.stdinEnd" => {
            return Some(format!(
                "{{ let child = {}; if !runtime::child_stdin_present(&child) {{ runtime::throw_type_error(\"Cannot read properties of null (reading 'end')\".into()); }} runtime::child_stdin_end(&child) }}",
                expr(&args[0], function, module)
            ));
        }
        "child.stdinEndOptional" => {
            return Some(format!(
                "runtime::child_stdin_end(&({}))",
                expr(&args[0], function, module)
            ));
        }
        "bun.spawnSync" => {
            return Some(format!(
                "native_bun_spawn_sync({}, {}, {}, {})",
                expr(&args[0], function, module),
                expr(&args[1], function, module),
                expr(&args[2], function, module),
                expr(&args[3], function, module)
            ));
        }
        "cp.execFileSyncUtf8" => {
            return Some(format!(
                "native_exec_file_sync_utf8({}, {}, {})",
                expr(&args[0], function, module),
                expr(&args[1], function, module),
                expr(&args[2], function, module)
            ));
        }
        "bun.exited" => {
            return Some(format!(
                "{{ let source = runtime::bun_subprocess_exited(&({})); runtime::promise_view_map(&source, NativeValue::Number) }}",
                expr(&args[0], function, module)
            ));
        }
        "bun.stdinPresent" => {
            return Some(format!(
                "runtime::child_stdin_present(&({}))",
                expr(&args[0], function, module)
            ));
        }
        "bun.stdinWrite" => {
            return Some(format!(
                "native_bun_stdin_write({}, {})",
                expr(&args[0], function, module),
                expr(&args[1], function, module)
            ));
        }
        "bun.stdinEnd" => {
            return Some(format!(
                "runtime::child_stdin_end(&({}))",
                expr(&args[0], function, module)
            ));
        }
        "bun.stdout" | "bun.stderr" => {
            return Some(format!(
                "NativeValue::WebBytesStream(runtime::bun_subprocess_output(&({}), {}, |bytes| bytes, runtime::bytes_empty::<u8>()).unwrap_or_else(|| runtime::throw_type_error(\"Bun subprocess output is not piped\".into())))",
                expr(&args[0], function, module),
                r#fn == "bun.stderr"
            ));
        }
        "bun.responseText" => {
            return Some(format!(
                "{{ let source = runtime::bun_subprocess_response_text(&({}), {}); runtime::promise_view_map(&source, NativeValue::String) }}",
                expr(&args[0], function, module),
                expr(&args[1], function, module)
            ));
        }
        "cp.execFileNative" | "cp.execNative" => {
            return Some(format!(
                "native_exec_callback({}, {})",
                expr(&args[0], function, module),
                r#fn == "cp.execNative"
            ));
        }
        "cp.execFilePromise" | "cp.execPromise" => {
            return Some(format!(
                "native_exec_promise({}, {})",
                expr(&args[0], function, module),
                r#fn == "cp.execPromise"
            ));
        }
        "cp.promiseChild" => {
            return Some(format!(
                "runtime::promise_own_get::<_, runtime::JsChild>(&({}), \"child\").unwrap_or_else(|| runtime::throw_type_error(\"scriptc: required Promise child property is missing\".into()))",
                expr(&args[0], function, module)
            ));
        }
        "child.killed" => {
            return Some(format!(
                "runtime::child_killed(&({}))",
                expr(&args[0], function, module)
            ));
        }
        "child.unref" => {
            return Some(format!(
                "{{ runtime::child_unref(&({})); () }}",
                expr(&args[0], function, module)
            ));
        }
        "child.kill" => {
            return Some(format!(
                "runtime::child_kill(&({}), &({}))",
                expr(&args[0], function, module),
                expr(&args[1], function, module)
            ));
        }
        "child.stdout" | "child.stderr" => {
            let getter = if r#fn == "child.stdout" {
                "child_stdout"
            } else {
                "child_stderr"
            };
            return Some(format!(
                "runtime::{getter}(&({})).map(native_child_stream_value).unwrap_or(NativeValue::Null)",
                expr(&args[0], function, module)
            ));
        }
        "child.pid" => "pid",
        "child.exitCode" => "exit_code",
        "child.signalCode" => "signal_code",
        _ => return None,
    };
    let Type::Union { union_id } = r#type else {
        debug_assert!(r#fn == "child.pid" && *r#type == Type::F64);
        return Some(format!(
            "runtime::child_pid(&({})).unwrap_or_else(|| runtime::throw_type_error(\"child pid is unavailable\".into()))",
            expr(&args[0], function, module)
        ));
    };
    let present = if r#fn == "child.signalCode" {
        Type::String
    } else {
        Type::F64
    };
    let number = module.unions[*union_id]
        .arms
        .iter()
        .position(|t| *t == present)
        .unwrap();
    let empty = 1 - number;
    Some(format!(
        "match runtime::child_{name}(&({})) {{ Some(value) => U{union_id}::V{number}(value), None => U{union_id}::V{empty}(()), }}",
        expr(&args[0], function, module)
    ))
}
