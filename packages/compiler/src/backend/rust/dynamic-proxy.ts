import type { RustDynamicContext } from "./dynamic-context.js";

/** Native proxies retain their target and handler, including cycles. This
 * slice implements [[Get]] for string/symbol keys over mutable object maps;
 * other internal methods keep explicit runtime refusals. */
export function emitRustDynamicProxy(context: RustDynamicContext): void {
  const dyn = context.dynTypeName();
  const line = (value: string) => context.line(value);
  line(`struct ScDynProxy { target: Option<${dyn}>, handler: Option<${dyn}> }`);
  line("impl runtime::Trace for ScDynProxy { fn trace(&self, tracer: &mut runtime::Tracer<'_>) {");
  line("if let Some(value) = &self.target { runtime::Trace::trace(value, tracer); }");
  line("if let Some(value) = &self.handler { runtime::Trace::trace(value, tracer); }");
  line("} }");
  line("impl runtime::ClearEdges for ScDynProxy { fn clear_edges(&mut self) { self.target = None; self.handler = None; } }");
  line('fn sc_dyn_proxy_unsupported<T>(operation: &str) -> T { runtime::throw_error(format!("scriptc: {} on native Proxy objects is not supported yet", operation)) }');
  line(`fn sc_dyn_mark_proxy_restricted(value: ${dyn}) -> ${dyn} { match &value { ${dyn}::Object(object) => runtime::map_mark_proxy_restricted(object), ${dyn}::Proxy(..) => sc_dyn_proxy_unsupported("Object.freeze"), _ => {}, } value }`);
  line(`fn sc_dyn_proxy_check_target(value: &${dyn}) { match value {`);
  line(`${dyn}::Object(object) if runtime::map_is_proxy_restricted(object) || runtime::map_is_module_namespace(object) => sc_dyn_proxy_unsupported("get with frozen or descriptor-restricted targets"),`);
  line(`${dyn}::Proxy(proxy) => { let target = proxy.with(|proxy| proxy.target.as_ref().expect("scriptc: cleared live Proxy target").clone()); sc_dyn_proxy_check_target(&target); },`);
  line('_ => {}, } }');
  line(`fn sc_dyn_proxy_new(target: ${dyn}, handler: ${dyn}) -> ${dyn} {`);
  line(`for (index, value) in [&target, &handler].into_iter().enumerate() { match value { ${dyn}::Object(..) | ${dyn}::Proxy(..) => {},`);
  line(`${dyn}::Undefined | ${dyn}::Null | ${dyn}::Number(..) | ${dyn}::BigInt(..) | ${dyn}::Boolean(..) | ${dyn}::String(..) | ${dyn}::Symbol(..) => runtime::throw_type_error(if runtime::target_runtime_id() == "bun" { format!("A Proxy's '{}' should be an Object", if index == 0 { "target" } else { "handler" }) } else { "Cannot create proxy with a non-object as target or handler".to_owned() }),`);
  line('_ => sc_dyn_proxy_unsupported("callable or exotic targets and handlers"), } }');
  line(`if let ${dyn}::Object(object) = &target { if runtime::map_is_module_namespace(object) { return sc_dyn_proxy_unsupported("module namespace targets"); } }`);
  line(`${dyn}::Proxy(runtime::Gc::new(ScDynProxy { target: Some(target), handler: Some(handler) })) }`);
  line(`fn sc_dyn_get(value: &${dyn}, key: &runtime::JsString, receiver: &${dyn}) -> ${dyn} { match value {`);
  line(`${dyn}::Object(object) => sc_dyn_object_key_get(object, key, receiver),`);
  line(`${dyn}::Proxy(proxy) => sc_dyn_proxy_get(proxy, &${dyn}::String(key.clone()), receiver),`);
  line("_ => sc_dyn_key_get(value, key, false), } }");
  line(`fn sc_dyn_get_key(value: &${dyn}, key: &${dyn}, receiver: &${dyn}) -> ${dyn} { match key {`);
  line(`${dyn}::String(key) => sc_dyn_get(value, key, receiver),`);
  line(`${dyn}::Symbol(..) => match value { ${dyn}::Proxy(proxy) => sc_dyn_proxy_get(proxy, key, receiver), _ => runtime::throw_error("scriptc: symbol-keyed native object storage is not supported yet".to_owned()), },`);
  line(`${dyn}::Undefined | ${dyn}::Null | ${dyn}::Number(..) | ${dyn}::BigInt(..) | ${dyn}::Boolean(..) => sc_dyn_get(value, &sc_dyn_to_string(key), receiver),`);
  line('_ => runtime::throw_error("scriptc: native object property-key coercion is not supported yet".to_owned()), } }');
  line(`fn sc_dyn_proxy_get(proxy: &runtime::Gc<ScDynProxy>, key: &${dyn}, receiver: &${dyn}) -> ${dyn} {`);
  line('let (target, handler) = proxy.with(|proxy| (proxy.target.as_ref().expect("scriptc: cleared live Proxy target").clone(), proxy.handler.as_ref().expect("scriptc: cleared live Proxy handler").clone()));');
  line('sc_dyn_proxy_check_target(&target);');
  line('let trap = sc_dyn_get(&handler, &runtime::string("get"), &handler);');
  line('sc_dyn_proxy_check_target(&target);');
  line(`if matches!(&trap, ${dyn}::Undefined | ${dyn}::Null) { return sc_dyn_get_key(&target, key, receiver); }`);
  line('if sc_dyn_kind(&trap) != "function" {');
  line('if runtime::target_runtime_id() == "bun" { runtime::throw_type_error("\'get\' property of a Proxy\'s handler should be callable".to_owned()); }');
  line(`let detail = match &trap { ${dyn}::Object(..) | ${dyn}::Proxy(..) => runtime::string("#<Object>"), ${dyn}::Symbol(value) => runtime::symbol_to_string(value), _ => sc_dyn_to_string(&trap), };`);
  line('runtime::throw_type_error(format!("\'{}\' returned for property \'get\' of object \'#<Object>\' is not a function", detail)); }');
  if (context.usesDynamicInvoke()) {
    line("let _this_guard = sc_dyn_this_push(handler);");
    line('let result = sc_dyn_call(&trap, &[target.clone(), key.clone(), receiver.clone()], "get");');
    line('sc_dyn_proxy_check_target(&target); result }');
  } else {
    line('sc_dyn_proxy_unsupported("getter invocation without dynamic call support") }');
  }
}
