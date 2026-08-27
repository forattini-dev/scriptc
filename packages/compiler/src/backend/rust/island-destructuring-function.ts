import type { IrExpr } from "../../ir/nodes.js";
import type { RustIslandContext } from "./island.js";

type JsOperation = Extract<IrExpr, { kind: "jsOp" }>;

/**
 * Recognize the compiler-generated Function used for simple island
 * destructuring. Rust executes the captured pattern directly over its native
 * dynamic tree; arbitrary user-created Function constructors remain fenced.
 */
export function emitRustIslandDestructuringFunction(
  expr: JsOperation,
  context: RustIslandContext,
  emitExpr: (expr: IrExpr) => string,
): string | null {
  if (expr.op !== "callFn" || expr.args.length < 2) return null;
  const [callee] = expr.args;
  if (callee?.kind !== "jsOp" || callee.op !== "construct" ||
      callee.args.length < 3 || !isFunctionGlobal(callee.args[0])) return null;
  const constructorArgs = callee.args.slice(1);
  const parameters = constructorArgs.slice(0, -1).map(compilerString);
  const body = compilerString(constructorArgs.at(-1));
  if (parameters.some((parameter) => parameter === null) || parameters[0] !== "v" || body === null ||
      expr.args.length !== parameters.length + 1) return null;
  const argumentsByName = new Map<string, IrExpr>();
  for (const [index, parameter] of parameters.entries()) {
    const argument = expr.args[index + 1];
    if (parameter === null || argument === undefined) return null;
    argumentsByName.set(parameter, argument);
  }
  const sourceExpr = argumentsByName.get("v");
  if (sourceExpr === undefined) return null;

  const nestedDefault = emitNestedDefaultPattern(body, sourceExpr, argumentsByName, context, emitExpr);
  if (nestedDefault !== null) return nestedDefault;
  if (parameters.length !== 1) return null;

  const array = parseArrayPattern(body);
  if (array !== null) {
    return `sc_dyn_iter_n(&(${emitExpr(sourceExpr)}), ${array.length})`;
  }
  const object = parseObjectPattern(body);
  if (object === null) return null;
  const source = context.nextName("sc_island_source");
  const output = context.nextName("sc_island_output");
  const dyn = context.dynTypeName();
  const pushes = object.map((key) =>
    `runtime::array_push(&${output}, sc_dyn_key_get(&${source}, &runtime::string("${context.rustString(key)}"), false));`
  ).join(" ");
  return `{ let ${source} = ${emitExpr(sourceExpr)}; match &${source} { ${dyn}::Undefined => runtime::throw_type_error("Cannot destructure 'v' as it is undefined.".to_owned()), ${dyn}::Null => runtime::throw_type_error("Cannot destructure 'v' as it is null.".to_owned()), _ => {}, } let ${output}: runtime::JsArray<${dyn}> = runtime::array_new(Vec::new()); ${pushes} ${dyn}::Array(${output}) }`;
}

function emitNestedDefaultPattern(
  body: string,
  sourceExpr: IrExpr,
  argumentsByName: ReadonlyMap<string, IrExpr>,
  context: RustIslandContext,
  emitExpr: (expr: IrExpr) => string,
): string | null {
  const empty = /^"use strict";\(\{\[("(?:\\.|[^"\\])*")\]:\{\}=(__d\d+)\} = v\);return \[\];$/u.exec(body);
  const value = /^"use strict";var (__\d+);\(\{\[("(?:\\.|[^"\\])*")\]:\{\[("(?:\\.|[^"\\])*")\]:(__\d+)\}=(__d\d+)\} = v\);return \[(__\d+)\];$/u.exec(body);
  if (empty === null && value === null) return null;
  const outerKey = parseString(empty?.[1] ?? value?.[2]);
  const defaultName = empty?.[2] ?? value?.[5];
  const defaultExpr = defaultName === undefined ? undefined : argumentsByName.get(defaultName);
  if (outerKey === null || defaultExpr === undefined) return null;
  if (value !== null && !(value[1] === value[4] && value[4] === value[6])) return null;
  const innerKey = value === null ? null : parseString(value[3]);
  if (value !== null && innerKey === null) return null;

  const dyn = context.dynTypeName();
  const source = context.nextName("sc_island_source");
  const fallback = context.nextName("sc_island_default");
  const nested = context.nextName("sc_island_nested");
  const output = context.nextName("sc_island_output");
  const requireObject = (name: string) =>
    `match &${name} { ${dyn}::Undefined => runtime::throw_type_error("Cannot destructure an undefined value".to_owned()), ${dyn}::Null => runtime::throw_type_error("Cannot destructure a null value".to_owned()), _ => {}, }`;
  const push = innerKey === null ? "" :
    `runtime::array_push(&${output}, sc_dyn_key_get(&${nested}, &runtime::string("${context.rustString(innerKey)}"), false));`;
  return `{ let ${source} = ${emitExpr(sourceExpr)}; let ${fallback} = ${emitExpr(defaultExpr)}; ${requireObject(source)} let ${nested} = sc_dyn_key_get(&${source}, &runtime::string("${context.rustString(outerKey)}"), false); let ${nested} = if matches!(&${nested}, ${dyn}::Undefined) { ${fallback} } else { ${nested} }; ${requireObject(nested)} let ${output}: runtime::JsArray<${dyn}> = runtime::array_new(Vec::new()); ${push} ${dyn}::Array(${output}) }`;
}

function parseString(value: string | undefined): string | null {
  if (value === undefined) return null;
  const parsed: unknown = JSON.parse(value);
  return typeof parsed === "string" ? parsed : null;
}

function isFunctionGlobal(expr: IrExpr | undefined): boolean {
  return expr?.kind === "jsOp" && expr.op === "globalGet" && expr.name === "Function" &&
    expr.args.length === 0;
}

function compilerString(expr: IrExpr | undefined): string | null {
  return expr?.kind === "jsMarshal" && expr.value.kind === "strLit"
    ? expr.value.value
    : null;
}

function parseArrayPattern(body: string): string[] | null {
  const match = /^"use strict";(?:var (__\d+(?:,__\d+)*);)?\(\[([^\]]*)\] = v\);return \[([^\]]*)\];$/u.exec(body);
  if (match === null) return null;
  const pattern = tempList(match[2] ?? "");
  const returned = tempList(match[3] ?? "");
  const declared = tempList(match[1] ?? "");
  return sameStrings(pattern, returned) && sameStrings(pattern, declared) ? pattern : null;
}

function parseObjectPattern(body: string): string[] | null {
  const match = /^"use strict";(?:var (__\d+(?:,__\d+)*);)?\(\{(.*)\} = v\);return \[([^\]]*)\];$/u.exec(body);
  if (match === null) return null;
  const fields = match[2] ?? "";
  const returned = tempList(match[3] ?? "");
  const declared = tempList(match[1] ?? "");
  if (!sameStrings(returned, declared)) return null;
  if (fields === "") return returned.length === 0 ? [] : null;
  const entries = objectEntries(fields);
  if (entries === null) return null;
  if (entries.length !== returned.length) return null;
  const keys: string[] = [];
  for (const [index, entry] of entries.entries()) {
    if (entry.temp !== returned[index]) return null;
    const key: unknown = JSON.parse(entry.literal);
    if (typeof key !== "string") return null;
    keys.push(key);
  }
  return keys;
}

function objectEntries(fields: string): { literal: string; temp: string }[] | null {
  const pattern = /\[("(?:\\.|[^"\\])*")\]: (__\d+)(?:,|$)/gy;
  const entries: { literal: string; temp: string }[] = [];
  while (pattern.lastIndex < fields.length) {
    const entry = pattern.exec(fields);
    if (entry === null) return null;
    entries.push({ literal: entry[1] ?? "", temp: entry[2] ?? "" });
  }
  return entries;
}

function tempList(value: string): string[] {
  return value === "" ? [] : value.split(",");
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
