import type { IrType } from "../../ir/nodes.js";
import type { RustLibCallContext, RustLibCallExpr } from "./lib-calls.js";

type IrFuncType = Extract<IrType, { kind: "func" }>;

function emitCreateServerCallback(
  expr: RustLibCallExpr,
  callbackType: IrFuncType,
  context: RustLibCallContext,
): string {
  const callbackExpr = expr.args[0];
  if (callbackExpr === undefined || callbackType.params.length > 2) {
    context.unsupported("http.createServer callback", expr.loc);
  }
  const [request, response] = callbackType.params;
  if ((request !== undefined && request.kind !== "httpReq") ||
      (response !== undefined && response.kind !== "httpRes")) {
    context.unsupported("HTTP request listener parameters", expr.loc);
  }
  const callback = context.nextTemporary();
  const traced = context.nextTemporary();
  const args = callbackType.params.map((_, index) => index === 0 ? "sc_request" : "sc_response");
  const dispatch = context.emitClosureDispatch(callback, callbackType, args, expr.loc);
  return `{ let ${callback} = ${context.emitExpr(callbackExpr)}; let ${traced} = ${callback}.clone(); runtime::http_server_new_callback(std::rc::Rc::new(move |sc_request, sc_response| { let _ = ${dispatch}; }), std::rc::Rc::new(move |sc_tracer: &mut runtime::Tracer<'_>| sc_tracer.edge(&${traced}))) }`;
}

function emitRequestListener(
  expr: RustLibCallExpr,
  callbackType: IrFuncType,
  context: RustLibCallContext,
): string {
  const [receiver, callbackExpr, onceExpr] = expr.args;
  if (receiver?.type.kind !== "netServer" || callbackExpr === undefined || onceExpr?.type.kind !== "bool") {
    context.unsupported("http.serverOnRequest shape", expr.loc);
  }
  const [request, response] = callbackType.params;
  if (callbackType.params.length > 2 ||
      (request !== undefined && request.kind !== "httpReq") ||
      (response !== undefined && response.kind !== "httpRes")) {
    context.unsupported("HTTP request listener parameters", expr.loc);
  }
  const callback = context.nextTemporary();
  const traced = context.nextTemporary();
  const args = callbackType.params.map((_, index) => index === 0 ? "sc_request" : "sc_response");
  const dispatch = context.emitClosureDispatch(callback, callbackType, args, expr.loc);
  return `{ let ${callback} = ${context.emitExpr(callbackExpr)}; let ${traced} = ${callback}.clone(); runtime::http_server_on_request(&(${context.emitExpr(receiver)}), std::rc::Rc::new(move |sc_request, sc_response| { let _ = ${dispatch}; }), std::rc::Rc::new(move |sc_tracer: &mut runtime::Tracer<'_>| sc_tracer.edge(&${traced})), ${context.emitExpr(onceExpr)}); }`;
}

function emitIncomingDataListener(
  expr: RustLibCallExpr,
  callbackType: IrFuncType,
  context: RustLibCallContext,
): string {
  const [receiver, callbackExpr, onceExpr] = expr.args;
  if (receiver?.type.kind !== "httpReq" || callbackExpr === undefined || onceExpr?.type.kind !== "bool") {
    context.unsupported("http.reqOnData shape", expr.loc);
  }
  const parameter = callbackType.params[0];
  if (callbackType.params.length > 1 ||
      (parameter !== undefined && parameter.kind !== "dyn" &&
        (parameter.kind !== "bytes" || parameter.elem !== "u8"))) {
    context.unsupported("HTTP data listener parameter", expr.loc);
  }
  const callback = context.nextTemporary();
  const traced = context.nextTemporary();
  const argument = parameter?.kind === "dyn" ? `${context.dynTypeName()}::Buffer(sc_chunk)` : "sc_chunk";
  const dispatch = context.emitClosureDispatch(callback, callbackType, parameter === undefined ? [] : [argument], expr.loc);
  return `{ let ${callback} = ${context.emitExpr(callbackExpr)}; let ${traced} = ${callback}.clone(); runtime::http_request_on_data(&(${context.emitExpr(receiver)}), std::rc::Rc::new(move |sc_chunk| { let _ = ${dispatch}; }), std::rc::Rc::new(move |sc_tracer: &mut runtime::Tracer<'_>| sc_tracer.edge(&${traced})), ${context.emitExpr(onceExpr)}); }`;
}

function emitIncomingEndListener(
  expr: RustLibCallExpr,
  callbackType: IrFuncType,
  context: RustLibCallContext,
): string {
  const [receiver, callbackExpr, onceExpr] = expr.args;
  if (receiver?.type.kind !== "httpReq" || callbackExpr === undefined || onceExpr?.type.kind !== "bool" ||
      callbackType.params.length !== 0) {
    context.unsupported("http.reqOnEnd shape", expr.loc);
  }
  const callback = context.nextTemporary();
  const traced = context.nextTemporary();
  const dispatch = context.emitClosureDispatch(callback, callbackType, [], expr.loc);
  return `{ let ${callback} = ${context.emitExpr(callbackExpr)}; let ${traced} = ${callback}.clone(); runtime::http_request_on_end(&(${context.emitExpr(receiver)}), std::rc::Rc::new(move || { let _ = ${dispatch}; }), std::rc::Rc::new(move |sc_tracer: &mut runtime::Tracer<'_>| sc_tracer.edge(&${traced})), ${context.emitExpr(onceExpr)}); }`;
}

function emitResponseCallback(
  callbackExpr: RustLibCallExpr["args"][number],
  callbackType: IrFuncType,
  context: RustLibCallContext,
  expr: RustLibCallExpr,
  runtimeCall: (invoke: string, trace: string) => string,
): string {
  const parameter = callbackType.params[0];
  if (callbackType.params.length > 1 || (parameter !== undefined && parameter.kind !== "httpReq")) {
    context.unsupported("HTTP response callback parameter", expr.loc);
  }
  const callback = context.nextTemporary();
  const traced = context.nextTemporary();
  const dispatch = context.emitClosureDispatch(
    callback,
    callbackType,
    parameter === undefined ? [] : ["sc_response"],
    expr.loc,
  );
  return `{ let ${callback} = ${context.emitExpr(callbackExpr)}; let ${traced} = ${callback}.clone(); ${runtimeCall(`std::rc::Rc::new(move |sc_response| { let _ = ${dispatch}; })`, `std::rc::Rc::new(move |sc_tracer: &mut runtime::Tracer<'_>| sc_tracer.edge(&${traced}))`)} }`;
}

function emitClientErrorListener(
  expr: RustLibCallExpr,
  callbackType: IrFuncType,
  context: RustLibCallContext,
): string {
  const [receiver, callbackExpr, onceExpr] = expr.args;
  const parameter = callbackType.params[0];
  if (receiver?.type.kind !== "httpClientReq" || callbackExpr === undefined ||
      onceExpr?.type.kind !== "bool" || callbackType.params.length > 1 ||
      (parameter !== undefined && (parameter.kind !== "object" || parameter.className !== "%Error"))) {
    context.unsupported("http.clientOnError shape", expr.loc);
  }
  const callback = context.nextTemporary();
  const traced = context.nextTemporary();
  const argument = context.hasErrorClassRoots()
    ? `${context.errorValueName()}::Builtin(sc_error)`
    : "sc_error";
  const dispatch = context.emitClosureDispatch(
    callback,
    callbackType,
    parameter === undefined ? [] : [argument],
    expr.loc,
  );
  const errorName = parameter === undefined ? "_sc_error" : "sc_error";
  return `{ let ${callback} = ${context.emitExpr(callbackExpr)}; let ${traced} = ${callback}.clone(); runtime::http_client_on_error(&(${context.emitExpr(receiver)}), std::rc::Rc::new(move |${errorName}| { let _ = ${dispatch}; }), std::rc::Rc::new(move |sc_tracer: &mut runtime::Tracer<'_>| sc_tracer.edge(&${traced})), ${context.emitExpr(onceExpr)}); }`;
}

function emitClientCloseListener(
  expr: RustLibCallExpr,
  callbackType: IrFuncType,
  context: RustLibCallContext,
): string {
  const [receiver, callbackExpr, onceExpr] = expr.args;
  if (receiver?.type.kind !== "httpClientReq" || callbackExpr === undefined ||
      onceExpr?.type.kind !== "bool" || callbackType.params.length !== 0) {
    context.unsupported("http.clientOnClose shape", expr.loc);
  }
  const callback = context.nextTemporary();
  const traced = context.nextTemporary();
  const dispatch = context.emitClosureDispatch(callback, callbackType, [], expr.loc);
  return `{ let ${callback} = ${context.emitExpr(callbackExpr)}; let ${traced} = ${callback}.clone(); runtime::http_client_on_close(&(${context.emitExpr(receiver)}), std::rc::Rc::new(move || { let _ = ${dispatch}; }), std::rc::Rc::new(move |sc_tracer: &mut runtime::Tracer<'_>| sc_tracer.edge(&${traced})), ${context.emitExpr(onceExpr)}); }`;
}

function emitResponseFinishListener(
  expr: RustLibCallExpr,
  callbackType: IrFuncType,
  context: RustLibCallContext,
): string {
  const [receiver, callbackExpr] = expr.args;
  if (receiver?.type.kind !== "httpRes" || callbackExpr === undefined ||
      callbackType.params.length !== 0) {
    context.unsupported("http.resOnFinish shape", expr.loc);
  }
  const callback = context.nextTemporary();
  const traced = context.nextTemporary();
  const dispatch = context.emitClosureDispatch(callback, callbackType, [], expr.loc);
  return `{ let ${callback} = ${context.emitExpr(callbackExpr)}; let ${traced} = ${callback}.clone(); runtime::http_response_on_finish(&(${context.emitExpr(receiver)}), std::rc::Rc::new(move || { let _ = ${dispatch}; }), std::rc::Rc::new(move |sc_tracer: &mut runtime::Tracer<'_>| sc_tracer.edge(&${traced}))); }`;
}

export function emitRustHttpCall(
  expr: RustLibCallExpr,
  context: RustLibCallContext,
): string | null {
  if (expr.fn === "http.createServer" && expr.args.length === 1) {
    const callbackType = expr.args[0]?.type;
    if (callbackType?.kind !== "func") context.unsupported("http.createServer shape", expr.loc);
    return emitCreateServerCallback(expr, callbackType, context);
  }
  if (expr.fn === "http.createServerEmpty" && expr.args.length === 0) {
    return "runtime::http_server_new()";
  }
  if (expr.fn === "http.serverOnRequest" && expr.args.length === 3) {
    const callbackType = expr.args[1]?.type;
    if (callbackType?.kind !== "func") context.unsupported("http.serverOnRequest callback", expr.loc);
    return emitRequestListener(expr, callbackType, context);
  }
  if ((expr.fn === "http.reqUrl" || expr.fn === "http.reqMethod") && expr.args.length === 1 &&
      expr.args[0]?.type.kind === "httpReq") {
    const fn = expr.fn === "http.reqUrl" ? "http_request_url" : "http_request_method";
    return `runtime::${fn}(&(${context.emitExpr(expr.args[0])}))`;
  }
  if (expr.fn === "http.reqHeader" && expr.args.length === 2 &&
      expr.args[0]?.type.kind === "httpReq" && expr.args[1]?.type.kind === "string") {
    if (expr.type.kind !== "union") context.unsupported("http.reqHeader result", expr.loc);
    const union = context.union(expr.type.unionId, expr.loc);
    const stringTag = union.arms.findIndex((arm) => arm.kind === "string");
    const undefinedTag = union.arms.findIndex((arm) => arm.kind === "undefinedT");
    if (stringTag < 0 || undefinedTag < 0) context.unsupported("http.reqHeader result union", expr.loc);
    const name = context.unionName(union.id);
    return `match runtime::http_request_header(&(${context.emitExpr(expr.args[0])}), &(${context.emitExpr(expr.args[1])})) { Some(sc_value) => ${name}::${context.unionVariant(stringTag)}(sc_value), None => ${name}::${context.unionVariant(undefinedTag)}, }`;
  }
  if ((expr.fn === "http.resStatusGet" || expr.fn === "http.resStatusMsgGet" ||
      expr.fn === "http.resHeadersSent") && expr.args.length === 1 && expr.args[0]?.type.kind === "httpRes") {
    const fn = expr.fn === "http.resStatusGet" ? "http_response_status_get"
      : expr.fn === "http.resStatusMsgGet" ? "http_response_status_message_get"
      : "http_response_headers_sent";
    return `runtime::${fn}(&(${context.emitExpr(expr.args[0])}))`;
  }
  if ((expr.fn === "http.resStatusSet" || expr.fn === "http.resStatusMsgSet") && expr.args.length === 2 &&
      expr.args[0]?.type.kind === "httpRes") {
    const value = expr.args[1];
    const valid = expr.fn === "http.resStatusSet" ? value?.type.kind === "f64" : value?.type.kind === "string";
    if (!valid || value === undefined) context.unsupported(`${expr.fn} shape`, expr.loc);
    const fn = expr.fn === "http.resStatusSet" ? "http_response_status_set" : "http_response_status_message_set";
    const borrow = value.type.kind === "string" ? "&" : "";
    return `runtime::${fn}(&(${context.emitExpr(expr.args[0])}), ${borrow}(${context.emitExpr(value)}))`;
  }
  if (expr.fn === "http.resSetHeader" && expr.args.length === 3 &&
      expr.args[0]?.type.kind === "httpRes" && expr.args[1]?.type.kind === "string" &&
      expr.args[2]?.type.kind === "string") {
    return `runtime::http_response_set_header(&(${context.emitExpr(expr.args[0])}), &(${context.emitExpr(expr.args[1])}), &(${context.emitExpr(expr.args[2])}))`;
  }
  if (expr.fn === "http.resGetHeader" && expr.args.length === 2 &&
      expr.args[0]?.type.kind === "httpRes" && expr.args[1]?.type.kind === "string") {
    if (expr.type.kind !== "union") context.unsupported("http.resGetHeader result", expr.loc);
    const union = context.union(expr.type.unionId, expr.loc);
    const stringTag = union.arms.findIndex((arm) => arm.kind === "string");
    const undefinedTag = union.arms.findIndex((arm) => arm.kind === "undefinedT");
    if (stringTag < 0 || undefinedTag < 0) context.unsupported("http.resGetHeader result union", expr.loc);
    const name = context.unionName(union.id);
    return `match runtime::http_response_get_header(&(${context.emitExpr(expr.args[0])}), &(${context.emitExpr(expr.args[1])})) { Some(sc_value) => ${name}::${context.unionVariant(stringTag)}(sc_value), None => ${name}::${context.unionVariant(undefinedTag)}, }`;
  }
  if ((expr.fn === "http.resHasHeader" || expr.fn === "http.resRemoveHeader") &&
      expr.args.length === 2 && expr.args[0]?.type.kind === "httpRes" &&
      expr.args[1]?.type.kind === "string") {
    const fn = expr.fn === "http.resHasHeader" ? "http_response_has_header" : "http_response_remove_header";
    return `runtime::${fn}(&(${context.emitExpr(expr.args[0])}), &(${context.emitExpr(expr.args[1])}))`;
  }
  if (expr.fn === "http.resWriteHead" && expr.args.length === 2 &&
      expr.args[0]?.type.kind === "httpRes" && expr.args[1]?.type.kind === "f64") {
    return `runtime::http_response_write_head(&(${context.emitExpr(expr.args[0])}), ${context.emitExpr(expr.args[1])})`;
  }
  if (expr.fn === "http.resWriteHeadN" && expr.args.length === 4 &&
      expr.args[0]?.type.kind === "httpRes" && expr.args[1]?.type.kind === "f64" &&
      expr.args[2]?.type.kind === "array" && expr.args[2].type.elem.kind === "string" &&
      expr.args[3]?.type.kind === "array" && expr.args[3].type.elem.kind === "string") {
    return `runtime::http_response_write_head_n(&(${context.emitExpr(expr.args[0])}), ${context.emitExpr(expr.args[1])}, &(${context.emitExpr(expr.args[2])}), &(${context.emitExpr(expr.args[3])}))`;
  }
  if ((expr.fn === "http.resWrite" || expr.fn === "http.resEndStr") && expr.args.length === 2 &&
      expr.args[0]?.type.kind === "httpRes" && expr.args[1]?.type.kind === "string") {
    const fn = expr.fn === "http.resWrite" ? "http_response_write_str" : "http_response_end_str";
    return `runtime::${fn}(&(${context.emitExpr(expr.args[0])}), &(${context.emitExpr(expr.args[1])}))`;
  }
  if ((expr.fn === "http.resWriteBytes" || expr.fn === "http.resEndBytes") && expr.args.length === 2 &&
      expr.args[0]?.type.kind === "httpRes" && expr.args[1]?.type.kind === "bytes" &&
      expr.args[1].type.elem === "u8") {
    const fn = expr.fn === "http.resWriteBytes" ? "http_response_write_bytes" : "http_response_end_bytes";
    return `runtime::${fn}(&(${context.emitExpr(expr.args[0])}), &(${context.emitExpr(expr.args[1])}))`;
  }
  if (expr.fn === "http.resEnd" && expr.args.length === 1 && expr.args[0]?.type.kind === "httpRes") {
    return `runtime::http_response_end(&(${context.emitExpr(expr.args[0])}))`;
  }
  if (expr.fn === "http.reqOnData" && expr.args.length === 3) {
    const callbackType = expr.args[1]?.type;
    if (callbackType?.kind !== "func") context.unsupported("http.reqOnData callback", expr.loc);
    return emitIncomingDataListener(expr, callbackType, context);
  }
  if (expr.fn === "http.reqOnEnd" && expr.args.length === 3) {
    const callbackType = expr.args[1]?.type;
    if (callbackType?.kind !== "func") context.unsupported("http.reqOnEnd callback", expr.loc);
    return emitIncomingEndListener(expr, callbackType, context);
  }
  if (expr.fn === "http.resOnFinish" && expr.args.length === 2) {
    const callbackType = expr.args[1]?.type;
    if (callbackType?.kind !== "func") context.unsupported("http.resOnFinish callback", expr.loc);
    return emitResponseFinishListener(expr, callbackType, context);
  }
  if (expr.fn === "http.reqPipeRes" && expr.args.length === 2 &&
      expr.args[0]?.type.kind === "httpReq" && expr.args[1]?.type.kind === "httpRes") {
    return `runtime::http_request_pipe_response(&(${context.emitExpr(expr.args[0])}), &(${context.emitExpr(expr.args[1])}))`;
  }
  if (expr.fn === "http.reqStatusCode" && expr.args.length === 1 &&
      expr.args[0]?.type.kind === "httpReq") {
    if (expr.type.kind !== "union") context.unsupported("http.reqStatusCode result", expr.loc);
    const union = context.union(expr.type.unionId, expr.loc);
    const numberTag = union.arms.findIndex((arm) => arm.kind === "f64");
    const undefinedTag = union.arms.findIndex((arm) => arm.kind === "undefinedT");
    if (numberTag < 0 || undefinedTag < 0) context.unsupported("http.reqStatusCode result union", expr.loc);
    const name = context.unionName(union.id);
    return `match runtime::http_request_status_code(&(${context.emitExpr(expr.args[0])})) { Some(sc_value) => ${name}::${context.unionVariant(numberTag)}(sc_value), None => ${name}::${context.unionVariant(undefinedTag)}, }`;
  }
  if (expr.fn === "http.reqStatusMessage" && expr.args.length === 1 &&
      expr.args[0]?.type.kind === "httpReq") {
    if (expr.type.kind !== "union") context.unsupported("http.reqStatusMessage result", expr.loc);
    const union = context.union(expr.type.unionId, expr.loc);
    const stringTag = union.arms.findIndex((arm) => arm.kind === "string");
    const undefinedTag = union.arms.findIndex((arm) => arm.kind === "undefinedT");
    if (stringTag < 0 || undefinedTag < 0) context.unsupported("http.reqStatusMessage result union", expr.loc);
    const name = context.unionName(union.id);
    return `match runtime::http_request_status_message(&(${context.emitExpr(expr.args[0])})) { Some(sc_value) => ${name}::${context.unionVariant(stringTag)}(sc_value), None => ${name}::${context.unionVariant(undefinedTag)}, }`;
  }
  if ((expr.fn === "http.requestUrl" || expr.fn === "http.requestUrlCb" ||
      expr.fn === "https.requestUrl" || expr.fn === "https.requestUrlCb") &&
      (expr.args.length === 3 || expr.args.length === 4)) {
    const [url, method, autoEnd, callbackExpr] = expr.args;
    if (url?.type.kind !== "string" || method?.type.kind !== "string" || autoEnd?.type.kind !== "bool") {
      context.unsupported(`${expr.fn} shape`, expr.loc);
    }
    const args = `&(${context.emitExpr(url)}), &(${context.emitExpr(method)}), ${context.emitExpr(autoEnd)}`;
    const secure = expr.fn.startsWith("https.");
    const runtimePrefix = secure ? "https" : "http";
    if (!expr.fn.endsWith("Cb")) {
      return `runtime::${runtimePrefix}_client_request_url(${args})`;
    }
    const callbackType = callbackExpr?.type;
    if (callbackExpr === undefined || callbackType?.kind !== "func") {
      context.unsupported(`${expr.fn} callback`, expr.loc);
    }
    return emitResponseCallback(callbackExpr, callbackType, context, expr,
      (invoke, trace) => `runtime::${runtimePrefix}_client_request_url_callback(${args}, ${invoke}, ${trace})`);
  }
  if ((expr.fn === "http.request" || expr.fn === "http.requestCb") &&
      (expr.args.length === 7 || expr.args.length === 8)) {
    const [host, port, path, method, timeout, headers, autoEnd, callbackExpr] = expr.args;
    if (host?.type.kind !== "string" || port?.type.kind !== "f64" || path?.type.kind !== "string" ||
        method?.type.kind !== "string" || timeout?.type.kind !== "f64" || headers?.type.kind !== "array" ||
        headers.type.elem.kind !== "string" || autoEnd?.type.kind !== "bool") {
      context.unsupported(`${expr.fn} shape`, expr.loc);
    }
    const args = `&(${context.emitExpr(host)}), ${context.emitExpr(port)}, &(${context.emitExpr(path)}), &(${context.emitExpr(method)}), ${context.emitExpr(timeout)}, &(${context.emitExpr(headers)}), ${context.emitExpr(autoEnd)}`;
    if (expr.fn === "http.request") {
      return `runtime::http_client_request(${args})`;
    }
    const callbackType = callbackExpr?.type;
    if (callbackExpr === undefined || callbackType?.kind !== "func") {
      context.unsupported("http.requestCb callback", expr.loc);
    }
    return emitResponseCallback(callbackExpr, callbackType, context, expr,
      (invoke, trace) => `runtime::http_client_request_callback(${args}, ${invoke}, ${trace})`);
  }
  if ((expr.fn === "https.request" || expr.fn === "https.requestCb") &&
      (expr.args.length === 9 || expr.args.length === 10)) {
    const [host, port, path, method, timeout, headers, autoEnd, reject, ca, callbackExpr] = expr.args;
    if (host?.type.kind !== "string" || port?.type.kind !== "f64" || path?.type.kind !== "string" ||
        method?.type.kind !== "string" || timeout?.type.kind !== "f64" || headers?.type.kind !== "array" ||
        headers.type.elem.kind !== "string" || autoEnd?.type.kind !== "bool" || reject?.type.kind !== "bool" ||
        (ca?.type.kind !== "string" && (ca?.type.kind !== "bytes" || ca.type.elem !== "u8"))) {
      context.unsupported(`${expr.fn} shape`, expr.loc);
    }
    const caValue = ca.type.kind === "string"
      ? context.emitExpr(ca)
      : `runtime::bytes_to_string(&(${context.emitExpr(ca)}), &runtime::string("utf8"))`;
    const args = `&(${context.emitExpr(host)}), ${context.emitExpr(port)}, &(${context.emitExpr(path)}), &(${context.emitExpr(method)}), ${context.emitExpr(timeout)}, &(${context.emitExpr(headers)}), ${context.emitExpr(autoEnd)}, ${context.emitExpr(reject)}, &(${caValue})`;
    if (expr.fn === "https.request") {
      return `runtime::https_client_request(${args})`;
    }
    const callbackType = callbackExpr?.type;
    if (callbackExpr === undefined || callbackType?.kind !== "func") {
      context.unsupported("https.requestCb callback", expr.loc);
    }
    return emitResponseCallback(callbackExpr, callbackType, context, expr,
      (invoke, trace) => `runtime::https_client_request_callback(${args}, ${invoke}, ${trace})`);
  }
  if (expr.fn === "http.clientOnResponse" && expr.args.length === 3) {
    const [receiver, callbackExpr, once] = expr.args;
    const callbackType = callbackExpr?.type;
    if (receiver?.type.kind !== "httpClientReq" || callbackExpr === undefined ||
        callbackType?.kind !== "func" || once?.type.kind !== "bool") {
      context.unsupported("http.clientOnResponse shape", expr.loc);
    }
    return emitResponseCallback(callbackExpr, callbackType, context, expr,
      (invoke, trace) => `runtime::http_client_on_response(&(${context.emitExpr(receiver)}), ${invoke}, ${trace}, ${context.emitExpr(once)});`);
  }
  if (expr.fn === "http.clientOnError" && expr.args.length === 3) {
    const callbackType = expr.args[1]?.type;
    if (callbackType?.kind !== "func") context.unsupported("http.clientOnError callback", expr.loc);
    return emitClientErrorListener(expr, callbackType, context);
  }
  if (expr.fn === "http.clientOnClose" && expr.args.length === 3) {
    const callbackType = expr.args[1]?.type;
    if (callbackType?.kind !== "func") context.unsupported("http.clientOnClose callback", expr.loc);
    return emitClientCloseListener(expr, callbackType, context);
  }
  if ((expr.fn === "http.clientWrite" || expr.fn === "http.clientEndStr") &&
      expr.args.length === 2 && expr.args[0]?.type.kind === "httpClientReq" &&
      expr.args[1]?.type.kind === "string") {
    const fn = expr.fn === "http.clientWrite" ? "http_client_write_str" : "http_client_end_str";
    return `runtime::${fn}(&(${context.emitExpr(expr.args[0])}), &(${context.emitExpr(expr.args[1])}))`;
  }
  if ((expr.fn === "http.clientWriteBytes" || expr.fn === "http.clientEndBytes") &&
      expr.args.length === 2 && expr.args[0]?.type.kind === "httpClientReq" &&
      expr.args[1]?.type.kind === "bytes" && expr.args[1].type.elem === "u8") {
    const fn = expr.fn === "http.clientWriteBytes" ? "http_client_write_bytes" : "http_client_end_bytes";
    return `runtime::${fn}(&(${context.emitExpr(expr.args[0])}), &(${context.emitExpr(expr.args[1])}))`;
  }
  if ((expr.fn === "http.clientWriteDyn" || expr.fn === "http.clientEndDyn") &&
      expr.args.length === 2 && expr.args[0]?.type.kind === "httpClientReq" &&
      expr.args[1]?.type.kind === "dyn") {
    const receiver = context.nextTemporary();
    const value = context.nextTemporary();
    const dyn = context.dynTypeName();
    const stringFn = expr.fn === "http.clientWriteDyn" ? "http_client_write_str" : "http_client_end_str";
    const bytesFn = expr.fn === "http.clientWriteDyn" ? "http_client_write_bytes" : "http_client_end_bytes";
    return `{ let ${receiver} = ${context.emitExpr(expr.args[0])}; let ${value} = ${context.emitExpr(expr.args[1])}; match &${value} { ${dyn}::String(sc_chunk) => runtime::${stringFn}(&${receiver}, sc_chunk), ${dyn}::Bytes(sc_chunk) | ${dyn}::Buffer(sc_chunk) => runtime::${bytesFn}(&${receiver}, sc_chunk), sc_chunk => sc_dyn_arg_type_fail("chunk", "of type string or an instance of Buffer or Uint8Array", sc_chunk), } }`;
  }
  if ((expr.fn === "http.clientEnd" || expr.fn === "http.clientDestroy" ||
      expr.fn === "http.clientDestroyed") && expr.args.length === 1 &&
      expr.args[0]?.type.kind === "httpClientReq") {
    const fn = expr.fn === "http.clientEnd" ? "http_client_end"
      : expr.fn === "http.clientDestroy" ? "http_client_destroy"
      : "http_client_destroyed";
    return `runtime::${fn}(&(${context.emitExpr(expr.args[0])}))`;
  }
  if (expr.fn === "http.serverJoinDupHeaders" && expr.args.length === 1 &&
      expr.args[0]?.type.kind === "netServer") {
    return `runtime::http_server_join_duplicate_headers(&(${context.emitExpr(expr.args[0])}))`;
  }
  if (expr.fn === "http.serverTimeoutGet" && expr.args.length === 2 &&
      expr.args[0]?.type.kind === "netServer" && expr.args[1]?.type.kind === "f64") {
    return `runtime::http_server_timeout_get(&(${context.emitExpr(expr.args[0])}), ${context.emitExpr(expr.args[1])})`;
  }
  if (expr.fn === "http.serverTimeoutSet" && expr.args.length === 3 &&
      expr.args[0]?.type.kind === "netServer" && expr.args[1]?.type.kind === "f64" &&
      expr.args[2]?.type.kind === "f64") {
    return `runtime::http_server_timeout_set(&(${context.emitExpr(expr.args[0])}), ${context.emitExpr(expr.args[1])}, ${context.emitExpr(expr.args[2])})`;
  }
  if (expr.fn === "http.serverTimeoutOptionSet" && expr.args.length === 3 &&
      expr.args[0]?.type.kind === "netServer" && expr.args[1]?.type.kind === "f64" &&
      expr.args[2]?.type.kind === "dyn") {
    const server = context.nextTemporary();
    const selector = context.nextTemporary();
    const value = context.nextTemporary();
    const dyn = context.dynTypeName();
    return `{ let ${server} = ${context.emitExpr(expr.args[0])}; let ${selector} = ${context.emitExpr(expr.args[1])}; let ${value} = ${context.emitExpr(expr.args[2])}; let sc_option = match &${value} { ${dyn}::Undefined => None, ${dyn}::Number(sc_number) => Some(*sc_number), sc_value => sc_dyn_arg_type_fail("keepAliveTimeoutBuffer", "of type number", sc_value), }; runtime::http_server_timeout_option_set(&${server}, ${selector}, sc_option); }`;
  }
  return null;
}
