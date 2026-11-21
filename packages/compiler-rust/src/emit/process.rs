//! Option-valued runtime reads keep the shared string/undefined union ABI.
use super::*;

pub(super) fn definitions(module: &Emission<'_>, output: &mut String) {
    output.push_str("fn native_path_to_file_url(path: &runtime::JsString) -> NativeValue { NativeValue::Url(runtime::url_path_to_file_url(path)) }
");
    output.push_str(
        "fn native_os_user_info() -> NativeValue { let uid = if cfg!(windows) { -1.0 } else { runtime::process_getuid() }; let gid = if cfg!(windows) { -1.0 } else { runtime::process_getgid() }; let shell = if cfg!(windows) { NativeValue::Null } else { NativeValue::String(runtime::os_user_shell()) }; NativeValue::Object(runtime::Gc::new(NativeMap { null_prototype: false, symbol_properties: None, entries: vec![(runtime::string(\"uid\"), NativeValue::Number(uid)), (runtime::string(\"gid\"), NativeValue::Number(gid)), (runtime::string(\"username\"), NativeValue::String(runtime::os_user_name())), (runtime::string(\"homedir\"), NativeValue::String(runtime::os_user_homedir())), (runtime::string(\"shell\"), shell)], hash_index: NativeHashIndex::default() })) }\n",
    );
    output.push_str(
        "fn native_v8_heap_statistics() -> NativeValue { let available = runtime::process_available_memory(); let limit = if available > 0.0 { available } else { usize::MAX as f64 }; NativeValue::Object(runtime::Gc::new(NativeMap { null_prototype: false, symbol_properties: None, entries: vec![(runtime::string(\"heap_size_limit\"), NativeValue::Number(limit))], hash_index: NativeHashIndex::default() })) }\n",
    );
    output.push_str(
        "fn native_process_env_object() -> NativeValue { let object = runtime::Gc::new(NativeMap { null_prototype: false, symbol_properties: None, entries: Vec::new(), hash_index: NativeHashIndex::default() }); let pairs = runtime::process_env_pairs(); let length = runtime::array_len(&pairs) as usize; object.with_mut(|data| { for index in (0..length).step_by(2) { let key = runtime::array_get(&pairs, index as f64); let value = runtime::array_get(&pairs, (index + 1) as f64); data.entries.push((key, NativeValue::String(value))); } }); NativeValue::Object(object) }\n",
    );
    output.push_str("thread_local! { static NATIVE_PROCESS_STREAMS: std::cell::RefCell<[Option<runtime::Gc<NativeMap<runtime::JsString, NativeValue>>>; 2]> = const { std::cell::RefCell::new([None, None]) }; }\nfn native_process_stream_value(fd: u8) -> NativeValue { let index = usize::from(fd - 1); NativeValue::Object(NATIVE_PROCESS_STREAMS.with(|streams| { let mut streams = streams.borrow_mut(); streams[index].get_or_insert_with(|| { let mut entries = vec![(runtime::string(\"write\"), NativeValue::ProcessWrite(fd))]; if runtime::process_is_tty(f64::from(fd)) { entries.push((runtime::string(\"isTTY\"), NativeValue::Boolean(true))); } runtime::Gc::new(NativeMap { null_prototype: false, symbol_properties: None, entries, hash_index: NativeHashIndex::default() }) }).clone() })) }\nfn native_process_stdout_value() -> NativeValue { native_process_stream_value(1) }\nfn native_process_stderr_value() -> NativeValue { native_process_stream_value(2) }\n");
    let chunk = if module.value_types().contains(&Type::bytes()) {
        values::box_value(&Type::bytes(), "chunk", module)
    } else {
        "NativeValue::String(runtime::bytes_to_string(&chunk, &runtime::string(\"utf8\")))".into()
    };
    output.push_str("thread_local! { static NATIVE_PROCESS_STDIN: std::cell::RefCell<Option<runtime::Gc<NativeMap<runtime::JsString, NativeValue>>>> = const { std::cell::RefCell::new(None) }; static NATIVE_STDIN_DATA_LISTENERS: std::cell::RefCell<Vec<(NativeValue, std::rc::Rc<dyn Fn(runtime::JsBytes<u8>)>)>> = const { std::cell::RefCell::new(Vec::new()) }; }\n");
    output.push_str("fn native_process_stdin_value() -> NativeValue { NativeValue::Object(NATIVE_PROCESS_STDIN.with(|stream| { let mut stream = stream.borrow_mut(); stream.get_or_insert_with(|| { let mut entries = vec![(runtime::string(\"on\"), NativeValue::ProcessStdinMethod(0)), (runtime::string(\"removeListener\"), NativeValue::ProcessStdinMethod(1)), (runtime::string(\"setRawMode\"), NativeValue::ProcessStdinMethod(2)), (runtime::string(\"resume\"), NativeValue::ProcessStdinMethod(3)), (runtime::string(\"pause\"), NativeValue::ProcessStdinMethod(4)), (runtime::string(\"isPaused\"), NativeValue::ProcessStdinMethod(5))]; if runtime::process_is_tty(0.0) { entries.push((runtime::string(\"isTTY\"), NativeValue::Boolean(true))); entries.push((runtime::string(\"isRaw\"), NativeValue::Boolean(runtime::process_stdin_is_raw()))); } runtime::Gc::new(NativeMap { null_prototype: false, symbol_properties: None, entries, hash_index: NativeHashIndex::default() }) }).clone() })) }\n");
    output.push_str(&format!("fn native_stdin_on_data(callback: NativeValue) -> NativeValue {{ if !native_value_is_function(&callback) {{ runtime::throw_type_error(\"The listener argument must be of type function\".into()); }} let target = callback.clone(); let listener: std::rc::Rc<dyn Fn(runtime::JsBytes<u8>)> = std::rc::Rc::new(move |chunk| {{ let _ = native_value_call(target.clone(), vec![{chunk}], \"process.stdin data listener\"); }}); runtime::stdin_on_data(listener.clone(), false); NATIVE_STDIN_DATA_LISTENERS.with(|listeners| listeners.borrow_mut().push((callback, listener))); native_process_stdin_value() }}\n"));
    output.push_str("fn native_stdin_remove_data(callback: NativeValue) -> NativeValue { NATIVE_STDIN_DATA_LISTENERS.with(|listeners| { let mut listeners = listeners.borrow_mut(); if let Some(index) = listeners.iter().position(|(stored, _)| native_value_eq(stored, &callback)) { let (_, listener) = listeners.remove(index); runtime::stdin_remove_data(&listener); } }); native_process_stdin_value() }\nfn native_stdin_set_raw(raw: bool) -> NativeValue { runtime::process_stdin_set_raw_mode(raw); if let NativeValue::Object(object) = native_process_stdin_value() { native_record_set(&object, runtime::string(\"isRaw\"), NativeValue::Boolean(raw)); } native_process_stdin_value() }\n");
}

pub(super) fn expression(
    value: &Expr,
    function: &Function,
    module: &Emission<'_>,
) -> Option<String> {
    if let Expr::LibCall { r#fn, args, .. } = value
        && r#fn == "process.emitWarning"
    {
        return Some(format!(
            "{{ let warning = {}; let _warning_type_or_options = {}; let _warning_code = {}; let _warning_ctor = {}; let text = match warning {{ NativeValue::Instance(object) if object.with(|value| value.error.is_some()) => error_string(object), value @ (NativeValue::Undefined | NativeValue::Null | NativeValue::BigInt(_) | NativeValue::Number(_) | NativeValue::Boolean(_) | NativeValue::String(_)) => native_value_string(value), _ => runtime::JsString::from(\"[object Object]\"), }}; console(true, &[text.to_utf8_lossy().to_owned()]); }}",
            expr(&args[0], function, module),
            expr(&args[1], function, module),
            expr(&args[2], function, module),
            expr(&args[3], function, module)
        ));
    }
    if let Expr::LibCall { r#fn, args, .. } = value
        && r#fn == "process.onUnhandledRejection"
    {
        return Some(format!(
            "native_process_on_unhandled_rejection({})",
            expr(&args[0], function, module)
        ));
    }
    if let Expr::LibCall { r#fn, args, .. } = value
        && r#fn == "process.onUncaughtException"
    {
        return Some(format!(
            "native_process_on_uncaught_exception({})",
            expr(&args[0], function, module)
        ));
    }
    if let Expr::LibCall { r#fn, args, .. } = value
        && matches!(
            r#fn.as_str(),
            "process.onExit"
                | "process.offExit"
                | "process.onUncaughtMonitor"
                | "process.offUncaughtMonitor"
        )
    {
        let helper = match r#fn.as_str() {
            "process.onExit" => "native_process_on_exit",
            "process.offExit" => "native_process_off_exit",
            "process.onUncaughtMonitor" => "native_process_on_uncaught_monitor",
            "process.offUncaughtMonitor" => "native_process_off_uncaught_monitor",
            _ => unreachable!(),
        };
        return Some(format!("{helper}({})", expr(&args[0], function, module)));
    }
    if let Expr::LibCall { r#fn, args, .. } = value
        && matches!(
            r#fn.as_str(),
            "process.onSignal"
                | "process.offSignal"
                | "process.onNamedSignal"
                | "process.offNamedSignal"
        )
    {
        let callback_type = args[1].ty();
        let callback = expr(&args[1], function, module);
        let boxed = values::box_value(&callback_type, "callback.clone()", module);
        let signal = expr(&args[0], function, module);
        let signal = if matches!(
            r#fn.as_str(),
            "process.onNamedSignal" | "process.offNamedSignal"
        ) {
            format!("runtime::process_signal_number(&({signal}))")
        } else {
            signal
        };
        if matches!(
            r#fn.as_str(),
            "process.offSignal" | "process.offNamedSignal"
        ) {
            return Some(format!(
                "{{ let signal = {signal}; let callback = {callback}; let identity = native_function_properties(&{boxed}).expect(\"validated signal listener\").identity(); runtime::process_signal_off(signal, identity); }}",
            ));
        }
        return Some(format!(
            "{{ let signal = {signal}; let callback = {callback}; let identity = native_function_properties(&{boxed}).expect(\"validated signal listener\").identity(); let target = {boxed}; let once = {}; runtime::process_signal_on(signal, identity, std::rc::Rc::new(move || {{ let _ = native_value_call(target.clone(), Vec::new(), \"process signal listener\"); }}), once); }}",
            expr(&args[2], function, module),
        ));
    }
    if let Expr::LibCall { r#fn, args, .. } = value
        && r#fn == "process.envSet"
    {
        return Some(format!(
            "{{ let key = {}; let value = {}; runtime::process_env_set(&key, &value); }}",
            expr(&args[0], function, module),
            expr(&args[1], function, module)
        ));
    }
    let Expr::LibCall {
        r#fn,
        args,
        r#type: Type::Union { union_id },
        ..
    } = value
    else {
        return None;
    };
    if r#fn != "process.envGet" {
        return None;
    }
    let arms = &module.unions[*union_id].arms;
    let string = arms.iter().position(|t| *t == Type::String).unwrap();
    let undefined = arms.iter().position(|t| *t == Type::Undefined).unwrap();
    Some(format!(
        "match runtime::process_env_get(&runtime::JsString::from({})) {{ Some(value) => U{union_id}::V{string}(value), None => U{union_id}::V{undefined}(()) }}",
        expr(&args[0], function, module)
    ))
}
