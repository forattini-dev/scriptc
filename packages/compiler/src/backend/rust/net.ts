import type { IrType } from "../../ir/nodes.js";
import type { RustLibCallContext, RustLibCallExpr } from "./lib-calls.js";

type IrFuncType = Extract<IrType, { kind: "func" }>;

function cleanCloseArgument(type: IrType, context: RustLibCallContext, expr: RustLibCallExpr): string {
  if (type.kind !== "union") context.unsupported("net close callback error parameter", expr.loc);
  const union = context.union(type.unionId, expr.loc);
  const undefinedTag = union.arms.findIndex((arm) => arm.kind === "undefinedT");
  if (undefinedTag < 0) context.unsupported("net close callback error union", expr.loc);
  return `${context.unionName(union.id)}::${context.unionVariant(undefinedTag)}`;
}

function emitVoidCallback(
  callbackExpr: RustLibCallExpr["args"][number],
  callbackType: IrFuncType,
  context: RustLibCallContext,
  expr: RustLibCallExpr,
  runtimeCall: (invoke: string, trace: string) => string,
): string {
  const callback = context.nextTemporary();
  const traced = context.nextTemporary();
  const dispatch = context.emitClosureDispatch(callback, callbackType, [], expr.loc);
  return `{ let ${callback} = ${context.emitExpr(callbackExpr)}; let ${traced} = ${callback}.clone(); ${runtimeCall(`std::rc::Rc::new(move || { let _ = ${dispatch}; })`, `std::rc::Rc::new(move |sc_tracer: &mut runtime::Tracer<'_>| sc_tracer.edge(&${traced}))`)} }`;
}

function emitCreateServerCallback(
  expr: RustLibCallExpr,
  callbackType: IrFuncType,
  context: RustLibCallContext,
): string {
  const callbackExpr = expr.args[0];
  if (callbackExpr === undefined) context.unsupported("net.createServerCb callback", expr.loc);
  const callback = context.nextTemporary();
  const traced = context.nextTemporary();
  const parameter = callbackType.params[0];
  if (parameter !== undefined && parameter.kind !== "netSocket") {
    context.unsupported("net connection callback parameter", expr.loc);
  }
  const dispatch = context.emitClosureDispatch(
    callback,
    callbackType,
    parameter === undefined ? [] : ["sc_socket"],
    expr.loc,
  );
  return `{ let ${callback} = ${context.emitExpr(callbackExpr)}; let ${traced} = ${callback}.clone(); runtime::net_server_new_callback(std::rc::Rc::new(move |sc_socket| { let _ = ${dispatch}; }), std::rc::Rc::new(move |sc_tracer: &mut runtime::Tracer<'_>| sc_tracer.edge(&${traced}))) }`;
}

function emitConnectionListener(
  expr: RustLibCallExpr,
  callbackType: IrFuncType,
  context: RustLibCallContext,
): string {
  const [receiver, callbackExpr, onceExpr] = expr.args;
  if (receiver?.type.kind !== "netServer" || callbackExpr === undefined || onceExpr?.type.kind !== "bool") {
    context.unsupported("net.serverOnConnection shape", expr.loc);
  }
  const parameter = callbackType.params[0];
  if (callbackType.params.length > 1 || (parameter !== undefined && parameter.kind !== "netSocket")) {
    context.unsupported("net connection callback parameter", expr.loc);
  }
  const callback = context.nextTemporary();
  const traced = context.nextTemporary();
  const dispatch = context.emitClosureDispatch(
    callback,
    callbackType,
    parameter === undefined ? [] : ["sc_socket"],
    expr.loc,
  );
  return `{ let ${callback} = ${context.emitExpr(callbackExpr)}; let ${traced} = ${callback}.clone(); runtime::net_server_on_connection(&(${context.emitExpr(receiver)}), std::rc::Rc::new(move |sc_socket| { let _ = ${dispatch}; }), std::rc::Rc::new(move |sc_tracer: &mut runtime::Tracer<'_>| sc_tracer.edge(&${traced})), ${context.emitExpr(onceExpr)}); }`;
}

function emitDataListener(
  expr: RustLibCallExpr,
  callbackType: IrFuncType,
  context: RustLibCallContext,
): string {
  const [receiver, callbackExpr, onceExpr] = expr.args;
  if (receiver?.type.kind !== "netSocket" || callbackExpr === undefined || onceExpr?.type.kind !== "bool") {
    context.unsupported("net.sockOnData shape", expr.loc);
  }
  const parameter = callbackType.params[0];
  if (callbackType.params.length > 1 ||
      (parameter !== undefined && (parameter.kind !== "bytes" || parameter.elem !== "u8"))) {
    context.unsupported("net data callback parameter", expr.loc);
  }
  const callback = context.nextTemporary();
  const traced = context.nextTemporary();
  const dispatch = context.emitClosureDispatch(
    callback,
    callbackType,
    parameter === undefined ? [] : ["sc_chunk"],
    expr.loc,
  );
  return `{ let ${callback} = ${context.emitExpr(callbackExpr)}; let ${traced} = ${callback}.clone(); runtime::net_socket_on_data(&(${context.emitExpr(receiver)}), std::rc::Rc::new(move |sc_chunk| { let _ = ${dispatch}; }), std::rc::Rc::new(move |sc_tracer: &mut runtime::Tracer<'_>| sc_tracer.edge(&${traced})), ${context.emitExpr(onceExpr)}); }`;
}

function emitCloseBind(
  expr: RustLibCallExpr,
  context: RustLibCallContext,
): string {
  const receiver = expr.args[0];
  if (receiver?.type.kind !== "netServer" || expr.type.kind !== "func" || expr.type.params.length !== 1) {
    context.unsupported("net.serverCloseBind shape", expr.loc);
  }
  const optionalType = expr.type.params[0];
  if (optionalType?.kind !== "union") context.unsupported("net.serverCloseBind callback union", expr.loc);
  const union = context.union(optionalType.unionId, expr.loc);
  const callbackTag = union.arms.findIndex((arm) => arm.kind === "func");
  const undefinedTag = union.arms.findIndex((arm) => arm.kind === "undefinedT");
  const callbackType = union.arms[callbackTag];
  if (callbackTag < 0 || undefinedTag < 0 || callbackType?.kind !== "func") {
    context.unsupported("net.serverCloseBind callback arms", expr.loc);
  }
  const callbackArgs = callbackType.params.map((type) => cleanCloseArgument(type, context, expr));
  const dispatch = context.emitClosureDispatch("sc_callback", callbackType, callbackArgs, expr.loc);
  const server = context.nextTemporary();
  const tracedServer = context.nextTemporary();
  const callbackTrace = context.nextTemporary();
  const name = context.unionName(union.id);
  const close = `match sc_optional { ${name}::${context.unionVariant(callbackTag)}(sc_callback) => { let ${callbackTrace} = sc_callback.clone(); runtime::net_server_close_direct_callback(&${server}, std::rc::Rc::new(move || { let _ = ${dispatch}; }), std::rc::Rc::new(move |sc_tracer: &mut runtime::Tracer<'_>| sc_tracer.edge(&${callbackTrace}))); }, ${name}::${context.unionVariant(undefinedTag)} => runtime::net_server_close_direct(&${server}), }`;
  const answer = expr.type.ret.kind === "netServer" ? `${server}.clone()` : "()";
  const shape = context.rustType(expr.type, expr.loc).replace(/^runtime::Gc<|>$/g, "");
  return `{ let ${server} = ${context.emitExpr(receiver)}; let ${tracedServer} = ${server}.clone(); runtime::Gc::new(${shape}::RuntimeCallback { callback: Some(std::rc::Rc::new(move |sc_optional| { ${close} ${answer} })), trace: Some(std::rc::Rc::new(move |sc_tracer: &mut runtime::Tracer<'_>| sc_tracer.edge(&${tracedServer}))) }) }`;
}

function emitCloseOverride(
  expr: RustLibCallExpr,
  callbackType: IrFuncType,
  context: RustLibCallContext,
): string {
  const [receiver, callbackExpr] = expr.args;
  if (receiver?.type.kind !== "netServer" || callbackExpr === undefined || callbackType.params.length !== 1) {
    context.unsupported("net.serverSetCloseOverride shape", expr.loc);
  }
  const callback = context.nextTemporary();
  const traced = context.nextTemporary();
  const parameter = callbackType.params[0];
  if (parameter === undefined) context.unsupported("net.serverSetCloseOverride callback", expr.loc);
  const argument = cleanCloseArgument(parameter, context, expr);
  const dispatch = context.emitClosureDispatch(callback, callbackType, [argument], expr.loc);
  return `{ let ${callback} = ${context.emitExpr(callbackExpr)}; let ${traced} = ${callback}.clone(); runtime::net_server_set_close_override(&(${context.emitExpr(receiver)}), std::rc::Rc::new(move || { let _ = ${dispatch}; }), std::rc::Rc::new(move |sc_tracer: &mut runtime::Tracer<'_>| sc_tracer.edge(&${traced}))); }`;
}

export function emitRustNetCall(
  expr: RustLibCallExpr,
  context: RustLibCallContext,
): string | null {
  if (expr.fn === "net.createServer" && expr.args.length === 0) return "runtime::net_server_new()";
  if (expr.fn === "net.createServerCb" && expr.args.length === 1) {
    const callbackType = expr.args[0]?.type;
    if (callbackType?.kind !== "func") context.unsupported("net.createServerCb shape", expr.loc);
    return emitCreateServerCallback(expr, callbackType, context);
  }
  if (expr.fn === "net.listen" && expr.args.length === 2 &&
      expr.args[0]?.type.kind === "netServer" && expr.args[1]?.type.kind === "f64") {
    return `runtime::net_server_listen(&(${context.emitExpr(expr.args[0])}), ${context.emitExpr(expr.args[1])})`;
  }
  if (expr.fn === "net.listenCb" && expr.args.length === 3 &&
      expr.args[0]?.type.kind === "netServer" && expr.args[1]?.type.kind === "f64") {
    const callbackExpr = expr.args[2];
    const callbackType = callbackExpr?.type;
    if (callbackExpr === undefined || callbackType?.kind !== "func") {
      context.unsupported("net.listenCb shape", expr.loc);
    }
    const server = context.emitExpr(expr.args[0]);
    const port = context.emitExpr(expr.args[1]);
    return emitVoidCallback(callbackExpr, callbackType, context, expr,
      (invoke, trace) => `runtime::net_server_listen_callback(&(${server}), ${port}, ${invoke}, ${trace});`);
  }
  if (expr.fn === "net.serverPort" && expr.args.length === 1 && expr.args[0]?.type.kind === "netServer") {
    return `runtime::net_server_port(&(${context.emitExpr(expr.args[0])}))`;
  }
  if (expr.fn === "net.serverClose" && expr.args.length === 1 && expr.args[0]?.type.kind === "netServer") {
    return `runtime::net_server_close(&(${context.emitExpr(expr.args[0])}))`;
  }
  if (expr.fn === "net.serverCloseBind" && expr.args.length === 1) return emitCloseBind(expr, context);
  if (expr.fn === "net.serverSetCloseOverride" && expr.args.length === 2) {
    const callbackType = expr.args[1]?.type;
    if (callbackType?.kind !== "func") context.unsupported("net.serverSetCloseOverride callback", expr.loc);
    return emitCloseOverride(expr, callbackType, context);
  }
  if (expr.fn === "net.serverOnClose" && expr.args.length === 3 &&
      expr.args[0]?.type.kind === "netServer" && expr.args[2]?.type.kind === "bool") {
    const callbackExpr = expr.args[1];
    const callbackType = callbackExpr?.type;
    if (callbackExpr === undefined || callbackType?.kind !== "func") {
      context.unsupported("net.serverOnClose shape", expr.loc);
    }
    const server = context.emitExpr(expr.args[0]);
    const once = context.emitExpr(expr.args[2]);
    return emitVoidCallback(callbackExpr, callbackType, context, expr,
      (invoke, trace) => `runtime::net_server_on_close(&(${server}), ${invoke}, ${trace}, ${once});`);
  }
  if (expr.fn === "net.serverOnListening" && expr.args.length === 3 &&
      expr.args[0]?.type.kind === "netServer" && expr.args[2]?.type.kind === "bool") {
    const callbackExpr = expr.args[1];
    const callbackType = callbackExpr?.type;
    if (callbackExpr === undefined || callbackType?.kind !== "func") {
      context.unsupported("net.serverOnListening shape", expr.loc);
    }
    const server = context.emitExpr(expr.args[0]);
    const once = context.emitExpr(expr.args[2]);
    return emitVoidCallback(callbackExpr, callbackType, context, expr,
      (invoke, trace) => `runtime::net_server_on_listening(&(${server}), ${invoke}, ${trace}, ${once});`);
  }
  if (expr.fn === "net.serverOnConnection" && expr.args.length === 3) {
    const callbackType = expr.args[1]?.type;
    if (callbackType?.kind !== "func") context.unsupported("net.serverOnConnection callback", expr.loc);
    return emitConnectionListener(expr, callbackType, context);
  }
  if (expr.fn === "net.connect" && expr.args.length === 2 &&
      expr.args[0]?.type.kind === "f64" && expr.args[1]?.type.kind === "string") {
    return `runtime::net_socket_connect(${context.emitExpr(expr.args[0])}, &(${context.emitExpr(expr.args[1])}))`;
  }
  if (expr.fn === "net.connectCb" && expr.args.length === 3 &&
      expr.args[0]?.type.kind === "f64" && expr.args[1]?.type.kind === "string") {
    const callbackExpr = expr.args[2];
    const callbackType = callbackExpr?.type;
    if (callbackExpr === undefined || callbackType?.kind !== "func") {
      context.unsupported("net.connectCb shape", expr.loc);
    }
    const port = context.emitExpr(expr.args[0]);
    const host = context.emitExpr(expr.args[1]);
    return emitVoidCallback(callbackExpr, callbackType, context, expr,
      (invoke, trace) => `runtime::net_socket_connect_callback(${port}, &(${host}), ${invoke}, ${trace})`);
  }
  if ((expr.fn === "net.sockWrite" || expr.fn === "net.sockEndStr") && expr.args.length === 2 &&
      expr.args[0]?.type.kind === "netSocket" && expr.args[1]?.type.kind === "string") {
    const fn = expr.fn === "net.sockWrite" ? "net_socket_write_str" : "net_socket_end_str";
    return `runtime::${fn}(&(${context.emitExpr(expr.args[0])}), &(${context.emitExpr(expr.args[1])}))`;
  }
  if ((expr.fn === "net.sockWriteBytes" || expr.fn === "net.sockEndBytes") && expr.args.length === 2 &&
      expr.args[0]?.type.kind === "netSocket" && expr.args[1]?.type.kind === "bytes" &&
      expr.args[1].type.elem === "u8") {
    const fn = expr.fn === "net.sockWriteBytes" ? "net_socket_write_bytes" : "net_socket_end_bytes";
    return `runtime::${fn}(&(${context.emitExpr(expr.args[0])}), &(${context.emitExpr(expr.args[1])}))`;
  }
  if (expr.fn === "net.sockEnd" && expr.args.length === 1 && expr.args[0]?.type.kind === "netSocket") {
    return `runtime::net_socket_end(&(${context.emitExpr(expr.args[0])}))`;
  }
  if (expr.fn === "net.sockOnData" && expr.args.length === 3) {
    const callbackType = expr.args[1]?.type;
    if (callbackType?.kind !== "func") context.unsupported("net.sockOnData callback", expr.loc);
    return emitDataListener(expr, callbackType, context);
  }
  if ((expr.fn === "net.sockOnEnd" || expr.fn === "net.sockOnClose" || expr.fn === "net.sockOnConnect") &&
      expr.args.length === 3 && expr.args[0]?.type.kind === "netSocket" && expr.args[2]?.type.kind === "bool") {
    const callbackExpr = expr.args[1];
    const callbackType = callbackExpr?.type;
    if (callbackExpr === undefined || callbackType?.kind !== "func") {
      context.unsupported(`${expr.fn} shape`, expr.loc);
    }
    const socket = context.emitExpr(expr.args[0]);
    const once = context.emitExpr(expr.args[2]);
    const fn = expr.fn === "net.sockOnEnd" ? "net_socket_on_end"
      : expr.fn === "net.sockOnClose" ? "net_socket_on_close"
      : "net_socket_on_connect";
    return emitVoidCallback(callbackExpr, callbackType, context, expr,
      (invoke, trace) => `runtime::${fn}(&(${socket}), ${invoke}, ${trace}, ${once});`);
  }
  if (expr.fn === "net.sockDestroy" && expr.args.length === 1 && expr.args[0]?.type.kind === "netSocket") {
    return `runtime::net_socket_destroy(&(${context.emitExpr(expr.args[0])}))`;
  }
  return null;
}
