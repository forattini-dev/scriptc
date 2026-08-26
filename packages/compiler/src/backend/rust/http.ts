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
  if (expr.fn === "http.resWriteHead" && expr.args.length === 2 &&
      expr.args[0]?.type.kind === "httpRes" && expr.args[1]?.type.kind === "f64") {
    return `runtime::http_response_write_head(&(${context.emitExpr(expr.args[0])}), ${context.emitExpr(expr.args[1])})`;
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
