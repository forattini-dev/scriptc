import type { ScrDiagnostic } from "../diagnostics/diagnostic.js";
import type { IrModule, IrType, SrcLoc } from "../ir/ir.js";

/** C and LLVM retain typed Symbol operations, but do not yet implement native
 * Proxy references or identity-preserving Symbol transport through Dyn. */
export function nativeProxyBackendDiagnostics(mod: IrModule, backend: "c" | "llvm"): ScrDiagnostic[] {
  const records = new Map(mod.records?.map(shape => [shape.id, shape]));
  const unions = new Map(mod.unions?.map(union => [union.id, union]));
  function containsSymbol(type: IrType | undefined, visiting = new Set<string>()): boolean {
    if (!type) return false;
    switch (type.kind) {
      case "symbol": return true;
      case "func": return type.params.some(param => containsSymbol(param, visiting)) || containsSymbol(type.ret, visiting);
      case "array": case "set": return containsSymbol(type.elem, visiting);
      case "map": return containsSymbol(type.key, visiting) || containsSymbol(type.value, visiting);
      case "promise": return containsSymbol(type.inner, visiting);
      case "generator": return [type.yieldT, type.retT, type.nextT].some(channel => containsSymbol(channel, visiting));
      case "record": case "union": {
        const key = type.kind === "record" ? `record:${type.shapeId}` : `union:${type.unionId}`;
        if (visiting.has(key)) return false;
        visiting.add(key);
        try {
          if (type.kind === "union") return unions.get(type.unionId)?.arms.some(arm => containsSymbol(arm, visiting)) ?? false;
          const shape = records.get(type.shapeId);
          return !!shape && (shape.fields.some(field => containsSymbol(field.type, visiting)) || containsSymbol(shape.indexValue, visiting));
        } finally { visiting.delete(key); }
      }
      default: return false;
    }
  }
  let loc: SrcLoc | undefined;
  function visit(value: unknown, parentLoc: SrcLoc): void {
    if (loc || value === null || typeof value !== "object") return;
    if (Array.isArray(value)) { for (const child of value) visit(child, parentLoc); return; }
    const node = value as { kind?: string; fn?: string; test?: string; key?: { type: IrType }; type?: IrType; value?: { type: IrType }; loc?: SrcLoc };
    const here = node.loc ?? parentLoc;
    if ((node.kind === "libCall" && node.fn === "dyn.proxyNew") ||
        (node.kind === "dynFrom" && containsSymbol(node.value?.type)) ||
        (node.kind === "dynCheck" && containsSymbol(node.type)) ||
        (node.kind === "dynTest" && node.test === "symbol") ||
        (node.kind === "dynKeyGet" && (node.key?.type.kind === "symbol" || node.key?.type.kind === "dyn"))) {
      loc = here;
      return;
    }
    for (const child of Object.values(value)) visit(child, here);
  }
  visit(mod, { file: mod.sourceFile, start: 0, end: 0 });
  return loc ? [{ code: "SC3001", loc,
    message: `the ${backend} backend does not support native Proxy references or dynamic Symbol transport yet; use --backend rust`,
  }] : [];
}
