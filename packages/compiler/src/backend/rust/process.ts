import type { RustLibCallContext, RustLibCallExpr } from "./lib-calls.js";

export function emitRustProcessCall(
  expr: RustLibCallExpr,
  context: RustLibCallContext,
): string | null {
  const arg = expr.args[0];
  const secondArg = expr.args[1];
  if (expr.fn === "process.exit" && expr.args.length === 1 && arg !== undefined) {
    return `runtime::process_exit(${context.emitExpr(arg)})`;
  }
  if (expr.fn === "process.exitCodeSet" && expr.args.length === 1 && arg?.type.kind === "f64") {
    return `runtime::process_exit_code_set(${context.emitExpr(arg)})`;
  }
  if (expr.fn === "process.kill" && expr.args.length === 2 &&
      arg?.type.kind === "f64" && secondArg?.type.kind === "string") {
    return `runtime::process_kill_named(${context.emitExpr(arg)}, &(${context.emitExpr(secondArg)}))`;
  }
  if (expr.fn === "process.killNum" && expr.args.length === 2 &&
      arg?.type.kind === "f64" && secondArg?.type.kind === "f64") {
    return `runtime::process_kill_num(${context.emitExpr(arg)}, ${context.emitExpr(secondArg)})`;
  }
  if (expr.fn === "process.onSignal" && expr.args.length === 3 &&
      arg?.type.kind === "f64" && secondArg?.type.kind === "func" &&
      secondArg.type.params.length === 0 && secondArg.type.ret.kind === "void" &&
      expr.args[2]?.type.kind === "bool") {
    const signal = context.nextTemporary();
    const callback = context.nextTemporary();
    const once = context.nextTemporary();
    const identity = context.functionIdentity(callback, secondArg.type, expr.loc);
    const dispatch = context.emitClosureDispatch(callback, secondArg.type, [], expr.loc);
    return `{ let ${signal} = ${context.emitExpr(arg)}; let ${callback} = ${context.emitExpr(secondArg)}; let ${once} = ${context.emitExpr(expr.args[2])}; let sc_signal_identity = ${identity}; runtime::process_signal_on(${signal}, sc_signal_identity, std::rc::Rc::new(move || { let _ = ${dispatch}; }), ${once}); }`;
  }
  if (expr.fn === "process.offSignal" && expr.args.length === 2 &&
      arg?.type.kind === "f64" && secondArg?.type.kind === "func" &&
      secondArg.type.params.length === 0 && secondArg.type.ret.kind === "void") {
    const signal = context.nextTemporary();
    const callback = context.nextTemporary();
    const identity = context.functionIdentity(callback, secondArg.type, expr.loc);
    return `{ let ${signal} = ${context.emitExpr(arg)}; let ${callback} = ${context.emitExpr(secondArg)}; runtime::process_signal_off(${signal}, ${identity}); }`;
  }
  if (expr.fn === "process.isTTY" && expr.args.length === 1 && arg !== undefined) {
    return `runtime::process_is_tty(${context.emitExpr(arg)})`;
  }
  if ((expr.fn === "process.columns" || expr.fn === "process.rows") &&
      expr.args.length === 1 && arg?.type.kind === "f64") {
    const runtimeFn = expr.fn === "process.columns" ? "process_columns" : "process_rows";
    return emitOptionalUnion(expr, context, "f64", `runtime::${runtimeFn}(${context.emitExpr(arg)})`);
  }
  if (expr.fn === "process.stdinDestroy" && expr.args.length === 0) {
    return "runtime::process_stdin_destroy()";
  }
  if (expr.fn === "process.stdinSetRawMode" && expr.args.length === 1 &&
      arg?.type.kind === "bool" && expr.type.kind === "void") {
    return `runtime::process_stdin_set_raw_mode(${context.emitExpr(arg)})`;
  }
  if (expr.fn === "process.argv" && expr.args.length === 0) return "runtime::process_argv()";
  if (expr.fn === "process.platform" && expr.args.length === 0) return "runtime::process_platform()";
  if (expr.fn === "process.cwd" && expr.args.length === 0) return "runtime::process_cwd()";
  if (expr.fn === "process.pid" && expr.args.length === 0) return "runtime::process_pid()";
  if (expr.fn === "process.getuid" && expr.args.length === 0) return "runtime::process_getuid()";
  if (expr.fn === "process.getgid" && expr.args.length === 0) return "runtime::process_getgid()";
  if (expr.fn === "process.execPath" && expr.args.length === 0) return "runtime::process_exec_path()";
  if (expr.fn === "process.arch" && expr.args.length === 0) return "runtime::process_arch()";
  if (expr.fn === "process.versionsNode" && expr.args.length === 0) return "runtime::process_versions_node()";
  if (expr.fn === "process.versionsOpenssl" && expr.args.length === 0) return "runtime::process_versions_openssl()";
  if (expr.fn === "process.chdir" && expr.args.length === 1 && arg?.type.kind === "string") {
    return `runtime::process_chdir(&(${context.emitExpr(arg)}))`;
  }
  if (expr.fn === "process.umask" && expr.args.length === 1 && arg?.type.kind === "f64") {
    return `runtime::process_umask(${context.emitExpr(arg)})`;
  }
  if (expr.fn === "process.envGet" && expr.args.length === 1 && arg !== undefined) {
    return emitOptionalUnion(expr, context, "string", `runtime::process_env_get(&(${context.emitExpr(arg)}))`);
  }
  if (expr.fn === "process.envSet" && expr.args.length === 2 &&
      arg?.type.kind === "string" && secondArg?.type.kind === "string") {
    return `runtime::process_env_set(&(${context.emitExpr(arg)}), &(${context.emitExpr(secondArg)}))`;
  }
  if (expr.fn === "process.envUnset" && expr.args.length === 1 && arg?.type.kind === "string") {
    return `runtime::process_env_unset(&(${context.emitExpr(arg)}))`;
  }
  if (expr.fn === "process.envPairs" && expr.args.length === 0 &&
      expr.type.kind === "array" && expr.type.elem.kind === "string") {
    return "runtime::process_env_pairs()";
  }
  if ((expr.fn === "process.stdoutWriteBytes" || expr.fn === "process.stderrWriteBytes") &&
      expr.args.length === 2 && arg?.type.kind === "bytes" && arg.type.elem === "u8" &&
      secondArg?.type.kind === "string") {
    const target = expr.fn === "process.stdoutWriteBytes" ? "stdout" : "stderr";
    return `runtime::process_${target}_write_bytes(&(${context.emitExpr(arg)}), &(${context.emitExpr(secondArg)}))`;
  }
  if ((expr.fn === "process.stdoutWriteBytesCb" || expr.fn === "process.stderrWriteBytesCb") &&
      expr.args.length === 3 && arg?.type.kind === "bytes" && arg.type.elem === "u8" &&
      secondArg?.type.kind === "string") {
    const callbackExpr = expr.args[2];
    if (callbackExpr?.type.kind !== "func" || callbackExpr.type.params.length > 1 || callbackExpr.type.ret.kind !== "void") {
      context.unsupported("process write callback shape", expr.loc);
    }
    const callbackType = callbackExpr.type;
    const bytes = context.nextTemporary();
    const encoding = context.nextTemporary();
    const callback = context.nextTemporary();
    const result = context.nextTemporary();
    const parameter = callbackType.params[0];
    let dispatch: string;
    if (parameter === undefined) {
      dispatch = context.emitClosureDispatch(callback, callbackType, [], expr.loc);
    } else if (parameter.kind === "dyn") {
      dispatch = context.emitClosureDispatch(callback, callbackType, [`${context.dynTypeName()}::Null`], expr.loc);
    } else {
      if (parameter.kind !== "union") context.unsupported("process write callback error parameter", expr.loc);
      const union = context.union(parameter.unionId, expr.loc);
      const nullTag = union.arms.findIndex((arm) => arm.kind === "nullT");
      if (nullTag < 0) context.unsupported("process write callback Error | null union", expr.loc);
      dispatch = context.emitClosureDispatch(
        callback,
        callbackType,
        [`${context.unionName(union.id)}::${context.unionVariant(nullTag)}`],
        expr.loc,
      );
    }
    const target = expr.fn === "process.stdoutWriteBytesCb" ? "stdout" : "stderr";
    return `{ let ${bytes} = ${context.emitExpr(arg)}; let ${encoding} = ${context.emitExpr(secondArg)}; let ${callback} = ${context.emitExpr(callbackExpr)}; let ${result} = runtime::process_${target}_write_bytes(&${bytes}, &${encoding}); runtime::process_next_tick(Box::new(move || { let _ = ${dispatch}; })); ${result} }`;
  }
  if ((expr.fn === "process.stdoutWrite" || expr.fn === "process.stderrWrite") &&
      expr.args.length === 1 && arg?.type.kind === "string") {
    const target = expr.fn === "process.stdoutWrite" ? "stdout" : "stderr";
    return `runtime::process_${target}_write(&(${context.emitExpr(arg)}))`;
  }
  return null;
}

function emitOptionalUnion(
  expr: RustLibCallExpr,
  context: RustLibCallContext,
  valueKind: "f64" | "string",
  option: string,
): string {
  if (expr.type.kind !== "union") context.unsupported(`${expr.fn} without an optional result union`, expr.loc);
  const union = context.union(expr.type.unionId, expr.loc);
  const valueTag = union.arms.findIndex((arm) => arm.kind === valueKind);
  const undefinedTag = union.arms.findIndex((arm) => arm.kind === "undefinedT");
  if (valueTag < 0 || undefinedTag < 0) context.unsupported(`${expr.fn} result union shape`, expr.loc);
  const name = context.unionName(union.id);
  return `match ${option} { Some(value) => ${name}::${context.unionVariant(valueTag)}(value), None => ${name}::${context.unionVariant(undefinedTag)}, }`;
}
