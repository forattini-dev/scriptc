import type { IrRecordShape, IrType } from "../../ir/nodes.js";
import { mangleField, mangleRecordStruct } from "../mangle.js";
import type { RustLibCallContext, RustLibCallExpr } from "./lib-calls.js";

type RecordType = Extract<IrType, { kind: "record" }>;

interface NetworkInfoArm {
  type: RecordType;
  shape: IrRecordShape;
  tag: number;
}

function networkInfoArm(
  tag: number,
  arms: readonly IrType[],
  context: RustLibCallContext,
  expr: RustLibCallExpr,
): NetworkInfoArm {
  const type = arms[tag];
  if (type?.kind !== "record") context.unsupported("os.networkInterfaces info arm", expr.loc);
  const shape = context.record(type.shapeId, expr.loc);
  if (shape.fields.length !== 7 || shape.indexValue !== undefined) {
    context.unsupported("os.networkInterfaces info record", expr.loc);
  }
  return { type, shape, tag };
}

function emitNetworkInfoRow(
  arm: NetworkInfoArm,
  ipv6: boolean,
  infoName: string,
  context: RustLibCallContext,
  expr: RustLibCallExpr,
): string {
  const field = (name: string): IrType => {
    const type = arm.shape.fields.find((candidate) => candidate.name === name)?.type;
    if (type === undefined) context.unsupported(`os.networkInterfaces '${name}' field`, expr.loc);
    return type;
  };
  for (const name of ["address", "netmask", "family", "mac"] as const) {
    if (field(name).kind !== "string") {
      context.unsupported(`os.networkInterfaces '${name}' type`, expr.loc);
    }
  }
  if (field("internal").kind !== "bool") {
    context.unsupported("os.networkInterfaces 'internal' type", expr.loc);
  }
  const cidrType = field("cidr");
  if (cidrType.kind !== "union") context.unsupported("os.networkInterfaces 'cidr' type", expr.loc);
  const cidrUnion = context.union(cidrType.unionId, expr.loc);
  const cidrStringTag = cidrUnion.arms.findIndex((candidate) => candidate.kind === "string");
  const cidrNullTag = cidrUnion.arms.findIndex((candidate) => candidate.kind === "nullT");
  if (cidrStringTag < 0 || cidrNullTag < 0 || cidrUnion.arms.length !== 2) {
    context.unsupported("os.networkInterfaces 'cidr' union", expr.loc);
  }
  const cidrName = context.unionName(cidrUnion.id);
  const cidr = `Some(match &sc_row.cidr { Some(sc_cidr) => ${cidrName}::${context.unionVariant(cidrStringTag)}(sc_cidr.clone()), None => ${cidrName}::${context.unionVariant(cidrNullTag)}, })`;
  const scopeType = field("scopeid");
  let scope: string;
  if (ipv6) {
    if (scopeType.kind !== "f64") {
      context.unsupported("os.networkInterfaces IPv6 'scopeid' type", expr.loc);
    }
    scope = "sc_row.scopeid";
  } else {
    if (scopeType.kind !== "union") {
      context.unsupported("os.networkInterfaces IPv4 'scopeid' type", expr.loc);
    }
    const scopeUnion = context.union(scopeType.unionId, expr.loc);
    const undefinedTag = scopeUnion.arms.findIndex((candidate) => candidate.kind === "undefinedT");
    if (undefinedTag < 0 || scopeUnion.arms.length !== 2) {
      context.unsupported("os.networkInterfaces IPv4 'scopeid' union", expr.loc);
    }
    scope = `Some(${context.unionName(scopeUnion.id)}::${context.unionVariant(undefinedTag)})`;
  }
  const values: Readonly<Record<string, string>> = {
    address: "sc_row.address.clone()",
    netmask: "sc_row.netmask.clone()",
    family: "sc_row.family.clone()",
    mac: "sc_row.mac.clone()",
    internal: "sc_row.internal",
    cidr,
    scopeid: scope,
  };
  const fields = arm.shape.fields.map((entry) => {
    const value = values[entry.name];
    if (value === undefined) context.unsupported(`os.networkInterfaces '${entry.name}' field`, expr.loc);
    return `${mangleField(entry.name)}: ${value}`;
  }).join(", ");
  return `${infoName}::${context.unionVariant(arm.tag)}(runtime::Gc::new(${mangleRecordStruct(arm.type.shapeId)} { ${fields} }))`;
}

export function emitRustOsCall(
  expr: RustLibCallExpr,
  context: RustLibCallContext,
): string | null {
  if (expr.fn !== "os.networkInterfaces") return null;
  if (expr.args.length !== 0 || expr.type.kind !== "record") {
    context.unsupported("os.networkInterfaces shape", expr.loc);
  }
  const dictionary = context.record(expr.type.shapeId, expr.loc);
  if (dictionary.fields.length !== 0 || dictionary.indexValue?.kind !== "union") {
    context.unsupported("os.networkInterfaces dictionary", expr.loc);
  }
  const dictionaryType = dictionary.indexValue;
  const dictionaryUnion = context.union(dictionaryType.unionId, expr.loc);
  const arrayTag = dictionaryUnion.arms.findIndex((candidate) => candidate.kind === "array");
  const arrayType = dictionaryUnion.arms[arrayTag];
  if (arrayType?.kind !== "array" || arrayType.elem.kind !== "union" ||
      dictionaryUnion.arms.length !== 2) {
    context.unsupported("os.networkInterfaces dictionary value", expr.loc);
  }
  const infoType = arrayType.elem;
  const infoUnion = context.union(infoType.unionId, expr.loc);
  if (infoUnion.arms.length !== 2) context.unsupported("os.networkInterfaces info union", expr.loc);
  const ipv6Tag = infoUnion.arms.findIndex((candidate) =>
    candidate.kind === "record" &&
      context.record(candidate.shapeId, expr.loc).fields.some((entry) =>
        entry.name === "scopeid" && entry.type.kind === "f64"
      )
  );
  const ipv4Tag = infoUnion.arms.findIndex((_, tag) => tag !== ipv6Tag);
  if (ipv6Tag < 0 || ipv4Tag < 0) context.unsupported("os.networkInterfaces family arms", expr.loc);
  const ipv6Arm = networkInfoArm(ipv6Tag, infoUnion.arms, context, expr);
  const ipv4Arm = networkInfoArm(ipv4Tag, infoUnion.arms, context, expr);
  const dictionaryName = context.unionName(dictionaryUnion.id);
  const infoName = context.unionName(infoUnion.id);
  const arrayVariant = `${dictionaryName}::${context.unionVariant(arrayTag)}`;
  const ipv6Row = emitNetworkInfoRow(ipv6Arm, true, infoName, context, expr);
  const ipv4Row = emitNetworkInfoRow(ipv4Arm, false, infoName, context, expr);
  const output = context.nextTemporary();
  const rows = context.nextTemporary();
  const value = context.nextTemporary();
  return `{ let ${output}: ${context.rustType(expr.type, expr.loc)} = runtime::map_new(); for sc_row in runtime::os_network_interfaces() { let ${rows} = match runtime::map_get_by(&${output}, &sc_row.name, |left, right| left.as_ref() == right.as_ref()) { Some(${arrayVariant}(sc_rows)) => sc_rows, _ => { let sc_rows: ${context.rustType(arrayType, expr.loc)} = runtime::array_new(Vec::new()); runtime::map_set_by(&${output}, sc_row.name.clone(), ${arrayVariant}(sc_rows.clone()), |left, right| left.as_ref() == right.as_ref()); sc_rows }, }; let ${value} = if sc_row.ipv6 { ${ipv6Row} } else { ${ipv4Row} }; runtime::array_push(&${rows}, ${value}); } ${output} }`;
}
