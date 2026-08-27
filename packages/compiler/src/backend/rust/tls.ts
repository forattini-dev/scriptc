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

const TLS_SERVER_FENCED_OPTIONS = [
  "ALPNProtocols", "ALPNCallback", "allowHalfOpen", "ciphers",
  "clientCertEngine", "crl", "dhparam", "ecdhCurve", "enableTrace",
  "handshakeTimeout", "highWaterMark", "honorCipherOrder", "keepAlive",
  "keepAliveInitialDelay", "maxVersion", "minVersion", "noDelay",
  "passphrase", "pauseOnConnect", "pfx", "privateKeyEngine",
  "privateKeyIdentifier", "pskCallback", "pskIdentityHint", "requestOCSP",
  "secureContext", "secureOptions", "secureProtocol", "sessionIdContext",
  "sessionTimeout", "sigalgs", "ticketKeys",
] as const;

function optionValue(options: string, key: string, dyn: string): string {
  return `match &${options} { ${dyn}::Object(..) => sc_dyn_key_get(&${options}, &runtime::string("${key}"), false), _ => ${dyn}::Undefined }`;
}

function tlsOptionsValidation(
  options: string,
  dyn: string,
  context: RustLibCallContext,
): string {
  const checks: string[] = [];
  for (const key of ["ciphers", "passphrase", "ecdhCurve", "sessionIdContext"] as const) {
    const value = context.nextTemporary();
    checks.push(`let ${value} = ${optionValue(options, key, dyn)}; if !matches!(&${value}, ${dyn}::Undefined | ${dyn}::Null | ${dyn}::String(..)) { sc_dyn_prop_type_fail("options.${key}", "of type string", &${value}); }`);
  }
  for (const key of ["clientCertEngine", "privateKeyEngine", "privateKeyIdentifier"] as const) {
    const value = context.nextTemporary();
    checks.push(`let ${value} = ${optionValue(options, key, dyn)}; if !matches!(&${value}, ${dyn}::Undefined | ${dyn}::Null | ${dyn}::String(..)) { sc_dyn_prop_type_fail("options.${key}", "of type string or one of null or undefined", &${value}); }`);
  }
  for (const [key, label] of [["minVersion", "minimum"], ["maxVersion", "maximum"]] as const) {
    const value = context.nextTemporary();
    const rendered = context.nextTemporary();
    checks.push(`let ${value} = ${optionValue(options, key, dyn)}; if !matches!(&${value}, ${dyn}::Undefined) { let sc_valid = matches!(&${value}, ${dyn}::String(sc_text) if matches!(sc_text.as_ref(), "TLSv1" | "TLSv1.1" | "TLSv1.2" | "TLSv1.3")); if !sc_valid { let ${rendered} = match &${value} { ${dyn}::String(sc_text) => runtime::json_stringify(sc_text).to_string(), sc_value => runtime::ParseArgsValue::parse_args_inspect_lite(sc_value), }; runtime::throw_type_error_code(format!("{${rendered}} is not a valid ${label} TLS protocol version"), "ERR_TLS_INVALID_PROTOCOL_VERSION"); } }`);
  }
  for (const key of ["handshakeTimeout", "keepAliveInitialDelay"] as const) {
    const value = context.nextTemporary();
    checks.push(`let ${value} = ${optionValue(options, key, dyn)}; if !matches!(&${value}, ${dyn}::Undefined | ${dyn}::Null | ${dyn}::Number(..)) { sc_dyn_prop_type_fail("options.${key}", "of type number", &${value}); }`);
  }
  const session = context.nextTemporary();
  checks.push(`let ${session} = ${optionValue(options, "sessionTimeout", dyn)}; match &${session} { ${dyn}::Undefined | ${dyn}::Null => {}, ${dyn}::Number(sc_number) => { if !sc_number.is_finite() || sc_number.trunc() != *sc_number { runtime::throw_range_error_code(format!("The value of \\"options.sessionTimeout\\" is out of range. It must be an integer. Received {}", runtime::format_number(*sc_number)), "ERR_OUT_OF_RANGE"); } if !(0.0..=2_147_483_647.0).contains(sc_number) { runtime::throw_range_error_code(format!("The value of \\"options.sessionTimeout\\" is out of range. It must be >= 0 && <= 2147483647. Received {}", runtime::format_number(*sc_number)), "ERR_OUT_OF_RANGE"); } }, sc_value => sc_dyn_prop_type_fail("options.sessionTimeout", "of type number", sc_value), }`);
  const ticket = context.nextTemporary();
  checks.push(`let ${ticket} = ${optionValue(options, "ticketKeys", dyn)}; match &${ticket} { ${dyn}::Undefined | ${dyn}::Null => {}, ${dyn}::Bytes(sc_bytes) | ${dyn}::Buffer(sc_bytes) => { let sc_length = runtime::bytes_byte_len(sc_bytes); if sc_length != 48.0 { runtime::throw_type_error_code(format!("The property 'options.ticketKeys' must be exactly 48 bytes. Received {}", runtime::format_number(sc_length)), "ERR_INVALID_ARG_VALUE"); } }, sc_value => sc_dyn_prop_type_fail("options.ticketKeys", "an instance of Buffer, TypedArray, or DataView", sc_value), }`);
  return checks.join(" ");
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

function emitTlsServerFromPem(
  expr: RustLibCallExpr,
  setup: string,
  cert: string,
  key: string,
  callbackExpr: RustLibCallExpr["args"][number] | undefined,
  context: RustLibCallContext,
): string {
  const https = expr.fn.startsWith("https.");
  if (callbackExpr === undefined) {
    const runtimeFn = https ? "https_server_new" : "tls_server_new";
    return `{ ${setup} runtime::${runtimeFn}(&${cert}, &${key}) }`;
  }
  if (callbackExpr?.type.kind !== "func") {
    return context.unsupported(`${expr.fn} callback`, expr.loc);
  }
  const callbackType = callbackExpr.type;
  const callback = context.nextTemporary();
  const traced = context.nextTemporary();
  if (!https) {
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

function emitTlsServer(expr: RustLibCallExpr, context: RustLibCallContext): string {
  const [certExpr, keyExpr, callbackExpr] = expr.args;
  if (certExpr === undefined || keyExpr === undefined) {
    context.unsupported(`${expr.fn} shape`, expr.loc);
  }
  const cert = context.nextTemporary();
  const key = context.nextTemporary();
  const setup = `${emitPemBinding(certExpr, cert, context, expr)} ${emitPemBinding(keyExpr, key, context, expr)}`;
  return emitTlsServerFromPem(expr, setup, cert, key, callbackExpr, context);
}

function emitTlsSecureContext(expr: RustLibCallExpr, context: RustLibCallContext): string {
  const [certExpr, keyExpr] = expr.args;
  if (certExpr === undefined || keyExpr === undefined) {
    context.unsupported(`${expr.fn} shape`, expr.loc);
  }
  const cert = context.nextTemporary();
  const key = context.nextTemporary();
  const setup = `${emitPemBinding(certExpr, cert, context, expr)} ${emitPemBinding(keyExpr, key, context, expr)}`;
  return `{ ${setup} runtime::tls_secure_context_new(&${cert}, &${key}) }`;
}

function pemDynString(value: string, what: string, dyn: string): string {
  return `match &${value} { ${dyn}::String(sc_text) => sc_text.clone(), ${dyn}::Bytes(sc_bytes) | ${dyn}::Buffer(sc_bytes) => runtime::bytes_to_string(sc_bytes, &runtime::string("utf8")), ${dyn}::Array(sc_values) => { let sc_length = runtime::array_len(sc_values) as usize; if sc_length == 0 { runtime::throw_error(format!("{} holding an empty array has no static lowering — pass PEM material", ${what})); } if sc_length > 1 { runtime::throw_error(format!("{} with more than one array entry has no static lowering — one cert/key pair per server here", ${what})); } let sc_entry = runtime::array_get(sc_values, 0.0); match &sc_entry { ${dyn}::String(sc_text) => sc_text.clone(), ${dyn}::Bytes(sc_bytes) | ${dyn}::Buffer(sc_bytes) => runtime::bytes_to_string(sc_bytes, &runtime::string("utf8")), sc_value => sc_dyn_arg_type_fail(${what}.as_ref(), "of type string or an instance of Buffer or Uint8Array", sc_value), } }, ${dyn}::Undefined | ${dyn}::Null => runtime::throw_error(format!("{} holding undefined has no static lowering — pass PEM material (a string or a Buffer)", ${what})), sc_value => sc_dyn_arg_type_fail(${what}.as_ref(), "of type string or an instance of Buffer or Uint8Array", sc_value), }`;
}

function emitPemDyn(expr: RustLibCallExpr, context: RustLibCallContext): string {
  const [valueExpr, whatExpr] = expr.args;
  if (valueExpr?.type.kind !== "dyn" || whatExpr?.type.kind !== "string") {
    return context.unsupported("tls.pemDyn shape", expr.loc);
  }
  const value = context.nextTemporary();
  const what = context.nextTemporary();
  const pem = pemDynString(value, what, context.dynTypeName());
  return `{ let ${value} = ${context.emitExpr(valueExpr)}; let ${what} = ${context.emitExpr(whatExpr)}; let sc_pem = ${pem}; runtime::buffer_from_string(&sc_pem, &runtime::string("utf8")) }`;
}

function emitTlsServerDynamic(expr: RustLibCallExpr, context: RustLibCallContext): string {
  const [optionsExpr, callbackExpr] = expr.args;
  if (optionsExpr?.type.kind !== "dyn") {
    return context.unsupported(`${expr.fn} shape`, expr.loc);
  }
  const dyn = context.dynTypeName();
  const options = context.nextTemporary();
  const certValue = context.nextTemporary();
  const keyValue = context.nextTemporary();
  const cert = context.nextTemporary();
  const key = context.nextTemporary();
  const api = expr.fn.startsWith("https.") ? "https.createServer" : "tls.createServer";
  const requestCert = context.nextTemporary();
  const sni = context.nextTemporary();
  const fences = TLS_SERVER_FENCED_OPTIONS.map((name) => {
    const value = context.nextTemporary();
    return `let ${value} = ${optionValue(options, name, dyn)}; if !matches!(&${value}, ${dyn}::Undefined) { runtime::throw_error(format!("${api} option '${name}' has no static lowering — cert and key (PEM strings or Buffers) are the honestly-implemented members of a runtime options record")); }`;
  }).join(" ");
  const certWhat = `runtime::string("a ${api} 'cert' option")`;
  const keyWhat = `runtime::string("a ${api} 'key' option")`;
  let timeout = "";
  let after = "";
  if (expr.fn.startsWith("https.")) {
    const timeoutValue = context.nextTemporary();
    const timeoutOption = context.nextTemporary();
    timeout = `let ${timeoutValue} = ${optionValue(options, "keepAliveTimeoutBuffer", dyn)}; let ${timeoutOption} = match &${timeoutValue} { ${dyn}::Undefined => None, ${dyn}::Number(sc_number) => Some(*sc_number), sc_value => sc_dyn_arg_type_fail("keepAliveTimeoutBuffer", "of type number", sc_value), };`;
    after = `runtime::http_server_timeout_option_set(&sc_server, 4.0, ${timeoutOption});`;
  }
  const validation = tlsOptionsValidation(options, dyn, context);
  const setup = `let ${options} = ${context.emitExpr(optionsExpr)}; if !matches!(&${options}, ${dyn}::Object(..)) { sc_dyn_arg_type_fail("options", "of type object", &${options}); } ${validation} ${timeout} let ${requestCert} = ${optionValue(options, "requestCert", dyn)}; if !matches!(&${requestCert}, ${dyn}::Undefined) && sc_dyn_is_truthy(&${requestCert}) { runtime::throw_error("${api} option 'requestCert' has no static lowering — client-certificate handshakes are not modeled; requestCert stays false".to_owned()); } let ${sni} = ${optionValue(options, "SNICallback", dyn)}; if !matches!(&${sni}, ${dyn}::Undefined) { runtime::throw_error("${api} option 'SNICallback' has no static lowering — serve one cert/key pair here".to_owned()); } ${fences} let ${certValue} = ${optionValue(options, "cert", dyn)}; let ${keyValue} = ${optionValue(options, "key", dyn)}; if matches!(&${certValue}, ${dyn}::Undefined) || matches!(&${keyValue}, ${dyn}::Undefined) { runtime::throw_error("${api} without both cert and key has no static lowering — the supported options are { cert, key } (PEM strings or Buffers)".to_owned()); } let ${cert} = ${pemDynString(certValue, certWhat, dyn)}; let ${key} = ${pemDynString(keyValue, keyWhat, dyn)};`;
  const call = emitTlsServerFromPem(expr, "", cert, key, callbackExpr, context);
  return `{ ${setup} let sc_server = ${call}; ${after} sc_server }`;
}

function emitTlsSecureContextDynamic(
  expr: RustLibCallExpr,
  context: RustLibCallContext,
): string {
  const optionsExpr = expr.args[0];
  if (optionsExpr?.type.kind !== "dyn") {
    return context.unsupported(`${expr.fn} shape`, expr.loc);
  }
  const dyn = context.dynTypeName();
  const options = context.nextTemporary();
  const certValue = context.nextTemporary();
  const keyValue = context.nextTemporary();
  const cert = context.nextTemporary();
  const key = context.nextTemporary();
  const requestCert = context.nextTemporary();
  const sni = context.nextTemporary();
  const validation = tlsOptionsValidation(options, dyn, context);
  const fences = TLS_SERVER_FENCED_OPTIONS.map((name) => {
    const value = context.nextTemporary();
    return `let ${value} = ${optionValue(options, name, dyn)}; if !matches!(&${value}, ${dyn}::Undefined) { runtime::throw_error(format!("tls.createSecureContext option '${name}' has no static lowering — cert and key (PEM strings or Buffers) are the honestly-implemented members of a runtime options record")); }`;
  }).join(" ");
  const certWhat = 'runtime::string("a tls.createSecureContext \'cert\' option")';
  const keyWhat = 'runtime::string("a tls.createSecureContext \'key\' option")';
  return `{ let ${options} = ${context.emitExpr(optionsExpr)}; if !matches!(&${options}, ${dyn}::Object(..)) { sc_dyn_arg_type_fail("options", "of type object", &${options}); } ${validation} let ${requestCert} = ${optionValue(options, "requestCert", dyn)}; if !matches!(&${requestCert}, ${dyn}::Undefined) && sc_dyn_is_truthy(&${requestCert}) { runtime::throw_error("tls.createSecureContext option 'requestCert' has no static lowering — client-certificate handshakes are not modeled; requestCert stays false".to_owned()); } let ${sni} = ${optionValue(options, "SNICallback", dyn)}; if !matches!(&${sni}, ${dyn}::Undefined) { runtime::throw_error("tls.createSecureContext option 'SNICallback' has no static lowering — SNICallback belongs on a TLS server".to_owned()); } ${fences} let ${certValue} = ${optionValue(options, "cert", dyn)}; let ${keyValue} = ${optionValue(options, "key", dyn)}; if matches!(&${certValue}, ${dyn}::Undefined) || matches!(&${keyValue}, ${dyn}::Undefined) { runtime::throw_error("tls.createSecureContext without both cert and key has no static lowering — the supported options are { cert, key } (PEM strings or Buffers)".to_owned()); } let ${cert} = ${pemDynString(certValue, certWhat, dyn)}; let ${key} = ${pemDynString(keyValue, keyWhat, dyn)}; runtime::tls_secure_context_new(&${cert}, &${key}) }`;
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
  if (expr.fn === "tls.caCertsChk" && expr.args.length === 2 &&
      arg?.type.kind === "dyn" && expr.args[1]?.type.kind === "string") {
    const value = context.nextTemporary();
    const fence = context.nextTemporary();
    const dyn = context.dynTypeName();
    return `{ let ${value} = ${context.emitExpr(arg)}; let ${fence} = ${context.emitExpr(expr.args[1])}; match &${value} { ${dyn}::String(sc_type) if matches!(sc_type.as_ref(), "default" | "system" | "bundled" | "extra") => runtime::throw_error_code(${fence}.to_string(), "SC2020"), ${dyn}::String(..) => sc_dyn_arg_value_fail("type", "is invalid", &${value}), sc_type => sc_dyn_arg_type_fail("type", "of type string", sc_type), } }`;
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
  if (expr.fn === "tls.createSecureContext" && expr.args.length === 2) {
    return emitTlsSecureContext(expr, context);
  }
  if (expr.fn === "tls.createSecureContextDyn" && expr.args.length === 1) {
    return emitTlsSecureContextDynamic(expr, context);
  }
  if (expr.fn === "tls.pemDyn" && expr.args.length === 2) {
    return emitPemDyn(expr, context);
  }
  if (["tls.createServerDyn", "tls.createServerDynCb", "https.createServerDyn", "https.createServerDynCb"].includes(expr.fn)) {
    return emitTlsServerDynamic(expr, context);
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
