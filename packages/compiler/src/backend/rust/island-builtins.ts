import type { IrExpr } from "../../ir/nodes.js";
import type { RustIslandContext } from "./island.js";

type JsOperation = Extract<IrExpr, { kind: "jsOp" }>;

/** Native implementations for island calls whose receiver is a known global. */
export function emitRustIslandBuiltin(
  expr: JsOperation,
  context: RustIslandContext,
  emitExpr: (expr: IrExpr) => string,
): string | null {
  if (expr.op !== "callMethod" || expr.name !== "stringify" ||
      !isGlobal(expr.args[0], "JSON") || expr.args.length < 2 || expr.args.length > 4) return null;
  const valueExpr = expr.args[1];
  if (valueExpr === undefined) return null;
  const replacer = expr.args[2];
  if (replacer !== undefined && !isNullish(replacer)) return null;
  const space = expr.args[3] === undefined ? "" : marshaledString(expr.args[3]);
  if (space === null) return null;

  const dyn = context.dynTypeName();
  const value = context.nextName("sc_island_json_value");
  const hook = context.nextName("sc_island_json_hook");
  const node = context.nextName("sc_island_json_node");
  const stringify = space === ""
    ? `runtime::json_stringify(&${node})`
    : `runtime::json_stringify_indented(&${node}, "${context.rustString(space.slice(0, 10))}")`;
  return `{ let ${value} = ${emitExpr(valueExpr)}; let ${hook} = match &${value} { ${dyn}::Object(sc_object) => runtime::map_get_by(sc_object, &runtime::string("toJSON"), |left, right| left.as_ref() == right.as_ref()), _ => None, }; let ${value} = if ${hook}.as_ref().is_some_and(|sc_hook| sc_dyn_function_identity(sc_hook).is_some()) { let sc_hook = ${hook}.expect("scriptc invariant: checked JSON hook disappeared"); let _sc_this = sc_dyn_this_push(${value}.clone()); sc_dyn_call(&sc_hook, &[${dyn}::String(runtime::empty_string())], "toJSON") } else { ${value} }; let sc_text = if matches!(&${value}, ${dyn}::Undefined) || sc_dyn_function_identity(&${value}).is_some() { runtime::string("undefined") } else { let ${node} = sc_dyn_to_json(&${value}, "$").unwrap_or_else(|message| runtime::throw_type_error(message)); ${stringify} }; ${dyn}::String(sc_text) }`;
}

function isGlobal(expr: IrExpr | undefined, name: string): boolean {
  return expr?.kind === "jsOp" && expr.op === "globalGet" && expr.name === name && expr.args.length === 0;
}

function isNullish(expr: IrExpr): boolean {
  return expr.kind === "jsOp" && (expr.op === "nullLit" || expr.op === "undefLit") && expr.args.length === 0;
}

function marshaledString(expr: IrExpr): string | null {
  return expr.kind === "jsMarshal" && expr.value.kind === "strLit" ? expr.value.value : null;
}
