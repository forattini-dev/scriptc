import type { ScrDiagnostic } from "../diagnostics/diagnostic.js";
import type { IrModule } from "../ir/ir.js";
import { islandEngineFeature, rustEngineRequirement } from "./rust/runtime-features.js";

/** Composition of the emitted executable, not a transitive safety claim. */
export interface ExecutionProfile {
  engine: "none" | "quickjs" | "boa" | "v8";
  externalFfi: boolean;
}

export function executionProfile(
  backend: "rust" | "c" | "llvm",
  dynamic: boolean,
  externalFfi: boolean,
  mod?: IrModule,
): ExecutionProfile {
  if (backend !== "rust") return { engine: dynamic ? "quickjs" : "none", externalFfi };
  if (mod === undefined) throw new Error("Rust execution profiles require lowered IR");
  const engine = rustEngineRequirement(mod) === null ? "none"
    : islandEngineFeature() === "island-v8" ? "v8" : "boa";
  return { engine, externalFfi };
}

export function noEngineDiagnostics(
  mod: IrModule,
  backend: "rust" | "c" | "llvm",
  dynamic: boolean,
  runtimeFences: readonly ScrDiagnostic[],
): ScrDiagnostic[] {
  const requirement = rustEngineRequirement(mod);
  if (requirement !== null || (backend !== "rust" && dynamic)) {
    return [{
      code: "SC3003",
      message: `--no-engine forbids ${requirement?.surface ?? "the QuickJS runtime selected by --dynamic"}; this program requires a JavaScript engine`,
      loc: requirement?.loc ?? { file: mod.sourceFile, start: 0, end: 0 },
    }];
  }
  return runtimeFences.map((diagnostic) => ({
    ...diagnostic,
    code: "SC3003",
    message: `--no-engine refuses deferred unsupported functionality: [${diagnostic.code}] ${diagnostic.message}`,
  }));
}
