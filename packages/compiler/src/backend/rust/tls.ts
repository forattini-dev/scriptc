import type { IrType } from "../../ir/nodes.js";
import type { RustLibCallContext, RustLibCallExpr } from "./lib-calls.js";

type IrFuncType = Extract<IrType, { kind: "func" }>;

const TLS_CONNECT_FENCED_OPTIONS = [
  "ALPNProtocols", "allowHalfOpen", "autoSelectFamily",
  "autoSelectFamilyAttemptTimeout", "cert", "ciphers", "clientCertEngine",
  "crl", "dhparam", "ecdhCurve", "enableTrace", "family", "fd", "hints",
  "highWaterMark", "honorCipherOrder", "keepAlive", "keepAliveInitialDelay",
  "key", "localAddress", "localPort", "lookup", "maxVersion", "minDHSize",
  "minVersion", "noDelay", "onread", "passphrase", "path", "pfx",
  "privateKeyEngine", "privateKeyIdentifier", "pskCallback", "readable",
  "secureContext", "secureOptions", "secureProtocol", "session",
  "sessionIdContext", "sigalgs", "signal", "socket", "ticketKeys", "timeout",
  "writable",
] as const;

function optionValue(options: string, key: string, dyn: string): string {
  return `match &${options} { ${dyn}::Object(..) => sc_dyn_key_get(&${options}, &runtime::string("${key}"), false), _ => ${dyn}::Undefined }`;
}

function emitVoidCallback(
  callbackExpr: RustLibCallExpr["args"][number],
  callbackType: IrFuncType,
  context: RustLibCallContext,
  expr: RustLibCallExpr,
  runtimeCall: (invoke: string, trace: string) => string,
): string {
  if (callbackType.params.length !== 0) context.unsupported("TLS void callback shape", expr.loc);
  const callback = context.nextTemporary();
  const traced = context.nextTemporary();
  const dispatch = context.emitClosureDispatch(callback, callbackType, [], expr.loc);
  return `{ let ${callback} = ${context.emitExpr(callbackExpr)}; let ${traced} = ${callback}.clone(); ${runtimeCall(`std::rc::Rc::new(move || { let _ = ${dispatch}; })`, `std::rc::Rc::new(move |sc_tracer: &mut runtime::Tracer<'_>| sc_tracer.edge(&${traced}))`)} }`;
}

function emitTlsConnect(expr: RustLibCallExpr, context: RustLibCallContext): string {
  const [portExpr, hostExpr, optionsExpr, callbackExpr] = expr.args;
  if (portExpr?.type.kind !== "f64" || hostExpr?.type.kind !== "string" ||
      optionsExpr?.type.kind !== "dyn") {
    context.unsupported(`${expr.fn} shape`, expr.loc);
  }
  const dyn = context.dynTypeName();
  const portArg = context.nextTemporary();
  const hostArg = context.nextTemporary();
  const options = context.nextTemporary();
  const portValue = context.nextTemporary();
  const hostValue = context.nextTemporary();
  const rejectValue = context.nextTemporary();
  const caValue = context.nextTemporary();
  const servernameValue = context.nextTemporary();
  const port = context.nextTemporary();
  const host = context.nextTemporary();
  const reject = context.nextTemporary();
  const ca = context.nextTemporary();
  const servername = context.nextTemporary();
  const fence = TLS_CONNECT_FENCED_OPTIONS.map((key) => {
    const value = context.nextTemporary();
    return `let ${value} = ${optionValue(options, key, dyn)}; if !matches!(&${value}, ${dyn}::Undefined) { runtime::throw_error(format!("tls.connect option '${key}' has no static lowering — port/host/rejectUnauthorized/ca/servername are the honestly-implemented members of a runtime options record")); }`;
  }).join(" ");
  const checkIdentity = context.nextTemporary();
  const caExtract = `match &${caValue} { ${dyn}::Undefined => None, ${dyn}::String(sc_text) => Some(sc_text.clone()), ${dyn}::Bytes(sc_bytes) | ${dyn}::Buffer(sc_bytes) => Some(runtime::bytes_to_string(sc_bytes, &runtime::string("utf8"))), ${dyn}::Array(sc_values) => { let sc_length = runtime::array_len(sc_values) as usize; if sc_length == 0 { runtime::throw_error("a tls.connect 'ca' option holding an empty array has no static lowering — pass PEM material".to_owned()); } let mut sc_pem = String::new(); for sc_index in 0..sc_length { let sc_entry = runtime::array_get(sc_values, sc_index as f64); match &sc_entry { ${dyn}::String(sc_text) => sc_pem.push_str(sc_text), ${dyn}::Bytes(sc_bytes) | ${dyn}::Buffer(sc_bytes) => sc_pem.push_str(&runtime::bytes_to_string(sc_bytes, &runtime::string("utf8"))), sc_value => sc_dyn_arg_type_fail("a tls.connect 'ca' option", "of type string or an instance of Buffer or Uint8Array", sc_value), } sc_pem.push('\\n'); } Some(runtime::string(&sc_pem)) }, sc_value => sc_dyn_arg_type_fail("a tls.connect 'ca' option", "of type string or an instance of Buffer or Uint8Array", sc_value), }`;
  const call = (callbackExpr === undefined)
    ? `runtime::tls_socket_connect(${port}, &${host}, &${servername}, ${reject}, ${ca})`
    : (() => {
      const callbackType = callbackExpr.type;
      if (callbackType.kind !== "func") context.unsupported("tls.connect callback", expr.loc);
      return emitVoidCallback(callbackExpr, callbackType, context, expr,
        (invoke, trace) => `runtime::tls_socket_connect_callback(${port}, &${host}, &${servername}, ${reject}, ${ca}, ${invoke}, ${trace})`);
    })();
  return `{ let ${portArg} = ${context.emitExpr(portExpr)}; let ${hostArg} = ${context.emitExpr(hostExpr)}; let ${options} = ${context.emitExpr(optionsExpr)}; if !matches!(&${options}, ${dyn}::Undefined | ${dyn}::Null | ${dyn}::Object(..)) { sc_dyn_arg_type_fail("options", "of type object", &${options}); } if sc_dyn_has_own(&${options}, &runtime::string("checkServerIdentity")) { let ${checkIdentity} = ${optionValue(options, "checkServerIdentity", dyn)}; if sc_dyn_typeof(&${checkIdentity}).as_ref() != "function" { sc_dyn_prop_type_fail("options.checkServerIdentity", "of type function", &${checkIdentity}); } runtime::throw_error("tls.connect option 'checkServerIdentity' has no static lowering — custom identity verification has no lowering — the runtime verifies against the servername/host".to_owned()); } ${fence} let ${portValue} = ${optionValue(options, "port", dyn)}; let ${port} = if ${portArg} >= 0.0 { ${portArg} } else { match &${portValue} { ${dyn}::Number(sc_number) => *sc_number, ${dyn}::String(sc_text) => runtime::number_from_string(sc_text), sc_value => sc_dyn_arg_type_fail("options.port", "of type number", sc_value), } }; let ${hostValue} = ${optionValue(options, "host", dyn)}; let sc_option_host = match &${hostValue} { ${dyn}::Undefined => None, ${dyn}::String(sc_text) => Some(sc_text.clone()), sc_value => sc_dyn_prop_type_fail("options.host", "of type string", sc_value), }; let ${host} = if !${hostArg}.is_empty() { ${hostArg} } else { sc_option_host.unwrap_or_else(|| runtime::string("localhost")) }; let ${rejectValue} = ${optionValue(options, "rejectUnauthorized", dyn)}; let ${reject} = if matches!(&${rejectValue}, ${dyn}::Undefined) { true } else { sc_dyn_is_truthy(&${rejectValue}) }; let ${caValue} = ${optionValue(options, "ca", dyn)}; let ${ca} = ${caExtract}; let ${servernameValue} = ${optionValue(options, "servername", dyn)}; let ${servername} = match &${servernameValue} { ${dyn}::Undefined => ${host}.clone(), ${dyn}::String(sc_text) => sc_text.clone(), sc_value => sc_dyn_prop_type_fail("options.servername", "of type string", sc_value), }; ${call} }`;
}

function emitPemBinding(
  arg: RustLibCallExpr["args"][number],
  name: string,
  context: RustLibCallContext,
  expr: RustLibCallExpr,
): string {
  if (arg.type.kind === "string") return `let ${name} = ${context.emitExpr(arg)};`;
  if (arg.type.kind === "bytes" && arg.type.elem === "u8") {
    const bytes = context.nextTemporary();
    return `let ${bytes} = ${context.emitExpr(arg)}; let ${name} = runtime::bytes_to_string(&${bytes}, &runtime::string("utf8"));`;
  }
  return context.unsupported("TLS server PEM argument", expr.loc);
}

function emitTlsServer(expr: RustLibCallExpr, context: RustLibCallContext): string {
  const [certExpr, keyExpr, callbackExpr] = expr.args;
  if (certExpr === undefined || keyExpr === undefined) {
    context.unsupported(`${expr.fn} shape`, expr.loc);
  }
  const cert = context.nextTemporary();
  const key = context.nextTemporary();
  const setup = `${emitPemBinding(certExpr, cert, context, expr)} ${emitPemBinding(keyExpr, key, context, expr)}`;
  if (expr.fn === "tls.createServer") {
    return `{ ${setup} runtime::tls_server_new(&${cert}, &${key}) }`;
  }
  if (callbackExpr?.type.kind !== "func") {
    return context.unsupported(`${expr.fn} callback`, expr.loc);
  }
  const callbackType = callbackExpr.type;
  const callback = context.nextTemporary();
  const traced = context.nextTemporary();
  if (expr.fn === "tls.createServerCb") {
    const parameter = callbackType.params[0];
    if (callbackType.params.length > 1 ||
        (parameter !== undefined && parameter.kind !== "netSocket")) {
      context.unsupported("TLS secureConnection listener parameters", expr.loc);
    }
    const dispatch = context.emitClosureDispatch(
      callback, callbackType, parameter === undefined ? [] : ["sc_socket"], expr.loc,
    );
    return `{ ${setup} let ${callback} = ${context.emitExpr(callbackExpr)}; let ${traced} = ${callback}.clone(); runtime::tls_server_new_callback(&${cert}, &${key}, std::rc::Rc::new(move |sc_socket| { let _ = ${dispatch}; }), std::rc::Rc::new(move |sc_tracer: &mut runtime::Tracer<'_>| sc_tracer.edge(&${traced}))) }`;
  }
  const [request, response] = callbackType.params;
  if (callbackType.params.length > 2 ||
      (request !== undefined && request.kind !== "httpReq") ||
      (response !== undefined && response.kind !== "httpRes")) {
    context.unsupported("HTTPS request listener parameters", expr.loc);
  }
  const args = callbackType.params.map((_, index) => index === 0 ? "sc_request" : "sc_response");
  const dispatch = context.emitClosureDispatch(callback, callbackType, args, expr.loc);
  return `{ ${setup} let ${callback} = ${context.emitExpr(callbackExpr)}; let ${traced} = ${callback}.clone(); runtime::https_server_new_callback(&${cert}, &${key}, std::rc::Rc::new(move |sc_request, sc_response| { let _ = ${dispatch}; }), std::rc::Rc::new(move |sc_tracer: &mut runtime::Tracer<'_>| sc_tracer.edge(&${traced}))) }`;
}

export function emitRustTlsCall(
  expr: RustLibCallExpr,
  context: RustLibCallContext,
): string | null {
  const arg = expr.args[0];
  if (expr.fn === "tlsca.get" && expr.args.length === 1 && arg?.type.kind === "string") {
    return `runtime::tls_ca_get(&(${context.emitExpr(arg)}))`;
  }
  if (expr.fn === "tlsca.root" && expr.args.length === 0) {
    return "runtime::tls_ca_root()";
  }
  if (expr.fn === "tlsca.set" && expr.args.length === 1 && arg?.type.kind === "array" &&
      arg.type.elem.kind === "string") {
    return `runtime::tls_ca_set_default(&(${context.emitExpr(arg)}))`;
  }
  if ((expr.fn === "tls.connect" || expr.fn === "tls.connectCb") &&
      (expr.args.length === 3 || expr.args.length === 4)) {
    return emitTlsConnect(expr, context);
  }
  if ((expr.fn === "tls.createServer" && expr.args.length === 2) ||
      ((expr.fn === "tls.createServerCb" || expr.fn === "https.createServer") &&
        expr.args.length === 3)) {
    return emitTlsServer(expr, context);
  }
  if (expr.fn === "tls.sockAuthorized" && expr.args.length === 1 &&
      arg?.type.kind === "netSocket") {
    return `runtime::tls_socket_authorized(&(${context.emitExpr(arg)}))`;
  }
  if (expr.fn === "tls.sockAuthError" && expr.args.length === 1 &&
      arg?.type.kind === "netSocket" && expr.type.kind === "union") {
    const union = context.union(expr.type.unionId, expr.loc);
    const stringTag = union.arms.findIndex((arm) => arm.kind === "string");
    const nullTag = union.arms.findIndex((arm) => arm.kind === "nullT");
    if (stringTag < 0 || nullTag < 0) context.unsupported("tls.sockAuthError result", expr.loc);
    const name = context.unionName(union.id);
    return `match runtime::tls_socket_authorization_error(&(${context.emitExpr(arg)})) { Some(sc_error) => ${name}::${context.unionVariant(stringTag)}(sc_error), None => ${name}::${context.unionVariant(nullTag)}, }`;
  }
  if (expr.fn === "tls.sockOnSecureConnect" && expr.args.length === 3 &&
      arg?.type.kind === "netSocket" && expr.args[2]?.type.kind === "bool") {
    const callbackExpr = expr.args[1];
    const callbackType = callbackExpr?.type;
    if (callbackExpr === undefined || callbackType?.kind !== "func") {
      context.unsupported("tls.sockOnSecureConnect callback", expr.loc);
    }
    const socket = context.emitExpr(arg);
    const once = context.emitExpr(expr.args[2]);
    return emitVoidCallback(callbackExpr, callbackType, context, expr,
      (invoke, trace) => `runtime::tls_socket_on_secure_connect(&(${socket}), ${invoke}, ${trace}, ${once});`);
  }
  return null;
}
