import type { IrExpr } from "../../ir/ir.js";
import type { RustLibCallContext } from "./lib-calls.js";
import type { RustDefinitionContext } from "./definitions.js";

export function emitRustErrorStackCall(expr: Extract<IrExpr, { kind: "libCall" }>, context: RustLibCallContext): string | null {
  if (expr.fn !== "error.captureStackTrace" && expr.fn !== "error.captureStackTraceExclude" && expr.fn !== "error.stack") return null;
  const target = expr.args[0];
  if (!target) context.unsupported("Error stack without a target", expr.loc);
  const local = context.nextTemporary();
  const excludeArg = expr.args[1];
  const exclude = excludeArg ? `Some((${context.emitExpr(excludeArg)}).as_ref())` : "None";
  if (expr.fn !== "error.stack") {
    const operation = context.hasErrorClassRoots()
      ? `sc_error_capture_stack(&${local}, ${exclude})` : excludeArg ? `runtime::error_capture_stack_excluding(&${local}, &(${context.emitExpr(excludeArg)}))` : `runtime::error_capture_stack(&${local})`;
    return `{ let ${local} = ${context.emitExpr(target)}; ${operation}; () }`;
  }
  return `${context.hasErrorClassRoots() ? "sc_error_stack" : "runtime::error_stack"}(&(${context.emitExpr(target)}))`;
}

export function emitRustErrorStackDefinitions(context: RustDefinitionContext): void {
  const name = context.errorValueName();
  context.line(`fn sc_error_capture_stack(value: &${name}, exclude: Option<&str>) { match value {`);
  context.pushIndent();
  context.line(`${name}::Builtin(error) => match exclude { Some(exclude) => runtime::error_capture_stack_excluding(error, &runtime::string(exclude)), None => runtime::error_capture_stack(error) },`);
  for (const root of context.errorClassRoots()) context.line(`${name}::${context.errorValueVariant(root)}(error) => runtime::error_capture_stack_gc(error, exclude),`);
  context.popIndent();
  context.line("} }");
  context.line(`fn sc_error_stack(value: &${name}) -> runtime::JsString { match value {`);
  context.pushIndent();
  context.line(`${name}::Builtin(error) => runtime::error_stack(error),`);
  for (const root of context.errorClassRoots()) {
    const fieldName = context.classFieldName(root.def.name, "name");
    const fieldMessage = context.classFieldName(root.def.name, "message");
    context.line(`${name}::${context.errorValueVariant(root)}(error) => runtime::error_stack_gc(error, || error.with(|object| runtime::error_to_string_parts(object.${fieldName}.as_ref(), object.${fieldMessage}.as_ref()))),`);
  }
  context.popIndent();
  context.line("} }");
}
