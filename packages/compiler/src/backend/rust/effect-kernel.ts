/* The effect kernel's Rust emission: `effect.*` lib calls over
 * runtime/effect.rs. Values cross the kernel boxed (`EffectValue`, an
 * `Rc<dyn Any>`): a producer boxes its typed value, a consumer unboxes
 * with the Rust type the IR knows at that site — no dynamic checks, the
 * checker already typed the effect's channels. Callbacks travel as the
 * runtime's traced closures (the child-listener pattern). */
import type { RustLibCallContext, RustLibCallExpr } from "./lib-calls.js";

function traced(context: RustLibCallContext, callback: string): string {
  return `Box::new(move |sc_tracer: &mut runtime::Tracer<'_>| sc_tracer.edge(&${callback}))`;
}

export function emitRustEffectCall(expr: RustLibCallExpr, context: RustLibCallContext): string | null {
  if (!expr.fn.startsWith("effect.")) return null;
  const first = expr.args[0];
  const second = expr.args[1];
  switch (expr.fn) {
    case "effect.succeed":
      if (first === undefined) break;
      return `runtime::effect_succeed(runtime::effect_box(${context.emitExpr(first)}))`;
    case "effect.sync": {
      if (first === undefined || first.type.kind !== "func") break;
      const callback = context.nextTemporary();
      const keep = context.nextTemporary();
      const dispatch = context.emitClosureDispatch(callback, first.type, [], expr.loc);
      return `{ let ${callback} = ${context.emitExpr(first)}; let ${keep} = ${callback}.clone(); runtime::effect_sync(std::rc::Rc::new(move || runtime::effect_box(${dispatch})), ${traced(context, keep)}) }`;
    }
    case "effect.map":
    case "effect.flatMap": {
      if (first === undefined || second === undefined || second.type.kind !== "func") break;
      const param = second.type.params[0];
      if (param === undefined) break;
      const source = context.nextTemporary();
      const callback = context.nextTemporary();
      const keep = context.nextTemporary();
      const dispatch = context.emitClosureDispatch(callback, second.type, ["sc_arg"], expr.loc);
      const body = expr.fn === "effect.map" ? `runtime::effect_box(${dispatch})` : dispatch;
      const runtimeFn = expr.fn === "effect.map" ? "effect_map" : "effect_flat_map";
      return `{ let ${source} = ${context.emitExpr(first)}; let ${callback} = ${context.emitExpr(second)}; let ${keep} = ${callback}.clone(); runtime::${runtimeFn}(&${source}, std::rc::Rc::new(move |sc_value: runtime::EffectValue| { let sc_arg: ${context.rustType(param, expr.loc)} = runtime::effect_unbox(&sc_value); ${body} }), ${traced(context, keep)}) }`;
    }
    case "effect.runSync":
      if (first === undefined) break;
      return `runtime::effect_unbox::<${context.rustType(expr.type, expr.loc)}>(&runtime::effect_run_sync(&${context.emitExpr(first)}))`;
    case "effect.runPromise":
      if (first === undefined || expr.type.kind !== "promise") break;
      return `runtime::effect_run_promise::<${context.rustType(expr.type.inner, expr.loc)}>(&${context.emitExpr(first)})`;
    default:
      break;
  }
  return context.unsupported(`${expr.fn} argument shape`, expr.loc);
}
