// Builtin argument normalization runs synchronously, including the custom
// Promise function. Both emitters share the runtime's normalization contract.
impl runtime::ExecFileValue for NativeValue {
    fn exec_kind(&self) -> runtime::ExecFileValueKind {
        use runtime::ExecFileValueKind as K;
        match self {
            NativeValue::Undefined => K::Undefined,
            NativeValue::Null => K::Null,
            NativeValue::Boolean(b) => K::Boolean(*b),
            NativeValue::Number(n) => K::Number(*n),
            NativeValue::String(s) => K::String(runtime::string(s)),
            NativeValue::Record(..) | NativeValue::Object(..) => K::Object,
            _ if native_exec_is_array(self) => K::Array,
            _ if native_value_test(self, "function") => K::Function,
            _ => K::Other,
        }
    }
    fn exec_undefined() -> Self {
        Self::Undefined
    }
    fn exec_get(&self, key: &str) -> Self {
        native_value_get(self.clone(), key.into())
    }
    fn exec_own_keys(&self) -> Vec<String> {
        native_value_own_keys(self)
            .into_iter()
            .map(|key| {
                key.well_formed_utf8()
                    .unwrap_or_else(|| {
                        runtime::throw_type_error(
                            "scriptc: ill-formed process environment keys are not ported".into(),
                        )
                    })
                    .to_owned()
            })
            .collect()
    }
    fn exec_scalar_string(&self) -> runtime::JsString {
        runtime::string(&native_value_string(self.clone()))
    }
}
fn native_exec_request(
    args: runtime::JsArray<NativeValue>,
    promise: bool,
    shell: bool,
) -> runtime::ExecFileRequest<NativeValue> {
    let values = (0..runtime::array_len(&args) as usize)
        .map(|i| runtime::array_get(&args, i as f64))
        .collect();
    runtime::exec_file_normalize(values, promise, shell)
}
fn native_exec_error(output: &runtime::ExecFileOutput, promise: bool) -> NativeValue {
    let failure = output.error.as_ref().expect("failed execFile output");
    let value = native_caught(runtime::caught_value(failure.error.clone()));
    if let NativeValue::Instance(object) = &value {
        object.with_mut(|object| {
            let error = object.error.as_mut().expect("native Error header");
            let code = failure
                .exit_code
                .map(NativeValue::Number)
                .or_else(|| {
                    runtime::error_code(&failure.error).map(|code| NativeValue::String(code))
                })
                .unwrap_or(NativeValue::Null);
            error.own = vec![("code".into(), code)];
            if runtime::error_code(&failure.error).is_none() {
                error
                    .own
                    .push(("killed".into(), NativeValue::Boolean(failure.killed)));
                error.own.push((
                    "signal".into(),
                    failure
                        .signal
                        .as_ref()
                        .map(|s| NativeValue::String(s.clone()))
                        .unwrap_or(NativeValue::Null),
                ));
            }
            error
                .own
                .push(("cmd".into(), NativeValue::String(output.command.clone())));
            if promise {
                error.own.extend([
                    ("stdout".into(), NativeValue::String(output.stdout.clone())),
                    ("stderr".into(), NativeValue::String(output.stderr.clone())),
                ]);
            }
        });
    }
    value
}
fn native_exec_callback(args: runtime::JsArray<NativeValue>, shell: bool) -> runtime::JsChild {
    let request = native_exec_request(args, false, shell);
    let callback = request.callback;
    let traced = callback.clone();
    runtime::child_exec_file_options(
        &request.command,
        &request.arguments,
        &request.display,
        request.options,
        std::rc::Rc::new(move |output| {
            if native_value_test(&callback, "function") {
                let error = if output.error.is_some() {
                    native_exec_error(&output, false)
                } else {
                    NativeValue::Null
                };
                let _ = native_value_call(
                    callback.clone(),
                    vec![
                        error,
                        NativeValue::String(output.stdout.clone()),
                        NativeValue::String(output.stderr.clone()),
                    ],
                    "execFile callback",
                );
            }
        }),
        std::rc::Rc::new(move |tracer| traced.trace_native(tracer)),
    )
}
