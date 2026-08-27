export interface RustDynamicAgentContext {
  line(value: string): void;
  pushIndent(): void;
  popIndent(): void;
  dynTypeName(): string;
  usesDynamicInvoke(): boolean;
}

/** Emit checked-dynamic dispatch for node:http Agent handles. */
export function emitRustDynamicAgent(context: RustDynamicAgentContext): void {
  const dyn = context.dynTypeName();
  const line = (value: string): void => context.line(value);
  const open = (value: string): void => { line(value); context.pushIndent(); };
  const close = (value: string): void => { context.popIndent(); line(value); };
  const alternate = (value: string): void => { close(value); context.pushIndent(); };

  open(`fn sc_dyn_http_agent_table(agent: &runtime::JsHttpAgent, queued: bool) -> ${dyn} {`);
  line(`let output: runtime::JsMap<runtime::JsString, ${dyn}> = runtime::map_new();`);
  open("if queued {");
  open("for name in runtime::http_agent_queued_names(agent) {");
  line(`let array = match runtime::map_get_by(&output, &name, |left, right| left.as_ref() == right.as_ref()) { Some(${dyn}::Array(array)) => array, _ => { let array = runtime::array_new(Vec::new()); runtime::map_set_by(&output, name.clone(), ${dyn}::Array(array.clone()), |left, right| left.as_ref() == right.as_ref()); array }, };`);
  line(`runtime::array_push(&array, ${dyn}::Undefined);`);
  close("}");
  alternate("} else {");
  open("for (name, socket) in runtime::http_agent_sockets(agent) {");
  line(`let array = match runtime::map_get_by(&output, &name, |left, right| left.as_ref() == right.as_ref()) { Some(${dyn}::Array(array)) => array, _ => { let array = runtime::array_new(Vec::new()); runtime::map_set_by(&output, name.clone(), ${dyn}::Array(array.clone()), |left, right| left.as_ref() == right.as_ref()); array }, };`);
  line(`runtime::array_push(&array, ${dyn}::NetSocket(socket));`);
  close("}");
  close("}");
  line(`${dyn}::Object(output)`);
  close("}");

  open(`fn sc_dyn_http_agent_get(agent: &runtime::JsHttpAgent, key: &runtime::JsString) -> ${dyn} {`);
  open("match key.as_ref() {");
  line(`"maxSockets" => ${dyn}::Number(runtime::http_agent_max_sockets(agent)),`);
  line(`"maxFreeSockets" => ${dyn}::Number(runtime::http_agent_max_free_sockets(agent)),`);
  line(`"keepAlive" => ${dyn}::Boolean(runtime::http_agent_keep_alive(agent)),`);
  line(`"keepAliveMsecs" => ${dyn}::Number(runtime::http_agent_keep_alive_msecs(agent)),`);
  line(`"defaultPort" => ${dyn}::Number(runtime::http_agent_default_port(agent)),`);
  line(`"protocol" => ${dyn}::String(runtime::http_agent_protocol(agent)),`);
  line('"sockets" => sc_dyn_http_agent_table(agent, false),');
  line('"requests" => sc_dyn_http_agent_table(agent, true),');
  line(`"freeSockets" => ${dyn}::Object(runtime::map_new()),`);
  line(`_ => ${dyn}::Undefined,`);
  close("}");
  close("}");

  open(`fn sc_dyn_http_agent_set(agent: &runtime::JsHttpAgent, key: &runtime::JsString, value: &${dyn}) -> bool {`);
  line(`let ${dyn}::Number(value) = value else { if matches!(key.as_ref(), "defaultPort" | "maxSockets" | "maxFreeSockets" | "keepAliveMsecs") { sc_dyn_arg_type_fail(key, "of type number", value); } return false; };`);
  line("runtime::http_agent_number_set(agent, key, *value)");
  close("}");

  if (!context.usesDynamicInvoke()) return;

  open(`fn sc_dyn_http_agent_option(options: &${dyn}, key: &str) -> ${dyn} {`);
  line(`match options { ${dyn}::Object(object) => runtime::map_get_by(object, &runtime::string(key), |left, right| left.as_ref() == right.as_ref()).unwrap_or(${dyn}::Undefined), _ => ${dyn}::Undefined, }`);
  close("}");

  open(`fn sc_dyn_http_agent_option_string(options: &${dyn}, key: &str) -> Option<runtime::JsString> {`);
  line(`match sc_dyn_http_agent_option(options, key) { ${dyn}::String(value) => Some(value), ${dyn}::Number(value) => Some(runtime::string(&runtime::display_number(value))), _ => None, }`);
  close("}");

  open(`fn sc_dyn_http_agent_invoke(agent: &runtime::JsHttpAgent, method: &str, args: &[${dyn}], callee_name: &str) -> ${dyn} {`);
  open("match method {");
  line(`"getName" => { let options = args.first().unwrap_or(&${dyn}::Undefined); let host = sc_dyn_http_agent_option_string(options, "host"); let port = sc_dyn_http_agent_option_string(options, "port"); let local = sc_dyn_http_agent_option_string(options, "localAddress"); let socket_path = sc_dyn_http_agent_option_string(options, "socketPath"); let family = match sc_dyn_http_agent_option(options, "family") { ${dyn}::Number(value) => value, _ => 0.0 }; ${dyn}::String(runtime::http_agent_name(host.as_ref(), port.as_ref(), local.as_ref(), family, socket_path.as_ref())) },`);
  line(`"destroy" => { runtime::http_agent_destroy(agent); ${dyn}::Undefined },`);
  line(`"toString" => ${dyn}::String(runtime::string("[object Object]")),`);
  line(`_ => runtime::throw_type_error(format!("{callee_name} is not a function")),`);
  close("}");
  close("}");
}
