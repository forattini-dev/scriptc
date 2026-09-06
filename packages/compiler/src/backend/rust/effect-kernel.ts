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
    case "effect.flatMap":
    case "effect.catchAll":
    case "effect.mapError": {
      if (first === undefined || second === undefined || second.type.kind !== "func") break;
      const param = second.type.params[0];
      if (param === undefined) break;
      const source = context.nextTemporary();
      const callback = context.nextTemporary();
      const keep = context.nextTemporary();
      const dispatch = context.emitClosureDispatch(callback, second.type, ["sc_arg"], expr.loc);
      const answersEffect = expr.fn === "effect.flatMap" || expr.fn === "effect.catchAll";
      const body = answersEffect ? dispatch : `runtime::effect_box(${dispatch})`;
      const runtimeFn = { "effect.map": "effect_map", "effect.flatMap": "effect_flat_map", "effect.catchAll": "effect_catch_all", "effect.mapError": "effect_map_error" }[expr.fn];
      return `{ let ${source} = ${context.emitExpr(first)}; let ${callback} = ${context.emitExpr(second)}; let ${keep} = ${callback}.clone(); runtime::${runtimeFn}(&${source}, std::rc::Rc::new(move |sc_value: runtime::EffectValue| { let sc_arg: ${context.rustType(param, expr.loc)} = runtime::effect_unbox(&sc_value); ${body} }), ${traced(context, keep)}) }`;
    }
    case "effect.gen": {
      if (first === undefined || first.type.kind !== "func" || first.type.ret.kind !== "generator") break;
      const ret = first.type.ret.retT;
      const retType = ret.kind === "void" || ret.kind === "undefinedT" ? "()" : context.rustType(ret, expr.loc);
      const callback = context.nextTemporary();
      const keep = context.nextTemporary();
      const dispatch = context.emitClosureDispatch(callback, first.type, [], expr.loc);
      return `{ let ${callback} = ${context.emitExpr(first)}; let ${keep} = ${callback}.clone(); runtime::effect_gen::<${retType}>(std::rc::Rc::new(move || ${dispatch}), ${traced(context, keep)}) }`;
    }
    case "effect.promise": {
      if (first === undefined || first.type.kind !== "func" || first.type.ret.kind !== "promise") break;
      const callback = context.nextTemporary();
      const keep = context.nextTemporary();
      const dispatch = context.emitClosureDispatch(callback, first.type, [], expr.loc);
      return `{ let ${callback} = ${context.emitExpr(first)}; let ${keep} = ${callback}.clone(); runtime::effect_promise(std::rc::Rc::new(move || runtime::promise_to_handle(&(${dispatch}))), ${traced(context, keep)}) }`;
    }
    case "effect.tryPromise": {
      if (first === undefined || second === undefined || first.type.kind !== "func" || second.type.kind !== "func") break;
      const reasonType = second.type.params[0];
      if (reasonType === undefined || reasonType.kind !== "dyn") break;
      const attempt = context.nextTemporary();
      const recover = context.nextTemporary();
      const keepAttempt = context.nextTemporary();
      const keepRecover = context.nextTemporary();
      const attemptDispatch = context.emitClosureDispatch(attempt, first.type, [], expr.loc);
      const recoverDispatch = context.emitClosureDispatch(recover, second.type, ["sc_arg"], expr.loc);
      return `{ let ${attempt} = ${context.emitExpr(first)}; let ${recover} = ${context.emitExpr(second)}; let ${keepAttempt} = ${attempt}.clone(); let ${keepRecover} = ${recover}.clone(); runtime::effect_try_promise(std::rc::Rc::new(move || runtime::promise_to_handle(&(${attemptDispatch}))), std::rc::Rc::new(move |sc_caught: runtime::Caught| { let sc_arg: ${context.rustType(reasonType, expr.loc)} = sc_dyn_from_caught(sc_caught); runtime::effect_box(${recoverDispatch}) }), Box::new(move |sc_tracer: &mut runtime::Tracer<'_>| { sc_tracer.edge(&${keepAttempt}); sc_tracer.edge(&${keepRecover}); })) }`;
    }
    case "effect.fail":
    case "effect.die":
      if (first === undefined) break;
      return `runtime::${expr.fn === "effect.fail" ? "effect_fail" : "effect_die"}(runtime::effect_box(${context.emitExpr(first)}))`;
    case "effect.orDie":
      if (first === undefined) break;
      return `runtime::effect_or_die(&${context.emitExpr(first)})`;
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
