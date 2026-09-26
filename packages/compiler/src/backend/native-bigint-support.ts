import type { ScrDiagnostic } from "../diagnostics/diagnostic.js";
import type { IrModule, SrcLoc } from "../ir/ir.js";

/** LLVM still lacks complete BigInt lowering. The C and Rust runtimes own
 * native representations and must not be rejected by this compatibility
 * fence. */
export function nativeBigIntBackendDiagnostics(mod: IrModule, backend: "c" | "llvm"): ScrDiagnostic[] {
  let loc: SrcLoc | undefined;
  const visit = (value: unknown, parentLoc: SrcLoc): void => {
    if (loc || value === null || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const child of value) visit(child, parentLoc);
      return;
    }
    const node = value as { kind?: unknown; fn?: unknown; test?: unknown; loc?: SrcLoc };
    const here = node.loc ?? parentLoc;
    const dynamicTagTest = node.kind === "dynTest" && node.test === "bigint";
    const llvmBigIntValue = backend === "llvm" && (
      node.kind === "bigint" ||
      (node.kind === "libCall" && typeof node.fn === "string" && node.fn.startsWith("bigint."))
    );
    if (dynamicTagTest || llvmBigIntValue) {
      loc = here;
      return;
    }
    for (const child of Object.values(value)) visit(child, here);
  };
  visit(mod, { file: mod.sourceFile, start: 0, end: 0 });
  return loc ? [{ code: "SC3001", loc, message: `the ${backend} backend does not support native BigInt values yet; use --backend rust` }] : [];
}
