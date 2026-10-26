import type { RustLibCallContext, RustLibCallExpr } from "./lib-calls.js";

export function emitRegexReplacement(expr: RustLibCallExpr, context: RustLibCallContext): string | null {
  if (expr.fn !== "regex.replaceCaptures") return null;
  const dyn = context.dynTypeName();
  const subject = context.nextTemporary();
  const regex = context.nextTemporary();
  const callback = context.nextTemporary();
  const all = context.nextTemporary();
  return `{ let ${subject} = ${context.emitExpr(expr.args[0]!)};
    let ${regex} = ${context.emitExpr(expr.args[1]!)};
    let ${callback} = ${context.emitExpr(expr.args[2]!)};
    let ${all} = ${context.emitExpr(expr.args[3]!)};
    runtime::regex_replace_captures(&${subject}, &${regex}, ${all}, |matched| {
      let mut args = vec![${dyn}::String(matched.matched)];
      args.extend(matched.captures.into_iter().map(|value| value.map(${dyn}::String).unwrap_or(${dyn}::Undefined)));
      args.push(${dyn}::Number(matched.offset as f64)); args.push(${dyn}::String(matched.input));
      if let Some(groups) = matched.groups {
        let object = runtime::map_new();
        sc_dyn_mark_null_proto(&object);
        for (key, value) in groups { runtime::map_set_by(&object, key, value.map(${dyn}::String).unwrap_or(${dyn}::Undefined), |a,b| a == b); }
        args.push(${dyn}::Object(object));
      }
      let _this = sc_dyn_this_push(${dyn}::Undefined);
      let result = sc_dyn_call(&${callback}, &args, "replacement");
      match &result {
        ${dyn}::Undefined | ${dyn}::Null | ${dyn}::String(_) | ${dyn}::Boolean(_) | ${dyn}::Number(_) | ${dyn}::BigInt(_) | ${dyn}::Symbol(_) => sc_dyn_string_coerce_js(&result),
        _ => runtime::throw_type_error("scriptc: object string conversion requires native ToPrimitive support".into()),
      }
    }) }`;
}
