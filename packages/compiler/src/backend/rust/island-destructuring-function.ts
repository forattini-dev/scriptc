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

  const computed = emitComputedPropertyPattern(body, sourceExpr, argumentsByName, context, emitExpr);
  if (computed !== null) return computed;
  const objectArrayDefault = emitObjectArrayDefaultPattern(body, sourceExpr, context, emitExpr);
  if (objectArrayDefault !== null) return objectArrayDefault;
  const arrayDefault = emitComputedArrayDefaultPattern(body, sourceExpr, argumentsByName, context, emitExpr);
  if (arrayDefault !== null) return arrayDefault;
  const nestedRest = emitComputedNestedRestPattern(body, sourceExpr, argumentsByName, context, emitExpr);
  if (nestedRest !== null) return nestedRest;
  const rest = emitObjectRestPattern(body, sourceExpr, context, emitExpr);
  if (rest !== null) return rest;
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

function emitObjectArrayDefaultPattern(
  body: string,
  sourceExpr: IrExpr,
  context: RustIslandContext,
  emitExpr: (expr: IrExpr) => string,
): string | null {
  const match = /^"use strict";var (__\d+);\(\{\[("(?:\\.|[^"\\])*")\]:(__\d+)=\[\]\} = v\);return \[(__\d+)\];$/u.exec(body);
  if (match === null || !(match[1] === match[3] && match[3] === match[4])) return null;
  const key = parseString(match[2]);
  if (key === null) return null;
  const dyn = context.dynTypeName();
  const source = context.nextName("sc_island_source");
  const value = context.nextName("sc_island_value");
  const output = context.nextName("sc_island_output");
  return `{ let ${source} = ${emitExpr(sourceExpr)}; ${requireObject(source, dyn)} let ${value} = sc_dyn_key_get(&${source}, &runtime::string("${context.rustString(key)}"), false); let ${value} = if matches!(&${value}, ${dyn}::Undefined) { ${dyn}::Array(runtime::array_new(Vec::new())) } else { ${value} }; let ${output}: runtime::JsArray<${dyn}> = runtime::array_new(Vec::new()); runtime::array_push(&${output}, ${value}); ${dyn}::Array(${output}) }`;
}

function emitComputedPropertyPattern(
  body: string,
  sourceExpr: IrExpr,
  argumentsByName: ReadonlyMap<string, IrExpr>,
  context: RustIslandContext,
  emitExpr: (expr: IrExpr) => string,
): string | null {
  const match = /^"use strict";var (__\d+);\(\{\[(__d\d+)\]:(__\d+)(?:=("(?:\\.|[^"\\])*"))?\} = v\);return \[(__\d+)\];$/u.exec(body);
  if (match === null || !(match[1] === match[3] && match[3] === match[5])) return null;
  const keyExpr = match[2] === undefined ? undefined : argumentsByName.get(match[2]);
  if (keyExpr === undefined) return null;
  const defaultValue = match[4] === undefined ? null : parseString(match[4]);
  if (match[4] !== undefined && defaultValue === null) return null;
  const dyn = context.dynTypeName();
  const source = context.nextName("sc_island_source");
  const key = context.nextName("sc_island_key");
  const value = context.nextName("sc_island_value");
  const output = context.nextName("sc_island_output");
  const defaulting = defaultValue === null ? "" :
    `let ${value} = if matches!(&${value}, ${dyn}::Undefined) { ${dyn}::String(runtime::string("${context.rustString(defaultValue)}")) } else { ${value} };`;
  return `{ let ${source} = ${emitExpr(sourceExpr)}; let ${key} = ${emitExpr(keyExpr)}; ${requireObject(source, dyn)} let ${value} = sc_dyn_key_get(&${source}, &sc_dyn_to_string(&${key}), false); ${defaulting} let ${output}: runtime::JsArray<${dyn}> = runtime::array_new(Vec::new()); runtime::array_push(&${output}, ${value}); ${dyn}::Array(${output}) }`;
}

function emitComputedArrayDefaultPattern(
  body: string,
  sourceExpr: IrExpr,
  argumentsByName: ReadonlyMap<string, IrExpr>,
  context: RustIslandContext,
  emitExpr: (expr: IrExpr) => string,
): string | null {
  const match = /^"use strict";var (__\d+);\(\[\{\[(__d\d+)\(1\)\]:(__\d+)\}=(__d\d+)\(0\)\] = v\);return \[(__\d+)\];$/u.exec(body);
  if (match === null || !(match[1] === match[3] && match[3] === match[5])) return null;
  const keyExpr = match[2] === undefined ? undefined : argumentsByName.get(match[2]);
  const defaultExpr = match[4] === undefined ? undefined : argumentsByName.get(match[4]);
  if (keyExpr === undefined || defaultExpr === undefined) return null;
  const dyn = context.dynTypeName();
  const source = context.nextName("sc_island_source");
  const keyFn = context.nextName("sc_island_key_fn");
  const defaultFn = context.nextName("sc_island_default_fn");
  const iterated = context.nextName("sc_island_iterated");
  const value = context.nextName("sc_island_value");
  const key = context.nextName("sc_island_key");
  const output = context.nextName("sc_island_output");
  return `{ let ${source} = ${emitExpr(sourceExpr)}; let ${keyFn} = ${emitExpr(keyExpr)}; let ${defaultFn} = ${emitExpr(defaultExpr)}; let ${iterated} = sc_dyn_iter_n(&${source}, 1); let ${dyn}::Array(${iterated}) = ${iterated} else { unreachable!("scriptc invariant: destructuring iterator is not an array") }; let ${value} = runtime::array_get(&${iterated}, 0.0); let ${value} = if matches!(&${value}, ${dyn}::Undefined) { sc_dyn_call(&${defaultFn}, &[${dyn}::Number(0.0)], "value") } else { ${value} }; ${requireObject(value, dyn)} let ${key} = sc_dyn_to_string(&sc_dyn_call(&${keyFn}, &[${dyn}::Number(1.0)], "value")); let ${value} = sc_dyn_key_get(&${value}, &${key}, false); let ${output}: runtime::JsArray<${dyn}> = runtime::array_new(Vec::new()); runtime::array_push(&${output}, ${value}); ${dyn}::Array(${output}) }`;
}

function emitComputedNestedRestPattern(
  body: string,
  sourceExpr: IrExpr,
  argumentsByName: ReadonlyMap<string, IrExpr>,
  context: RustIslandContext,
  emitExpr: (expr: IrExpr) => string,
): string | null {
  const match = /^"use strict";var (__\d+),(__\d+);\(\{\[(__d\d+)\(0\)\]:\{\[(__d\d+)\(2\)\]:(__\d+)\}=(__d\d+)\(1\),\.\.\.(__\d+)\} = v\);return \[(__\d+),(__\d+)\];$/u.exec(body);
  if (match === null || !(match[1] === match[5] && match[5] === match[8] &&
      match[2] === match[7] && match[7] === match[9])) return null;
  const outerExpr = match[3] === undefined ? undefined : argumentsByName.get(match[3]);
  const innerExpr = match[4] === undefined ? undefined : argumentsByName.get(match[4]);
  const defaultExpr = match[6] === undefined ? undefined : argumentsByName.get(match[6]);
  if (outerExpr === undefined || innerExpr === undefined || defaultExpr === undefined) return null;
  const dyn = context.dynTypeName();
  const source = context.nextName("sc_island_source");
  const outerFn = context.nextName("sc_island_outer_fn");
  const innerFn = context.nextName("sc_island_inner_fn");
  const defaultFn = context.nextName("sc_island_default_fn");
  const outerKey = context.nextName("sc_island_outer_key");
  const innerKey = context.nextName("sc_island_inner_key");
  const nested = context.nextName("sc_island_nested");
  const value = context.nextName("sc_island_value");
  const rest = context.nextName("sc_island_rest");
  const output = context.nextName("sc_island_output");
  return `{ let ${source} = ${emitExpr(sourceExpr)}; let ${outerFn} = ${emitExpr(outerExpr)}; let ${innerFn} = ${emitExpr(innerExpr)}; let ${defaultFn} = ${emitExpr(defaultExpr)}; ${requireObject(source, dyn)} let ${outerKey} = sc_dyn_to_string(&sc_dyn_call(&${outerFn}, &[${dyn}::Number(0.0)], "value")); let ${nested} = sc_dyn_key_get(&${source}, &${outerKey}, false); let ${nested} = if matches!(&${nested}, ${dyn}::Undefined) { sc_dyn_call(&${defaultFn}, &[${dyn}::Number(1.0)], "value") } else { ${nested} }; ${requireObject(nested, dyn)} let ${innerKey} = sc_dyn_to_string(&sc_dyn_call(&${innerFn}, &[${dyn}::Number(2.0)], "value")); let ${value} = sc_dyn_key_get(&${nested}, &${innerKey}, false); let ${rest}: runtime::JsMap<runtime::JsString, ${dyn}> = runtime::map_new(); ${copyObjectRest(source, rest, outerKey, dyn)} let ${output}: runtime::JsArray<${dyn}> = runtime::array_new(Vec::new()); runtime::array_push(&${output}, ${value}); runtime::array_push(&${output}, ${dyn}::Object(${rest})); ${dyn}::Array(${output}) }`;
}

function emitObjectRestPattern(
  body: string,
  sourceExpr: IrExpr,
  context: RustIslandContext,
  emitExpr: (expr: IrExpr) => string,
): string | null {
  const match = /^"use strict";var (__\d+);\(\{\.\.\.(__\d+)\} = v\);return \[(__\d+)\];$/u.exec(body);
  if (match === null || !(match[1] === match[2] && match[2] === match[3])) return null;
  const dyn = context.dynTypeName();
  const source = context.nextName("sc_island_source");
  const rest = context.nextName("sc_island_rest");
  const output = context.nextName("sc_island_output");
  return `{ let ${source} = ${emitExpr(sourceExpr)}; ${requireObject(source, dyn)} let ${rest}: runtime::JsMap<runtime::JsString, ${dyn}> = runtime::map_new(); ${copyObjectRest(source, rest, null, dyn)} let ${output}: runtime::JsArray<${dyn}> = runtime::array_new(Vec::new()); runtime::array_push(&${output}, ${dyn}::Object(${rest})); ${dyn}::Array(${output}) }`;
}

function requireObject(value: string, dyn: string): string {
  return `match &${value} { ${dyn}::Undefined => runtime::throw_type_error("Cannot destructure an undefined value".to_owned()), ${dyn}::Null => runtime::throw_type_error("Cannot destructure a null value".to_owned()), _ => {}, }`;
}

function copyObjectRest(source: string, output: string, excluded: string | null, dyn: string): string {
  const copy = `runtime::map_set_by(&${output}, sc_key, runtime::map_iter_value(sc_object, sc_index), |left, right| left.as_ref() == right.as_ref());`;
  const filteredCopy = excluded === null ? copy : `if sc_key.as_ref() != ${excluded}.as_ref() { ${copy} }`;
  return `match &${source} { ${dyn}::Object(sc_object) => { let mut sc_index = 0.0; while sc_index < runtime::map_iter_count(sc_object) { if runtime::map_iter_live(sc_object, sc_index) { let sc_key = runtime::map_iter_key(sc_object, sc_index); ${filteredCopy} } sc_index += 1.0; } }, _ => runtime::throw_error_code("island object rest over this dynamic value is not supported yet".to_owned(), "SC3001"), }`;
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
  const pattern = /\[("(?:\\.|[^"\\])*")\]:\s*(__\d+)(?:,|$)/gy;
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
