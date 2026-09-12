import { RUNTIME_ERROR_CLASSES, type IrType, type IrUnionDef, type SrcLoc } from "../../ir/ir.js";
import type { RustDynamicContext } from "./dynamic-context.js";

/** Distinct native tags select an arm without a JSON round trip. Two arrays,
 * records, or callable signatures still need structural disambiguation; never
 * choose their first arm solely because their outer runtime tags agree.
 */
function variants(type: IrType): readonly string[] | null {
  switch (type.kind) {
    case "f64": return ["Number"];
    case "bool": return ["Boolean"];
    case "string": return ["String"];
    case "undefinedT": return ["Undefined"];
    case "nullT": return ["Null"];
    case "array": return ["Array"];
    case "record": return ["Object"];
    case "func": return ["function"];
    case "bytes": return type.elem === "u8" ? ["Bytes", "Buffer"] : null;
    case "object": return RUNTIME_ERROR_CLASSES.has(type.className) ? ["Object"] : null;
    case "netSocket": return ["NetSocket"];
    case "netServer": return ["NetServer"];
    case "httpReq": return ["HttpRequest"];
    case "httpRes": return ["HttpResponse"];
    default: return null;
  }
}

export function planNativeUnionVariants(union: IrUnionDef): readonly (readonly string[])[] | null {
  const alternatives: (readonly string[])[] = [];
  const used = new Set<string>();
  for (const arm of union.arms) {
    const names = variants(arm);
    if (names === null || names.some(name => used.has(name))) return null;
    for (const name of names) used.add(name);
    alternatives.push(names);
  }
  return alternatives;
}

export function emitNativeUnionCheck(
  context: RustDynamicContext, union: IrUnionDef, value: string,
  check: (type: IrType, value: string, loc?: SrcLoc) => string, loc?: SrcLoc, path = '"$"',
): string | null {
  const alternatives = planNativeUnionVariants(union);
  if (alternatives === null) return null;
  const dyn = context.dynTypeName();
  const result = context.unionName(union.id);
  const input = context.nextTemporary();
  const arms = union.arms.map((arm, tag) => {
    const names = alternatives[tag];
    if (names === undefined) throw new Error("scriptc: missing native union tag plan");
    const target = `${result}::${context.unionVariant(tag)}`;
    if (context.isUnit(arm)) return `${dyn}::${names[0]} => ${target}`;
    const patterns = arm.kind === "func"
      ? [...context.dynBoxedFunctionShapes].map(key => {
          const shape = context.closureShapes.get(key);
          if (shape === undefined) context.unsupported(`dynamic function signature '${key}'`, loc);
          return `${dyn}::${context.dynFunctionVariant(shape)}(..)`;
        }).concat([`${dyn}::NativeConstructor(..)`, `${dyn}::NativeMethod(..)`])
      : names.map(name => `${dyn}::${name}(..)`);
    return `${input} @ (${patterns.join(" | ")}) => ${target}(${check(arm, input, loc)})`;
  });
  return `{ let ${input} = ${value}; match ${input} { ${arms.join(", ")}, ` +
    `${input} => sc_dyn_check_fail_at("union", &${input}, ${path}), } }`;
}
