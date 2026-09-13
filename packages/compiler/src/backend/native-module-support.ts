import { nativeEffectBackendDiagnostics } from "./native-effect-support.js";
import { nativeProxyBackendDiagnostics } from "./native-proxy-support.js";
import { nativeDateBackendDiagnostics } from "./native-date-support.js";
import { nativeCallableRecordBackendDiagnostics } from "./native-callable-record-support.js";
import { nativeBigIntBackendDiagnostics } from "./native-bigint-support.js";
import { nativeRegexBackendDiagnostics } from "./native-regex-support.js";
import type { ScrDiagnostic } from "../diagnostics/diagnostic.js";
import type { IrModule, SrcLoc } from "../ir/ir.js";
import { LlvmUnsupportedError } from "./llvm/unsupported.js";

/** Native module evaluation has a Rust implementation; other emitters must
 * refuse the metadata as well as the call so cached failures cannot be lost. */
export function nativeModuleBackendDiagnostics(
  mod: IrModule,
  backend: "c" | "llvm" | "rust",
): ScrDiagnostic[] {
  if (backend === "rust") return [];
  const regex = nativeRegexBackendDiagnostics(mod, backend);
  if (regex.length > 0) return regex;
  const proxies = nativeProxyBackendDiagnostics(mod, backend);
  if (proxies.length > 0) return proxies;
  const effects = nativeEffectBackendDiagnostics(mod, backend);
  if (effects.length > 0) return effects;
  const dates = nativeDateBackendDiagnostics(mod, backend);
  if (dates.length > 0) return dates;
  const bigints = nativeBigIntBackendDiagnostics(mod, backend);
  if (bigints.length > 0) return bigints;
  const callableRecords = nativeCallableRecordBackendDiagnostics(mod, backend);
  if (callableRecords.length > 0) return callableRecords;
  let loc = mod.functions.find((fn) => fn.syncModuleCacheGlobal !== undefined)?.loc;
  let feature = "native local module imports";
  const visit = (value: unknown): void => {
    if (loc !== undefined || value === null || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const child of value) visit(child);
      return;
    }
    const node = value as { kind?: unknown; fn?: unknown; loc?: SrcLoc };
    if (node.kind === "libCall" && (node.fn === "module.import" || node.fn === "module.namespace" || node.fn === "promise.view")) {
      if (node.fn === "promise.view") feature = "Promise payload views";
      loc = node.loc ?? { file: mod.sourceFile, start: 0, end: 0 };
      return;
    }
    for (const child of Object.values(value)) visit(child);
  };
  visit(mod);
  return loc === undefined ? [] : [{
    code: "SC3001",
    message: `the ${backend} backend does not support ${feature} yet; use --backend rust`,
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
