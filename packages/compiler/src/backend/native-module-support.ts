import { nativeCallableRecordBackendDiagnostics } from "./native-callable-record-support.js";
import type { ScrDiagnostic } from "../diagnostics/diagnostic.js";
import type { IrModule, SrcLoc } from "../ir/nodes.js";
import { LlvmUnsupportedError } from "./llvm/unsupported.js";

/** Native module evaluation has a Rust implementation; other emitters must
 * refuse the metadata as well as the call so cached failures cannot be lost. */
export function nativeModuleBackendDiagnostics(
  mod: IrModule,
  backend: "c" | "llvm" | "rust",
): ScrDiagnostic[] {
  if (backend === "rust") return [];
  const callableRecords = nativeCallableRecordBackendDiagnostics(mod, backend);
  if (callableRecords.length > 0) return callableRecords;
  let loc = mod.functions.find((fn) => fn.syncModuleCacheGlobal !== undefined)?.loc;
  const visit = (value: unknown): void => {
    if (loc !== undefined || value === null || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const child of value) visit(child);
      return;
    }
    const node = value as { kind?: unknown; fn?: unknown; loc?: SrcLoc };
    if (node.kind === "libCall" && (node.fn === "module.import" || node.fn === "module.namespace")) {
      loc = node.loc ?? { file: mod.sourceFile, start: 0, end: 0 };
      return;
    }
    for (const child of Object.values(value)) visit(child);
  };
  visit(mod);
  return loc === undefined ? [] : [{
    code: "SC3001",
    message: `the ${backend} backend does not support native local module imports yet; use --backend rust`,
    loc,
  }];
}

export function assertNativeModuleBackend(mod: IrModule, backend: "c" | "llvm"): void {
  const diagnostic = nativeModuleBackendDiagnostics(mod, backend)[0];
  if (diagnostic === undefined) return;
  const error = backend === "llvm"
    ? new LlvmUnsupportedError(diagnostic.message, diagnostic.loc)
    : new Error(diagnostic.message);
  error.message = diagnostic.message;
  throw error;
}
