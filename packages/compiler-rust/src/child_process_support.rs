// Builtin argument normalization runs synchronously, including the custom
// Promise function. Both emitters share the runtime's normalization contract.
impl runtime::ExecFileValue for NativeValue {
    fn exec_kind(&self) -> runtime::ExecFileValueKind {
        use runtime::ExecFileValueKind as K;
        match self {
            NativeValue::Undefined => K::Undefined, NativeValue::Null => K::Null,
            NativeValue::Boolean(b) => K::Boolean(*b), NativeValue::Number(n) => K::Number(*n),
            NativeValue::String(s) => K::String(runtime::string(s)),
            NativeValue::Record(..) | NativeValue::Object(..) => K::Object,
            _ if native_exec_is_array(self) => K::Array,
            _ if native_value_test(self, "function") => K::Function,
            _ => K::Other,
        }
    }
    fn exec_undefined() -> Self { Self::Undefined }
    fn exec_get(&self, key: &str) -> Self { native_value_get(self.clone(), key.into()) }
    fn exec_own_keys(&self) -> Vec<String> { native_value_own_keys(self) }
    fn exec_scalar_string(&self) -> runtime::JsString { runtime::string(&native_value_string(self.clone())) }
}
fn native_exec_request(args: runtime::JsArray<NativeValue>, promise: bool) -> runtime::ExecFileRequest<NativeValue> {
    let values = (0..runtime::array_len(&args) as usize).map(|i| runtime::array_get(&args, i as f64)).collect();
    runtime::exec_file_normalize(values, promise)
}
fn native_exec_error(output: &runtime::ExecFileOutput, promise: bool) -> NativeValue {
    let failure = output.error.as_ref().expect("failed execFile output");
    let value = native_caught(runtime::caught_value(failure.error.clone()));
    if let NativeValue::Instance(object) = &value {
        object.with_mut(|object| {
            let error = object.error.as_mut().expect("native Error header");
            let code = failure.exit_code.map(NativeValue::Number).or_else(|| runtime::error_code(&failure.error).map(|code| NativeValue::String(code.to_string()))).unwrap_or(NativeValue::Null);
            error.own = vec![("code".into(), code)];
            if runtime::error_code(&failure.error).is_none() {
                error.own.push(("killed".into(), NativeValue::Boolean(failure.killed)));
                error.own.push(("signal".into(), failure.signal.as_ref().map(|s| NativeValue::String(s.to_string())).unwrap_or(NativeValue::Null)));
            }
            error.own.push(("cmd".into(), NativeValue::String(output.command.to_string())));
            if promise { error.own.extend([
                ("stdout".into(), NativeValue::String(output.stdout.to_string())),
                ("stderr".into(), NativeValue::String(output.stderr.to_string()))]); }
        });
    }
    value
}
fn native_exec_callback(args: runtime::JsArray<NativeValue>) -> runtime::JsChild {
    let request = native_exec_request(args, false);
    let callback = request.callback;
    let traced = callback.clone();
    runtime::child_exec_file_options(&request.command, &request.arguments, request.options, std::rc::Rc::new(move |output| {
        if native_value_test(&callback, "function") {
            let error = if output.error.is_some() { native_exec_error(&output, false) } else { NativeValue::Null };
            let _ = native_value_call(callback.clone(), vec![error, NativeValue::String(output.stdout.to_string()), NativeValue::String(output.stderr.to_string())], "execFile callback");
        }
    }), std::rc::Rc::new(move |tracer| traced.trace_native(tracer)))
}
