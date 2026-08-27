import type { IrType, SrcLoc } from "../../ir/nodes.js";
import { mangleField, mangleRecordStruct } from "../mangle.js";
import type { RustLibCallContext, RustLibCallExpr } from "./lib-calls.js";

type IrFuncType = Extract<IrType, { kind: "func" }>;

function emitVoidCallback(
  callbackExpr: RustLibCallExpr["args"][number],
  callbackType: IrFuncType,
  context: RustLibCallContext,
  expr: RustLibCallExpr,
  runtimeCall: (invoke: string, trace: string) => string,
): string {
  if (callbackType.params.length !== 0) context.unsupported("dgram void callback shape", expr.loc);
  const callback = context.nextTemporary();
  const traced = context.nextTemporary();
  const dispatch = context.emitClosureDispatch(callback, callbackType, [], expr.loc);
  return `{ let ${callback} = ${context.emitExpr(callbackExpr)}; let ${traced} = ${callback}.clone(); ${runtimeCall(`std::rc::Rc::new(move || { let _ = ${dispatch}; })`, `std::rc::Rc::new(move |sc_tracer: &mut runtime::Tracer<'_>| sc_tracer.edge(&${traced}))`)} }`;
}

function emitErrorListener(
  expr: RustLibCallExpr,
  callbackType: IrFuncType,
  context: RustLibCallContext,
): string {
  const [receiver, callbackExpr, onceExpr] = expr.args;
  const parameter = callbackType.params[0];
  if (receiver?.type.kind !== "dgramSocket" || callbackExpr === undefined ||
      onceExpr?.type.kind !== "bool" || callbackType.params.length > 1 ||
      (parameter !== undefined && (parameter.kind !== "object" || parameter.className !== "%Error"))) {
    context.unsupported("dgram error listener shape", expr.loc);
  }
  const callback = context.nextTemporary();
  const traced = context.nextTemporary();
  const error = parameter === undefined ? "_sc_error" : "sc_error";
  const argument = context.hasErrorClassRoots()
    ? `${context.errorValueName()}::Builtin(sc_error)`
    : "sc_error";
  const dispatch = context.emitClosureDispatch(
    callback,
    callbackType,
    parameter === undefined ? [] : [argument],
    expr.loc,
  );
  return `{ let ${callback} = ${context.emitExpr(callbackExpr)}; let ${traced} = ${callback}.clone(); runtime::dgram_on_error(&(${context.emitExpr(receiver)}), std::rc::Rc::new(move |${error}| { let _ = ${dispatch}; }), std::rc::Rc::new(move |sc_tracer: &mut runtime::Tracer<'_>| sc_tracer.edge(&${traced})), ${context.emitExpr(onceExpr)}); }`;
}

function emitMessageListener(
  expr: RustLibCallExpr,
  callbackType: IrFuncType,
  context: RustLibCallContext,
): string {
  const [receiver, callbackExpr, onceExpr] = expr.args;
  if (receiver?.type.kind !== "dgramSocket" || callbackExpr === undefined || onceExpr?.type.kind !== "bool" ||
      callbackType.params.length > 2) context.unsupported("dgram message listener shape", expr.loc);
  const messageType = callbackType.params[0];
  if (messageType !== undefined && (messageType.kind !== "bytes" || messageType.elem !== "u8")) {
    context.unsupported("dgram message listener buffer", expr.loc);
  }
  const rinfoType = callbackType.params[1];
  let rinfo = "";
  if (rinfoType !== undefined) {
    if (rinfoType.kind !== "record") context.unsupported("dgram rinfo listener record", expr.loc);
    const shape = context.record(rinfoType.shapeId, expr.loc);
    const values: Readonly<Record<string, string>> = {
      address: "sc_address.clone()",
      family: "sc_family.clone()",
      port: "sc_port",
      size: "sc_size",
    };
    const fields = shape.fields.map((field) => {
      const value = values[field.name];
      if (value === undefined) context.unsupported(`dgram rinfo field '${field.name}'`, expr.loc);
      return `${mangleField(field.name)}: ${value}`;
    }).join(", ");
    rinfo = `runtime::Gc::new(${mangleRecordStruct(shape.id)} { ${fields} })`;
  }
  const args = messageType === undefined ? [] : rinfoType === undefined ? ["sc_message"] : ["sc_message", rinfo];
  const callback = context.nextTemporary();
  const traced = context.nextTemporary();
  const dispatch = context.emitClosureDispatch(callback, callbackType, args, expr.loc);
  return `{ let ${callback} = ${context.emitExpr(callbackExpr)}; let ${traced} = ${callback}.clone(); runtime::dgram_on_message(&(${context.emitExpr(receiver)}), std::rc::Rc::new(move |sc_message, sc_address, sc_family, sc_port, sc_size| { let _ = ${dispatch}; }), std::rc::Rc::new(move |sc_tracer: &mut runtime::Tracer<'_>| sc_tracer.edge(&${traced})), ${context.emitExpr(onceExpr)}); }`;
}

function emitSendChecked(expr: RustLibCallExpr, context: RustLibCallContext): string {
  const [socketExpr, bufferExpr, a1Expr, a2Expr, a3Expr, a4Expr, fenceExpr] = expr.args;
  if (socketExpr?.type.kind !== "dgramSocket" || fenceExpr?.type.kind !== "string" ||
      [bufferExpr, a1Expr, a2Expr, a3Expr, a4Expr].some((arg) => arg?.type.kind !== "dyn") ||
      expr.args.length !== 7 || expr.type.kind !== "void") {
    context.unsupported("dgram.sendChk shape", expr.loc);
  }
  const values = expr.args.map(() => context.nextTemporary());
  const bind = expr.args.map((arg, index) => `let ${values[index]} = ${context.emitExpr(arg)};`).join(" ");
  const socket = required(values, 0, context, expr.loc);
  const buffer = required(values, 1, context, expr.loc);
  const a1 = required(values, 2, context, expr.loc);
  const a2 = required(values, 3, context, expr.loc);
  const a3 = required(values, 4, context, expr.loc);
  const a4 = required(values, 5, context, expr.loc);
  const fenceValue = required(values, 6, context, expr.loc);
  const dyn = context.dynTypeName();
  const validPayload = `${dyn}::String(..) | ${dyn}::Bytes(..) | ${dyn}::Buffer(..)`;
  return `{ ${bind} let sc_connected = runtime::dgram_is_connected(&${socket}); let mut sc_offset = ${a1}.clone(); let mut sc_length = ${a2}.clone(); let mut sc_port = ${a3}.clone(); let mut sc_address = ${a4}.clone(); let mut sc_callback = ${dyn}::Undefined; let mut sc_sliced = false; if !sc_connected { if sc_dyn_is_truthy(&sc_address) || (sc_dyn_is_truthy(&sc_port) && sc_dyn_function_identity(&sc_port).is_none()) { sc_sliced = true; } else { sc_callback = sc_port; sc_port = sc_offset.clone(); sc_address = sc_length.clone(); } } else if matches!(&sc_length, ${dyn}::Number(..)) { sc_sliced = true; if sc_dyn_function_identity(&sc_port).is_some() { sc_callback = sc_port.clone(); } } else { sc_callback = sc_offset.clone(); sc_port = ${a3}.clone(); sc_address = ${a4}.clone(); } let mut sc_slice_offset = 0_usize; let mut sc_slice_length = 0_usize; if sc_sliced { let sc_byte_length = match &${buffer} { ${dyn}::String(sc_data) => sc_data.len() as f64, ${dyn}::Bytes(sc_data) | ${dyn}::Buffer(sc_data) => runtime::bytes_byte_len(sc_data), sc_value => sc_dyn_arg_type_fail("buffer", "of type string or an instance of Buffer, TypedArray, or DataView", sc_value), }; sc_slice_offset = match &sc_offset { ${dyn}::Number(sc_number) => runtime::to_uint32(*sc_number) as usize, _ => 0_usize, }; sc_slice_length = match &sc_length { ${dyn}::Number(sc_number) => runtime::to_uint32(*sc_number) as usize, _ => 0_usize, }; if sc_slice_offset as f64 > sc_byte_length { runtime::throw_range_error_code("\\\"offset\\\" is outside of buffer bounds".to_owned(), "ERR_BUFFER_OUT_OF_BOUNDS"); } if (sc_slice_offset + sc_slice_length) as f64 > sc_byte_length { runtime::throw_range_error_code("\\\"length\\\" is outside of buffer bounds".to_owned(), "ERR_BUFFER_OUT_OF_BOUNDS"); } } else if let ${dyn}::Array(sc_list) = &${buffer} { let mut sc_index = 0.0; while sc_index < runtime::array_len(sc_list) { let sc_item = runtime::array_get(sc_list, sc_index); if !matches!(&sc_item, ${validPayload}) { sc_dyn_arg_type_fail("buffer list arguments", "of type string or an instance of Buffer, TypedArray, or DataView", &${buffer}); } sc_index += 1.0; } } else if !matches!(&${buffer}, ${validPayload}) { sc_dyn_arg_type_fail("buffer", "of type string or an instance of Buffer, TypedArray, or DataView", &${buffer}); } if sc_connected { if sc_dyn_is_truthy(&sc_port) || sc_dyn_is_truthy(&sc_address) { runtime::throw_error_code("Already connected".to_owned(), "ERR_SOCKET_DGRAM_IS_CONNECTED"); } runtime::throw_error_code(${fenceValue}.to_string(), "SC2020"); } let sc_port_number = match &sc_port { ${dyn}::Number(sc_number) if sc_number.is_finite() && sc_number.trunc() == *sc_number && (0.0..65_536.0).contains(sc_number) && *sc_number != 0.0 => *sc_number, ${dyn}::String(sc_text) if !sc_text.is_empty() => { let sc_number = runtime::number_from_string(sc_text); if sc_number.is_finite() && sc_number.trunc() == sc_number && (0.0..65_536.0).contains(&sc_number) && sc_number != 0.0 { sc_number } else { runtime::throw_range_error_code(format!("Port should be > 0 and < 65536. Received {}.", sc_dyn_specific_type(&sc_port)), "ERR_SOCKET_BAD_PORT"); } }, _ => runtime::throw_range_error_code(format!("Port should be > 0 and < 65536. Received {}.", sc_dyn_specific_type(&sc_port)), "ERR_SOCKET_BAD_PORT"), }; if sc_dyn_function_identity(&sc_address).is_some() { sc_callback = sc_address.clone(); sc_address = ${dyn}::Undefined; } else if !matches!(&sc_address, ${dyn}::Undefined | ${dyn}::Null | ${dyn}::String(..)) { sc_dyn_arg_type_fail("address", "of type string", &sc_address); } if sc_dyn_function_identity(&sc_callback).is_some() || matches!(&${buffer}, ${dyn}::Array(..)) { runtime::throw_error_code(${fenceValue}.to_string(), "SC2020"); } let sc_host = match &sc_address { ${dyn}::String(sc_host) => sc_host.clone(), _ => runtime::string("127.0.0.1"), }; match &${buffer} { ${dyn}::String(sc_data) if sc_sliced => runtime::dgram_send_string_slice(&${socket}, sc_data, sc_slice_offset, sc_slice_length, sc_port_number, &sc_host), ${dyn}::String(sc_data) => runtime::dgram_send_string(&${socket}, sc_data, sc_port_number, &sc_host), ${dyn}::Bytes(sc_data) | ${dyn}::Buffer(sc_data) if sc_sliced => runtime::dgram_send_bytes_slice(&${socket}, sc_data, sc_slice_offset, sc_slice_length, sc_port_number, &sc_host), ${dyn}::Bytes(sc_data) | ${dyn}::Buffer(sc_data) => runtime::dgram_send_bytes(&${socket}, sc_data, sc_port_number, &sc_host), _ => unreachable!(), } }`;
}

export function emitRustDgramCall(
  expr: RustLibCallExpr,
  context: RustLibCallContext,
): string | null {
  const [receiver] = expr.args;
  if (expr.fn === "dgram.createSocket" && expr.args.length === 1 && receiver?.type.kind === "bool" &&
      expr.type.kind === "dgramSocket") {
    return `runtime::dgram_create_socket(${context.emitExpr(receiver)})`;
  }
  if ((expr.fn === "dgram.bind" || expr.fn === "dgram.connect") && expr.args.length === 3 &&
      receiver?.type.kind === "dgramSocket" && expr.args[1]?.type.kind === "f64" && expr.args[2]?.type.kind === "string") {
    const fn = expr.fn === "dgram.bind" ? "dgram_bind" : "dgram_connect";
    return `runtime::${fn}(&(${context.emitExpr(receiver)}), ${context.emitExpr(expr.args[1])}, &(${context.emitExpr(expr.args[2])}))`;
  }
  if ((expr.fn === "dgram.bindCb" || expr.fn === "dgram.connectCb") && expr.args.length === 4 &&
      receiver?.type.kind === "dgramSocket" && expr.args[1]?.type.kind === "f64" && expr.args[2]?.type.kind === "string") {
    const callbackExpr = expr.args[3];
    const callbackType = callbackExpr?.type;
    if (callbackExpr === undefined || callbackType?.kind !== "func") context.unsupported(`${expr.fn} callback`, expr.loc);
    const socket = context.emitExpr(receiver);
    const port = context.emitExpr(expr.args[1]);
    const host = context.emitExpr(expr.args[2]);
    const fn = expr.fn === "dgram.bindCb" ? "dgram_bind_callback" : "dgram_connect_callback";
    return emitVoidCallback(callbackExpr, callbackType, context, expr,
      (invoke, trace) => `runtime::${fn}(&(${socket}), ${port}, &(${host}), ${invoke}, ${trace})`);
  }
  if ((expr.fn === "dgram.sendStr" || expr.fn === "dgram.sendBytes") && expr.args.length === 4 &&
      receiver?.type.kind === "dgramSocket" && expr.args[2]?.type.kind === "f64" && expr.args[3]?.type.kind === "string") {
    const data = expr.args[1];
    if (data === undefined || (expr.fn === "dgram.sendStr" ? data.type.kind !== "string" : data.type.kind !== "bytes")) {
      context.unsupported(`${expr.fn} data`, expr.loc);
    }
    const fn = expr.fn === "dgram.sendStr" ? "dgram_send_string" : "dgram_send_bytes";
    return `runtime::${fn}(&(${context.emitExpr(receiver)}), &(${context.emitExpr(data)}), ${context.emitExpr(expr.args[2])}, &(${context.emitExpr(expr.args[3])}))`;
  }
  if (expr.fn === "dgram.sendChk") return emitSendChecked(expr, context);
  if (expr.fn === "dgram.address" && expr.args.length === 1 && receiver?.type.kind === "dgramSocket" &&
      expr.type.kind === "record") {
    const shape = context.record(expr.type.shapeId, expr.loc);
    const fields = shape.fields.map((field) => {
      const value = field.name === "address" ? "sc_address" : field.name === "family" ? "sc_family" : field.name === "port" ? "sc_port" : undefined;
      if (value === undefined) context.unsupported(`dgram address field '${field.name}'`, expr.loc);
      return `${mangleField(field.name)}: ${value}`;
    }).join(", ");
    return `{ let (sc_address, sc_family, sc_port) = runtime::dgram_address(&(${context.emitExpr(receiver)})); runtime::Gc::new(${mangleRecordStruct(shape.id)} { ${fields} }) }`;
  }
  if ((expr.fn === "dgram.close" || expr.fn === "dgram.unref" || expr.fn === "dgram.ref") &&
      expr.args.length === 1 && receiver?.type.kind === "dgramSocket") {
    const fn = expr.fn === "dgram.close" ? "dgram_close" : expr.fn === "dgram.unref" ? "dgram_unref" : "dgram_ref";
    return `runtime::${fn}(&(${context.emitExpr(receiver)}))`;
  }
  if (expr.fn === "dgram.closeCb" && expr.args.length === 2 && receiver?.type.kind === "dgramSocket") {
    const callbackExpr = expr.args[1];
    const callbackType = callbackExpr?.type;
    if (callbackExpr === undefined || callbackType?.kind !== "func") context.unsupported("dgram.closeCb callback", expr.loc);
    const socket = context.emitExpr(receiver);
    return emitVoidCallback(callbackExpr, callbackType, context, expr,
      (invoke, trace) => `runtime::dgram_close_callback(&(${socket}), ${invoke}, ${trace})`);
  }
  if (expr.fn === "dgram.onMessage" && expr.args.length === 3) {
    const callbackType = expr.args[1]?.type;
    if (callbackType?.kind !== "func") context.unsupported("dgram.onMessage callback", expr.loc);
    return emitMessageListener(expr, callbackType, context);
  }
  if (expr.fn === "dgram.onError" && expr.args.length === 3) {
    const callbackType = expr.args[1]?.type;
    if (callbackType?.kind !== "func") context.unsupported("dgram.onError callback", expr.loc);
    return emitErrorListener(expr, callbackType, context);
  }
  if ((expr.fn === "dgram.onListening" || expr.fn === "dgram.onClose" || expr.fn === "dgram.onConnect") &&
      expr.args.length === 3 && receiver?.type.kind === "dgramSocket" && expr.args[2]?.type.kind === "bool") {
    const callbackExpr = expr.args[1];
    const callbackType = callbackExpr?.type;
    if (callbackExpr === undefined || callbackType?.kind !== "func") context.unsupported(`${expr.fn} callback`, expr.loc);
    const socket = context.emitExpr(receiver);
    const once = context.emitExpr(expr.args[2]);
    const fn = expr.fn === "dgram.onListening" ? "dgram_on_listening" : expr.fn === "dgram.onClose" ? "dgram_on_close" : "dgram_on_connect";
    return emitVoidCallback(callbackExpr, callbackType, context, expr,
      (invoke, trace) => `runtime::${fn}(&(${socket}), ${invoke}, ${trace}, ${once})`);
  }
  return null;
}

function required(
  values: readonly string[],
  index: number,
  context: RustLibCallContext,
  loc: SrcLoc,
): string {
  return values[index] ?? context.unsupported("dgram temporary", loc);
}
