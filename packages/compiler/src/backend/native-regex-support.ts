import type { ScrDiagnostic } from "../diagnostics/diagnostic.js";
import type { IrModule, SrcLoc } from "../ir/ir.js";

/** Serialized Rust regex operations must never reach a legacy emitter. */
export function nativeRegexBackendDiagnostics(mod: IrModule, backend: "c" | "llvm"): ScrDiagnostic[] {
  let loc: SrcLoc | undefined;
  function visit(value: unknown): void {
    if (loc || value === null || typeof value !== "object") return;
    if (Array.isArray(value)) { for (const item of value) visit(item); return; }
    const node = value as { kind?: unknown; method?: unknown; loc?: SrcLoc };
    if (node.kind === "regexIntrinsic" && ["exec", "lastIndex", "setLastIndex"].includes(String(node.method))) {
      loc = node.loc ?? { file: mod.sourceFile, start: 0, end: 0 };
    } else for (const child of Object.values(value)) visit(child);
  }
  visit(mod);
  return loc ? [{ code: "SC3001", message: `the ${backend} backend does not support stateful regex operations yet; use --backend rust`, loc }] : [];
}
