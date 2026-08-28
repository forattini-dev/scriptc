import { mangleField, mangleRecordStruct } from "../mangle.js";
import type { RustLibCallContext, RustLibCallExpr } from "./lib-calls.js";

/** Emit filesystem calls whose result needs compiler-owned record assembly. */
export function emitRustFilesystemCall(
  expr: RustLibCallExpr,
  context: RustLibCallContext,
): string | null {
  const watch = emitRustFsWatchCall(expr, context);
  if (watch !== null) return watch;
  if (expr.fn !== "fs.readdirTypesSync") return null;
  const [pathExpr] = expr.args;
  if (pathExpr?.type.kind !== "string" || expr.args.length !== 1 ||
      expr.type.kind !== "array" || expr.type.elem.kind !== "record") {
    context.unsupported("fs.readdirTypesSync shape", expr.loc);
  }
  const rowType = expr.type.elem;
  const shape = context.record(rowType.shapeId, expr.loc);
  const expected = [
    ["%dtype", "f64"],
    ["name", "string"],
    ["parentPath", "string"],
  ] as const;
  if (shape.tuple || shape.indexValue !== undefined || shape.fields.length !== expected.length ||
      shape.fields.some((field, index) =>
        field.name !== expected[index]?.[0] || field.type.kind !== expected[index]?.[1]
      )) {
    context.unsupported("fs.readdirTypesSync record", expr.loc);
  }

  const path = context.nextTemporary();
  const output = context.nextTemporary();
  const entry = context.nextTemporary();
  const fields = [
    `${mangleField("%dtype")}: ${entry}.kind`,
    `${mangleField("name")}: ${entry}.name`,
    `${mangleField("parentPath")}: ${path}.clone()`,
  ].join(", ");
  return `{ let ${path} = ${context.emitExpr(pathExpr)}; let ${output}: ${context.rustType(expr.type, expr.loc)} = runtime::array_new(Vec::new()); for ${entry} in runtime::fs_readdir_types(&${path}) { let sc_row = runtime::Gc::new(${mangleRecordStruct(rowType.shapeId)} { ${fields} }); runtime::array_push(&${output}, sc_row); } ${output} }`;
}

function emitRustFsWatchCall(
  expr: RustLibCallExpr,
  context: RustLibCallContext,
): string | null {
  const pathExpr = expr.args[0];
  if ((expr.fn === "fs.watch" || expr.fn === "fs.watchCb") &&
      pathExpr?.type.kind === "string" && expr.type.kind === "fsWatcher") {
    const path = context.nextTemporary();
    if (expr.fn === "fs.watch" && expr.args.length === 1) {
      return `{ let ${path} = ${context.emitExpr(pathExpr)}; runtime::fs_watch(&${path}, None, None) }`;
    }
    const callbackExpr = expr.args[1];
    if (expr.fn !== "fs.watchCb" || expr.args.length !== 2 ||
        callbackExpr?.type.kind !== "func" || callbackExpr.type.ret.kind !== "void" ||
        callbackExpr.type.params.length > 1 ||
        (callbackExpr.type.params[0] !== undefined && callbackExpr.type.params[0].kind !== "string")) {
      context.unsupported("fs.watch callback shape", expr.loc);
    }
    const callbackType = callbackExpr.type;
    const callback = context.nextTemporary();
    const callbackTrace = context.nextTemporary();
    const args = callbackType.params.length === 0 ? [] : ["sc_event"];
    const dispatch = context.emitClosureDispatch(callback, callbackType, args, expr.loc);
    return `{ let ${path} = ${context.emitExpr(pathExpr)}; let ${callback} = ${context.emitExpr(callbackExpr)}; let ${callbackTrace} = ${callback}.clone(); runtime::fs_watch(&${path}, Some(std::rc::Rc::new(move |sc_event| { let _ = ${dispatch}; })), Some(std::rc::Rc::new(move |tracer| tracer.edge(&${callbackTrace})))) }`;
  }
  if (expr.fn === "watcher.close" && expr.args.length === 1 &&
      pathExpr?.type.kind === "fsWatcher" && expr.type.kind === "void") {
    return `runtime::fs_watcher_close(&(${context.emitExpr(pathExpr)}))`;
  }
  return null;
}
