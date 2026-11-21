// Argument normalization is shared by native value representations. This
// protocol only reads already-compiled values; it cannot evaluate source.
pub enum ExecFileValueKind {
    Undefined,
    Null,
    Boolean(bool),
    Number(f64),
    String(JsString),
    Array,
    Function,
    Object,
    Other,
}
pub trait ExecFileValue: Clone {
    fn exec_kind(&self) -> ExecFileValueKind;
    fn exec_undefined() -> Self;
    fn exec_get(&self, key: &str) -> Self;
    fn exec_own_keys(&self) -> Vec<String>;
    fn exec_scalar_string(&self) -> JsString;
}
pub struct ExecFileRequest<V> {
    pub command: JsString,
    pub arguments: JsArray<JsString>,
    pub display: JsString,
    pub options: ExecFileOptions,
    pub callback: V,
}

fn exec_file_invalid<V: ExecFileValue>(name: &str, expected: &str, value: &V) -> ! {
    let received = match value.exec_kind() {
        ExecFileValueKind::Undefined => "undefined".into(),
        ExecFileValueKind::Null => "null".into(),
        ExecFileValueKind::Number(n) => format!("type number ({})", format_number(n)),
        ExecFileValueKind::Boolean(b) => format!("type boolean ({b})"),
        ExecFileValueKind::String(s) => format!("type string ('{s}')"),
        _ => "an instance of Object".into(),
    };
    throw_type_error_code(
        format!("The \"{name}\" argument must be of type {expected}. Received {received}"),
        "ERR_INVALID_ARG_TYPE",
    )
}
fn exec_file_string<V: ExecFileValue>(value: V, name: &str) -> JsString {
    match value.exec_kind() {
        ExecFileValueKind::String(value) => value,
        _ => exec_file_invalid(name, "string", &value),
    }
}
fn exec_file_option<V: ExecFileValue>(options: &V, name: &str) -> V {
    match options.exec_kind() {
        ExecFileValueKind::Undefined | ExecFileValueKind::Null => V::exec_undefined(),
        _ => options.exec_get(name),
    }
}
fn exec_file_number<V: ExecFileValue>(options: &V, name: &str, default: f64) -> f64 {
    let value = exec_file_option(options, name);
    match value.exec_kind() {
        ExecFileValueKind::Undefined => default,
        ExecFileValueKind::Number(n) if n >= 0.0 && (name == "maxBuffer" || n.fract() == 0.0) => n,
        ExecFileValueKind::Number(n) => throw_range_error_code(
            format!(
                "The value of \"{name}\" is out of range. It must be a non-negative integer. Received {}",
                format_number(n)
            ),
            "ERR_OUT_OF_RANGE",
        ),
        _ => exec_file_invalid(name, "number", &value),
    }
}

pub fn exec_file_normalize<V: ExecFileValue>(
    mut values: Vec<V>,
    promise: bool,
    shell: bool,
) -> ExecFileRequest<V> {
    use ExecFileValueKind as K;
    let callback = if values
        .last()
        .is_some_and(|v| matches!(v.exec_kind(), K::Function))
    {
        if promise {
            throw_type_error(
                "scriptc: an explicit callback on the custom child-process Promise is not ported"
                    .into(),
            );
        }
        values.pop().unwrap()
    } else {
        V::exec_undefined()
    };
    if values.len() > if shell { 2 } else { 3 } {
        throw_type_error(format!(
            "scriptc: {} extra arguments are not ported",
            if shell { "exec" } else { "execFile" }
        ));
    }
    let source_command = exec_file_string(
        values.first().cloned().unwrap_or_else(V::exec_undefined),
        if shell { "command" } else { "file" },
    );
    if !shell && source_command.is_empty() {
        throw_type_error_code(
            "The argument 'file' cannot be empty. Received ''".into(),
            "ERR_INVALID_ARG_VALUE",
        );
    }
    if source_command.contains('\0') {
        throw_type_error_code(
            format!(
                "The argument '{}' must be a string without null bytes",
                if shell { "command" } else { "file" }
            ),
            "ERR_INVALID_ARG_VALUE",
        );
    }
    let mut arguments = Vec::new();
    let second = values.get(1).cloned().unwrap_or_else(V::exec_undefined);
    let options = if shell {
        second
    } else if matches!(second.exec_kind(), K::Array) {
        let K::Number(len) = second.exec_get("length").exec_kind() else {
            unreachable!("native array length");
        };
        for index in 0..len as usize {
            let value = second.exec_get(&index.to_string());
            let argument = match value.exec_kind() {
                K::String(s) => s,
                K::Undefined | K::Null | K::Number(_) | K::Boolean(_) => value.exec_scalar_string(),
                _ => {
                    throw_type_error("scriptc: execFile argument ToPrimitive is not ported".into())
                }
            };
            if argument.contains('\0') {
                throw_type_error_code(
                    "The argument 'args' must be an array without null bytes".into(),
                    "ERR_INVALID_ARG_VALUE",
                );
            }
            arguments.push(argument);
        }
        values.get(2).cloned().unwrap_or_else(V::exec_undefined)
    } else {
        if values.len() > 2 {
            throw_type_error("scriptc: execFile option overload is not ported".into());
        }
        second
    };
    if !matches!(options.exec_kind(), K::Undefined | K::Null | K::Object) {
        exec_file_invalid("options", "object", &options);
    }
    for name in [
        "signal",
        "uid",
        "gid",
        "detached",
        "windowsVerbatimArguments",
    ] {
        if !matches!(exec_file_option(&options, name).exec_kind(), K::Undefined) {
            throw_type_error(format!("scriptc: execFile option {name} is not ported"));
        }
    }
    let shell_path = match exec_file_option(&options, "shell").exec_kind() {
        K::Undefined if shell => None,
        K::String(path) if shell && !path.is_empty() && !path.contains('\0') => Some(path),
        K::Undefined | K::Boolean(false) if !shell => None,
        _ if shell => {
            throw_type_error("scriptc: exec shell must be a non-empty string when provided".into())
        }
        _ => throw_type_error("scriptc: execFile shell execution is not ported".into()),
    };
    match exec_file_option(&options, "killSignal").exec_kind() {
        K::Undefined => {}
        K::String(s) if s.as_ref() == "SIGTERM" => {}
        _ => throw_type_error("scriptc: execFile killSignal requires SIGTERM".into()),
    }
    match exec_file_option(&options, "encoding").exec_kind() {
        K::Undefined => {}
        K::String(s) if s.as_ref() == "utf8" || s.as_ref() == "utf-8" => {}
        _ => throw_type_error("scriptc: execFile capture requires utf8 encoding".into()),
    }
    let cwd = exec_file_option(&options, "cwd");
    let cwd = match cwd.exec_kind() {
        K::Undefined | K::Null => string(""),
        _ => exec_file_string(cwd, "options.cwd"),
    };
    let hide = exec_file_option(&options, "windowsHide");
    let windows_hide = match hide.exec_kind() {
        K::Undefined => false,
        K::Boolean(value) => value,
        _ => exec_file_invalid("options.windowsHide", "boolean", &hide),
    };
    let timeout_ms = exec_file_number(&options, "timeout", 0.0);
    let max_buffer = exec_file_number(&options, "maxBuffer", 1024.0 * 1024.0) as usize;
    let env = exec_file_option(&options, "env");
    let env = match env.exec_kind() {
        K::Undefined | K::Null => None,
        K::Object => {
            let mut pairs = Vec::new();
            for key in env.exec_own_keys() {
                let value = env.exec_get(&key);
                match value.exec_kind() {
                    K::Undefined => {}
                    K::String(_) | K::Number(_) | K::Boolean(_) | K::Null => {
                        pairs.push(string(&key));
                        pairs.push(value.exec_scalar_string());
                    }
                    _ => throw_type_error(
                        "scriptc: execFile environment ToPrimitive is not ported".into(),
                    ),
                }
            }
            Some(array_new(pairs))
        }
        _ => exec_file_invalid("options.env", "object", &env),
    };
    let (command, arguments, display) = if shell {
        #[cfg(windows)]
        let command = shell_path.unwrap_or_else(|| {
            std::env::var("ComSpec")
                .map(|value| string(&value))
                .unwrap_or_else(|_| string("cmd.exe"))
        });
        #[cfg(not(windows))]
        let command = shell_path.unwrap_or_else(|| string("/bin/sh"));
        #[cfg(windows)]
        let arguments = vec![
            string("/d"),
            string("/s"),
            string("/c"),
            source_command.clone(),
        ];
        #[cfg(not(windows))]
        let arguments = vec![string("-c"), source_command.clone()];
        (command, arguments, source_command)
    } else {
        let mut display = source_command.to_string();
        for argument in &arguments {
            display.push(' ');
            display.push_str(argument);
        }
        (source_command, arguments, string(&display))
    };
    ExecFileRequest {
        command,
        arguments: array_new(arguments),
        display,
        options: ExecFileOptions {
            cwd,
            env,
            timeout_ms,
            windows_hide,
            max_buffer,
        },
        callback,
    }
}
