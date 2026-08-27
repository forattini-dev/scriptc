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
  rustString(value: string): string;
  unsupported(kind: string, loc?: SrcLoc): never;
}

/** Emit the backend-neutral island subset used by compiled program imports.
 *
 * Rust intentionally has no embedded JavaScript engine. Own-module imports
 * nevertheless need only a native promise microtask, a compiled namespace
 * builder, and the existing checked-dynamic value model. Every other island
 * operation keeps its explicit SC3001 refusal instead of approximating JS.
 */
export function emitRustIslandExpr(
  expr: IslandExpr,
  context: RustIslandContext,
  emitExpr: (expr: IrExpr) => string,
): string {
  switch (expr.kind) {
    case "jsMarshal": return emitMarshal(expr, context, emitExpr);
    case "jsExit": return context.emitDynCheckValue(expr.type, emitExpr(expr.value), expr.loc);
    case "jsOp": return emitOperation(expr, context, emitExpr);
    case "jsBridgePromise": return emitProgramImportBridge(expr, context, emitExpr);
  }
}

function emitMarshal(
  expr: Extract<IrExpr, { kind: "jsMarshal" }>,
  context: RustIslandContext,
  emitExpr: (expr: IrExpr) => string,
): string {
  switch (expr.value.type.kind) {
    case "f64":
    case "bool":
    case "string":
    case "func":
    case "array":
    case "bytes":
    case "record":
    case "union":
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
    const elements = expr.args.map((arg) => `runtime::array_push(&${array}, ${emitExpr(arg)});`).join(" ");
    return `{ let ${array}: runtime::JsArray<${context.dynTypeName()}> = runtime::array_new(Vec::new()); ${elements} ${context.dynTypeName()}::Array(${array}) }`;
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
  const builtin = emitRustIslandBuiltin(expr, context, emitExpr);
  if (builtin !== null) return builtin;
  const destructuring = emitRustIslandDestructuringFunction(expr, context, emitExpr);
  if (destructuring !== null) return destructuring;
  if (expr.op === "callFn" && expr.args.length > 0) {
    const callee = context.nextName("sc_island_callee");
    const args = context.nextName("sc_island_args");
    const values = expr.args.slice(1).map((arg) => emitExpr(arg)).join(", ");
    return `{ let ${callee} = ${emitExpr(argOf(expr, 0, context))}; let ${args} = [${values}]; sc_dyn_call(&${callee}, &${args}, "value") }`;
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
    return `{ let ${receiver} = ${emitExpr(receiverExpr)}; let ${args} = [${values}]; sc_dyn_invoke(&${receiver}, "${context.rustString(expr.name)}", &${args}, "${context.rustString(expr.name)}") }`;
  }
  context.unsupported(`island operation '${expr.op}'`, expr.loc);
}

function numericOperator(op: "sub" | "mul" | "div" | "mod"): string {
  return { sub: "-", mul: "*", div: "/", mod: "%" }[op];
}

function emitObjectLiteral(
  expr: Extract<IrExpr, { kind: "jsOp" }>,
  context: RustIslandContext,
  emitExpr: (expr: IrExpr) => string,
): string {
  if (expr.args.length % 2 !== 0) context.unsupported("island object literal arity", expr.loc);
  const object = context.nextName("sc_island_object");
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

function emitProgramImportBridge(
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
    context.unsupported("island promise bridge outside a compiled program import", expr.loc);
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

function argOf(
  expr: Extract<IrExpr, { kind: "jsOp" }>,
  index: number,
  context: RustIslandContext,
): IrExpr {
  const arg = expr.args[index];
  if (arg === undefined) context.unsupported(`island operation '${expr.op}' argument ${index}`, expr.loc);
  return arg;
}
