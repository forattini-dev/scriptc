import type { RustLibCallContext, RustLibCallExpr } from "./lib-calls.js";

export function emitRustWeakMapCall(expr: RustLibCallExpr, context: RustLibCallContext): string | null {
  if (!expr.fn.startsWith("weakmap.")) return null;
  const [ownerExpr, keyExpr, valueExpr] = expr.args;
  if (!ownerExpr || !keyExpr || ownerExpr.type.kind !== "object" || ownerExpr.type.className !== "native_builtin_WeakMap") return context.unsupported("invalid native weak map operation", expr.loc);
  const dyn = context.dynTypeName();
  const receiver = context.nextTemporary(), key = context.nextTemporary(), owner = context.nextTemporary(), weak = context.nextTemporary(), value = context.nextTemporary();
  // Internal private-slot tables keep typed class receivers as their actual GC
  // identity. Boxing through an object mirror would change the weak key.
  const typedKey = keyExpr.kind === "dynFrom" && keyExpr.value.type.kind === "object" ? keyExpr.value : undefined;
  const snapshot = `let ${receiver} = ${context.emitExpr(ownerExpr)}; let ${key} = ${context.emitExpr(typedKey ?? keyExpr)}; ${valueExpr ? `let ${value} = ${context.emitExpr(valueExpr)};` : ""} let ${owner} = runtime::WeakKey::new(&${receiver});`;
  const check = typedKey ? `let ${weak} = Some(runtime::WeakKey::new(&${key}));` : `let ${weak} = match &${key} { ${dyn}::Object(value) => Some(runtime::WeakKey::new(value)), ${dyn}::Undefined | ${dyn}::Null | ${dyn}::Number(_) | ${dyn}::Boolean(_) | ${dyn}::String(_) => None, _ => runtime::throw_type_error("scriptc: WeakMap key representation is not ported".into()), };`;
  const result = expr.fn === "weakmap.get" ? `${weak}.as_ref().and_then(|key| runtime::weak_map_get::<${dyn}>(&${owner}, key)).unwrap_or(${dyn}::Undefined)` :
    expr.fn === "weakmap.has" ? `${weak}.as_ref().is_some_and(|key| runtime::weak_map_has::<${dyn}>(&${owner}, key))` :
    expr.fn === "weakmap.delete" ? `${weak}.as_ref().is_some_and(|key| runtime::weak_map_delete::<${dyn}>(&${owner}, key))` :
    expr.fn === "weakmap.set" && valueExpr ? `match ${weak} { Some(key) => runtime::weak_map_set(&${owner}, &key, ${value}), None => runtime::throw_type_error("Invalid value used as weak map key".into()) }` : context.unsupported("invalid native weak map operation", expr.loc);
  return `{ ${snapshot} ${check} ${result} }`;
}
