import type { IrFunction } from "../../ir/nodes.js";
import { mangleGlobal } from "../mangle.js";
import type { RustDefinitionContext } from "./definitions.js";
import type { RustLibCallContext, RustLibCallExpr } from "./lib-calls.js";

export function emitRustNativeModuleCall(expr: RustLibCallExpr, context: RustLibCallContext): string | null {
  const argument = expr.args[0];
  if (expr.fn === "module.namespace" && expr.args.length === 1 && argument?.type.kind === "jsval") {
    const namespace = context.nextTemporary();
    return `{ let ${namespace} = ${context.emitExpr(argument)}; if let ${context.dynTypeName()}::Object(sc_fields) = &${namespace} { runtime::map_mark_module_namespace(sc_fields); } else { runtime::throw_type_error("module namespace must be an object".to_owned()); } ${namespace} }`;
  }
  if (expr.fn !== "module.import") return null;
  if (expr.args.length !== 1 || argument?.type.kind !== "func" || argument.type.params.length !== 0 ||
      argument.type.ret.kind !== "promise" || argument.type.ret.inner.kind !== "jsval" ||
      expr.type.kind !== "promise" || expr.type.inner.kind !== "jsval") {
    return context.unsupported("module.import loader signature", expr.loc);
  }
  const loader = context.nextTemporary();
  const invoke = context.emitClosureDispatch(loader, argument.type, [], expr.loc);
  return `{ let ${loader} = ${context.emitExpr(argument)}; runtime::module_import(move || ${invoke}) }`;
}

/** Keep synchronous ESM evaluation synchronous while remembering failures. */
export function emitRustSyncModuleBody(fn: IrFunction, context: RustDefinitionContext): void {
  const cacheId = fn.syncModuleCacheGlobal;
  if (cacheId === undefined) return context.emitStatements(fn.body);
  const cache = mangleGlobal(cacheId);
  context.line(`if let Some(sc_cached) = ${cache}.with(|slot| slot.borrow().clone()) { return runtime::module_cached_sync(&sc_cached); }`);
  context.line("let sc_evaluation = runtime::promise_new::<()>();");
  context.line(`${cache}.with(|slot| *slot.borrow_mut() = Some(sc_evaluation.clone()));`);
  context.line("runtime::module_evaluate_sync(&sc_evaluation, || {");
  context.pushIndent();
  context.emitStatements(fn.body);
  context.popIndent();
  context.line("});");
}
