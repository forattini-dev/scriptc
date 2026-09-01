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
      if (expr.type.kind === "bytes" && expr.type.elem === "u8") {
        const checked = context.emitDynCheckValue(expr.type, "sc_value", expr.loc);
        return `{ let ${value} = ${emitExpr(expr.value)}; match ${value} { ` +
          `${dyn}::Island(sc_value) => runtime::island_exit_bytes(&sc_value), sc_value => ${checked}, } }`;
      }
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
  const host = emitHostFunction(expr, context, emitExpr);
  if (host !== null) return host;
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

/** Extract one engine argument as a closure parameter's static type.
 *
 * Strict by kind, like the C island's typed adapters: the engine's value
 * is checked at the boundary, never coerced. */
function hostArgument(type: IrType, args: string, index: number): string | null {
  const extract = (helper: string): string => `runtime::${helper}(${args}, ${index})`;
  switch (type.kind) {
    case "string": return extract("island_host_argument_string");
    case "f64": return extract("island_host_argument_number");
    case "bool": return extract("island_host_argument_bool");
    case "bytes": return type.elem === "u8" ? extract("island_host_argument_bytes") : null;
    default: return null;
  }
}

/** Marshal a closure's return back into the realm.
 *
 * `record` rides the JSON path — the type-directed serializer, then the
 * realm's own parser: the deep copy the rest of this boundary already
 * performs for composites. */
function hostResult(type: IrType, value: string): string | null {
  const result = (variant: string, payload: string): string =>
    `runtime::IslandHostResult::${variant}(${payload})`;
  switch (type.kind) {
    case "void": return `{ ${value}; runtime::IslandHostResult::Undefined }`;
    case "string": return result("String", value);
    case "f64": return result("Number", value);
    case "bool": return result("Bool", value);
    case "bytes":
      return type.elem === "u8"
        ? result("Bytes", `runtime::island_bytes_values(&(${value}))`)
        : null;
    case "record": return result("Json", `runtime::json_stringify(&(${value}))`);
    default: return null;
  }
}

/** A scriptc closure crossing into the realm as a callable.
 *
 * Returns null when the signature is outside the marshaled subset, so the
 * caller falls through to the generic checked-dynamic paths. */
function emitHostFunction(
  expr: Extract<IrExpr, { kind: "jsMarshal" }>,
  context: RustIslandContext,
  emitExpr: (expr: IrExpr) => string,
): string | null {
  const type = expr.value.type;
  if (type.kind !== "func" || !context.hasEmbeddedModules() || type.rest === true) return null;
  const closure = context.nextName("sc_island_host_closure");
  const argumentsName = context.nextName("sc_island_host_arguments");
  const args: string[] = [];
  for (const [index, param] of type.params.entries()) {
    const argument = hostArgument(param, argumentsName, index);
    if (argument === null) return null;
    args.push(argument);
  }
  const dispatch = context.emitClosureDispatch(closure, type, args, expr.loc);
  const result = hostResult(type.ret, dispatch);
  if (result === null) return null;
  return `{ let ${closure} = ${emitExpr(expr.value)}; ` +
    `${context.dynTypeName()}::Island(runtime::island_value_host_function(${args.length}, ` +
    `std::rc::Rc::new(move |${argumentsName}| ${result}))) }`;
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
  if (expr.op === "globalGet" && expr.name !== undefined && expr.args.length === 0 && context.hasEmbeddedModules()) {
    return `${context.dynTypeName()}::Island(runtime::island_global_get("${context.rustString(expr.name)}"))`;
  }
  if (expr.op === "getProp" && expr.name !== undefined && expr.args.length === 1) {
    const receiver = context.nextName("sc_island_receiver");
    const dyn = context.dynTypeName();
    const name = context.rustString(expr.name);
    if (!context.hasEmbeddedModules()) {
      return `{ let ${receiver} = ${emitExpr(argOf(expr, 0, context))}; ` +
        `sc_dyn_key_get(&${receiver}, &runtime::string("${name}"), false) }`;
    }
    return `{ let ${receiver} = ${emitExpr(argOf(expr, 0, context))}; match &${receiver} { ` +
      `${dyn}::Island(sc_value) => ${dyn}::Island(runtime::island_get_property(sc_value, "${name}")), ` +
      `sc_value => sc_dyn_key_get(sc_value, &runtime::string("${name}"), false), } }`;
  }
  if (expr.op === "getIdx" && expr.args.length === 2) {
    const receiver = context.nextName("sc_island_receiver");
    const key = context.nextName("sc_island_key");
    const keyExpr = argOf(expr, 1, context);
    if (context.hasEmbeddedModules()) {
      const dyn = context.dynTypeName();
      return `{ let ${receiver} = ${emitExpr(argOf(expr, 0, context))}; ` +
        `let ${key} = ${emitExpr(keyExpr)}; match (&${receiver}, &${key}) { ` +
        `(${dyn}::Island(sc_receiver), ${dyn}::Island(sc_key)) => ` +
        `${dyn}::Island(runtime::island_get_index(sc_receiver, sc_key)), ` +
        `_ => sc_dyn_key_get(&${receiver}, &sc_dyn_to_string(&${key}), false), } }`;
    }
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
  if (expr.op === "iterNew" && expr.args.length === 1 && context.hasEmbeddedModules()) {
    const value = context.nextName("sc_island_iterable");
    const dyn = context.dynTypeName();
    return `{ let ${value} = ${emitExpr(argOf(expr, 0, context))}; match &${value} { ` +
      `${dyn}::Island(sc_value) => ${dyn}::Island(runtime::island_iter_new(sc_value)), ` +
      `_ => runtime::throw_type_error("value is not iterable".to_owned()), } }`;
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
  if (expr.op === "callFnThis" && expr.args.length > 1) {
    const callee = context.nextName("sc_island_callee");
    const receiver = context.nextName("sc_island_receiver");
    const args = context.nextName("sc_island_args");
    const values = expr.args.slice(2).map((arg) => emitExpr(arg)).join(", ");
    const bind = `let ${callee} = ${emitExpr(argOf(expr, 0, context))}; ` +
      `let ${receiver} = ${emitExpr(argOf(expr, 1, context))}; let ${args} = [${values}];`;
    if (!context.hasEmbeddedModules()) {
      return `{ ${bind} let _ = &${receiver}; sc_dyn_call(&${callee}, &${args}, "value") }`;
    }
    const dyn = context.dynTypeName();
    const islandArgs = context.nextName("sc_island_call_args");
    return `{ ${bind} match (&${callee}, &${receiver}) { ` +
      `(${dyn}::Island(sc_callee), ${dyn}::Island(sc_receiver)) => { ` +
      `let ${islandArgs} = ${emitIslandArguments(args, context)}; ` +
      `${dyn}::Island(runtime::island_call_this(sc_callee, sc_receiver, &${islandArgs})) }, ` +
      `_ => sc_dyn_call(&${callee}, &${args}, "value"), } }`;
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
    const emitted = emitExpr(argOf(expr, 0, context));
    const truthy = context.hasEmbeddedModules()
      ? `{ let sc_value = ${emitted}; match &sc_value { ` +
        `${context.dynTypeName()}::Island(sc_island) => runtime::island_truthy(sc_island), ` +
        `_ => sc_dyn_is_truthy(&sc_value), } }`
      : `sc_dyn_is_truthy(&(${emitted}))`;
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
    const dyn = context.dynTypeName();
    const equal = context.hasEmbeddedModules()
      ? `match (&${left}, &${right}) { ` +
        `(${dyn}::Island(sc_value), ${dyn}::Undefined) | (${dyn}::Undefined, ${dyn}::Island(sc_value)) => runtime::island_is_undefined(sc_value), ` +
        `(${dyn}::Island(sc_value), ${dyn}::Null) | (${dyn}::Null, ${dyn}::Island(sc_value)) => runtime::island_is_null(sc_value), ` +
        `_ => sc_dyn_strict_equal(&${left}, &${right}), }`
      : `sc_dyn_strict_equal(&${left}, &${right})`;
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
  if (expr.op === "optCallMethod" && expr.name !== undefined && expr.args.length > 0) {
    return emitOptionalMethodCall(expr, context, emitExpr);
  }
  if (expr.op === "construct" && expr.args.length > 0) {
    return emitConstruct(expr, context, emitExpr);
  }
  if (expr.op === "instanceOf" && expr.args.length === 2) {
    return emitInstanceOf(expr, context, emitExpr);
  }
  context.unsupported(`island operation '${expr.op}'`, expr.loc);
}

/** `o.name?.(...)` — the optional METHOD call.
 *
 * A nullish member answers undefined without calling; anything else calls
 * with `this = o`, so a non-callable member still throws. The realm's
 * receivers read the member exactly once (island_opt_call_method owns the
 * whole operation); a NATIVE receiver reads it twice — once for the
 * nullish guard, once inside sc_dyn_invoke — which is observable only
 * through a dyn accessor property, and never on the island receivers this
 * operation is lowered for.
 *
 * Because that arm calls sc_dyn_invoke, this op MUST stay listed in the
 * emitter's usesDynamicInvoke scan; otherwise the helper is never emitted
 * and the generated program does not compile. */
function emitOptionalMethodCall(
  expr: Extract<IrExpr, { kind: "jsOp" }>,
  context: RustIslandContext,
  emitExpr: (expr: IrExpr) => string,
): string {
  const receiverExpr = argOf(expr, 0, context);
  const name = context.rustString(expr.name ?? "");
  const dyn = context.dynTypeName();
  const receiver = context.nextName("sc_island_receiver");
  const args = context.nextName("sc_island_args");
  const member = context.nextName("sc_island_member");
  const values = expr.args.slice(1).map((arg) => emitExpr(arg)).join(", ");
  const bind = `let ${receiver} = ${emitExpr(receiverExpr)}; let ${args} = [${values}];`;
  const native = `{ let ${member} = sc_dyn_key_get(&${receiver}, &runtime::string("${name}"), false); ` +
    `if matches!(&${member}, ${dyn}::Undefined | ${dyn}::Null) { ${dyn}::Undefined } ` +
    `else { sc_dyn_invoke(&${receiver}, "${name}", &${args}, "${name}") } }`;
  if (!context.hasEmbeddedModules()) return `{ ${bind} ${native} }`;
  const islandArgs = context.nextName("sc_island_method_args");
  return `{ ${bind} match &${receiver} { ` +
    `${dyn}::Island(sc_value) => { let ${islandArgs} = ${emitIslandArguments(args, context)}; ` +
    `${dyn}::Island(runtime::island_opt_call_method(sc_value, "${name}", &${islandArgs})) }, ` +
    `_ => ${native}, } }`;
}

/** `new X(...)` on a jsval callee.
 *
 * Only the realm has constructors; a native dyn callee reaching here is
 * exactly JavaScript's "not a constructor", so it takes that TypeError at
 * RUNTIME rather than an SC3001 at build time — the argument expressions
 * still evaluate first, left to right, like every other call form. */
function emitConstruct(
  expr: Extract<IrExpr, { kind: "jsOp" }>,
  context: RustIslandContext,
  emitExpr: (expr: IrExpr) => string,
): string {
  const dyn = context.dynTypeName();
  const callee = context.nextName("sc_island_callee");
  const args = context.nextName("sc_island_args");
  const values = expr.args.slice(1).map((arg) => emitExpr(arg)).join(", ");
  const bind = `let ${callee} = ${emitExpr(argOf(expr, 0, context))}; let ${args} = [${values}];`;
  const refuse = (value: string): string =>
    `runtime::throw_type_error(format!("{} is not a constructor", sc_dyn_kind(&${value})))`;
  if (!context.hasEmbeddedModules()) return `{ ${bind} let _ = &${args}; ${refuse(callee)} }`;
  const islandArgs = context.nextName("sc_island_call_args");
  return `{ ${bind} match &${callee} { ` +
    `${dyn}::Island(sc_value) => { let ${islandArgs} = ${emitIslandArguments(args, context)}; ` +
    `${dyn}::Island(runtime::island_construct(sc_value, &${islandArgs})) }, ` +
    `sc_value => ${refuse("sc_value")}, } }`;
}

/** `v instanceof C` — the spec's InstanceofOperator in the realm.
 *
 * Both operands cross INTO the realm first, so a native dyn left-hand
 * side answers false (a fresh realm object is not an instance of an
 * embedded class) instead of forcing a second, divergent implementation;
 * a non-object right-hand side throws the engine's own TypeError. Without
 * an embedded realm there is nothing to ask, so the refusal stands. */
function emitInstanceOf(
  expr: Extract<IrExpr, { kind: "jsOp" }>,
  context: RustIslandContext,
  emitExpr: (expr: IrExpr) => string,
): string {
  if (!context.hasEmbeddedModules()) {
    context.unsupported("island 'instanceof' without an embedded module realm", expr.loc);
  }
  const left = context.nextName("sc_island_left");
  const right = context.nextName("sc_island_right");
  const target = context.nextName("sc_island_target");
  const value = context.nextName("sc_island_value");
  return `{ let ${left} = ${emitExpr(argOf(expr, 0, context))}; ` +
    `let ${right} = ${emitExpr(argOf(expr, 1, context))}; ` +
    `let ${value} = ${emitIslandValue(`&${left}`, context)}; ` +
    `let ${target} = ${emitIslandValue(`&${right}`, context)}; ` +
    `runtime::island_instance_of(&${value}, &${target}) }`;
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
    `${dyn}::Bytes(sc_value) | ${dyn}::Buffer(sc_value) => runtime::island_value_bytes(sc_value), ` +
    `${dyn}::Array(..) | ${dyn}::Object(..) => runtime::island_value_json(&runtime::json_stringify(${value})), ` +
    // A native RegExp crosses as its own source+flags, rebuilt by the
    // realm's RegExp constructor (the `z.string().regex(/^a+$/)` shape).
    // A fresh engine object per marshal: identity and lastIndex stay
    // host-side, exactly as SEMANTICS.md states for the C island.
    `${dyn}::Regex(sc_value) => runtime::island_value_regexp(` +
    `&runtime::regex_source(sc_value), &runtime::regex_flags(sc_value)), ` +
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
  const island = context.hasEmbeddedModules()
    ? `${dyn}::Island(sc_handle) => runtime::promise_resolved(${dyn}::Island(runtime::island_await(&sc_handle))), `
    : "";
  const adopt = `match ${value} { ${dyn}::Promise(sc_handle) => runtime::promise_from_handle::<${dyn}>(&sc_handle), ${island}sc_value => runtime::promise_resolved(sc_value), }`;
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
