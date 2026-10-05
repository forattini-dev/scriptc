import { recordNewName } from "./shared-records.js";
import { mangleField, mangleRecordStruct } from "../mangle.js";
import type { IrType } from "../../ir/ir.js";
import type { RustLibCallExpr, RustLibCallContext } from "./lib-calls.js";

function addressValue(type: IrType, context: RustLibCallContext, expr: RustLibCallExpr): string {
  if (type.kind === "union") {
    const union = context.union(type.unionId, expr.loc);
    const stringTag = union.arms.findIndex(arm => arm.kind === "string");
    const nullTag = union.arms.findIndex(arm => arm.kind === "nullT");
    if (stringTag >= 0 && nullTag >= 0 && union.arms.length === 2) {
      const name = context.unionName(union.id);
      return `match sc_address { Some(sc_address) => ${name}::${context.unionVariant(stringTag)}(sc_address), None => ${name}::${context.unionVariant(nullTag)}, }`;
    }
  }
  context.unsupported("dns.promises.lookup address must preserve Node 24's null result", expr.loc);
}

export function emitRustDnsCall(expr: RustLibCallExpr, context: RustLibCallContext): string | null {
  if (expr.fn === "dns.lookupFamily" && expr.args.length === 1 && expr.args[0]?.type.kind === "dyn" && expr.type.kind === "f64") {
    const dyn = context.dynTypeName();
    return `{ let sc_value = ${context.emitExpr(expr.args[0])}; match &sc_value { ${dyn}::Number(value) => *value, ${dyn}::Null | ${dyn}::Undefined => 0.0, ${dyn}::String(value) if value == &runtime::string("IPv4") => 4.0, ${dyn}::String(value) if value == &runtime::string("IPv6") => 6.0, _ => runtime::throw_type_error_code(format!("The property 'options.family' must be one of: 0, 4, 6. Received {}", sc_dyn_inspect(&sc_value, 0.0, 2.0)), "ERR_INVALID_ARG_VALUE"), } }`;
  }
  if (expr.fn !== "dns.promises.lookup" && expr.fn !== "dns.lookupAsync") return null;
  const [host, family, familyName] = expr.args;
  if (host?.type.kind !== "string" || family?.type.kind !== "f64" || familyName?.type.kind !== "string" ||
      expr.type.kind !== "promise" || expr.type.inner.kind !== "record" || expr.args.length !== 3) {
    context.unsupported("dns.promises.lookup shape", expr.loc);
  }
  const shape = context.record(expr.type.inner.shapeId, expr.loc);
  if (shape.fields.length !== 2) context.unsupported("dns.promises.lookup result fields", expr.loc);
  const fields = shape.fields.map(field => {
    if (field.name === "address") {
      const value = addressValue(field.type, context, expr);
      return `${mangleField(field.name)}: ${context.isEdgeValue(field.type) ? `Some(${value})` : value}`;
    }
    if (field.name === "family" && field.type.kind === "f64") return `${mangleField(field.name)}: sc_family`;
    return context.unsupported(`dns.promises.lookup field '${field.name}'`, expr.loc);
  }).join(", ");
  const runtimeFunction = expr.fn === "dns.lookupAsync" ? "dns_lookup_promisified" : "dns_lookup_promise";
  return `{ let sc_hostname = ${context.emitExpr(host)}; let sc_family_name = ${context.emitExpr(familyName)}; runtime::${runtimeFunction}(&sc_hostname, || ${context.emitExpr(family)}, &sc_family_name, |sc_address, sc_family| ${recordNewName(shape.id)}(${mangleRecordStruct(shape.id)} { ${fields} })) }`;
}
