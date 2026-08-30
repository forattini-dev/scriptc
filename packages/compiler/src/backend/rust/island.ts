import type { IrExpr, IrType, SrcLoc } from "../../ir/nodes.js";
import type { IrFuncType } from "./model.js";
import { emitRustIslandDestructuringFunction } from "./island-destructuring-function.js";
import { emitRustIslandBuiltin } from "./island-builtins.js";

type IslandExpr = Extract<IrExpr, { kind: "jsMarshal" | "jsOp" | "jsExit" | "jsBridgePromise" }>;

export interface RustIslandContext {
  nextName(prefix: string): string;
  dynTypeName(): string;
  emitClosureDispatch(callee: string, type: IrFuncType, args: string[], loc: SrcLoc): string;
  emitDynCheckValue(type: IrType, value: string, loc?: SrcLoc): string;
  emitDynFromValue(type: IrType, value: string, loc?: SrcLoc, functionName?: string): string;
  hasEmbeddedModules(): boolean;
  rustString(value: string): string;
  unsupported(kind: string, loc?: SrcLoc): never;
}

/** Emit the backend-neutral island subset used by compiled program imports.
 *
 * Most operations map directly to the native checked-dynamic value model.
 * The explicit island.eval hook instead uses the runtime's persistent
 * ECMAScript realm. Unsupported operations keep their explicit SC3001 refusal.
 */
export function emitRustIslandExpr(
  expr: IslandExpr,
  context: RustIslandContext,
  emitExpr: (expr: IrExpr) => string,
): string {
  switch (expr.kind) {
    case "jsMarshal": return emitMarshal(expr, context, emitExpr);
    case "jsExit": {
      if (!context.hasEmbeddedModules()) {
        return context.emitDynCheckValue(expr.type, emitExpr(expr.value), expr.loc);
      }
      const value = context.nextName("sc_island_exit");
      const dyn = context.dynTypeName();
      const normalized = `{ let ${value} = ${emitExpr(expr.value)}; match ${value} { ${dyn}::Island(sc_value) => runtime::json_parse_typed::<${dyn}>(&runtime::island_json(&sc_value)), sc_value => sc_value, } }`;
      return context.emitDynCheckValue(expr.type, normalized, expr.loc);
    }
    case "jsOp": return emitOperation(expr, context, emitExpr);
    case "jsBridgePromise": return emitPromiseBridge(expr, context, emitExpr);
  }
}

function emitMarshal(
  expr: Extract<IrExpr, { kind: "jsMarshal" }>,
  context: RustIslandContext,
  emitExpr: (expr: IrExpr) => string,
): string {
  if (
    expr.value.type.kind === "func" && context.hasEmbeddedModules() &&
    expr.value.type.rest !== true && expr.value.type.params.every((param) => param.kind === "string") &&
    expr.value.type.ret.kind === "string"
  ) {
    const closure = context.nextName("sc_island_host_closure");
    const argumentsName = context.nextName("sc_island_host_arguments");
    const args = expr.value.type.params.map((_, index) =>
      `runtime::island_host_argument_string(${argumentsName}, ${index})`
    );
    const dispatch = context.emitClosureDispatch(closure, expr.value.type, args, expr.loc);
    return `{ let ${closure} = ${emitExpr(expr.value)}; ` +
      `${context.dynTypeName()}::Island(runtime::island_value_host_function(${args.length}, ` +
      `std::rc::Rc::new(move |${argumentsName}| runtime::IslandHostResult::String(${dispatch})))) }`;
  }
  switch (expr.value.type.kind) {
    case "f64":
    case "bool":
    case "string":
    case "func":
    case "array":
    case "bytes":
    case "url":
    case "promise":
    case "record":
    case "union":
    case "dyn":
      return context.emitDynFromValue(expr.value.type, emitExpr(expr.value), expr.loc);
    default:
      context.unsupported(`island marshal from '${expr.value.type.kind}'`, expr.loc);
  }
}

function emitOperation(
  expr: Extract<IrExpr, { kind: "jsOp" }>,
  context: RustIslandContext,
  emitExpr: (expr: IrExpr) => string,
): string {
  if (expr.op === "objLit") return emitObjectLiteral(expr, context, emitExpr);
  if (expr.op === "arrLit") {
    const array = context.nextName("sc_island_array");
    if (context.hasEmbeddedModules()) {
      const elements = expr.args.map((arg) => emitOwnedIslandValue(emitExpr(arg), context)).join(", ");
      return `${context.dynTypeName()}::Island(runtime::island_value_array(vec![${elements}]))`;
    }
    const elements = expr.args.map((arg) => `runtime::array_push(&${array}, ${emitExpr(arg)});`).join(" ");
    return `{ let ${array}: runtime::JsArray<${context.dynTypeName()}> = runtime::array_new(Vec::new()); ${elements} ${context.dynTypeName()}::Array(${array}) }`;
  }
  if (expr.op === "tplStrings" && expr.args.length % 2 === 0) {
    const middle = expr.args.length / 2;
    const cooked = expr.args.slice(0, middle).map((arg) => emitExpr(arg)).join(", ");
    const raw = expr.args.slice(middle).map((arg) => emitExpr(arg)).join(", ");
    return `${context.dynTypeName()}::Array(runtime::array_new_with_raw(vec![${cooked}], vec![${raw}]))`;
  }
  if (expr.op === "undefLit" && expr.args.length === 0) return `${context.dynTypeName()}::Undefined`;
  if (expr.op === "nullLit" && expr.args.length === 0) return `${context.dynTypeName()}::Null`;
  if (expr.op === "getProp" && expr.name !== undefined && expr.args.length === 1) {
    return `sc_dyn_key_get(&(${emitExpr(argOf(expr, 0, context))}), &runtime::string("${context.rustString(expr.name)}"), false)`;
  }
  if (expr.op === "getIdx" && expr.args.length === 2) {
    const receiver = context.nextName("sc_island_receiver");
    const key = context.nextName("sc_island_key");
    const keyExpr = argOf(expr, 1, context);
    if (keyExpr.kind !== "jsMarshal" || !["f64", "string", "bool"].includes(keyExpr.value.type.kind)) {
      context.unsupported("island computed key outside the native primitive subset", expr.loc);
    }
    return `{ let ${receiver} = ${emitExpr(argOf(expr, 0, context))}; let ${key} = ${emitExpr(keyExpr)}; sc_dyn_key_get(&${receiver}, &sc_dyn_to_string(&${key}), false) }`;
  }
  if (expr.op === "setProp" && expr.name !== undefined && expr.args.length === 2) {
    const receiver = context.nextName("sc_island_receiver");
    const value = context.nextName("sc_island_value");
    return `{ let ${receiver} = ${emitExpr(argOf(expr, 0, context))}; let ${value} = ${emitExpr(argOf(expr, 1, context))}; sc_dyn_key_set(&${receiver}, runtime::string("${context.rustString(expr.name)}"), ${value}); }`;
  }
  if (expr.op === "setIdx" && expr.args.length === 3) {
    const receiver = context.nextName("sc_island_receiver");
    const key = context.nextName("sc_island_key");
    const value = context.nextName("sc_island_value");
    return `{ let ${receiver} = ${emitExpr(argOf(expr, 0, context))}; let ${key} = ${emitExpr(argOf(expr, 1, context))}; let ${value} = ${emitExpr(argOf(expr, 2, context))}; sc_dyn_key_set(&${receiver}, sc_dyn_to_string(&${key}), ${value}); }`;
  }
  if (expr.op === "objSpread" && expr.args.length === 2) {
    const target = context.nextName("sc_island_target");
    const source = context.nextName("sc_island_source");
    const dyn = context.dynTypeName();
    return `{ let ${target} = ${emitExpr(argOf(expr, 0, context))}; let ${source} = ${emitExpr(argOf(expr, 1, context))}; if let ${dyn}::Object(sc_source) = &${source} { for (sc_key, sc_value) in runtime::map_string_entries_js_order(sc_source) { sc_dyn_key_set(&${target}, sc_key, sc_value); } } ${target} }`;
  }
  if (expr.op === "defineGetter" && expr.args.length === 3) {
    const target = context.nextName("sc_island_target");
    const key = context.nextName("sc_island_key");
    const getter = context.nextName("sc_island_getter");
    const dyn = context.dynTypeName();
    return `{ let ${target} = ${emitExpr(argOf(expr, 0, context))}; let ${key} = ${emitExpr(argOf(expr, 1, context))}; let ${getter} = ${emitExpr(argOf(expr, 2, context))}; sc_dyn_key_set(&${target}, sc_dyn_to_string(&${key}), ${dyn}::Getter(Box::new(${getter}))); ${target} }`;
  }
  const builtin = emitRustIslandBuiltin(expr, context, emitExpr);
  if (builtin !== null) return builtin;
  const destructuring = emitRustIslandDestructuringFunction(expr, context, emitExpr);
  if (destructuring !== null) return destructuring;
  if (expr.op === "callFn" && expr.args.length > 0) {
    const callee = context.nextName("sc_island_callee");
    const args = context.nextName("sc_island_args");
    const values = expr.args.slice(1).map((arg) => emitExpr(arg)).join(", ");
    if (!context.hasEmbeddedModules()) {
      return `{ let ${callee} = ${emitExpr(argOf(expr, 0, context))}; let ${args} = [${values}]; sc_dyn_call(&${callee}, &${args}, "value") }`;
    }
    const islandArgs = context.nextName("sc_island_call_args");
    const islandCall = `{ let ${islandArgs} = ${emitIslandArguments(args, context)}; ` +
      `${context.dynTypeName()}::Island(runtime::island_call(&sc_value, &${islandArgs})) }`;
    return `{ let ${callee} = ${emitExpr(argOf(expr, 0, context))}; let ${args} = [${values}]; match ${callee} { ${context.dynTypeName()}::Island(sc_value) => ${islandCall}, sc_value => sc_dyn_call(&sc_value, &${args}, "value"), } }`;
  }
  if (expr.op === "callSpread" && expr.name !== undefined && expr.args.length === 3) {
    const callee = context.nextName("sc_island_callee");
    const leading = context.nextName("sc_island_leading");
    const spread = context.nextName("sc_island_spread");
    const pack = context.nextName("sc_island_pack");
    const args = context.nextName("sc_island_args");
    const dyn = context.dynTypeName();
    const collect = `let ${pack} = ${dyn}::Array(runtime::array_new(Vec::new())); ` +
      `sc_dyn_pack_push_spread(&${pack}, &${leading}, &runtime::empty_string(), true); ` +
      `sc_dyn_pack_push_spread(&${pack}, &${spread}, &runtime::string("${context.rustString(expr.name)}"), false); ` +
      `let ${dyn}::Array(${args}) = ${pack} else { unreachable!("scriptc invariant: spread call pack is not an array") }; ` +
      `let ${args} = runtime::array_values(&${args});`;
    if (!context.hasEmbeddedModules()) {
      return `{ let ${callee} = ${emitExpr(argOf(expr, 0, context))}; ` +
        `let ${leading} = ${emitExpr(argOf(expr, 1, context))}; ` +
        `let ${spread} = ${emitExpr(argOf(expr, 2, context))}; ${collect} ` +
        `sc_dyn_call(&${callee}, &${args}, "value") }`;
    }
    const islandArgs = context.nextName("sc_island_call_args");
    const islandCall = `{ let ${islandArgs} = ${emitIslandArguments(args, context)}; ` +
      `${dyn}::Island(runtime::island_call(&sc_value, &${islandArgs})) }`;
    return `{ let ${callee} = ${emitExpr(argOf(expr, 0, context))}; ` +
      `let ${leading} = ${emitExpr(argOf(expr, 1, context))}; ` +
      `let ${spread} = ${emitExpr(argOf(expr, 2, context))}; ${collect} ` +
      `match ${callee} { ${dyn}::Island(sc_value) => ${islandCall}, ` +
      `sc_value => sc_dyn_call(&sc_value, &${args}, "value"), } }`;
  }
  if ((expr.op === "truthy" || expr.op === "not") && expr.args.length === 1) {
    const truthy = `sc_dyn_is_truthy(&(${emitExpr(argOf(expr, 0, context))}))`;
    return expr.op === "not" ? `!(${truthy})` : truthy;
  }
  if (expr.op === "add" && expr.args.length === 2) {
    const left = context.nextName("sc_island_left");
    const right = context.nextName("sc_island_right");
    const dyn = context.dynTypeName();
    const numeric = (value: string): string =>
      `matches!(&${value}, ${dyn}::Undefined | ${dyn}::Null | ${dyn}::Number(..) | ${dyn}::Boolean(..))`;
    return `{ let ${left} = ${emitExpr(argOf(expr, 0, context))}; let ${right} = ${emitExpr(argOf(expr, 1, context))}; if ${numeric(left)} && ${numeric(right)} { ${dyn}::Number(sc_dyn_to_number(&${left}) + sc_dyn_to_number(&${right})) } else { ${dyn}::String(runtime::string_concat(&sc_dyn_to_string(&${left}), &sc_dyn_to_string(&${right}))) } }`;
  }
  if ((expr.op === "eq" || expr.op === "neq") && expr.args.length === 2) {
    const left = context.nextName("sc_island_left");
    const right = context.nextName("sc_island_right");
    const equal = `sc_dyn_strict_equal(&${left}, &${right})`;
    return `{ let ${left} = ${emitExpr(argOf(expr, 0, context))}; let ${right} = ${emitExpr(argOf(expr, 1, context))}; ${expr.op === "neq" ? `!(${equal})` : equal} }`;
  }
  if ((expr.op === "sub" || expr.op === "mul" || expr.op === "div" || expr.op === "mod" || expr.op === "pow") && expr.args.length === 2) {
    const left = context.nextName("sc_island_left");
    const right = context.nextName("sc_island_right");
    const operation = expr.op === "pow"
      ? `runtime::math_pow(sc_dyn_to_number(&${left}), sc_dyn_to_number(&${right}))`
      : `sc_dyn_to_number(&${left}) ${numericOperator(expr.op)} sc_dyn_to_number(&${right})`;
    return `{ let ${left} = ${emitExpr(argOf(expr, 0, context))}; let ${right} = ${emitExpr(argOf(expr, 1, context))}; ${context.dynTypeName()}::Number(${operation}) }`;
  }
  if ((expr.op === "lt" || expr.op === "le" || expr.op === "gt" || expr.op === "ge") && expr.args.length === 2) {
    const left = context.nextName("sc_island_left");
    const right = context.nextName("sc_island_right");
    const order = context.nextName("sc_island_order");
    const dyn = context.dynTypeName();
    const numericOrder = `{ let sc_left = sc_dyn_to_number(&${left}); let sc_right = sc_dyn_to_number(&${right}); if sc_left.is_nan() || sc_right.is_nan() { None } else { Some(if sc_left < sc_right { -1 } else if sc_left > sc_right { 1 } else { 0 }) } }`;
    const compare = relationalOperator(expr.op);
    return `{ let ${left} = ${emitExpr(argOf(expr, 0, context))}; let ${right} = ${emitExpr(argOf(expr, 1, context))}; let ${order} = match (&${left}, &${right}) { (${dyn}::String(sc_left), ${dyn}::String(sc_right)) => Some(runtime::string_compare_utf16(sc_left, sc_right)), _ => ${numericOrder}, }; ${order}.is_some_and(|sc_order| sc_order ${compare} 0) }`;
  }
  if ((expr.op === "neg" || expr.op === "plus") && expr.args.length === 1) {
    const value = context.nextName("sc_island_value");
    const number = `sc_dyn_to_number(&${value})`;
    return `{ let ${value} = ${emitExpr(argOf(expr, 0, context))}; ${context.dynTypeName()}::Number(${expr.op === "neg" ? `-(${number})` : number}) }`;
  }
  if (expr.op === "toStr" && expr.args.length === 1) {
    return `sc_dyn_to_string(&(${emitExpr(argOf(expr, 0, context))}))`;
  }
  if (expr.op === "typeof" && expr.args.length === 1) {
    const value = context.nextName("sc_island_typeof");
    const dyn = context.dynTypeName();
    return `{ let ${value} = ${emitExpr(argOf(expr, 0, context))}; runtime::string(match &${value} { ${dyn}::Undefined => "undefined", ${dyn}::Boolean(..) => "boolean", ${dyn}::Number(..) => "number", ${dyn}::String(..) => "string", value if sc_dyn_kind(value) == "function" => "function", _ => "object" }) }`;
  }
  if (expr.op === "callMethod" && expr.name !== undefined && expr.args.length > 0) {
    const receiver = context.nextName("sc_island_receiver");
    const args = context.nextName("sc_island_args");
    const receiverExpr = expr.args[0];
    if (receiverExpr === undefined) context.unsupported("island method without a receiver", expr.loc);
    const values = expr.args.slice(1).map((arg) => emitExpr(arg)).join(", ");
    if (context.hasEmbeddedModules()) {
      const islandArgs = context.nextName("sc_island_method_args");
      const name = context.rustString(expr.name);
      return `{ let ${receiver} = ${emitExpr(receiverExpr)}; let ${args} = [${values}]; match &${receiver} { ` +
        `${context.dynTypeName()}::Island(sc_value) => { let ${islandArgs} = ${emitIslandArguments(args, context)}; ` +
        `${context.dynTypeName()}::Island(runtime::island_call_method(sc_value, "${name}", &${islandArgs})) }, ` +
        `sc_value => sc_dyn_invoke(sc_value, "${name}", &${args}, "${name}"), } }`;
    }
    return `{ let ${receiver} = ${emitExpr(receiverExpr)}; let ${args} = [${values}]; sc_dyn_invoke(&${receiver}, "${context.rustString(expr.name)}", &${args}, "${context.rustString(expr.name)}") }`;
  }
  context.unsupported(`island operation '${expr.op}'`, expr.loc);
}

function numericOperator(op: "sub" | "mul" | "div" | "mod"): string {
  return { sub: "-", mul: "*", div: "/", mod: "%" }[op];
}

function relationalOperator(op: "lt" | "le" | "gt" | "ge"): string {
  return { lt: "<", le: "<=", gt: ">", ge: ">=" }[op];
}

/** Convert JSON-safe arguments into Boa-owned values.
 * Embedded exports and methods share this bridge so argument evaluation
 * remains left-to-right in the generated dyn array before any call. */
function emitIslandArguments(args: string, context: RustIslandContext): string {
  return `${args}.iter().map(|sc_arg| ${emitIslandValue("sc_arg", context)}).collect::<Vec<_>>()`;
}

function emitIslandValue(value: string, context: RustIslandContext): string {
  const dyn = context.dynTypeName();
  return `match ${value} { ` +
    `${dyn}::Undefined => runtime::island_value_undefined(), ` +
    `${dyn}::Null => runtime::island_value_null(), ` +
    `${dyn}::Number(sc_value) => runtime::island_value_number(*sc_value), ` +
    `${dyn}::Boolean(sc_value) => runtime::island_value_boolean(*sc_value), ` +
    `${dyn}::String(sc_value) => runtime::island_value_string(sc_value), ` +
    `${dyn}::Array(..) | ${dyn}::Object(..) => runtime::island_value_json(&runtime::json_stringify(${value})), ` +
    `${dyn}::Island(sc_value) => sc_value.clone(), ` +
    `_ => runtime::throw_error_code("embedded module call argument is outside the JSON-safe island subset".to_owned(), "SC3001"), ` +
    `}`;
}

function emitOwnedIslandValue(value: string, context: RustIslandContext): string {
  const temporary = context.nextName("sc_island_value");
  return `{ let ${temporary} = ${value}; ${emitIslandValue(`&${temporary}`, context)} }`;
}

function emitObjectLiteral(
  expr: Extract<IrExpr, { kind: "jsOp" }>,
  context: RustIslandContext,
  emitExpr: (expr: IrExpr) => string,
): string {
  if (expr.args.length % 2 !== 0) context.unsupported("island object literal arity", expr.loc);
  const object = context.nextName("sc_island_object");
  if (context.hasEmbeddedModules()) {
    const fields: string[] = [];
    for (let index = 0; index < expr.args.length; index += 2) {
      const key = expr.args[index];
      const value = expr.args[index + 1];
      if (
        key?.kind !== "jsMarshal" || key.value.kind !== "strLit" ||
        key.value.type.kind !== "string" || value === undefined
      ) {
        context.unsupported("island object literal key", expr.loc);
      }
      fields.push(
        `(runtime::string("${context.rustString(key.value.value)}"), ${emitOwnedIslandValue(emitExpr(value), context)})`,
      );
    }
    return `${context.dynTypeName()}::Island(runtime::island_value_object(vec![${fields.join(", ")}]))`;
  }
  const fields: string[] = [];
  for (let index = 0; index < expr.args.length; index += 2) {
    const key = expr.args[index];
    const value = expr.args[index + 1];
    if (key?.kind !== "jsMarshal" || key.value.type.kind !== "string" || value === undefined) {
      context.unsupported("island object literal key", expr.loc);
    }
    const emittedKey = context.nextName("sc_island_key");
    fields.push(
      `let ${emittedKey} = ${emitExpr(key)}; ` +
      `let ${context.dynTypeName()}::String(${emittedKey}) = ${emittedKey} else { unreachable!("scriptc invariant: marshaled object key is not a string") }; ` +
      `runtime::map_set_by(&${object}, ${emittedKey}, ${emitExpr(value)}, |left, right| left.as_ref() == right.as_ref());`,
    );
  }
  return `{ let ${object}: runtime::JsMap<runtime::JsString, ${context.dynTypeName()}> = runtime::map_new(); ${fields.join(" ")} ${context.dynTypeName()}::Object(${object}) }`;
}

function emitPromiseBridge(
  expr: Extract<IrExpr, { kind: "jsBridgePromise" }>,
  context: RustIslandContext,
  emitExpr: (expr: IrExpr) => string,
): string {
  const then = expr.value;
  const resolved = then.kind === "jsOp" && then.op === "callMethod" && then.name === "then"
    ? then.args[0]
    : undefined;
  const marshaled = then.kind === "jsOp" && then.op === "callMethod" && then.name === "then"
    ? then.args[1]
    : undefined;
  const promiseGlobal = resolved?.kind === "jsOp" && resolved.op === "callMethod" && resolved.name === "resolve"
    ? resolved.args[0]
    : undefined;
  const callback = marshaled?.kind === "jsMarshal" && marshaled.value.kind === "closure"
    ? marshaled.value
    : undefined;
  if (
    expr.type.kind !== "promise" || expr.type.inner.kind !== "jsval" ||
    then.kind !== "jsOp" || then.args.length !== 2 ||
    resolved?.kind !== "jsOp" || resolved.args.length !== 1 ||
    promiseGlobal?.kind !== "jsOp" || promiseGlobal.op !== "globalGet" || promiseGlobal.name !== "Promise" ||
    callback?.type.kind !== "func" || callback.type.params.length !== 0
  ) {
    return emitGenericPromiseBridge(expr, context, emitExpr);
  }
  const closure = context.nextName("sc_import_builder");
  const source = context.nextName("sc_import_source");
  const dispatch = context.emitClosureDispatch(closure, callback.type, [], expr.loc);
  const combinator = callback.type.ret.kind === "jsval"
    ? "promise_map"
    : callback.type.ret.kind === "promise" && callback.type.ret.inner.kind === "jsval"
      ? "promise_flat_map"
      : context.unsupported("compiled program import builder result", expr.loc);
  return `{ let ${closure} = ${emitExpr(callback)}; let ${source} = runtime::promise_resolved(()); runtime::${combinator}(&${source}, move |_| ${dispatch}) }`;
}

function emitGenericPromiseBridge(
  expr: Extract<IrExpr, { kind: "jsBridgePromise" }>,
  context: RustIslandContext,
  emitExpr: (expr: IrExpr) => string,
): string {
  if (expr.type.kind !== "promise") context.unsupported("island promise bridge result", expr.loc);
  const dyn = context.dynTypeName();
  const value = context.nextName("sc_island_promise_value");
  const source = context.nextName("sc_island_promise_source");
  const adopt = `match ${value} { ${dyn}::Promise(sc_handle) => runtime::promise_from_handle::<${dyn}>(&sc_handle), ${dyn}::Island(sc_handle) => runtime::promise_resolved(${dyn}::Island(runtime::island_await(&sc_handle))), sc_value => runtime::promise_resolved(sc_value), }`;
  if (expr.type.inner.kind === "jsval") {
    return `{ let ${value} = ${emitExpr(expr.value)}; let ${source} = ${adopt}; ${source} }`;
  }
  if (expr.type.inner.kind === "void") {
    return `{ let ${value} = ${emitExpr(expr.value)}; let ${source} = ${adopt}; runtime::promise_map(&${source}, |_| ()) }`;
  }
  if (expr.type.inner.kind === "array" && expr.type.inner.elem.kind === "jsval") {
    return `{ let ${value} = ${emitExpr(expr.value)}; let ${source} = ${adopt}; runtime::promise_map(&${source}, |sc_value| match sc_value { ${dyn}::Array(sc_array) => sc_array, sc_value => sc_dyn_check_fail("array", &sc_value), }) }`;
  }
  context.unsupported("island promise bridge payload", expr.loc);
}

function argOf(
  expr: Extract<IrExpr, { kind: "jsOp" }>,
  index: number,
  context: RustIslandContext,
): IrExpr {
  const arg = expr.args[index];
  if (arg === undefined) context.unsupported(`island operation '${expr.op}' argument ${index}`, expr.loc);
  return arg;
}
