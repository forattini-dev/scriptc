export interface RustDynamicHttpContext {
  line(value: string): void;
  pushIndent(): void;
  popIndent(): void;
  dynTypeName(): string;
  usesDynamicInvoke(): boolean;
}

/** Emit checked-dynamic dispatch for node:http request and response handles. */
export function emitRustDynamicHttp(context: RustDynamicHttpContext): void {
  const dyn = context.dynTypeName();
  const line = (value: string): void => context.line(value);
  const open = (value: string): void => { line(value); context.pushIndent(); };
  const close = (value: string): void => { context.popIndent(); line(value); };

  open(`fn sc_dyn_http_header_value(value: &${dyn}, name: &str) -> runtime::JsString {`);
  open("match value {");
  line(`${dyn}::String(value) => value.clone(),`);
  line(`${dyn}::Number(value) => runtime::string(&runtime::display_number(*value)),`);
  line(`value => sc_dyn_arg_type_fail(name, "of type string or number", value),`);
  close("}");
  close("}");

  open(`fn sc_dyn_http_request_get(request: &runtime::JsHttpRequest, key: &runtime::JsString) -> ${dyn} {`);
  open("match key.as_ref() {");
  line(`"status" if runtime::http_request_is_fetch_response(request) => ${dyn}::Number(runtime::http_request_status_code(request).unwrap_or(200.0)),`);
  line(`"ok" if runtime::http_request_is_fetch_response(request) => { let status = runtime::http_request_status_code(request).unwrap_or(200.0); ${dyn}::Boolean((200.0..300.0).contains(&status)) },`);
  line(`"statusText" if runtime::http_request_is_fetch_response(request) => ${dyn}::String(runtime::http_request_status_message(request).unwrap_or_else(runtime::empty_string)),`);
  line(`"bodyUsed" if runtime::http_request_is_fetch_response(request) => ${dyn}::Boolean(runtime::http_request_fetch_body_used(request)),`);
  line(`"url" => ${dyn}::String(runtime::http_request_url(request)),`);
  line(`"method" => ${dyn}::String(runtime::http_request_method(request)),`);
  line(`"statusCode" => runtime::http_request_status_code(request).map(${dyn}::Number).unwrap_or(${dyn}::Null),`);
  line(`"readable" => ${dyn}::Boolean(runtime::http_request_readable(request)),`);
  line(`"readableEnded" | "complete" => ${dyn}::Boolean(!runtime::http_request_readable(request)),`);
  line(`"destroyed" => ${dyn}::Boolean(runtime::http_request_destroyed(request)),`);
  line('"headers" => {');
  context.pushIndent();
  line(`let output: runtime::JsMap<runtime::JsString, ${dyn}> = runtime::map_new();`);
  line(`for (name, value) in runtime::http_request_headers(request) { runtime::map_set_by(&output, name, ${dyn}::String(value), |left, right| left.as_ref() == right.as_ref()); }`);
  line(`${dyn}::Object(output)`);
  context.popIndent();
  line("},");
  line(`_ => ${dyn}::Undefined,`);
  close("}");
  close("}");

  open(`fn sc_dyn_http_response_get(response: &runtime::JsHttpResponse, key: &runtime::JsString) -> ${dyn} {`);
  open("match key.as_ref() {");
  line(`"statusCode" => ${dyn}::Number(runtime::http_response_status_get(response)),`);
  line(`"statusMessage" => ${dyn}::String(runtime::http_response_status_message_get(response)),`);
  line(`"headersSent" => ${dyn}::Boolean(runtime::http_response_headers_sent(response)),`);
  line(`"writableCorked" => ${dyn}::Number(runtime::http_response_writable_corked(response)),`);
  line(`"finished" | "writableEnded" | "writableFinished" => ${dyn}::Boolean(runtime::http_response_writable_finished(response)),`);
  line(`"destroyed" => ${dyn}::Boolean(runtime::http_response_destroyed(response)),`);
  line(`"req" => runtime::http_response_request(response).map(${dyn}::HttpRequest).unwrap_or(${dyn}::Null),`);
  line(`_ => ${dyn}::Undefined,`);
  close("}");
  close("}");

  open(`fn sc_dyn_http_response_set(response: &runtime::JsHttpResponse, key: &runtime::JsString, value: &${dyn}) -> bool {`);
  open("match key.as_ref() {");
  line(`"statusCode" => { let ${dyn}::Number(value) = value else { sc_dyn_arg_type_fail("statusCode", "of type number", value); }; runtime::http_response_status_set(response, *value); true },`);
  line(`"statusMessage" => { let ${dyn}::String(value) = value else { sc_dyn_arg_type_fail("statusMessage", "of type string", value); }; runtime::http_response_status_message_set(response, value); true },`);
  line("_ => false,");
  close("}");
  close("}");

  if (!context.usesDynamicInvoke()) return;

  open(`fn sc_dyn_http_request_invoke(request: &runtime::JsHttpRequest, recv: &${dyn}, method: &str, args: &[${dyn}], callee_name: &str) -> ${dyn} {`);
  open("match method {");
  line(`"pause" => { runtime::http_request_pause(request); recv.clone() },`);
  line(`"resume" => { runtime::http_request_resume(request); recv.clone() },`);
  line(`"pipe" => { let destination = match args.first() { Some(${dyn}::HttpResponse(response)) => response, value => sc_dyn_arg_type_fail("destination", "an instance of ServerResponse", value.unwrap_or(&${dyn}::Undefined)), }; runtime::http_request_pipe_response(request, destination); args[0].clone() },`);
  line('"on" | "once" | "addListener" => {');
  context.pushIndent();
  line(`let event = match args.first() { Some(${dyn}::String(value)) => value.as_ref(), _ => runtime::throw_type_error(format!("{callee_name} is not a function")), };`);
  line(`let callback = args.get(1).cloned().unwrap_or(${dyn}::Undefined);`);
  line(`if sc_dyn_function_identity(&callback).is_none() { sc_dyn_arg_type_fail("listener", "of type function", &callback); }`);
  line("let traced = callback.clone();");
  line("let this_request = request.clone();");
  line("let once = method == \"once\";");
  open("match event {");
  line(`"data" => runtime::http_request_on_data(request, std::rc::Rc::new(move |chunk| { let _guard = sc_dyn_this_push(${dyn}::HttpRequest(this_request.clone())); let _ = sc_dyn_call(&callback, &[${dyn}::Buffer(chunk)], "listener"); }), std::rc::Rc::new(move |tracer| runtime::Trace::trace(&traced, tracer)), once),`);
  line(`"end" => runtime::http_request_on_end(request, std::rc::Rc::new(move || { let _guard = sc_dyn_this_push(${dyn}::HttpRequest(this_request.clone())); let _ = sc_dyn_call(&callback, &[], "listener"); }), std::rc::Rc::new(move |tracer| runtime::Trace::trace(&traced, tracer)), once),`);
  line(`_ => runtime::throw_error(format!("listening for '{event}' on a dynamic IncomingMessage is not supported yet")),`);
  close("}");
  line("recv.clone()");
  context.popIndent();
  line("},");
  line(`_ => runtime::throw_type_error(format!("{callee_name} is not a function")),`);
  close("}");
  close("}");

  open(`fn sc_dyn_http_response_headers(response: &runtime::JsHttpResponse) -> ${dyn} {`);
  line(`let output: runtime::JsMap<runtime::JsString, ${dyn}> = runtime::map_new();`);
  line(`for (name, value) in runtime::http_response_get_headers(response) { runtime::map_set_by(&output, name, ${dyn}::String(value), |left, right| left.as_ref() == right.as_ref()); }`);
  line(`${dyn}::Object(output)`);
  close("}");

  open(`fn sc_dyn_http_response_write_head(response: &runtime::JsHttpResponse, args: &[${dyn}]) {`);
  line(`let status = match args.first() { Some(${dyn}::Number(value)) => *value, value => sc_dyn_arg_type_fail("statusCode", "of type number", value.unwrap_or(&${dyn}::Undefined)), };`);
  open("if let Some(headers) = args.get(1) {");
  open("match headers {");
  line(`${dyn}::Undefined => {},`);
  line(`${dyn}::Array(values) => { let length = runtime::array_len(values); if length % 2.0 != 0.0 { runtime::throw_type_error_code("The argument 'headers' is invalid.".to_owned(), "ERR_INVALID_ARG_VALUE"); } let mut index = 0.0; while index < length { let name = match runtime::array_get(values, index) { ${dyn}::String(value) => value, value => sc_dyn_arg_type_fail("name", "of type string", &value), }; let value = sc_dyn_http_header_value(&runtime::array_get(values, index + 1.0), name.as_ref()); runtime::http_response_set_header(response, &name, &value); index += 2.0; } },`);
  line(`${dyn}::Object(values) => { let mut index = 0.0; while index < runtime::map_iter_count(values) { if runtime::map_iter_live(values, index) { let name = runtime::map_iter_key(values, index); let value = sc_dyn_http_header_value(&runtime::map_iter_value(values, index), name.as_ref()); runtime::http_response_set_header(response, &name, &value); } index += 1.0; } },`);
  line(`value => sc_dyn_arg_type_fail("headers", "of type object or an instance of Array", value),`);
  close("}");
  close("}");
  line("runtime::http_response_write_head(response, status);");
  close("}");

  open(`fn sc_dyn_http_response_callback(response: &runtime::JsHttpResponse, callback: ${dyn}, finish: bool) {`);
  line(`if sc_dyn_function_identity(&callback).is_none() { sc_dyn_arg_type_fail("callback", "of type function", &callback); }`);
  line("let traced = callback.clone();");
  line("let this_response = response.clone();");
  line(`let invoke = std::rc::Rc::new(move || { let _guard = sc_dyn_this_push(${dyn}::HttpResponse(this_response.clone())); let _ = sc_dyn_call(&callback, &[], "callback"); });`);
  line("let trace = std::rc::Rc::new(move |tracer: &mut runtime::Tracer<'_>| runtime::Trace::trace(&traced, tracer));");
  line("if finish { runtime::http_response_on_finish(response, invoke, trace); } else { runtime::http_response_after_write(response, invoke, trace); }");
  close("}");

  open(`fn sc_dyn_http_response_write(response: &runtime::JsHttpResponse, args: &[${dyn}]) -> ${dyn} {`);
  line(`let chunk = args.first().unwrap_or(&${dyn}::Undefined);`);
  line("let mut callback_index = 1usize;");
  open("match chunk {");
  line(`${dyn}::String(value) => { if let Some(${dyn}::String(encoding)) = args.get(1) { let bytes = runtime::buffer_from_string(value, encoding); runtime::http_response_write_bytes(response, &bytes); callback_index = 2; } else { runtime::http_response_write_str(response, value); } },`);
  line(`${dyn}::Bytes(value) | ${dyn}::Buffer(value) => { runtime::http_response_write_bytes(response, value); if matches!(args.get(1), Some(${dyn}::String(_))) { callback_index = 2; } },`);
  line(`value => sc_dyn_arg_type_fail("chunk", "of type string or an instance of Buffer or Uint8Array", value),`);
  close("}");
  line("if let Some(callback) = args.get(callback_index) { sc_dyn_http_response_callback(response, callback.clone(), false); }");
  line(`${dyn}::Boolean(true)`);
  close("}");

  open(`fn sc_dyn_http_response_end(response: &runtime::JsHttpResponse, recv: &${dyn}, args: &[${dyn}]) -> ${dyn} {`);
  line("let callback_index = match args.first() {");
  context.pushIndent();
  line(`Some(value) if sc_dyn_function_identity(value).is_some() => Some(0usize),`);
  line(`Some(${dyn}::String(_)) => Some(if matches!(args.get(1), Some(${dyn}::String(_))) { 2 } else { 1 }),`);
  line(`Some(${dyn}::Bytes(_) | ${dyn}::Buffer(_)) => Some(if matches!(args.get(1), Some(${dyn}::String(_))) { 2 } else { 1 }),`);
  line("_ => None,");
  context.popIndent();
  line("};");
  line("if let Some(index) = callback_index { if let Some(callback) = args.get(index) { if !matches!(callback, " + `${dyn}::Undefined) { sc_dyn_http_response_callback(response, callback.clone(), true); } } }`);
  open("match args.first() {");
  line(`None | Some(${dyn}::Undefined) | Some(${dyn}::Null) => runtime::http_response_end(response),`);
  line(`Some(value) if sc_dyn_function_identity(value).is_some() => runtime::http_response_end(response),`);
  line(`Some(${dyn}::String(value)) => { if let Some(${dyn}::String(encoding)) = args.get(1) { let bytes = runtime::buffer_from_string(value, encoding); runtime::http_response_end_bytes(response, &bytes); } else { runtime::http_response_end_str(response, value); } },`);
  line(`Some(${dyn}::Bytes(value) | ${dyn}::Buffer(value)) => runtime::http_response_end_bytes(response, value),`);
  line(`Some(value) => sc_dyn_arg_type_fail("chunk", "of type string or an instance of Buffer or Uint8Array", value),`);
  close("}");
  line("recv.clone()");
  close("}");

  open(`fn sc_dyn_http_response_invoke(response: &runtime::JsHttpResponse, recv: &${dyn}, method: &str, args: &[${dyn}], callee_name: &str) -> ${dyn} {`);
  open("match method {");
  line('"setHeader" => { let name = match args.first() { Some(' + `${dyn}::String(value)) => value, value => sc_dyn_arg_type_fail("name", "of type string", value.unwrap_or(&${dyn}::Undefined)), }; let value = sc_dyn_http_header_value(args.get(1).unwrap_or(&${dyn}::Undefined), name.as_ref()); runtime::http_response_set_header(response, name, &value); recv.clone() },`);
  line('"getHeaders" => sc_dyn_http_response_headers(response),');
  line('"flushHeaders" => { runtime::http_response_flush_headers(response); ' + `${dyn}::Undefined },`);
  line('"cork" => { runtime::http_response_cork(response); ' + `${dyn}::Undefined },`);
  line('"uncork" => { runtime::http_response_uncork(response); ' + `${dyn}::Undefined },`);
  line('"writeHead" => { sc_dyn_http_response_write_head(response, args); recv.clone() },');
  line('"write" => sc_dyn_http_response_write(response, args),');
  line('"end" => sc_dyn_http_response_end(response, recv, args),');
  line('"on" | "once" | "addListener" => {');
  context.pushIndent();
  line(`let event = match args.first() { Some(${dyn}::String(value)) => value.as_ref(), _ => runtime::throw_type_error(format!("{callee_name} is not a function")), };`);
  line(`let callback = args.get(1).cloned().unwrap_or(${dyn}::Undefined);`);
  line(`if sc_dyn_function_identity(&callback).is_none() { sc_dyn_arg_type_fail("listener", "of type function", &callback); }`);
  line("let traced = callback.clone();");
  line("let this_response = response.clone();");
  line(`let invoke = std::rc::Rc::new(move || { let _guard = sc_dyn_this_push(${dyn}::HttpResponse(this_response.clone())); let _ = sc_dyn_call(&callback, &[], "listener"); });`);
  line("let trace = std::rc::Rc::new(move |tracer: &mut runtime::Tracer<'_>| runtime::Trace::trace(&traced, tracer));");
  line("match event { \"close\" => runtime::http_response_on_close(response, invoke, trace), \"finish\" => runtime::http_response_on_finish(response, invoke, trace), _ => runtime::throw_error(format!(\"listening for '{event}' on a dynamic ServerResponse is not supported yet\")), }");
  line("recv.clone()");
  context.popIndent();
  line("},");
  line(`_ => runtime::throw_type_error(format!("{callee_name} is not a function")),`);
  close("}");
  close("}");
}
