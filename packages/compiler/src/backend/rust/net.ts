import type { IrType } from "../../ir/nodes.js";
import { mangleField, mangleRecordStruct } from "../mangle.js";
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
  const runtimeFn = expr.fn === "net.serverOnSecureConnection"
    ? "tls_server_on_secure_connection"
    : "net_server_on_connection";
  return `{ let ${callback} = ${context.emitExpr(callbackExpr)}; let ${traced} = ${callback}.clone(); runtime::${runtimeFn}(&(${context.emitExpr(receiver)}), std::rc::Rc::new(move |sc_socket| { let _ = ${dispatch}; }), std::rc::Rc::new(move |sc_tracer: &mut runtime::Tracer<'_>| sc_tracer.edge(&${traced})), ${context.emitExpr(onceExpr)}); }`;
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
      (parameter !== undefined && parameter.kind !== "dyn" &&
        (parameter.kind !== "bytes" || parameter.elem !== "u8"))) {
    context.unsupported("net data callback parameter", expr.loc);
  }
  const callback = context.nextTemporary();
  const traced = context.nextTemporary();
  const encoded = context.nextTemporary();
  const argument = parameter?.kind === "dyn"
    ? `if ${encoded} { ${context.dynTypeName()}::String(runtime::bytes_to_string(&sc_chunk, &runtime::string("utf8"))) } else { ${context.dynTypeName()}::Buffer(sc_chunk) }`
    : "sc_chunk";
  const dispatch = context.emitClosureDispatch(
    callback,
    callbackType,
    parameter === undefined ? [] : [argument],
    expr.loc,
  );
  return `{ let ${callback} = ${context.emitExpr(callbackExpr)}; let ${traced} = ${callback}.clone(); runtime::net_socket_on_data(&(${context.emitExpr(receiver)}), std::rc::Rc::new(move |sc_chunk, ${encoded}| { let _ = ${dispatch}; }), std::rc::Rc::new(move |sc_tracer: &mut runtime::Tracer<'_>| sc_tracer.edge(&${traced})), ${context.emitExpr(onceExpr)}); }`;
}

function emitSocketErrorListener(
  expr: RustLibCallExpr,
  callbackType: IrFuncType,
  context: RustLibCallContext,
): string {
  const [receiver, callbackExpr, onceExpr] = expr.args;
  const parameter = callbackType.params[0];
  if (receiver?.type.kind !== "netSocket" || callbackExpr === undefined ||
      onceExpr?.type.kind !== "bool" || callbackType.params.length > 1 ||
      (parameter !== undefined && (parameter.kind !== "object" || parameter.className !== "%Error"))) {
    context.unsupported("net.sockOnError shape", expr.loc);
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
  return `{ let ${callback} = ${context.emitExpr(callbackExpr)}; let ${traced} = ${callback}.clone(); runtime::net_socket_on_error(&(${context.emitExpr(receiver)}), std::rc::Rc::new(move |${errorName}| { let _ = ${dispatch}; }), std::rc::Rc::new(move |sc_tracer: &mut runtime::Tracer<'_>| sc_tracer.edge(&${traced})), ${context.emitExpr(onceExpr)}); }`;
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

function attemptTimeoutValidation(value: string, dyn: string, name: string): string {
  return `match &${value} { ${dyn}::Number(sc_number) => runtime::net_validate_attempt_timeout(*sc_number, "${name}"), sc_value => sc_dyn_prop_type_fail("${name}", "of type number", sc_value), }`;
}

function emitConnectOptionsCheck(expr: RustLibCallExpr, context: RustLibCallContext): string {
  const optionsExpr = expr.args[0];
  const fenceExpr = expr.args[1];
  if (optionsExpr?.type.kind !== "dyn" || fenceExpr?.type.kind !== "string") {
    context.unsupported("net.connectOptsChk shape", expr.loc);
  }
  const options = context.nextTemporary();
  const fence = context.nextTemporary();
  const value = context.nextTemporary();
  const dyn = context.dynTypeName();
  const checks = ["objectMode", "readableObjectMode", "writableObjectMode"]
    .map((key) => `let ${value} = sc_dyn_key_get(&${options}, &runtime::string("${key}"), false); if !matches!(&${value}, ${dyn}::Undefined) && sc_dyn_is_truthy(&${value}) { sc_dyn_arg_value_fail("options.${key}", "is not supported", &${value}); }`)
    .join(" ");
  return `{ let ${options} = ${context.emitExpr(optionsExpr)}; let ${fence} = ${context.emitExpr(fenceExpr)}; if !matches!(&${options}, ${dyn}::Object(..)) { sc_dyn_arg_type_fail("options", "of type object", &${options}); } ${checks} let ${value} = sc_dyn_key_get(&${options}, &runtime::string("port"), false); if !matches!(&${value}, ${dyn}::Undefined) { let sc_ok = match &${value} { ${dyn}::Number(sc_number) => sc_number.is_finite() && sc_number.trunc() == *sc_number && (0.0..65_536.0).contains(sc_number), ${dyn}::String(sc_text) => { let sc_number = runtime::number_from_string(sc_text); !sc_text.is_empty() && sc_number.is_finite() && sc_number.trunc() == sc_number && (0.0..65_536.0).contains(&sc_number) }, _ => false, }; if !sc_ok { runtime::throw_range_error_code(format!("options.port should be >= 0 and < 65536. Received {}", sc_dyn_specific_type(&${value})), "ERR_SOCKET_BAD_PORT"); } } let ${value} = sc_dyn_key_get(&${options}, &runtime::string("host"), false); if !matches!(&${value}, ${dyn}::Undefined | ${dyn}::String(..)) { sc_dyn_prop_type_fail("options.host", "of type string", &${value}); } let ${value} = sc_dyn_key_get(&${options}, &runtime::string("autoSelectFamily"), false); if !matches!(&${value}, ${dyn}::Undefined | ${dyn}::Boolean(..)) { sc_dyn_prop_type_fail("options.autoSelectFamily", "of type boolean", &${value}); } let ${value} = sc_dyn_key_get(&${options}, &runtime::string("autoSelectFamilyAttemptTimeout"), false); if !matches!(&${value}, ${dyn}::Undefined) { ${attemptTimeoutValidation(value, dyn, "options.autoSelectFamilyAttemptTimeout")} } runtime::throw_error_code(${fence}.to_string(), "SC2020") }`;
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
  if (expr.fn === "net.listenOpts" && expr.args.length === 4 &&
      expr.args[0]?.type.kind === "netServer" && expr.args[1]?.type.kind === "f64" &&
      expr.args[2]?.type.kind === "string" && expr.args[3]?.type.kind === "bool") {
    return `runtime::net_server_listen_options(&(${context.emitExpr(expr.args[0])}), ${context.emitExpr(expr.args[1])}, &(${context.emitExpr(expr.args[2])}), ${context.emitExpr(expr.args[3])})`;
  }
  if (expr.fn === "net.listenOptsReusePort" && expr.args.length === 5 &&
      expr.args[0]?.type.kind === "netServer" && expr.args[1]?.type.kind === "f64" &&
      expr.args[2]?.type.kind === "string" && expr.args[3]?.type.kind === "bool" &&
      expr.args[4]?.type.kind === "bool") {
    return `runtime::net_server_listen_options_reuse_port(&(${context.emitExpr(expr.args[0])}), ${context.emitExpr(expr.args[1])}, &(${context.emitExpr(expr.args[2])}), ${context.emitExpr(expr.args[3])}, ${context.emitExpr(expr.args[4])})`;
  }
  if (expr.fn === "net.listenOptsCb" && expr.args.length === 5 &&
      expr.args[0]?.type.kind === "netServer" && expr.args[1]?.type.kind === "f64" &&
      expr.args[2]?.type.kind === "string" && expr.args[3]?.type.kind === "bool") {
    const callbackExpr = expr.args[4];
    const callbackType = callbackExpr?.type;
    if (callbackExpr === undefined || callbackType?.kind !== "func") {
      context.unsupported("net.listenOptsCb callback", expr.loc);
    }
    const server = context.emitExpr(expr.args[0]);
    const port = context.emitExpr(expr.args[1]);
    const host = context.emitExpr(expr.args[2]);
    const exclusive = context.emitExpr(expr.args[3]);
    return emitVoidCallback(callbackExpr, callbackType, context, expr,
      (invoke, trace) => `runtime::net_server_listen_options_callback(&(${server}), ${port}, &(${host}), ${exclusive}, ${invoke}, ${trace});`);
  }
  if (expr.fn === "net.listenOptsReusePortCb" && expr.args.length === 6 &&
      expr.args[0]?.type.kind === "netServer" && expr.args[1]?.type.kind === "f64" &&
      expr.args[2]?.type.kind === "string" && expr.args[3]?.type.kind === "bool" &&
      expr.args[4]?.type.kind === "bool") {
    const callbackExpr = expr.args[5];
    const callbackType = callbackExpr?.type;
    if (callbackExpr === undefined || callbackType?.kind !== "func") {
      context.unsupported("net.listenOptsReusePortCb callback", expr.loc);
    }
    const server = context.emitExpr(expr.args[0]);
    const port = context.emitExpr(expr.args[1]);
    const host = context.emitExpr(expr.args[2]);
    const ipv6Only = context.emitExpr(expr.args[3]);
    const reusePort = context.emitExpr(expr.args[4]);
    return emitVoidCallback(callbackExpr, callbackType, context, expr,
      (invoke, trace) => `runtime::net_server_listen_options_reuse_port_callback(&(${server}), ${port}, &(${host}), ${ipv6Only}, ${reusePort}, ${invoke}, ${trace});`);
  }
  if (expr.fn === "net.serverPort" && expr.args.length === 1 && expr.args[0]?.type.kind === "netServer") {
    return `runtime::net_server_port(&(${context.emitExpr(expr.args[0])}))`;
  }
  if (expr.fn === "net.serverAddress" && expr.args.length === 1 &&
      expr.args[0]?.type.kind === "netServer" && expr.type.kind === "record") {
    const shape = context.record(expr.type.shapeId, expr.loc);
    const expected = [
      ["address", "string"],
      ["family", "string"],
      ["port", "f64"],
    ] as const;
    if (shape.tuple || shape.indexValue !== undefined || shape.fields.length !== expected.length ||
        shape.fields.some((field, index) =>
          field.name !== expected[index]?.[0] || field.type.kind !== expected[index]?.[1]
        )) {
      context.unsupported("net.serverAddress record", expr.loc);
    }
    const server = context.nextTemporary();
    const fields = [
      `${mangleField("address")}: runtime::net_server_address_ip(&${server})`,
      `${mangleField("family")}: runtime::net_server_address_family(&${server})`,
      `${mangleField("port")}: runtime::net_server_port(&${server})`,
    ].join(", ");
    return `{ let ${server} = ${context.emitExpr(expr.args[0])}; runtime::Gc::new(${mangleRecordStruct(expr.type.shapeId)} { ${fields} }) }`;
  }
  if (expr.fn === "net.serverClose" && expr.args.length === 1 && expr.args[0]?.type.kind === "netServer") {
    return `runtime::net_server_close(&(${context.emitExpr(expr.args[0])}))`;
  }
  if (expr.fn === "net.serverCloseCb" && expr.args.length === 2 &&
      expr.args[0]?.type.kind === "netServer") {
    const callbackExpr = expr.args[1];
    const callbackType = callbackExpr?.type;
    if (callbackExpr === undefined || callbackType?.kind !== "func" || callbackType.params.length !== 0) {
      context.unsupported("net.serverCloseCb shape", expr.loc);
    }
    const server = context.emitExpr(expr.args[0]);
    return emitVoidCallback(callbackExpr, callbackType, context, expr,
      (invoke, trace) => `runtime::net_server_close_direct_callback(&(${server}), ${invoke}, ${trace});`);
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
  if ((expr.fn === "net.serverOnConnection" || expr.fn === "net.serverOnSecureConnection") &&
      expr.args.length === 3) {
    const callbackType = expr.args[1]?.type;
    if (callbackType?.kind !== "func") context.unsupported("net.serverOnConnection callback", expr.loc);
    return emitConnectionListener(expr, callbackType, context);
  }
  if (expr.fn === "net.connect" && expr.args.length === 2 &&
      expr.args[0]?.type.kind === "f64" && expr.args[1]?.type.kind === "string") {
    return `runtime::net_socket_connect(${context.emitExpr(expr.args[0])}, &(${context.emitExpr(expr.args[1])}))`;
  }
  if (expr.fn === "net.connectAttempt" && expr.args.length === 3 &&
      expr.args[0]?.type.kind === "f64" && expr.args[1]?.type.kind === "string" &&
      expr.args[2]?.type.kind === "dyn") {
    const port = context.nextTemporary();
    const host = context.nextTemporary();
    const attempt = context.nextTemporary();
    const dyn = context.dynTypeName();
    return `{ let ${port} = ${context.emitExpr(expr.args[0])}; let ${host} = ${context.emitExpr(expr.args[1])}; let ${attempt} = ${context.emitExpr(expr.args[2])}; ${attemptTimeoutValidation(attempt, dyn, "options.autoSelectFamilyAttemptTimeout")} runtime::net_socket_connect(${port}, &${host}) }`;
  }
  if (expr.fn === "net.connectOptsChk" && expr.args.length === 2) {
    return emitConnectOptionsCheck(expr, context);
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
  if (expr.fn === "net.sockSetEncoding" && expr.args.length === 2 &&
      expr.args[0]?.type.kind === "netSocket" && expr.args[1]?.type.kind === "string") {
    return `runtime::net_socket_set_encoding(&(${context.emitExpr(expr.args[0])}), &(${context.emitExpr(expr.args[1])}))`;
  }
  if ((expr.fn === "net.sockWriteBytes" || expr.fn === "net.sockEndBytes") && expr.args.length === 2 &&
      expr.args[0]?.type.kind === "netSocket" && expr.args[1]?.type.kind === "bytes" &&
      expr.args[1].type.elem === "u8") {
    const fn = expr.fn === "net.sockWriteBytes" ? "net_socket_write_bytes" : "net_socket_end_bytes";
    return `runtime::${fn}(&(${context.emitExpr(expr.args[0])}), &(${context.emitExpr(expr.args[1])}))`;
  }
  if (expr.fn === "net.sockEndDyn" && expr.args.length === 2 &&
      expr.args[0]?.type.kind === "netSocket" && expr.args[1]?.type.kind === "dyn") {
    const socket = context.nextTemporary();
    const chunk = context.nextTemporary();
    const dyn = context.dynTypeName();
    return `{ let ${socket} = ${context.emitExpr(expr.args[0])}; let ${chunk} = ${context.emitExpr(expr.args[1])}; match &${chunk} { ${dyn}::String(sc_chunk) => runtime::net_socket_end_str(&${socket}, sc_chunk), ${dyn}::Bytes(sc_chunk) | ${dyn}::Buffer(sc_chunk) => runtime::net_socket_end_bytes(&${socket}, sc_chunk), sc_chunk => sc_dyn_arg_type_fail("chunk", "of type string or an instance of Buffer or Uint8Array", sc_chunk), } }`;
  }
  if (expr.fn === "net.sockEnd" && expr.args.length === 1 && expr.args[0]?.type.kind === "netSocket") {
    return `runtime::net_socket_end(&(${context.emitExpr(expr.args[0])}))`;
  }
  if ((expr.fn === "net.sockPause" || expr.fn === "net.sockResume") && expr.args.length === 1 &&
      expr.args[0]?.type.kind === "netSocket") {
    const fn = expr.fn === "net.sockPause" ? "net_socket_pause" : "net_socket_resume";
    return `runtime::${fn}(&(${context.emitExpr(expr.args[0])}))`;
  }
  if (expr.fn === "net.sockSetNoDelay" && expr.args.length === 2 &&
      expr.args[0]?.type.kind === "netSocket" && expr.args[1]?.type.kind === "bool") {
    return `runtime::net_socket_set_no_delay(&(${context.emitExpr(expr.args[0])}), ${context.emitExpr(expr.args[1])})`;
  }
  if (expr.fn === "net.sockDestroySoon" && expr.args.length === 1 && expr.args[0]?.type.kind === "netSocket") {
    return `runtime::net_socket_destroy_soon(&(${context.emitExpr(expr.args[0])}))`;
  }
  if ((expr.fn === "net.sockBytesWritten" || expr.fn === "net.sockReadable" ||
      expr.fn === "net.sockDestroyed" || expr.fn === "net.sockWritable") &&
      expr.args.length === 1 && expr.args[0]?.type.kind === "netSocket") {
    const fn = expr.fn === "net.sockBytesWritten" ? "net_socket_bytes_written"
      : expr.fn === "net.sockReadable" ? "net_socket_readable"
      : expr.fn === "net.sockDestroyed" ? "net_socket_destroyed"
      : "net_socket_writable";
    return `runtime::${fn}(&(${context.emitExpr(expr.args[0])}))`;
  }
  if ((expr.fn === "net.sockRemoteAddress" || expr.fn === "net.sockEncrypted") &&
      expr.args.length === 1 && expr.args[0]?.type.kind === "netSocket" &&
      expr.type.kind === "union") {
    const union = context.union(expr.type.unionId, expr.loc);
    const valueKind = expr.fn === "net.sockRemoteAddress" ? "string" : "bool";
    const valueTag = union.arms.findIndex((arm) => arm.kind === valueKind);
    const undefinedTag = union.arms.findIndex((arm) => arm.kind === "undefinedT");
    if (valueTag < 0 || undefinedTag < 0) context.unsupported(`${expr.fn} result`, expr.loc);
    const helper = expr.fn === "net.sockRemoteAddress"
      ? "net_socket_remote_address"
      : "tls_socket_encrypted";
    const name = context.unionName(union.id);
    return `match runtime::${helper}(&(${context.emitExpr(expr.args[0])})) { Some(sc_value) => ${name}::${context.unionVariant(valueTag)}(sc_value), None => ${name}::${context.unionVariant(undefinedTag)}, }`;
  }
  if (expr.fn === "net.sockOnData" && expr.args.length === 3) {
    const callbackType = expr.args[1]?.type;
    if (callbackType?.kind !== "func") context.unsupported("net.sockOnData callback", expr.loc);
    return emitDataListener(expr, callbackType, context);
  }
  if (expr.fn === "net.sockOnError" && expr.args.length === 3) {
    const callbackType = expr.args[1]?.type;
    if (callbackType?.kind !== "func") context.unsupported("net.sockOnError callback", expr.loc);
    return emitSocketErrorListener(expr, callbackType, context);
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
