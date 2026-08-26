import type { RustLibCallContext, RustLibCallExpr } from "./lib-calls.js";

export function emitRustDynamicLibCall(
  expr: RustLibCallExpr,
  context: RustLibCallContext,
): string | null {
  const arg = expr.args[0];
  const secondArg = expr.args[1];
  if (expr.fn === "dyn.this" && expr.args.length === 0) return "sc_dyn_this_get()";
  if (expr.fn === "dyn.defineProps" && expr.args.length === 2 &&
    arg?.type.kind === "dyn" && secondArg?.type.kind === "dyn") {
    const target = context.nextTemporary();
    const descriptors = context.nextTemporary();
    return `{ let ${target} = ${context.emitExpr(arg)}; let ${descriptors} = ${context.emitExpr(secondArg)}; sc_dyn_define_properties(&${target}, &${descriptors}) }`;
  }
  if (expr.fn === "dyn.assign" && expr.args.length === 2 &&
    arg?.type.kind === "dyn" && secondArg?.type.kind === "dyn" && expr.type.kind === "dyn") {
    const target = context.nextTemporary();
    const source = context.nextTemporary();
    return `{ let ${target} = ${context.emitExpr(arg)}; let ${source} = ${context.emitExpr(secondArg)}; sc_dyn_assign(&${target}, &${source}) }`;
  }
  if (expr.fn === "dyn.packPush" && expr.args.length === 2 &&
    arg?.type.kind === "dyn" && secondArg?.type.kind === "dyn" && expr.type.kind === "void") {
    const pack = context.nextTemporary();
    const value = context.nextTemporary();
    return `{ let ${pack} = ${context.emitExpr(arg)}; let ${value} = ${context.emitExpr(secondArg)}; sc_dyn_pack_push(&${pack}, ${value}); () }`;
  }
  if (expr.fn === "dyn.packPushSpread" && expr.args.length === 3 &&
    arg?.type.kind === "dyn" && secondArg?.type.kind === "dyn" && expr.args[2]?.type.kind === "string" && expr.type.kind === "void") {
    const pack = context.nextTemporary();
    const source = context.nextTemporary();
    const what = context.nextTemporary();
    return `{ let ${pack} = ${context.emitExpr(arg)}; let ${source} = ${context.emitExpr(secondArg)}; let ${what} = ${context.emitExpr(expr.args[2])}; sc_dyn_pack_push_spread(&${pack}, &${source}, &${what}, false); () }`;
  }
  if (expr.fn === "dyn.packPushSpreadIter" && expr.args.length === 2 &&
    arg?.type.kind === "dyn" && secondArg?.type.kind === "dyn" && expr.type.kind === "void") {
    const pack = context.nextTemporary();
    const source = context.nextTemporary();
    return `{ let ${pack} = ${context.emitExpr(arg)}; let ${source} = ${context.emitExpr(secondArg)}; sc_dyn_pack_push_spread(&${pack}, &${source}, &runtime::empty_string(), true); () }`;
  }
  if (expr.fn === "dyn.assignAll" && expr.args.length === 2 &&
    arg?.type.kind === "dyn" && secondArg?.type.kind === "dyn" && expr.type.kind === "dyn") {
    const target = context.nextTemporary();
    const sources = context.nextTemporary();
    return `{ let ${target} = ${context.emitExpr(arg)}; let ${sources} = ${context.emitExpr(secondArg)}; sc_dyn_assign_all(&${target}, &${sources}) }`;
  }
  if (expr.fn === "dyn.keySet" && expr.args.length === 3 && arg?.type.kind === "dyn") {
    const keyExpr = expr.args[1];
    const valueExpr = expr.args[2];
    if (keyExpr?.type.kind !== "string" || valueExpr?.type.kind !== "dyn") {
      context.unsupported("dynamic keyed write argument types", expr.loc);
    }
    const receiver = context.nextTemporary();
    const key = context.nextTemporary();
    const value = context.nextTemporary();
    return `{ let ${receiver} = ${context.emitExpr(arg)}; let ${key} = ${context.emitExpr(keyExpr)}; let ${value} = ${context.emitExpr(valueExpr)}; sc_dyn_key_set(&${receiver}, ${key}, ${value}); () }`;
  }
  if (expr.fn === "dyn.typeof" && expr.args.length === 1 && arg?.type.kind === "dyn") {
    return `sc_dyn_typeof(&(${context.emitExpr(arg)}))`;
  }
  if ((expr.fn === "dyn.objKeys" || expr.fn === "dyn.objValues" || expr.fn === "dyn.objEntries") &&
    expr.args.length === 1 && arg?.type.kind === "dyn" && expr.type.kind === "dyn") {
    const value = context.nextTemporary();
    const helper = expr.fn === "dyn.objKeys"
      ? "sc_dyn_obj_keys"
      : expr.fn === "dyn.objValues" ? "sc_dyn_obj_values" : "sc_dyn_obj_entries";
    return `{ let ${value} = ${context.emitExpr(arg)}; ${helper}(&${value}) }`;
  }
  if (expr.fn === "dyn.hasOwn" && expr.args.length === 2 &&
    arg?.type.kind === "dyn" && secondArg?.type.kind === "string" && expr.type.kind === "bool") {
    const value = context.nextTemporary();
    const key = context.nextTemporary();
    return `{ let ${value} = ${context.emitExpr(arg)}; let ${key} = ${context.emitExpr(secondArg)}; sc_dyn_has_own(&${value}, &${key}) }`;
  }
  if (expr.fn === "dyn.errInstanceof" && expr.args.length === 2 &&
    arg?.type.kind === "dyn" && secondArg?.type.kind === "f64") {
    const value = context.nextTemporary();
    const kind = context.nextTemporary();
    return `{ let ${value} = ${context.emitExpr(arg)}; let ${kind} = ${context.emitExpr(secondArg)}; sc_dyn_error_instanceof(&${value}, ${kind}) }`;
  }
  if (expr.fn === "dyn.structuredClone" && expr.args.length === 2 &&
    arg?.type.kind === "dyn" && secondArg?.type.kind === "dyn") {
    const value = context.nextTemporary();
    const options = context.nextTemporary();
    return `{ let ${value} = ${context.emitExpr(arg)}; let ${options} = ${context.emitExpr(secondArg)}; sc_dyn_structured_clone(&${value}, &${options}) }`;
  }
  if (expr.fn === "dyn.cloneMissing" && expr.args.length === 0) {
    return "runtime::throw_type_error_code(\"The \\\"The value argument must be specified\\\" argument must be specified\".to_owned(), \"ERR_MISSING_ARGS\")";
  }
  if (expr.fn === "dyn.cloneTransferFail" && expr.args.length === 0) {
    return "runtime::throw_dom_exception(\"DataCloneError\", \"Found invalid value in transferList.\")";
  }
  return null;
}
