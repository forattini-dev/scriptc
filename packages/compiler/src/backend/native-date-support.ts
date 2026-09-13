import type { ScrDiagnostic } from "../diagnostics/diagnostic.js";
import type { IrModule, IrType, SrcLoc } from "../ir/ir.js";

/** C/LLVM retain their existing scalar Date ABI. Reference identity, dynamic
 * slots and tagged Date unions require the Rust object representation. */
export function nativeDateBackendDiagnostics(mod: IrModule, backend: "c" | "llvm"): ScrDiagnostic[] {
  const records = new Map(mod.records?.map(shape => [shape.id, shape]));
  const unions = new Map(mod.unions?.map(union => [union.id, union]));
  function containsDate(type: IrType | undefined, seen = new Set<string>()): boolean {
    if (!type) return false;
    if (type.kind === "date") return true;
    if (type.kind === "array") return containsDate(type.elem, seen);
    if (type.kind === "record") {
      if (seen.has(type.shapeId)) return false;
      seen.add(type.shapeId);
      const shape = records.get(type.shapeId);
      return !!shape && (shape.fields.some(field => containsDate(field.type, seen)) || containsDate(shape.indexValue, seen));
    }
    if (type.kind === "union") {
      if (seen.has(type.unionId)) return false;
      seen.add(type.unionId);
      return unions.get(type.unionId)?.arms.some(arm => containsDate(arm, seen)) ?? false;
    }
    return false;
  }
  let loc: SrcLoc | undefined;
  if (mod.unions?.some(union => union.arms.some(arm => arm.kind === "date"))) loc = { file: mod.sourceFile, start: 0, end: 0 };
  function visit(value: unknown): void {
    if (loc || !value || typeof value !== "object") return;
    if (Array.isArray(value)) { value.forEach(visit); return; }
    const node = value as { kind?: string; test?: string; op?: string; type?: IrType; value?: { type: IrType }; left?: { type: IrType }; right?: { type: IrType }; loc?: SrcLoc };
    if ((node.kind === "dynTest" && node.test === "date") ||
        (node.kind === "array" && containsDate((value as Extract<IrType, { kind: "array" }>).elem)) ||
        (node.kind === "dynFrom" && containsDate(node.value?.type)) ||
        (node.kind === "dynCheck" && containsDate(node.type)) ||
        ((node.kind === "dynScalarEq" || (node.kind === "bin" && (node.op === "===" || node.op === "!=="))) &&
          (node.left?.type.kind === "date" || node.right?.type.kind === "date"))) {
      loc = node.loc ?? { file: mod.sourceFile, start: 0, end: 0 };
      return;
    }
    Object.values(value).forEach(visit);
  }
  visit(mod);
  return loc ? [{ code: "SC3001", loc, message: `the ${backend} backend does not support native Date object identity and dynamic tags yet; use --backend rust` }] : [];
}
