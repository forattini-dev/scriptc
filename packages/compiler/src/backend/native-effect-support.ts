import type { ScrDiagnostic } from "../diagnostics/diagnostic.js";
import type { IrModule, IrType, SrcLoc } from "../ir/ir.js";

/** Existing static Effect operations keep their backend policy. The new
 * identity comparisons and dynamic reference transport require Rust's
 * identity-preserving representation and Effect tag. */
export function nativeEffectBackendDiagnostics(mod: IrModule, backend: "c" | "llvm"): ScrDiagnostic[] {
  const records = new Map(mod.records?.map(shape => [shape.id, shape]));
  const unions = new Map(mod.unions?.map(union => [union.id, union]));
  function containsEffect(type: IrType | undefined, visiting = new Set<string>()): boolean {
    if (!type) return false;
    switch (type.kind) {
      case "effect": return true;
      case "func": return type.params.some(param => containsEffect(param, visiting)) || containsEffect(type.ret, visiting);
      case "array": case "set": return containsEffect(type.elem, visiting);
      case "map": return containsEffect(type.key, visiting) || containsEffect(type.value, visiting);
      case "promise": return containsEffect(type.inner, visiting);
      case "generator": return [type.yieldT, type.retT, type.nextT].some(channel => containsEffect(channel, visiting));
      case "record": case "union": {
        const key = type.kind === "record" ? `record:${type.shapeId}` : `union:${type.unionId}`;
        if (visiting.has(key)) return false;
        visiting.add(key);
        try {
          if (type.kind === "union") return unions.get(type.unionId)?.arms.some(arm => containsEffect(arm, visiting)) ?? false;
          const shape = records.get(type.shapeId);
          return !!shape && (shape.fields.some(field => containsEffect(field.type, visiting)) || containsEffect(shape.indexValue, visiting));
        } finally { visiting.delete(key); }
      }
      default: return false;
    }
  }
  let loc: SrcLoc | undefined;
  function visit(value: unknown, parentLoc: SrcLoc): void {
    if (loc || value === null || typeof value !== "object") return;
    if (Array.isArray(value)) { for (const child of value) visit(child, parentLoc); return; }
    const node = value as { kind?: string; op?: string; left?: { type: IrType }; right?: { type: IrType }; type?: IrType; value?: { type: IrType }; loc?: SrcLoc };
    const here = node.loc ?? parentLoc;
    if ((node.kind === "dynFrom" && containsEffect(node.value?.type)) ||
        (node.kind === "dynCheck" && containsEffect(node.type)) ||
        ((node.kind === "dynScalarEq" || (node.kind === "bin" && (node.op === "===" || node.op === "!=="))) &&
          (node.left?.type.kind === "effect" || node.right?.type.kind === "effect"))) {
      loc = here;
      return;
    }
    for (const child of Object.values(value)) visit(child, here);
  }
  visit(mod, { file: mod.sourceFile, start: 0, end: 0 });
  return loc ? [{ code: "SC3001", loc,
    message: `the ${backend} backend does not support native Effect identity comparisons or reference transport through dynamic slots yet; use --backend rust`,
  }] : [];
}
