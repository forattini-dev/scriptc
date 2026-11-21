// Node-style descriptor operations reached through erased JavaScript calls
// (`fs.open/write/close/fsync/mkdir` with a completion callback, and
// `fs.writeSync` with a string or buffer). Callback forms run the operation in
// a native Promise segment so a failure becomes the callback's error argument.
fn native_fs_number(value: Option<&NativeValue>, name: &str) -> f64 {
    match value {
        Some(NativeValue::Number(number)) => *number,
        _ => runtime::throw_type_error(format!("The \"{name}\" argument must be of type number")),
    }
}
fn native_fs_path(value: Option<&NativeValue>) -> runtime::JsString {
    match value {
        Some(NativeValue::String(path)) => path.clone(),
        _ => runtime::throw_type_error("The \"path\" argument must be of type string".into()),
    }
}
fn native_fs_write_value(fd: f64, data: NativeValue, encoding: Option<&NativeValue>) -> f64 {
    if let NativeValue::String(text) = &data {
        let encoding = match encoding {
            Some(NativeValue::String(encoding)) => encoding.clone(),
            _ => runtime::string("utf8"),
        };
        return runtime::fs_write_str_sync(fd, text, f64::NAN, &encoding);
    }
    let Some(bytes) = native_file_handle_bytes(data) else {
        runtime::throw_type_error(
            "The \"buffer\" argument must be of type string or an instance of Buffer, TypedArray, or DataView".into(),
        );
    };
    let length = runtime::bytes_len(&bytes);
    runtime::fs_write_sync(fd, &bytes, 0.0, length, f64::NAN)
}
fn native_fs_sync_call(operation: &str, args: Vec<NativeValue>) -> NativeValue {
    match operation {
        "writeSync" => {
            let fd = native_fs_number(args.first(), "fd");
            let data = args.get(1).cloned().unwrap_or(NativeValue::Undefined);
            NativeValue::Number(native_fs_write_value(fd, data, args.get(2)))
        }
        "fsyncSync" => {
            runtime::fs_fsync(native_fs_number(args.first(), "fd"));
            NativeValue::Undefined
        }
        _ => unreachable!("registered fs descriptor operation"),
    }
}
fn native_fs_operation(operation: &str, args: &[NativeValue]) -> Vec<NativeValue> {
    match operation {
        "close" => {
            runtime::fs_close(native_fs_number(args.first(), "fd"));
            vec![]
        }
        "fsync" => {
            runtime::fs_fsync(native_fs_number(args.first(), "fd"));
            vec![]
        }
        "open" => {
            let path = native_fs_path(args.first());
            let flags = match args.get(1) {
                Some(NativeValue::String(flags)) => flags.clone(),
                _ => runtime::string("r"),
            };
            let mode = match args.get(2) {
                Some(NativeValue::Number(mode)) => *mode,
                _ => 438.0,
            };
            vec![NativeValue::Number(runtime::fs_open_mode(&path, &flags, mode))]
        }
        "write" => {
            let fd = native_fs_number(args.first(), "fd");
            let data = args.get(1).cloned().unwrap_or(NativeValue::Undefined);
            let written = native_fs_write_value(fd, data.clone(), args.get(2));
            vec![NativeValue::Number(written), data]
        }
        "mkdir" => {
            let path = native_fs_path(args.first());
            let recursive = match args.get(1) {
                Some(options @ (NativeValue::Object(_) | NativeValue::Record(..))) => matches!(
                    native_value_get(options.clone(), runtime::string("recursive")),
                    NativeValue::Boolean(true)
                ),
                _ => false,
            };
            if recursive {
                runtime::fs_mkdir_recursive(&path);
            } else {
                runtime::fs_mkdir(&path);
            }
            vec![]
        }
        _ => unreachable!("registered fs callback operation"),
    }
}
fn native_fs_node_call(operation: &'static str, mut args: Vec<NativeValue>) -> NativeValue {
    let callback = args.pop().unwrap_or(NativeValue::Undefined);
    if !native_value_is_function(&callback) {
        runtime::throw_type_error("The \"cb\" argument must be of type function".into());
    }
    let source = runtime::promise_from_sync(move || {
        NativeValue::Array(runtime::array_new(native_fs_operation(operation, &args)))
    });
    runtime::promise_then(
        &source,
        Box::new(move |outcome| {
            let args = match outcome {
                Ok(NativeValue::Array(results)) => {
                    let mut args = vec![NativeValue::Null];
                    args.extend(runtime::array_values(&results));
                    args
                }
                Ok(_) => vec![NativeValue::Null],
                Err(caught) => vec![native_caught(caught)],
            };
            native_value_call(callback, args, "callback");
        }),
    );
    NativeValue::Undefined
}
fn native_fs_callback_open(args: &runtime::JsArray<NativeValue>) -> NativeValue {
    native_fs_node_call("open", runtime::array_values(args))
}
fn native_fs_callback_write(args: &runtime::JsArray<NativeValue>) -> NativeValue {
    native_fs_node_call("write", runtime::array_values(args))
}
fn native_fs_callback_close(args: &runtime::JsArray<NativeValue>) -> NativeValue {
    native_fs_node_call("close", runtime::array_values(args))
}
fn native_fs_callback_fsync(args: &runtime::JsArray<NativeValue>) -> NativeValue {
    native_fs_node_call("fsync", runtime::array_values(args))
}
fn native_fs_callback_mkdir(args: &runtime::JsArray<NativeValue>) -> NativeValue {
    native_fs_node_call("mkdir", runtime::array_values(args))
}
fn native_fs_dynamic_write_sync(args: &runtime::JsArray<NativeValue>) -> NativeValue {
    native_fs_sync_call("writeSync", runtime::array_values(args))
}
fn native_fs_dynamic_fsync_sync(args: &runtime::JsArray<NativeValue>) -> NativeValue {
    native_fs_sync_call("fsyncSync", runtime::array_values(args))
}
