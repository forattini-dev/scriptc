/* The effect kernel's Rust emission: `effect.*` lib calls over
 * runtime/effect.rs. Values cross the kernel boxed (`EffectValue`, an
 * `Rc<dyn Any>`): a producer boxes its typed value, a consumer unboxes
 * with the Rust type the IR knows at that site — no dynamic checks, the
 * checker already typed the effect's channels. Callbacks travel as the
 * runtime's traced closures (the child-listener pattern). */
import type { RustLibCallContext, RustLibCallExpr } from "./lib-calls.js";
import { mangleField, mangleRecordStruct } from "../mangle.js";
import { typeEquals } from "../../ir/nodes.js";

/** A boxed value (or its absence) as the site's `A | undefined` union. */
function optionalOf(context: RustLibCallContext, expr: RustLibCallExpr, present: string): string {
  if (expr.type.kind !== "union") return context.unsupported("Option.getOrUndefined result union", expr.loc);
  const union = context.union(expr.type.unionId, expr.loc);
  const absent = union.arms.findIndex((arm) => arm.kind === "undefinedT");
  const valueArm = union.arms.findIndex((arm) => arm.kind !== "undefinedT");
  const valueType = union.arms[valueArm];
  if (absent < 0 || valueArm < 0 || valueType === undefined || union.arms.length !== 2 || !typeEquals(union.arms[valueArm]!, valueType)) return context.unsupported("Option.getOrUndefined result arms", expr.loc);
  const name = context.unionName(union.id);
  return `match ${present} { Some(sc_v) => ${name}::${context.unionVariant(valueArm)}(runtime::effect_unbox::<${context.rustType(valueType, expr.loc)}>(&sc_v)), None => ${name}::${context.unionVariant(absent)} }`;
}

/** The collect closure a result carrier describes (see collectionCarrier in lower-effect.ts). */
function collector(carrier: RustLibCallExpr["args"][number], context: RustLibCallContext, loc: RustLibCallExpr["loc"]): string {
  if (carrier.kind === "strLit" && carrier.value === "discard") return "std::rc::Rc::new(|_sc_values: Vec<runtime::EffectValue>| runtime::effect_box(()))";
  if (carrier.type.kind === "array") {
    const elem = context.rustType(carrier.type.elem, loc);
    return `std::rc::Rc::new(|sc_values: Vec<runtime::EffectValue>| runtime::effect_box(runtime::array_new(sc_values.iter().map(|sc_value| runtime::effect_unbox::<${elem}>(sc_value)).collect::<Vec<${elem}>>())))`;
  }
  if (carrier.kind === "strLit" && carrier.value.startsWith("record:")) {
    const shape = context.record(carrier.value.slice("record:".length), loc);
    const fields = shape.fields.map((field, index) => {
      const value = `runtime::effect_unbox::<${context.rustType(field.type, loc)}>(&sc_values[${index}])`;
      return `${mangleField(field.name)}: ${context.isEdgeValue(field.type) ? `Some(${value})` : value}`;
    }).join(", ");
    return `std::rc::Rc::new(|sc_values: Vec<runtime::EffectValue>| runtime::effect_box(runtime::Gc::new(${mangleRecordStruct(shape.id)} { ${fields} })))`;
  }
  return context.unsupported("effect collection carrier", loc);
}

function traced(context: RustLibCallContext, callback: string): string {
  return `Box::new(move |sc_tracer: &mut runtime::Tracer<'_>| sc_tracer.edge(&${callback}))`;
}

export function emitRustEffectCall(expr: RustLibCallExpr, context: RustLibCallContext): string | null {
  if (!expr.fn.startsWith("effect.") && !expr.fn.startsWith("layer.") && !expr.fn.startsWith("option.")) return null;
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
      const source = context.nextTemporary();
      const callback = context.nextTemporary();
      const keep = context.nextTemporary();
      // A thunk (andThen's `() => …`) ignores the value; a one-parameter callback reads it with its own type.
      const dispatch = context.emitClosureDispatch(callback, second.type, param === undefined ? [] : ["sc_arg"], expr.loc);
      const bind = param === undefined ? "" : `let sc_arg: ${context.rustType(param, expr.loc)} = runtime::effect_unbox(&sc_value);`;
      const answersEffect = expr.fn === "effect.flatMap" || expr.fn === "effect.catchAll";
      const body = answersEffect ? dispatch : `runtime::effect_box(${dispatch})`;
      const runtimeFn = { "effect.map": "effect_map", "effect.flatMap": "effect_flat_map", "effect.catchAll": "effect_catch_all", "effect.mapError": "effect_map_error" }[expr.fn];
      return `{ let ${source} = ${context.emitExpr(first)}; let ${callback} = ${context.emitExpr(second)}; let ${keep} = ${callback}.clone(); runtime::${runtimeFn}(&${source}, std::rc::Rc::new(move |sc_value: runtime::EffectValue| { let _ = &sc_value; ${bind} ${body} }), ${traced(context, keep)}) }`;
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
    case "effect.fn": {
      if (first === undefined || first.type.kind !== "func" || first.type.ret.kind !== "generator" || expr.type.kind !== "func") break;
      const ret = first.type.ret.retT;
      const retType = ret.kind === "void" || ret.kind === "undefinedT" ? "()" : context.rustType(ret, expr.loc);
      const body = context.nextTemporary();
      const keep = context.nextTemporary();
      const shape = context.rustType(expr.type, expr.loc).replace(/^runtime::Gc<|>$/g, "");
      const params = expr.type.params.map((type, index) => `sc_p${index}: ${context.rustType(type, expr.loc)}`).join(", ");
      const args = expr.type.params.map((_, index) => `sc_p${index}.clone()`);
      const dispatch = context.emitClosureDispatch("sc_body", first.type, args, expr.loc);
      return `{ let ${body} = ${context.emitExpr(first)}; let ${keep} = ${body}.clone(); runtime::Gc::new(${shape}::RuntimeCallback { callback: Some(std::rc::Rc::new(move |${params}| { let sc_body = ${body}.clone(); let sc_keep = sc_body.clone(); runtime::effect_gen::<${retType}>(std::rc::Rc::new(move || ${dispatch}), Box::new(move |sc_tracer: &mut runtime::Tracer<'_>| sc_tracer.edge(&sc_keep))) })), trace: Some(std::rc::Rc::new(move |sc_tracer: &mut runtime::Tracer<'_>| sc_tracer.edge(&${keep}))) }) }`;
    }
    case "effect.void":
      return "runtime::effect_succeed(runtime::effect_box(()))";
    case "effect.as":
      if (first === undefined || second === undefined) break;
      return `runtime::effect_as(&${context.emitExpr(first)}, runtime::effect_box(${context.emitExpr(second)}))`;
    case "effect.asVoid":
      if (first === undefined) break;
      return `runtime::effect_as(&${context.emitExpr(first)}, runtime::effect_box(()))`;
    case "effect.ignore":
      if (first === undefined) break;
      return `runtime::effect_ignore(&${context.emitExpr(first)})`;
    case "effect.andThenEffect":
      if (first === undefined || second === undefined) break;
      return `runtime::effect_zip_right(&${context.emitExpr(first)}, &${context.emitExpr(second)})`;
    case "effect.serviceKey":
      if (first === undefined) break;
      return `runtime::effect_service_key(&${context.emitExpr(first)})`;
    case "effect.provideService":
      if (first === undefined || second === undefined || expr.args[2] === undefined) break;
      return `runtime::effect_provide_service(&${context.emitExpr(first)}, &${context.emitExpr(second)}, runtime::effect_box(${context.emitExpr(expr.args[2])}))`;
    case "effect.provide":
      if (first === undefined || second === undefined) break;
      return `runtime::effect_provide(&${context.emitExpr(first)}, &${context.emitExpr(second)})`;
    case "layer.empty":
      return "runtime::layer_empty()";
    case "layer.succeed":
      if (first === undefined || second === undefined) break;
      return `runtime::layer_succeed(&${context.emitExpr(first)}, runtime::effect_box(${context.emitExpr(second)}))`;
    case "layer.effect":
    case "layer.provide":
    case "layer.provideMerge":
    case "layer.merge": {
      if (first === undefined || second === undefined) break;
      const runtimeFn = { "layer.effect": "layer_effect", "layer.provide": "layer_provide", "layer.provideMerge": "layer_provide_merge", "layer.merge": "layer_merge" }[expr.fn];
      return `runtime::${runtimeFn}(&${context.emitExpr(first)}, &${context.emitExpr(second)})`;
    }
    case "effect.forEach": {
      const carrier = expr.args[2];
      if (first === undefined || second === undefined || carrier === undefined || first.type.kind !== "array" || second.type.kind !== "func") break;
      const param = second.type.params[0];
      if (param === undefined) break;
      const items = context.nextTemporary();
      const callback = context.nextTemporary();
      const keep = context.nextTemporary();
      const dispatch = context.emitClosureDispatch(callback, second.type, second.type.params.length === 2 ? ["sc_arg", "sc_index"] : ["sc_arg"], expr.loc);
      return `{ let ${items} = ${context.emitExpr(first)}; let sc_len = runtime::array_len(&${items}) as usize; let mut sc_boxed: Vec<runtime::EffectValue> = Vec::with_capacity(sc_len); for sc_i in 0..sc_len { sc_boxed.push(runtime::effect_box(runtime::array_get(&${items}, sc_i as f64))); } let ${callback} = ${context.emitExpr(second)}; let ${keep} = ${callback}.clone(); runtime::effect_for_each(sc_boxed, std::rc::Rc::new(move |sc_value: runtime::EffectValue, sc_index: f64| { let _ = sc_index; let sc_arg: ${context.rustType(param, expr.loc)} = runtime::effect_unbox(&sc_value); ${dispatch} }), ${collector(carrier, context, expr.loc)}, ${traced(context, keep)}) }`;
    }
    case "effect.all":
      if (first === undefined || second === undefined || second.type.kind !== "array") break;
      return `runtime::effect_all(&${context.emitExpr(second)}, ${collector(first, context, expr.loc)})`;
    case "effect.log":
      if (first === undefined || second === undefined) break;
      return `runtime::effect_log(&${context.emitExpr(first)}, &${context.emitExpr(second)})`;
    case "effect.tap":
    case "effect.tapError": {
      if (first === undefined || second === undefined || second.type.kind !== "func") break;
      const param = second.type.params[0];
      const source = context.nextTemporary();
      const callback = context.nextTemporary();
      const keep = context.nextTemporary();
      const dispatch = context.emitClosureDispatch(callback, second.type, param === undefined ? [] : ["sc_arg"], expr.loc);
      const bind = param === undefined ? "" : `let sc_arg: ${context.rustType(param, expr.loc)} = runtime::effect_unbox(&sc_value);`;
      const body = second.type.ret.kind === "effect" ? dispatch : `{ let _ = ${dispatch}; runtime::effect_succeed(runtime::effect_box(())) }`;
      return `{ let ${source} = ${context.emitExpr(first)}; let ${callback} = ${context.emitExpr(second)}; let ${keep} = ${callback}.clone(); runtime::${expr.fn === "effect.tap" ? "effect_tap" : "effect_tap_error"}(&${source}, std::rc::Rc::new(move |sc_value: runtime::EffectValue| { let _ = &sc_value; ${bind} ${body} }), ${traced(context, keep)}) }`;
    }
    case "effect.suspend": {
      if (first === undefined || first.type.kind !== "func") break;
      const callback = context.nextTemporary();
      const keep = context.nextTemporary();
      const dispatch = context.emitClosureDispatch(callback, first.type, [], expr.loc);
      return `{ let ${callback} = ${context.emitExpr(first)}; let ${keep} = ${callback}.clone(); runtime::effect_suspend(std::rc::Rc::new(move || ${dispatch}), ${traced(context, keep)}) }`;
    }
    case "effect.sleep":
      if (first === undefined) break;
      return first.type.kind === "string" ? `runtime::effect_sleep_text(&${context.emitExpr(first)})` : `runtime::effect_sleep(${context.emitExpr(first)})`;
    case "effect.scoped":
    case "effect.exit":
      if (first === undefined) break;
      return `runtime::${expr.fn === "effect.scoped" ? "effect_scoped" : "effect_exit"}(&${context.emitExpr(first)})`;
    case "effect.addFinalizer": {
      if (first === undefined || first.type.kind !== "func") break;
      const callback = context.nextTemporary();
      const keep = context.nextTemporary();
      const dispatch = context.emitClosureDispatch(callback, first.type, first.type.params.length === 1 ? ["sc_exit"] : [], expr.loc);
      return `{ let ${callback} = ${context.emitExpr(first)}; let ${keep} = ${callback}.clone(); runtime::effect_add_finalizer(std::rc::Rc::new(move |sc_exit: runtime::JsEffect| { let _ = &sc_exit; ${dispatch} }), ${traced(context, keep)}) }`;
    }
    case "effect.ensuring":
      if (first === undefined || second === undefined) break;
      return `runtime::effect_ensuring(&${context.emitExpr(first)}, &${context.emitExpr(second)})`;
    case "effect.acquireRelease":
    case "effect.acquireUseRelease": {
      const release = expr.fn === "effect.acquireRelease" ? second : expr.args[2];
      if (first === undefined || release === undefined || release.type.kind !== "func") break;
      const resource = release.type.params[0];
      if (resource === undefined) break;
      const acquire = context.nextTemporary();
      const releaseFn = context.nextTemporary();
      const keepRelease = context.nextTemporary();
      const releaseDispatch = context.emitClosureDispatch(releaseFn, release.type, release.type.params.length === 2 ? ["sc_arg", "sc_exit"] : ["sc_arg"], expr.loc);
      const releaseClosure = `std::rc::Rc::new(move |sc_value: runtime::EffectValue, sc_exit: runtime::JsEffect| { let _ = &sc_exit; let sc_arg: ${context.rustType(resource, expr.loc)} = runtime::effect_unbox(&sc_value); ${releaseDispatch} })`;
      if (expr.fn === "effect.acquireRelease") {
        return `{ let ${acquire} = ${context.emitExpr(first)}; let ${releaseFn} = ${context.emitExpr(release)}; let ${keepRelease} = ${releaseFn}.clone(); runtime::effect_acquire_release(&${acquire}, ${releaseClosure}, ${traced(context, keepRelease)}) }`;
      }
      if (second === undefined || second.type.kind !== "func" || second.type.params[0] === undefined) break;
      const useFn = context.nextTemporary();
      const keepUse = context.nextTemporary();
      const useDispatch = context.emitClosureDispatch(useFn, second.type, ["sc_arg"], expr.loc);
      const useClosure = `std::rc::Rc::new(move |sc_value: runtime::EffectValue| { let sc_arg: ${context.rustType(second.type.params[0], expr.loc)} = runtime::effect_unbox(&sc_value); ${useDispatch} })`;
      return `{ let ${acquire} = ${context.emitExpr(first)}; let ${useFn} = ${context.emitExpr(second)}; let ${keepUse} = ${useFn}.clone(); let ${releaseFn} = ${context.emitExpr(release)}; let ${keepRelease} = ${releaseFn}.clone(); runtime::effect_acquire_use_release(&${acquire}, ${useClosure}, ${releaseClosure}, Box::new(move |sc_tracer: &mut runtime::Tracer<'_>| { sc_tracer.edge(&${keepUse}); sc_tracer.edge(&${keepRelease}); })) }`;
    }
    case "effect.exitSucceed":
    case "effect.exitFail":
      if (first === undefined) break;
      return `runtime::${expr.fn === "effect.exitSucceed" ? "effect_exit_succeed" : "effect_exit_fail"}(runtime::effect_box(${context.emitExpr(first)}))`;
    case "effect.exitIsSuccess":
    case "effect.exitIsFailure":
      if (first === undefined) break;
      return `${expr.fn === "effect.exitIsFailure" ? "!" : ""}runtime::effect_exit_is_success(&${context.emitExpr(first)})`;
    case "effect.dataTag":
      if (first === undefined) break;
      return `runtime::effect_data_tag(&${context.emitExpr(first)})`;
    case "effect.exitValue":
      if (first === undefined) break;
      return `runtime::effect_unbox::<${context.rustType(expr.type, expr.loc)}>(&runtime::effect_exit_value(&${context.emitExpr(first)}))`;
    case "effect.try": {
      if (first === undefined || second === undefined || first.type.kind !== "func" || second.type.kind !== "func") break;
      const attempt = context.nextTemporary();
      const recover = context.nextTemporary();
      const keepAttempt = context.nextTemporary();
      const keepRecover = context.nextTemporary();
      const attemptDispatch = context.emitClosureDispatch(attempt, first.type, [], expr.loc);
      const reasonType = second.type.params[0];
      const recoverDispatch = context.emitClosureDispatch(recover, second.type, reasonType === undefined ? [] : ["sc_arg"], expr.loc);
      const bind = reasonType === undefined ? "" : `let sc_arg: ${context.rustType(reasonType, expr.loc)} = sc_dyn_from_caught(sc_caught);`;
      return `{ let ${attempt} = ${context.emitExpr(first)}; let ${recover} = ${context.emitExpr(second)}; let ${keepAttempt} = ${attempt}.clone(); let ${keepRecover} = ${recover}.clone(); runtime::effect_try(std::rc::Rc::new(move || runtime::effect_box(${attemptDispatch})), std::rc::Rc::new(move |sc_caught: runtime::Caught| { let _ = &sc_caught; ${bind} runtime::effect_box(${recoverDispatch}) }), Box::new(move |sc_tracer: &mut runtime::Tracer<'_>| { sc_tracer.edge(&${keepAttempt}); sc_tracer.edge(&${keepRecover}); })) }`;
    }
    case "effect.orElseSucceed": {
      if (first === undefined || second === undefined || second.type.kind !== "func") break;
      const callback = context.nextTemporary();
      const keep = context.nextTemporary();
      const dispatch = context.emitClosureDispatch(callback, second.type, [], expr.loc);
      return `{ let ${callback} = ${context.emitExpr(second)}; let ${keep} = ${callback}.clone(); runtime::effect_or_else_succeed(&${context.emitExpr(first)}, std::rc::Rc::new(move || runtime::effect_box(${dispatch})), ${traced(context, keep)}) }`;
    }
    case "effect.catchIf": {
      const handler = expr.args[2];
      if (first === undefined || second === undefined || handler === undefined || second.type.kind !== "func" || handler.type.kind !== "func") break;
      const errorType = second.type.params[0];
      if (errorType === undefined) break;
      const predicate = context.nextTemporary();
      const recover = context.nextTemporary();
      const keepPredicate = context.nextTemporary();
      const keepRecover = context.nextTemporary();
      const predicateDispatch = context.emitClosureDispatch(predicate, second.type, ["sc_arg"], expr.loc);
      const recoverDispatch = context.emitClosureDispatch(recover, handler.type, handler.type.params.length === 1 ? ["sc_arg"] : [], expr.loc);
      const errorRust = context.rustType(errorType, expr.loc);
      return `{ let ${predicate} = ${context.emitExpr(second)}; let ${recover} = ${context.emitExpr(handler)}; let ${keepPredicate} = ${predicate}.clone(); let ${keepRecover} = ${recover}.clone(); runtime::effect_catch_if(&${context.emitExpr(first)}, std::rc::Rc::new(move |sc_value: runtime::EffectValue| { let sc_arg: ${errorRust} = runtime::effect_unbox(&sc_value); ${predicateDispatch} }), std::rc::Rc::new(move |sc_value: runtime::EffectValue| { let sc_arg: ${errorRust} = runtime::effect_unbox(&sc_value); let _ = &sc_arg; ${recoverDispatch} }), Box::new(move |sc_tracer: &mut runtime::Tracer<'_>| { sc_tracer.edge(&${keepPredicate}); sc_tracer.edge(&${keepRecover}); })) }`;
    }
    case "option.some":
      if (first === undefined) break;
      return `runtime::option_some(runtime::effect_box(${context.emitExpr(first)}))`;
    case "option.none":
      return "runtime::option_none()";
    case "option.isSome":
      if (first === undefined) break;
      return `runtime::option_is_some(&${context.emitExpr(first)})`;
    case "option.getOrUndefined":
      if (first === undefined) break;
      return `{ let sc_present = runtime::option_get(&${context.emitExpr(first)}); ${optionalOf(context, expr, "sc_present")} }`;
    case "option.getOrElse": {
      if (first === undefined || second === undefined || second.type.kind !== "func") break;
      const callback = context.nextTemporary();
      const dispatch = context.emitClosureDispatch(callback, second.type, [], expr.loc);
      const valueType = context.rustType(expr.type, expr.loc);
      return `{ let ${callback} = ${context.emitExpr(second)}; match runtime::option_get(&${context.emitExpr(first)}) { Some(sc_v) => runtime::effect_unbox::<${valueType}>(&sc_v), None => ${dispatch} } }`;
    }
    case "option.map": {
      if (first === undefined || second === undefined || second.type.kind !== "func" || second.type.params[0] === undefined) break;
      const callback = context.nextTemporary();
      const dispatch = context.emitClosureDispatch(callback, second.type, ["sc_arg"], expr.loc);
      return `{ let ${callback} = ${context.emitExpr(second)}; match runtime::option_get(&${context.emitExpr(first)}) { Some(sc_v) => { let sc_arg: ${context.rustType(second.type.params[0], expr.loc)} = runtime::effect_unbox(&sc_v); runtime::option_some(runtime::effect_box(${dispatch})) }, None => runtime::option_none() } }`;
    }
    case "option.match": {
      const onSome = expr.args[2];
      if (first === undefined || second === undefined || onSome === undefined || second.type.kind !== "func" || onSome.type.kind !== "func" || onSome.type.params[0] === undefined) break;
      const none = context.nextTemporary();
      const some = context.nextTemporary();
      const noneDispatch = context.emitClosureDispatch(none, second.type, [], expr.loc);
      const someDispatch = context.emitClosureDispatch(some, onSome.type, ["sc_arg"], expr.loc);
      return `{ let ${none} = ${context.emitExpr(second)}; let ${some} = ${context.emitExpr(onSome)}; match runtime::option_get(&${context.emitExpr(first)}) { Some(sc_v) => { let sc_arg: ${context.rustType(onSome.type.params[0], expr.loc)} = runtime::effect_unbox(&sc_v); ${someDispatch} }, None => ${noneDispatch} } }`;
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
