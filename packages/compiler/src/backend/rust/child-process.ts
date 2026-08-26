import type { IrType } from "../../ir/nodes.js";
import type { RustLibCallContext, RustLibCallExpr } from "./lib-calls.js";

type IrFuncType = Extract<IrType, { kind: "func" }>;

function unionArgument(
  type: IrType,
  value: string,
  empty: "nullT" | "undefinedT",
  context: RustLibCallContext,
  expr: RustLibCallExpr,
): string {
  if (type.kind !== "union") context.unsupported("child listener parameter without a union", expr.loc);
  const union = context.union(type.unionId, expr.loc);
  const valueTag = union.arms.findIndex((arm) => arm.kind === "f64");
  const emptyTag = union.arms.findIndex((arm) => arm.kind === empty);
  if (valueTag < 0 || emptyTag < 0) context.unsupported("child listener union shape", expr.loc);
  const name = context.unionName(union.id);
  return `match ${value} { Some(value) => ${name}::${context.unionVariant(valueTag)}(value), None => ${name}::${context.unionVariant(emptyTag)}, }`;
}

function signalArgument(
  type: IrType,
  context: RustLibCallContext,
  expr: RustLibCallExpr,
): string {
  if (type.kind !== "union") context.unsupported("child exit signal without a union", expr.loc);
  const union = context.union(type.unionId, expr.loc);
  const valueTag = union.arms.findIndex((arm) => arm.kind === "string");
  const nullTag = union.arms.findIndex((arm) => arm.kind === "nullT");
  if (valueTag < 0 || nullTag < 0) context.unsupported("child exit signal union shape", expr.loc);
  const name = context.unionName(union.id);
  return `match sc_signal { Some(value) => ${name}::${context.unionVariant(valueTag)}(value), None => ${name}::${context.unionVariant(nullTag)}, }`;
}

function emitExitListener(
  expr: RustLibCallExpr,
  callbackType: IrFuncType,
  context: RustLibCallContext,
): string {
  const receiverExpr = expr.args[0];
  const callbackExpr = expr.args[1];
  if (receiverExpr === undefined || callbackExpr === undefined) {
    context.unsupported("child exit listener arguments", expr.loc);
  }
  const child = context.nextTemporary();
  const callback = context.nextTemporary();
  const traced = context.nextTemporary();
  const args: string[] = [];
  const bindings: string[] = [];
  const codeType = callbackType.params[0];
  if (codeType !== undefined) {
    bindings.push(`let sc_code_arg = ${unionArgument(codeType, "sc_code", "nullT", context, expr)};`);
    args.push("sc_code_arg");
  }
  const signalType = callbackType.params[1];
  if (signalType !== undefined) {
    bindings.push(`let sc_signal_arg = ${signalArgument(signalType, context, expr)};`);
    args.push("sc_signal_arg");
  }
  const dispatch = context.emitClosureDispatch(callback, callbackType, args, expr.loc);
  const codeName = codeType === undefined ? "_sc_code" : "sc_code";
  const signalName = signalType === undefined ? "_sc_signal" : "sc_signal";
  return `{ let ${child} = ${context.emitExpr(receiverExpr)}; let ${callback} = ${context.emitExpr(callbackExpr)}; let ${traced} = ${callback}.clone(); runtime::child_on_exit(&${child}, Box::new(move |${codeName}, ${signalName}| { ${bindings.join(" ")} let _ = ${dispatch}; }), Box::new(move |sc_tracer: &mut runtime::Tracer<'_>| sc_tracer.edge(&${traced}))); }`;
}

function emitErrorListener(
  expr: RustLibCallExpr,
  callbackType: IrFuncType,
  context: RustLibCallContext,
): string {
  const receiverExpr = expr.args[0];
  const callbackExpr = expr.args[1];
  if (receiverExpr === undefined || callbackExpr === undefined) {
    context.unsupported("child error listener arguments", expr.loc);
  }
  const child = context.nextTemporary();
  const callback = context.nextTemporary();
  const traced = context.nextTemporary();
  const parameter = callbackType.params[0];
  const argument = context.hasErrorClassRoots()
    ? `${context.errorValueName()}::Builtin(sc_error)`
    : "sc_error";
  const dispatch = context.emitClosureDispatch(callback, callbackType, parameter === undefined ? [] : [argument], expr.loc);
  const errorName = parameter === undefined ? "_sc_error" : "sc_error";
  return `{ let ${child} = ${context.emitExpr(receiverExpr)}; let ${callback} = ${context.emitExpr(callbackExpr)}; let ${traced} = ${callback}.clone(); runtime::child_on_error(&${child}, Box::new(move |${errorName}| { let _ = ${dispatch}; }), Box::new(move |sc_tracer: &mut runtime::Tracer<'_>| sc_tracer.edge(&${traced}))); }`;
}

export function emitRustChildProcessCall(
  expr: RustLibCallExpr,
  context: RustLibCallContext,
): string | null {
  if (expr.fn === "cp.spawn" && expr.args.length === 2 &&
      expr.args[0]?.type.kind === "string" && expr.args[1]?.type.kind === "array" &&
      expr.args[1].type.elem.kind === "string") {
    return `runtime::child_spawn(&(${context.emitExpr(expr.args[0])}), &(${context.emitExpr(expr.args[1])}))`;
  }
  if (expr.fn === "cp.spawnOpts" && expr.args.length === 11) {
    const [command, arguments_, stdinMode, stdoutMode, stderrMode, , , detached, hasEnv, envPairs, cwd] = expr.args;
    if (command?.type.kind !== "string" || arguments_?.type.kind !== "array" ||
        arguments_.type.elem.kind !== "string" || stdinMode?.kind !== "numLit" ||
        stdoutMode?.kind !== "numLit" || stderrMode?.kind !== "numLit" ||
        detached?.type.kind !== "bool" || hasEnv?.type.kind !== "bool" ||
        envPairs?.type.kind !== "array" || envPairs.type.elem.kind !== "string" || cwd?.type.kind !== "string") {
      context.unsupported("cp.spawnOpts argument shape", expr.loc);
    }
    if ([stdinMode.value, stdoutMode.value, stderrMode.value].some((mode) => mode !== 0 && mode !== 1)) {
      context.unsupported("cp.spawnOpts with fd or piped stdio", expr.loc);
    }
    return `runtime::child_spawn_options(&(${context.emitExpr(command)}), &(${context.emitExpr(arguments_)}), ${context.emitExpr(stdinMode)}, ${context.emitExpr(stdoutMode)}, ${context.emitExpr(stderrMode)}, ${context.emitExpr(detached)}, ${context.emitExpr(hasEnv)}, &(${context.emitExpr(envPairs)}), &(${context.emitExpr(cwd)}))`;
  }
  if ((expr.fn === "child.pid" || expr.fn === "child.exitCode") && expr.args.length === 1 &&
      expr.args[0]?.type.kind === "child") {
    const empty = expr.fn === "child.pid" ? "undefinedT" : "nullT";
    const accessor = expr.fn === "child.pid" ? "pid" : "exit_code";
    return unionArgument(expr.type, `runtime::child_${accessor}(&(${context.emitExpr(expr.args[0])}))`, empty, context, expr);
  }
  if (expr.fn === "child.killed" && expr.args.length === 1 && expr.args[0]?.type.kind === "child") {
    return `runtime::child_killed(&(${context.emitExpr(expr.args[0])}))`;
  }
  if (expr.fn === "child.kill" && expr.args.length === 2 && expr.args[0]?.type.kind === "child" &&
      expr.args[1]?.type.kind === "string") {
    return `runtime::child_kill(&(${context.emitExpr(expr.args[0])}), &(${context.emitExpr(expr.args[1])}))`;
  }
  if (expr.fn === "child.killNum" && expr.args.length === 2 && expr.args[0]?.type.kind === "child" &&
      expr.args[1]?.type.kind === "f64") {
    return `runtime::child_kill_num(&(${context.emitExpr(expr.args[0])}), ${context.emitExpr(expr.args[1])})`;
  }
  if (expr.fn === "child.unref" && expr.args.length === 1 && expr.args[0]?.type.kind === "child") {
    return `runtime::child_unref(&(${context.emitExpr(expr.args[0])}))`;
  }
  if ((expr.fn === "child.onExit" || expr.fn === "child.onError") && expr.args.length === 2) {
    const callbackType = expr.args[1]?.type;
    if (expr.args[0]?.type.kind !== "child" || callbackType?.kind !== "func") {
      context.unsupported(`${expr.fn} argument shape`, expr.loc);
    }
    return expr.fn === "child.onExit"
      ? emitExitListener(expr, callbackType, context)
      : emitErrorListener(expr, callbackType, context);
  }
  return null;
}
