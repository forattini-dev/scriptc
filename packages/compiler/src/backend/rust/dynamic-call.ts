import type { IrExpr } from "../../ir/ir.js";

type DynamicCall = Extract<IrExpr, { kind: "dynCall" }>;

export interface RustDynamicCallContext {
  hasEmbeddedModules(): boolean;
  dynTypeName(): string;
  emitExpr(expr: IrExpr): string;
  nextName(prefix: string): string;
  rustString(value: string): string;
}

export function emitRustDynamicCall(
  expr: DynamicCall,
  context: RustDynamicCallContext,
): string {
  const dyn = context.dynTypeName();
  const callee = context.nextName("sc_rt");
  const args = context.nextName("sc_rt");
  const member = context.hasEmbeddedModules() && expr.callee.kind === "dynKeyGet" ? expr.callee : null;
  const receiver = member === null ? "" : context.nextName("sc_receiver");
  const key = member === null ? "" : context.nextName("sc_key");
  const readCallee = member === null
    ? `let ${callee} = ${context.emitExpr(expr.callee)};`
    : `let ${receiver} = ${context.emitExpr(member.value)}; let ${key} = ${context.emitExpr(member.key)}; ` +
      `let ${callee} = sc_dyn_key_get(&${receiver}, &${key}, ${member.optional === true});`;
  const spreads = new Map((expr.spreads ?? []).map((spread) => [spread.arg, spread.what]));
  const append = expr.args.map((arg, index) => {
    const value = context.nextName("sc_rt");
    const emitted = `let ${value} = ${context.emitExpr(arg)};`;
    const what = spreads.get(index);
    if (what === undefined) return `${emitted} ${args}.push(${value});`;
    const label = context.rustString(what);
    return `${emitted} match ${value} { ` +
      `${dyn}::Array(array) => { let mut index = 0.0; while index < runtime::array_len(&array) { ${args}.push(runtime::array_get(&array, index)); index += 1.0; } }, ` +
      `${dyn}::String(text) => { for character in text.chars() { ${args}.push(${dyn}::String(runtime::string(&character.to_string()))); } }, ` +
      `${dyn}::Null => runtime::throw_type_error("${label} is not iterable (cannot read property null)".to_owned()), ` +
      `${dyn}::Undefined => runtime::throw_type_error("${label} is not iterable (cannot read property undefined)".to_owned()), ` +
      `_ => runtime::throw_type_error("Spread syntax requires ...iterable[Symbol.iterator] to be a function".to_owned()), }`;
  }).join(" ");
  const call = member === null
    ? `sc_dyn_call(&${callee}, &${args}, "${context.rustString(expr.calleeName)}")`
    : `sc_dyn_call_with_receiver(&${callee}, &${receiver}, &${args}, "${context.rustString(expr.calleeName)}")`;
  return `{ ${readCallee} let mut ${args}: Vec<${dyn}> = Vec::new(); ${append} ${call} }`;
}
