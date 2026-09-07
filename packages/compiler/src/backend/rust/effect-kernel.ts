/* The effect kernel's Rust emission: `effect.*` lib calls over
 * runtime/effect.rs. Values cross the kernel boxed (`EffectValue`, an
 * `Rc<dyn Any>`): a producer boxes its typed value, a consumer unboxes
 * with the Rust type the IR knows at that site — no dynamic checks, the
 * checker already typed the effect's channels. Callbacks travel as the
 * runtime's traced closures (the child-listener pattern). */
import type { RustLibCallContext, RustLibCallExpr } from "./lib-calls.js";
import { mangleField, mangleRecordStruct } from "../mangle.js";
import { typeEquals, type IrType, type SrcLoc } from "../../ir/nodes.js";

/** A typed value boxed for the kernel. UNION values travel as their ARM: a producer typed by one arm (`Effect.fail(new
 * NotFound())`) and a consumer typed by the union (`Effect.catch` over `NotFound | Busy`) agree on the box; unit arms box
 * as `EffectUnit` so `undefined` and `null` stay apart. */
function box(context: RustLibCallContext, type: IrType, value: string, loc: SrcLoc): string {
  if (type.kind !== "union") return `runtime::effect_box(${value})`;
  const union = context.union(type.unionId, loc);
  const name = context.unionName(union.id);
  const arms = union.arms.map((arm, tag) => context.isUnit(arm)
    ? `${name}::${context.unionVariant(tag)} => runtime::effect_box(runtime::EffectUnit::${arm.kind === "nullT" ? "Null" : "Undefined"})`
    : `${name}::${context.unionVariant(tag)}(sc_arm) => runtime::effect_box(sc_arm)`).join(", ");
  return `match ${value} { ${arms} }`;
}

/** A boxed value read at a site's type (`value` is a `&EffectValue` expression): a union site accepts the union itself
 * or any arm's box (rebuilt into the arm's variant); `()` answers an undefined arm (the kernel's own unit). */
function unbox(context: RustLibCallContext, type: IrType, value: string, loc: SrcLoc): string {
  const rust = context.rustType(type, loc);
  if (type.kind !== "union") return `runtime::effect_unbox::<${rust}>(${value})`;
  const union = context.union(type.unionId, loc);
  const name = context.unionName(union.id);
  const tries = union.arms.map((arm, tag) => {
    const variant = `${name}::${context.unionVariant(tag)}`;
    if (arm.kind === "nullT") return `if sc_boxed.downcast_ref::<runtime::EffectUnit>() == Some(&runtime::EffectUnit::Null) { return ${variant}; }`;
    if (context.isUnit(arm)) return `if sc_boxed.downcast_ref::<runtime::EffectUnit>() == Some(&runtime::EffectUnit::Undefined) || sc_boxed.downcast_ref::<()>().is_some() { return ${variant}; }`;
    return `if let Some(sc_arm) = sc_boxed.downcast_ref::<${context.rustType(arm, loc)}>() { return ${variant}(sc_arm.clone()); }`;
  }).join(" ");
  return `(|sc_boxed: &runtime::EffectValue| -> ${rust} { if let Some(sc_whole) = sc_boxed.downcast_ref::<${rust}>() { return sc_whole.clone(); } ${tries} runtime::effect_unbox_mismatch("${rust}") })(${value})`;
}

/** A boxed value (or its absence) as the site's `A | undefined` union. */
function optionalOf(context: RustLibCallContext, expr: RustLibCallExpr, present: string): string {
  if (expr.type.kind !== "union") return context.unsupported("Option.getOrUndefined result union", expr.loc);
  const union = context.union(expr.type.unionId, expr.loc);
  const absent = union.arms.findIndex((arm) => arm.kind === "undefinedT");
  const valueArm = union.arms.findIndex((arm) => arm.kind !== "undefinedT");
  const valueType = union.arms[valueArm];
  if (absent < 0 || valueArm < 0 || valueType === undefined || union.arms.length !== 2 || !typeEquals(union.arms[valueArm]!, valueType)) return context.unsupported("Option.getOrUndefined result arms", expr.loc);
  const name = context.unionName(union.id);
  return `match ${present} { Some(sc_v) => ${name}::${context.unionVariant(valueArm)}(${unbox(context, valueType, "&sc_v", expr.loc)}), None => ${name}::${context.unionVariant(absent)} }`;
}

/** The collect closure a result carrier describes (see collectionCarrier in lower-effect.ts). */
function collector(carrier: RustLibCallExpr["args"][number], context: RustLibCallContext, loc: RustLibCallExpr["loc"]): string {
  if (carrier.kind === "strLit" && carrier.value === "discard") return "std::rc::Rc::new(|_sc_values: Vec<runtime::EffectValue>| runtime::effect_box(()))";
  if (carrier.type.kind === "array") {
    const elem = context.rustType(carrier.type.elem, loc);
    return `std::rc::Rc::new(|sc_values: Vec<runtime::EffectValue>| runtime::effect_box(runtime::array_new(sc_values.iter().map(|sc_value| ${unbox(context, carrier.type.elem, "sc_value", loc)}).collect::<Vec<${elem}>>())))`;
  }
  if (carrier.kind === "strLit" && carrier.value.startsWith("record:")) {
    const shape = context.record(carrier.value.slice("record:".length), loc);
    const fields = shape.fields.map((field, index) => {
      const value = unbox(context, field.type, `&sc_values[${index}]`, loc);
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
  if (expr.fn.startsWith("schema.")) return emitRustSchemaCall(expr, context);
  if (!expr.fn.startsWith("effect.") && !expr.fn.startsWith("layer.") && !expr.fn.startsWith("option.")) return null;
  const first = expr.args[0];
  const second = expr.args[1];
  switch (expr.fn) {
    case "effect.succeed":
      if (first === undefined) break;
      return `runtime::effect_succeed(${box(context, first.type, context.emitExpr(first), expr.loc)})`;
    case "effect.sync": {
      if (first === undefined || first.type.kind !== "func") break;
      const callback = context.nextTemporary();
      const keep = context.nextTemporary();
      const dispatch = context.emitClosureDispatch(callback, first.type, [], expr.loc);
      return `{ let ${callback} = ${context.emitExpr(first)}; let ${keep} = ${callback}.clone(); runtime::effect_sync(std::rc::Rc::new(move || ${box(context, first.type.ret, dispatch, expr.loc)}), ${traced(context, keep)}) }`;
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
      const bind = param === undefined ? "" : `let sc_arg: ${context.rustType(param, expr.loc)} = ${unbox(context, param, "&sc_value", expr.loc)};`;
      const answersEffect = expr.fn === "effect.flatMap" || expr.fn === "effect.catchAll";
      const body = answersEffect ? dispatch : box(context, second.type.ret, dispatch, expr.loc);
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
      return `{ let ${attempt} = ${context.emitExpr(first)}; let ${recover} = ${context.emitExpr(second)}; let ${keepAttempt} = ${attempt}.clone(); let ${keepRecover} = ${recover}.clone(); runtime::effect_try_promise(std::rc::Rc::new(move || runtime::promise_to_handle(&(${attemptDispatch}))), std::rc::Rc::new(move |sc_caught: runtime::Caught| { let sc_arg: ${context.rustType(reasonType, expr.loc)} = sc_dyn_from_caught(sc_caught); ${box(context, second.type.ret, recoverDispatch, expr.loc)} }), Box::new(move |sc_tracer: &mut runtime::Tracer<'_>| { sc_tracer.edge(&${keepAttempt}); sc_tracer.edge(&${keepRecover}); })) }`;
    }
    case "effect.tryPromiseUnknown": {
      if (first === undefined || first.type.kind !== "func") break;
      const attempt = context.nextTemporary();
      const keepAttempt = context.nextTemporary();
      const attemptDispatch = context.emitClosureDispatch(attempt, first.type, [], expr.loc);
      return `{ let ${attempt} = ${context.emitExpr(first)}; let ${keepAttempt} = ${attempt}.clone(); runtime::effect_try_promise_unknown(std::rc::Rc::new(move || runtime::promise_to_handle(&(${attemptDispatch}))), Box::new(move |sc_tracer: &mut runtime::Tracer<'_>| { sc_tracer.edge(&${keepAttempt}); })) }`;
    }
    case "effect.fn":
    case "effect.fnPipe": {
      if (first === undefined || first.type.kind !== "func" || first.type.ret.kind !== "generator" || expr.type.kind !== "func") break;
      const ret = first.type.ret.retT;
      const retType = ret.kind === "void" || ret.kind === "undefinedT" ? "()" : context.rustType(ret, expr.loc);
      const body = context.nextTemporary();
      const keep = context.nextTemporary();
      const shape = context.rustType(expr.type, expr.loc).replace(/^runtime::Gc<|>$/g, "");
      const params = expr.type.params.map((type, index) => `sc_p${index}: ${context.rustType(type, expr.loc)}`).join(", ");
      const args = expr.type.params.map((_, index) => `sc_p${index}.clone()`);
      const dispatch = context.emitClosureDispatch("sc_body", first.type, args, expr.loc);
      const generated = `runtime::effect_gen::<${retType}>(std::rc::Rc::new(move || ${dispatch}), Box::new(move |sc_tracer: &mut runtime::Tracer<'_>| sc_tracer.edge(&sc_keep)))`;
      if (second === undefined) {
        return `{ let ${body} = ${context.emitExpr(first)}; let ${keep} = ${body}.clone(); runtime::Gc::new(${shape}::RuntimeCallback { callback: Some(std::rc::Rc::new(move |${params}| { let sc_body = ${body}.clone(); let sc_keep = sc_body.clone(); ${generated} })), trace: Some(std::rc::Rc::new(move |sc_tracer: &mut runtime::Tracer<'_>| sc_tracer.edge(&${keep}))) }) }`;
      }
      // Pipeline steps: the lifted `(effect) => effect` runs over each call's generated effect.
      if (second.type.kind !== "func") break;
      const post = context.nextTemporary();
      const keepPost = context.nextTemporary();
      const applied = context.emitClosureDispatch("sc_post", second.type, ["sc_eff"], expr.loc);
      return `{ let ${body} = ${context.emitExpr(first)}; let ${keep} = ${body}.clone(); let ${post} = ${context.emitExpr(second)}; let ${keepPost} = ${post}.clone(); runtime::Gc::new(${shape}::RuntimeCallback { callback: Some(std::rc::Rc::new(move |${params}| { let sc_body = ${body}.clone(); let sc_keep = sc_body.clone(); let sc_post = ${post}.clone(); let sc_eff = ${generated}; ${applied} })), trace: Some(std::rc::Rc::new(move |sc_tracer: &mut runtime::Tracer<'_>| { sc_tracer.edge(&${keep}); sc_tracer.edge(&${keepPost}); })) }) }`;
    }
    case "effect.void":
      return "runtime::effect_succeed(runtime::effect_box(()))";
    case "effect.as":
      if (first === undefined || second === undefined) break;
      return `runtime::effect_as(&${context.emitExpr(first)}, ${box(context, second.type, context.emitExpr(second), expr.loc)})`;
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
      return `runtime::effect_provide_service(&${context.emitExpr(first)}, &${context.emitExpr(second)}, ${box(context, expr.args[2].type, context.emitExpr(expr.args[2]), expr.loc)})`;
    case "effect.provide":
      if (first === undefined || second === undefined) break;
      return `runtime::effect_provide(&${context.emitExpr(first)}, &${context.emitExpr(second)})`;
    case "layer.empty":
      return "runtime::layer_empty()";
    case "layer.succeed":
      if (first === undefined || second === undefined) break;
      return `runtime::layer_succeed(&${context.emitExpr(first)}, ${box(context, second.type, context.emitExpr(second), expr.loc)})`;
    case "layer.effectDiscard":
      if (first === undefined) break;
      return `runtime::layer_effect_discard(&${context.emitExpr(first)})`;
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
      return `{ let ${items} = ${context.emitExpr(first)}; let sc_len = runtime::array_len(&${items}) as usize; let mut sc_boxed: Vec<runtime::EffectValue> = Vec::with_capacity(sc_len); for sc_i in 0..sc_len { sc_boxed.push(${box(context, first.type.elem, `runtime::array_get(&${items}, sc_i as f64)`, expr.loc)}); } let ${callback} = ${context.emitExpr(second)}; let ${keep} = ${callback}.clone(); runtime::effect_for_each(sc_boxed, std::rc::Rc::new(move |sc_value: runtime::EffectValue, sc_index: f64| { let _ = sc_index; let sc_arg: ${context.rustType(param, expr.loc)} = ${unbox(context, param, "&sc_value", expr.loc)}; ${dispatch} }), ${collector(carrier, context, expr.loc)}, ${traced(context, keep)}) }`;
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
      const bind = param === undefined ? "" : `let sc_arg: ${context.rustType(param, expr.loc)} = ${unbox(context, param, "&sc_value", expr.loc)};`;
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
      const releaseClosure = `std::rc::Rc::new(move |sc_value: runtime::EffectValue, sc_exit: runtime::JsEffect| { let _ = &sc_exit; let sc_arg: ${context.rustType(resource, expr.loc)} = ${unbox(context, resource, "&sc_value", expr.loc)}; ${releaseDispatch} })`;
      if (expr.fn === "effect.acquireRelease") {
        return `{ let ${acquire} = ${context.emitExpr(first)}; let ${releaseFn} = ${context.emitExpr(release)}; let ${keepRelease} = ${releaseFn}.clone(); runtime::effect_acquire_release(&${acquire}, ${releaseClosure}, ${traced(context, keepRelease)}) }`;
      }
      if (second === undefined || second.type.kind !== "func" || second.type.params[0] === undefined) break;
      const useFn = context.nextTemporary();
      const keepUse = context.nextTemporary();
      const useDispatch = context.emitClosureDispatch(useFn, second.type, ["sc_arg"], expr.loc);
      const useClosure = `std::rc::Rc::new(move |sc_value: runtime::EffectValue| { let sc_arg: ${context.rustType(second.type.params[0], expr.loc)} = ${unbox(context, second.type.params[0], "&sc_value", expr.loc)}; ${useDispatch} })`;
      return `{ let ${acquire} = ${context.emitExpr(first)}; let ${useFn} = ${context.emitExpr(second)}; let ${keepUse} = ${useFn}.clone(); let ${releaseFn} = ${context.emitExpr(release)}; let ${keepRelease} = ${releaseFn}.clone(); runtime::effect_acquire_use_release(&${acquire}, ${useClosure}, ${releaseClosure}, Box::new(move |sc_tracer: &mut runtime::Tracer<'_>| { sc_tracer.edge(&${keepUse}); sc_tracer.edge(&${keepRelease}); })) }`;
    }
    case "effect.exitSucceed":
    case "effect.exitFail":
      if (first === undefined) break;
      return `runtime::${expr.fn === "effect.exitSucceed" ? "effect_exit_succeed" : "effect_exit_fail"}(${box(context, first.type, context.emitExpr(first), expr.loc)})`;
    case "effect.exitIsSuccess":
    case "effect.exitIsFailure":
      if (first === undefined) break;
      return `${expr.fn === "effect.exitIsFailure" ? "!" : ""}runtime::effect_exit_is_success(&${context.emitExpr(first)})`;
    case "effect.dataTag":
      if (first === undefined) break;
      return `runtime::effect_data_tag(&${context.emitExpr(first)})`;
    case "effect.dataMessage":
      if (first === undefined) break;
      return `runtime::schema_error_message(&${context.emitExpr(first)})`;
    case "effect.durationMillis":
      if (first === undefined) break;
      return `runtime::effect_duration_millis(${context.emitExpr(first)})`;
    case "effect.durationToMillis":
      if (first === undefined) break;
      return `runtime::effect_duration_to_millis(&${context.emitExpr(first)})`;
    case "effect.refMake":
    case "effect.refMakeUnsafe": {
      if (first === undefined) break;
      const made = box(context, first.type, context.emitExpr(first), expr.loc);
      return `runtime::${expr.fn === "effect.refMake" ? "effect_ref_make" : "effect_ref_make_unsafe"}(${made})`;
    }
    case "effect.refGet":
      if (first === undefined) break;
      return `runtime::effect_ref_get(&${context.emitExpr(first)})`;
    case "effect.refSet": {
      const keepArg = expr.args[2];
      if (first === undefined || second === undefined || keepArg === undefined) break;
      return `runtime::effect_ref_set(&${context.emitExpr(first)}, ${box(context, second.type, context.emitExpr(second), expr.loc)}, ${context.emitExpr(keepArg)})`;
    }
    case "effect.refUpdate": {
      // The third argument says which value the effect answers: 0 unit (update), 1 the previous (getAndSet), 2 the next (updateAndGet).
      const third = expr.args[2];
      if (first === undefined || second === undefined || third === undefined || second.type.kind !== "func") break;
      const param = second.type.params[0];
      const cell = context.nextTemporary();
      const callback = context.nextTemporary();
      const keep = context.nextTemporary();
      const dispatch = context.emitClosureDispatch(callback, second.type, param === undefined ? [] : ["sc_arg"], expr.loc);
      const bind = param === undefined ? "" : `let sc_arg: ${context.rustType(param, expr.loc)} = ${unbox(context, param, "&sc_value", expr.loc)};`;
      return `{ let ${cell} = ${context.emitExpr(first)}; let ${callback} = ${context.emitExpr(second)}; let ${keep} = ${callback}.clone(); runtime::effect_ref_update(&${cell}, std::rc::Rc::new(move |sc_value: runtime::EffectValue| { let _ = &sc_value; ${bind} ${box(context, second.type.ret, dispatch, expr.loc)} }), ${context.emitExpr(third)}, ${traced(context, keep)}) }`;
    }
    case "effect.refUpdateEffect": {
      if (first === undefined || second === undefined || second.type.kind !== "func") break;
      const param = second.type.params[0];
      const cell = context.nextTemporary();
      const callback = context.nextTemporary();
      const keep = context.nextTemporary();
      const dispatch = context.emitClosureDispatch(callback, second.type, param === undefined ? [] : ["sc_arg"], expr.loc);
      const bind = param === undefined ? "" : `let sc_arg: ${context.rustType(param, expr.loc)} = ${unbox(context, param, "&sc_value", expr.loc)};`;
      return `{ let ${cell} = ${context.emitExpr(first)}; let ${callback} = ${context.emitExpr(second)}; let ${keep} = ${callback}.clone(); runtime::effect_ref_update_effect(&${cell}, std::rc::Rc::new(move |sc_value: runtime::EffectValue| { let _ = &sc_value; ${bind} ${dispatch} }), ${traced(context, keep)}) }`;
    }
    case "effect.deferredMake":
      return "runtime::effect_deferred_make()";
    case "effect.deferredAwait":
      if (first === undefined) break;
      return `runtime::effect_deferred_await(&${context.emitExpr(first)})`;
    case "effect.deferredIsDone":
      if (first === undefined) break;
      return `runtime::effect_deferred_is_done(&${context.emitExpr(first)})`;
    case "effect.deferredSettle": {
      const okArg = expr.args[2];
      if (first === undefined || second === undefined || okArg === undefined) break;
      return `runtime::effect_deferred_settle(&${context.emitExpr(first)}, ${box(context, second.type, context.emitExpr(second), expr.loc)}, ${context.emitExpr(okArg)})`;
    }
    case "effect.semaphoreMake":
    case "effect.semaphoreMakeUnsafe":
      if (first === undefined) break;
      return `runtime::${expr.fn === "effect.semaphoreMake" ? "effect_semaphore_make" : "effect_semaphore_make_unsafe"}(${context.emitExpr(first)})`;
    case "effect.semaphoreWithPermits": {
      const body = expr.args[2];
      if (first === undefined || second === undefined || body === undefined) break;
      return `runtime::effect_semaphore_with_permits(&${context.emitExpr(first)}, ${context.emitExpr(second)}, &${context.emitExpr(body)})`;
    }
    case "effect.queueMake":
      if (first === undefined || second === undefined) break;
      return `runtime::effect_queue_make(${context.emitExpr(first)}, ${context.emitExpr(second)})`;
    case "effect.queueTake":
      if (first === undefined) break;
      return `runtime::effect_queue_take(&${context.emitExpr(first)})`;
    case "effect.queueSize":
      if (first === undefined) break;
      return `runtime::effect_queue_size(&${context.emitExpr(first)})`;
    case "effect.queueShutdown":
      if (first === undefined) break;
      return `runtime::effect_queue_shutdown(&${context.emitExpr(first)})`;
    case "effect.queueOffer":
      if (first === undefined || second === undefined) break;
      return `runtime::effect_queue_offer(&${context.emitExpr(first)}, ${box(context, second.type, context.emitExpr(second), expr.loc)})`;
    case "effect.pubsubMake":
      if (first === undefined || second === undefined) break;
      return `runtime::effect_pubsub_make(${context.emitExpr(first)}, ${context.emitExpr(second)})`;
    case "effect.pubsubSubscribe":
      if (first === undefined) break;
      return `runtime::effect_pubsub_subscribe(&${context.emitExpr(first)})`;
    case "effect.pubsubShutdown":
      if (first === undefined) break;
      return `runtime::effect_pubsub_shutdown(&${context.emitExpr(first)})`;
    case "effect.pubsubPublish":
      if (first === undefined || second === undefined) break;
      return `runtime::effect_pubsub_publish(&${context.emitExpr(first)}, ${box(context, second.type, context.emitExpr(second), expr.loc)})`;
    case "effect.causeFail":
      if (first === undefined) break;
      return `runtime::effect_cause_new(false, ${box(context, first.type, context.emitExpr(first), expr.loc)})`;
    case "effect.causeSquash":
      if (first === undefined) break;
      return unbox(context, expr.type, `&runtime::effect_cause_squash(&${context.emitExpr(first)})`, expr.loc);
    case "effect.causeHas":
      if (first === undefined || second === undefined) break;
      return `runtime::effect_cause_has(&${context.emitExpr(first)}, ${context.emitExpr(second)})`;
    case "effect.tapErrorCause":
    case "effect.catchCause": {
      if (first === undefined || second === undefined || second.type.kind !== "func") break;
      const source = context.nextTemporary();
      const callback = context.nextTemporary();
      const keep = context.nextTemporary();
      const param = second.type.params[0];
      const dispatch = context.emitClosureDispatch(callback, second.type, param === undefined ? [] : ["sc_arg"], expr.loc);
      const bind = param === undefined ? "" : `let sc_arg: ${context.rustType(param, expr.loc)} = ${unbox(context, param, "&sc_value", expr.loc)};`;
      return `{ let ${source} = ${context.emitExpr(first)}; let ${callback} = ${context.emitExpr(second)}; let ${keep} = ${callback}.clone(); runtime::${expr.fn === "effect.tapErrorCause" ? "effect_tap_error_cause" : "effect_catch_cause"}(&${source}, std::rc::Rc::new(move |sc_value: runtime::EffectValue| { let _ = &sc_value; ${bind} ${dispatch} }), ${traced(context, keep)}) }`;
    }
    case "effect.exitValue":
      if (first === undefined) break;
      return unbox(context, expr.type, `&runtime::effect_exit_value(&${context.emitExpr(first)})`, expr.loc);
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
      return `{ let ${attempt} = ${context.emitExpr(first)}; let ${recover} = ${context.emitExpr(second)}; let ${keepAttempt} = ${attempt}.clone(); let ${keepRecover} = ${recover}.clone(); runtime::effect_try(std::rc::Rc::new(move || ${box(context, first.type.ret, attemptDispatch, expr.loc)}), std::rc::Rc::new(move |sc_caught: runtime::Caught| { let _ = &sc_caught; ${bind} ${box(context, second.type.ret, recoverDispatch, expr.loc)} }), Box::new(move |sc_tracer: &mut runtime::Tracer<'_>| { sc_tracer.edge(&${keepAttempt}); sc_tracer.edge(&${keepRecover}); })) }`;
    }
    case "effect.orElseSucceed": {
      if (first === undefined || second === undefined || second.type.kind !== "func") break;
      const callback = context.nextTemporary();
      const keep = context.nextTemporary();
      const dispatch = context.emitClosureDispatch(callback, second.type, [], expr.loc);
      return `{ let ${callback} = ${context.emitExpr(second)}; let ${keep} = ${callback}.clone(); runtime::effect_or_else_succeed(&${context.emitExpr(first)}, std::rc::Rc::new(move || ${box(context, second.type.ret, dispatch, expr.loc)}), ${traced(context, keep)}) }`;
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
      const handlerType = handler.type.params[0] ?? errorType;
      return `{ let ${predicate} = ${context.emitExpr(second)}; let ${recover} = ${context.emitExpr(handler)}; let ${keepPredicate} = ${predicate}.clone(); let ${keepRecover} = ${recover}.clone(); runtime::effect_catch_if(&${context.emitExpr(first)}, std::rc::Rc::new(move |sc_value: runtime::EffectValue| { let sc_arg: ${errorRust} = ${unbox(context, errorType, "&sc_value", expr.loc)}; ${predicateDispatch} }), std::rc::Rc::new(move |sc_value: runtime::EffectValue| { let sc_arg: ${context.rustType(handlerType, expr.loc)} = ${unbox(context, handlerType, "&sc_value", expr.loc)}; let _ = &sc_arg; ${recoverDispatch} }), Box::new(move |sc_tracer: &mut runtime::Tracer<'_>| { sc_tracer.edge(&${keepPredicate}); sc_tracer.edge(&${keepRecover}); })) }`;
    }
    case "effect.catchTag": {
      // The failure matches when its box holds the handler's (tag-narrowed) parameter type: the class the tag names.
      const handler = expr.args[2];
      if (first === undefined || second === undefined || handler === undefined || handler.type.kind !== "func") break;
      const narrowed = handler.type.params[0];
      if (narrowed === undefined || narrowed.kind === "union") return context.unsupported("Effect.catchTag over a handler whose error parameter is not one class", expr.loc);
      const recover = context.nextTemporary();
      const keepRecover = context.nextTemporary();
      const recoverDispatch = context.emitClosureDispatch(recover, handler.type, ["sc_arg"], expr.loc);
      const narrowedRust = context.rustType(narrowed, expr.loc);
      return `{ let ${recover} = ${context.emitExpr(handler)}; let ${keepRecover} = ${recover}.clone(); runtime::effect_catch_if(&${context.emitExpr(first)}, std::rc::Rc::new(move |sc_value: runtime::EffectValue| sc_value.downcast_ref::<${narrowedRust}>().is_some()), std::rc::Rc::new(move |sc_value: runtime::EffectValue| { let sc_arg: ${narrowedRust} = runtime::effect_unbox(&sc_value); ${recoverDispatch} }), ${traced(context, keepRecover)}) }`;
    }
    case "option.some":
      if (first === undefined) break;
      return `runtime::option_some(${box(context, first.type, context.emitExpr(first), expr.loc)})`;
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
      return `{ let ${callback} = ${context.emitExpr(second)}; match runtime::option_get(&${context.emitExpr(first)}) { Some(sc_v) => ${unbox(context, expr.type, "&sc_v", expr.loc)}, None => ${dispatch} } }`;
    }
    case "option.map": {
      if (first === undefined || second === undefined || second.type.kind !== "func" || second.type.params[0] === undefined) break;
      const callback = context.nextTemporary();
      const dispatch = context.emitClosureDispatch(callback, second.type, ["sc_arg"], expr.loc);
      return `{ let ${callback} = ${context.emitExpr(second)}; match runtime::option_get(&${context.emitExpr(first)}) { Some(sc_v) => { let sc_arg: ${context.rustType(second.type.params[0], expr.loc)} = ${unbox(context, second.type.params[0], "&sc_v", expr.loc)}; runtime::option_some(${box(context, second.type.ret, dispatch, expr.loc)}) }, None => runtime::option_none() } }`;
    }
    case "option.match": {
      const onSome = expr.args[2];
      if (first === undefined || second === undefined || onSome === undefined || second.type.kind !== "func" || onSome.type.kind !== "func" || onSome.type.params[0] === undefined) break;
      const none = context.nextTemporary();
      const some = context.nextTemporary();
      const noneDispatch = context.emitClosureDispatch(none, second.type, [], expr.loc);
      const someDispatch = context.emitClosureDispatch(some, onSome.type, ["sc_arg"], expr.loc);
      return `{ let ${none} = ${context.emitExpr(second)}; let ${some} = ${context.emitExpr(onSome)}; match runtime::option_get(&${context.emitExpr(first)}) { Some(sc_v) => { let sc_arg: ${context.rustType(onSome.type.params[0], expr.loc)} = ${unbox(context, onSome.type.params[0], "&sc_v", expr.loc)}; ${someDispatch} }, None => ${noneDispatch} } }`;
    }
    case "effect.fail":
    case "effect.die":
      if (first === undefined) break;
      return `runtime::${expr.fn === "effect.fail" ? "effect_fail" : "effect_die"}(${box(context, first.type, context.emitExpr(first), expr.loc)})`;
    case "effect.orDie":
      if (first === undefined) break;
      return `runtime::effect_or_die(&${context.emitExpr(first)})`;
    case "effect.runSync":
      if (first === undefined) break;
      return unbox(context, expr.type, `&runtime::effect_run_sync(&${context.emitExpr(first)})`, expr.loc);
    case "effect.runPromise":
      if (first === undefined || expr.type.kind !== "promise") break;
      return `runtime::effect_run_promise::<${context.rustType(expr.type.inner, expr.loc)}>(&${context.emitExpr(first)}, std::rc::Rc::new(|sc_boxed: &runtime::EffectValue| ${unbox(context, expr.type.inner, "sc_boxed", expr.loc)}))`;
    default:
      break;
  }
  return context.unsupported(`${expr.fn} argument shape`, expr.loc);
}

/** The Schema kernel's lib calls (runtime/schema.rs): descriptors are kernel handles built from literal shapes; the
 * decoders are runtime-callback closures over the program's dynamic value whose result converts to the site's type. */
function emitRustSchemaCall(expr: RustLibCallExpr, context: RustLibCallContext): string {
  const first = expr.args[0];
  const second = expr.args[1];
  const handles = (arg: RustLibCallExpr["args"][number] | undefined): string[] | null =>
    arg !== undefined && arg.kind === "arrayLit" && arg.spreads === undefined && arg.elems.every((e) => e.type.kind === "effect") ? arg.elems.map((e) => context.emitExpr(e)) : null;
  switch (expr.fn) {
    case "schema.prim":
      if (first === undefined) break;
      return `runtime::schema_prim(&${context.emitExpr(first)})`;
    case "schema.literal": {
      if (first === undefined || first.kind !== "arrayLit" || first.spreads !== undefined) break;
      const literals = first.elems.map((e) => {
        const value = context.emitExpr(e);
        if (e.type.kind === "string") return `runtime::SchemaLiteral::Str(${value})`;
        if (e.type.kind === "f64") return `runtime::SchemaLiteral::Num(${value})`;
        if (e.type.kind === "bool") return `runtime::SchemaLiteral::Bool(${value})`;
        return context.unsupported("Schema.Literal over this literal kind", expr.loc);
      });
      return `runtime::schema_literal(vec![${literals.join(", ")}])`;
    }
    case "schema.struct": {
      if (first === undefined || first.kind !== "recordLit") break;
      const fields = first.fields.map((field) => {
        if (field.value.type.kind !== "effect") return context.unsupported("Schema.Struct over a non-schema field", expr.loc);
        return `(runtime::string("${context.rustString(field.name)}"), ${context.emitExpr(field.value)})`;
      });
      return `runtime::schema_struct(vec![${fields.join(", ")}])`;
    }
    case "schema.array":
      if (first === undefined) break;
      return `runtime::schema_array(&${context.emitExpr(first)})`;
    case "schema.record":
      if (first === undefined || second === undefined) break;
      return `runtime::schema_record(&${context.emitExpr(first)}, &${context.emitExpr(second)})`;
    case "schema.union": {
      const members = handles(first);
      if (members !== null) return `runtime::schema_union(vec![${members.join(", ")}])`;
      if (first === undefined || first.type.kind !== "array" || first.type.elem.kind !== "effect") break;
      return `runtime::schema_union(runtime::array_values(&${context.emitExpr(first)}))`;
    }
    case "schema.tuple": {
      const elements = handles(first);
      if (elements !== null) return `runtime::schema_tuple(vec![${elements.join(", ")}])`;
      if (first === undefined || first.type.kind !== "array" || first.type.elem.kind !== "effect") break;
      return `runtime::schema_tuple(runtime::array_values(&${context.emitExpr(first)}))`;
    }
    case "schema.decodeTo": {
      // The program's transform runs BETWEEN the two decoders: the source's decoded value (the program's dynamic
      // value) converts to the transform's parameter type, and its result converts back for the target decoder.
      const transform = expr.args[2];
      if (first === undefined || second === undefined || transform === undefined || transform.type.kind !== "func") break;
      const param = transform.type.params[0];
      if (param === undefined) break;
      const callback = context.nextTemporary();
      const keep = context.nextTemporary();
      const dispatch = context.emitClosureDispatch(callback, transform.type, ["sc_arg"], expr.loc);
      const dynIn = context.emitDynCheckValue(param, "sc_dyn", expr.loc);
      const dynOut = context.emitDynFromValue(transform.type.ret, dispatch, expr.loc);
      return `{ let ${callback} = ${context.emitExpr(transform)}; let ${keep} = ${callback}.clone(); let _ = &${keep}; runtime::schema_decode_to(&${context.emitExpr(first)}, &${context.emitExpr(second)}, std::rc::Rc::new(move |sc_boxed: runtime::EffectValue| { let sc_dyn: sc_dyn_value = match sc_boxed.downcast_ref::<sc_dyn_value>() { Some(sc_v) => sc_v.clone(), None => runtime::throw_error("scriptc: a schema transform received a foreign value".to_owned()) }; let sc_arg: ${context.rustType(param, expr.loc)} = ${dynIn}; std::rc::Rc::new(${dynOut}) as runtime::EffectValue })) }`;
    }
    case "schema.wrap":
      if (first === undefined || second === undefined) break;
      return `runtime::schema_wrap(&${context.emitExpr(first)}, &${context.emitExpr(second)})`;
    case "schema.filterPattern":
      if (first === undefined || second === undefined) break;
      return `runtime::schema_filter_pattern(&${context.emitExpr(first)}, &${context.emitExpr(second)})`;
    case "schema.filterBetween":
      if (first === undefined || second === undefined) break;
      return `runtime::schema_filter_between(${context.emitExpr(first)}, ${context.emitExpr(second)})`;
    case "schema.filter":
      if (first === undefined || second === undefined || expr.args[2] === undefined) break;
      return `runtime::schema_filter(&${context.emitExpr(first)}, ${context.emitExpr(second)}, &${context.emitExpr(expr.args[2])})`;
    case "schema.check":
      if (first === undefined || second === undefined) break;
      return `runtime::schema_check(&${context.emitExpr(first)}, &${context.emitExpr(second)})`;
    case "schema.test":
      if (first === undefined || second === undefined) break;
      return `runtime::schema_decode(&${context.emitExpr(first)}, &${context.emitExpr(second)}).is_ok()`;
    case "schema.make":
      // The props (as a dynamic value) with the Struct's constructor defaults applied, converted to the site's Type.
      if (first === undefined || second === undefined) break;
      return context.emitDynCheckValue(expr.type, `runtime::schema_make(&${context.emitExpr(first)}, &${context.emitExpr(second)})`, expr.loc);
    case "schema.decodeSync":
    case "schema.decodeOption":
    case "schema.decodeEffect":
    case "schema.decodeExit":
    case "schema.is":
    case "schema.encodeSync": {
      if (first === undefined || expr.type.kind !== "func" || expr.type.params[0] === undefined) break;
      const input = expr.type.params[0];
      const ret = expr.type.ret;
      const shape = context.rustType(expr.type, expr.loc).replace(/^runtime::Gc<|>$/g, "");
      const params = expr.type.params.map((type, index) => `sc_p${index}: ${context.rustType(type, expr.loc)}`).join(", ");
      const unused = expr.type.params.map((_, index) => (index === 0 ? "" : `let _ = &sc_p${index};`)).join(" ");
      let body: string;
      if (expr.fn === "schema.encodeSync") {
        if (!typeEquals(input, ret)) return context.unsupported("Schema.encodeSync over a transforming schema", expr.loc);
        body = "sc_p0.clone()";
      } else {
        if (input.kind !== "dyn") return context.unsupported("a schema decoder whose input is not unknown", expr.loc);
        const decoded = `runtime::schema_decode(&sc_schema, &sc_p0)`;
        if (expr.fn === "schema.is") body = `${decoded}.is_ok()`;
        else {
          // The decoded dynamic value converts to the site's type (the schema's `Type`, as the checker knows it).
          const valueType = ret.kind === "effect" && expr.fn !== "schema.decodeSync" ? decodeValueType(context, expr) : ret;
          const typed = context.emitDynCheckValue(valueType, "sc_v", expr.loc);
          const boxed = box(context, valueType, typed, expr.loc);
          body = expr.fn === "schema.decodeSync" ? `match ${decoded} { Ok(sc_v) => ${typed}, Err(sc_m) => runtime::schema_throw(sc_m) }`
            : expr.fn === "schema.decodeOption" ? `match ${decoded} { Ok(sc_v) => runtime::option_some(${boxed}), Err(_) => runtime::option_none() }`
            : expr.fn === "schema.decodeEffect" ? `match ${decoded} { Ok(sc_v) => runtime::effect_succeed(${boxed}), Err(sc_m) => runtime::effect_fail(runtime::effect_box(runtime::schema_error_handle(sc_m))) }`
            : `match ${decoded} { Ok(sc_v) => runtime::effect_exit_succeed(${boxed}), Err(sc_m) => runtime::effect_exit_fail(runtime::effect_box(runtime::schema_error_handle(sc_m))) }`;
        }
      }
      return `{ let sc_schema = ${context.emitExpr(first)}; let sc_keep = sc_schema.clone(); runtime::Gc::new(${shape}::RuntimeCallback { callback: Some(std::rc::Rc::new(move |${params}| { ${unused} ${body} })), trace: Some(std::rc::Rc::new(move |sc_tracer: &mut runtime::Tracer<'_>| sc_tracer.edge(&sc_keep))) }) }`;
    }
    default:
      break;
  }
  return context.unsupported(`${expr.fn} argument shape`, expr.loc);
}

/** The decoded VALUE type of an Option/Effect/Exit-returning decoder: the lowering stamps it as the call's second
 * argument — an empty array literal of that element type (the collection-carrier precedent) — since the func type
 * only says "handle". */
function decodeValueType(context: RustLibCallContext, expr: RustLibCallExpr): IrType {
  const carrier = expr.args[1];
  if (carrier === undefined || carrier.type.kind !== "array") return context.unsupported("a schema decoder without its value carrier", expr.loc);
  return carrier.type.elem;
}
