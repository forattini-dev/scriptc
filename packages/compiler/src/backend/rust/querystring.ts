import type { RustLibCallContext, RustLibCallExpr } from "./lib-calls.js";

interface RustLineContext {
  line(value: string): void;
  pushIndent(): void;
  popIndent(): void;
}

export function emitRustQuerystringDynImpl(name: string, context: RustLineContext): void {
  context.line(`impl runtime::QuerystringDyn for ${name} {`);
  context.pushIndent();
  context.line("fn querystring_object_entries(&self) -> Option<Vec<(runtime::JsString, Self)>> {");
  context.pushIndent();
  context.line("match self { Self::Object(value) => Some(runtime::map_string_entries_js_order(value)), _ => None }");
  context.popIndent();
  context.line("}");
  context.line("fn querystring_array_values(&self) -> Option<Vec<Self>> {");
  context.pushIndent();
  context.line("match self { Self::Array(value) => Some(runtime::array_values(value)), _ => None }");
  context.popIndent();
  context.line("}");
  context.line("fn querystring_scalar(&self) -> runtime::JsString {");
  context.pushIndent();
  context.line("match self {");
  context.pushIndent();
  context.line("Self::String(value) => value.clone(),");
  context.line("Self::Number(value) if value.is_finite() => runtime::string(&runtime::format_number(*value)),");
  context.line("Self::Boolean(value) => runtime::string(if *value { \"true\" } else { \"false\" }),");
  context.line("_ => runtime::empty_string(),");
  context.popIndent();
  context.line("}");
  context.popIndent();
  context.line("}");
  context.popIndent();
  context.line("}");
}

export function emitRustQuerystringCall(
  expr: RustLibCallExpr,
  context: RustLibCallContext,
): string | null {
  const first = expr.args[0];
  if (expr.fn === "qs.escape" && expr.args.length === 1 && first?.type.kind === "string") {
    return `runtime::querystring_escape(&(${context.emitExpr(first)}))`;
  }
  if (expr.fn === "qs.unescape" && expr.args.length === 1 && first?.type.kind === "string") {
    return `runtime::querystring_unescape(&(${context.emitExpr(first)}))`;
  }
  if (expr.fn === "qs.stringify" && expr.args.length === 3 && first?.type.kind === "dyn" &&
      expr.args[1]?.type.kind === "string" && expr.args[2]?.type.kind === "string") {
    const object = context.nextTemporary();
    const separator = context.nextTemporary();
    const equals = context.nextTemporary();
    return `{ let ${object} = ${context.emitExpr(first)}; let ${separator} = ${context.emitExpr(expr.args[1])}; let ${equals} = ${context.emitExpr(expr.args[2])}; runtime::querystring_stringify(&${object}, &${separator}, &${equals}) }`;
  }
  if (expr.fn !== "qs.parse") return null;
  if (expr.args.length !== 4 || first?.type.kind !== "string" ||
      expr.args[1]?.type.kind !== "string" || expr.args[2]?.type.kind !== "string" ||
      expr.args[3]?.type.kind !== "f64" || expr.type.kind !== "record") {
    context.unsupported("querystring.parse shape", expr.loc);
  }
  const shape = context.record(expr.type.shapeId, expr.loc);
  if (shape.fields.length !== 0 || shape.indexValue?.kind !== "union") {
    context.unsupported("querystring.parse result record", expr.loc);
  }
  const valueType = shape.indexValue;
  const union = context.union(valueType.unionId, expr.loc);
  const stringTag = union.arms.findIndex((arm) => arm.kind === "string");
  const stringsTag = union.arms.findIndex((arm) =>
    arm.kind === "array" && arm.elem.kind === "string",
  );
  if (stringTag < 0 || stringsTag < 0) {
    context.unsupported("querystring.parse result union", expr.loc);
  }
  const input = context.nextTemporary();
  const separator = context.nextTemporary();
  const equals = context.nextTemporary();
  const maxKeys = context.nextTemporary();
  const parsed = context.nextTemporary();
  const output = context.nextTemporary();
  const name = context.unionName(union.id);
  const stringVariant = `${name}::${context.unionVariant(stringTag)}`;
  const stringsVariant = `${name}::${context.unionVariant(stringsTag)}`;
  return `{ let ${input} = ${context.emitExpr(first)}; let ${separator} = ${context.emitExpr(expr.args[1])}; let ${equals} = ${context.emitExpr(expr.args[2])}; let ${maxKeys} = ${context.emitExpr(expr.args[3])}; let ${parsed} = runtime::querystring_parse(&${input}, &${separator}, &${equals}, ${maxKeys}); let ${output}: ${context.rustType(expr.type, expr.loc)} = runtime::map_new(); for (key, value) in runtime::map_string_entries_js_order(&${parsed}) { let value = match value { runtime::QuerystringParsedValue::String(value) => ${stringVariant}(value), runtime::QuerystringParsedValue::Strings(value) => ${stringsVariant}(value), }; runtime::map_set_by(&${output}, key, value, |left, right| left.as_ref() == right.as_ref()); } ${output} }`;
}
