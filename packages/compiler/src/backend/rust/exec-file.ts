import type { RustDynamicContext } from "./dynamic-context.js";
import type { RustLibCallContext, RustLibCallExpr } from "./lib-calls.js";

/** Argument normalization and capture scheduling are shared Rust runtime contracts. */
export function emitExecFileDefinitions(context: RustDynamicContext): void {
  const dyn = context.dynTypeName();
  const error = context.errorClassRoots().length ? `${context.errorValueName()}::Builtin(output.error.as_ref().unwrap().error.clone())` : "output.error.as_ref().unwrap().error.clone()";
  context.line(`impl runtime::ExecFileValue for ${dyn} {
    fn exec_kind(&self) -> runtime::ExecFileValueKind {
      use runtime::ExecFileValueKind as K;
      match self { Self::Undefined => K::Undefined, Self::Null => K::Null,
        Self::Boolean(b) => K::Boolean(*b), Self::Number(n) => K::Number(*n), Self::String(s) => K::String(s.clone()),
        Self::Array(_) => K::Array, Self::Object(_) => K::Object,
        _ if sc_dyn_typeof(self).as_ref() == "function" => K::Function, _ => K::Other }
    }
    fn exec_undefined() -> Self { Self::Undefined }
    fn exec_get(&self, key: &str) -> Self { sc_dyn_key_get(self, &runtime::string(key), false) }
    fn exec_own_keys(&self) -> Vec<String> { match self { Self::Object(object) => runtime::map_string_entries_js_order(object).into_iter().map(|(key,_)| key.to_string()).collect(), _ => Vec::new() } }
    fn exec_scalar_string(&self) -> runtime::JsString { sc_dyn_to_string(self) }
  }
  fn sc_exec_file_error(output: &runtime::ExecFileOutput, promise: bool) -> ${dyn} {
    let error = sc_dyn_error_box(&${error});
    if let ${dyn}::Object(object) = &error {
      let failure = output.error.as_ref().unwrap();
      let code = failure.exit_code.map(${dyn}::Number).or_else(|| runtime::error_code(&failure.error).map(${dyn}::String)).unwrap_or(${dyn}::Null);
      runtime::map_set_by(object, runtime::string("code"), code, |a,b| a == b);
      if runtime::error_code(&failure.error).is_none() {
        runtime::map_set_by(object, runtime::string("killed"), ${dyn}::Boolean(failure.killed), |a,b| a == b);
        runtime::map_set_by(object, runtime::string("signal"), failure.signal.clone().map(${dyn}::String).unwrap_or(${dyn}::Null), |a,b| a == b);
      }
      runtime::map_set_by(object, runtime::string("cmd"), ${dyn}::String(output.command.clone()), |a,b| a == b);
      if promise {
        runtime::map_set_by(object, runtime::string("stdout"), ${dyn}::String(output.stdout.clone()), |a,b| a == b);
        runtime::map_set_by(object, runtime::string("stderr"), ${dyn}::String(output.stderr.clone()), |a,b| a == b);
      }
    }
    error
  }
  fn sc_native_child_get(child: &runtime::JsChild, key: &str) -> ${dyn} {
    match key { "pid" => runtime::child_pid(child).map(${dyn}::Number).unwrap_or(${dyn}::Undefined),
      "exitCode" => runtime::child_exit_code(child).map(${dyn}::Number).unwrap_or(${dyn}::Null),
      "killed" => ${dyn}::Boolean(runtime::child_killed(child)),
      "then" => ${dyn}::Undefined,
      _ => runtime::throw_type_error("scriptc: ChildProcess member is not ported".into()) }
  }`);
}

export function emitExecFileCall(expr: RustLibCallExpr, context: RustLibCallContext): string | null {
  if (expr.fn === "cp.promiseChild") return `runtime::promise_own_get::<_, runtime::JsChild>(&(${context.emitExpr(expr.args[0]!)}), "child").unwrap_or_else(|| runtime::throw_type_error("scriptc: required Promise child property is missing".into()))`;
  if (expr.fn !== "cp.execFileNative" && expr.fn !== "cp.execFilePromise") return null;
  const dyn = context.dynTypeName();
  const values = context.nextTemporary(), request = context.nextTemporary();
  const normalize = `let ${values} = ${context.emitExpr(expr.args[0]!)}; let ${request} = runtime::exec_file_normalize((0..runtime::array_len(&${values}) as usize).map(|i| runtime::array_get(&${values}, i as f64)).collect(), ${expr.fn === "cp.execFilePromise"});`;
  if (expr.fn === "cp.execFileNative") return `{ ${normalize}
    let callback = ${request}.callback; let traced = callback.clone();
    runtime::child_exec_file_options(&${request}.command, &${request}.arguments, ${request}.options,
      std::rc::Rc::new(move |output| { if sc_dyn_typeof(&callback).as_ref() == "function" {
        let error = if output.error.is_some() { sc_exec_file_error(&output, false) } else { ${dyn}::Null };
        let _ = sc_dyn_call(&callback, &[error, ${dyn}::String(output.stdout), ${dyn}::String(output.stderr)], "execFile callback");
      }}), std::rc::Rc::new(move |tracer| runtime::HeapValue::trace_value(&traced, tracer))) }`;
  if (expr.type.kind !== "promise") context.unsupported("execFile Promise result", expr.loc);
  const promise = context.nextTemporary(), target = context.nextTemporary(), traced = context.nextTemporary(), child = context.nextTemporary();
  const value = context.emitDynCheckValue(expr.type.inner, `${dyn}::Object(object)`, expr.loc);
  return `{ ${normalize}
    let ${promise} = runtime::promise_new(); let ${target} = ${promise}.clone(); let ${traced} = ${target}.clone();
    let ${child} = runtime::child_exec_file_options(&${request}.command, &${request}.arguments, ${request}.options,
      std::rc::Rc::new(move |output| {
        if output.error.is_some() { let _ = runtime::promise_reject(&${target}, runtime::caught_value(sc_exec_file_error(&output, true))); }
        else { let object = runtime::map_new();
          runtime::map_set_by(&object, runtime::string("stdout"), ${dyn}::String(output.stdout), |a,b| a == b);
          runtime::map_set_by(&object, runtime::string("stderr"), ${dyn}::String(output.stderr), |a,b| a == b);
          let value = ${value}; let _ = runtime::promise_fulfill(&${target}, value); }
      }), std::rc::Rc::new(move |tracer| tracer.edge(&${traced})));
    runtime::promise_own_set(&${promise}, "child", ${child}); ${promise} }`;
}
