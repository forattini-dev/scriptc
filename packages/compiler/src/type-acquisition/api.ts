import { resolve } from "node:path";
import { analyze, type AnalyzeOptions, type AnalyzeResult, type CompileBaseOptions } from "../index.js";
import { resolveRuntimeTarget, setActiveRuntimeTarget } from "../compat/runtime-target.js";
import type { ScrDiagnostic } from "../diagnostics/diagnostic.js";
import { prepareTypeAcquisition, type TypeAcquisitionOptions } from "./acquire.js";
import { withDeclarationOverlay } from "./context.js";

export type AsyncAnalyzeOptions = AnalyzeOptions & { typeAcquisition?: TypeAcquisitionOptions };

export async function withAcquiredTypes<T>(entry: string,
  options: Pick<CompileBaseOptions, "target" | "conditions" | "typeAcquisition"> & { externalTypes?: Readonly<Record<string, string>> },
  run: () => T | Promise<T>, failure: (diagnostic: ScrDiagnostic) => T): Promise<T> {
  if ((options.typeAcquisition?.mode ?? "local") === "local") return run();
  setActiveRuntimeTarget(resolveRuntimeTarget(resolve(entry), options.target).profile, options.conditions ?? []);
  let overlay;
  try { overlay = await prepareTypeAcquisition(entry, options.typeAcquisition, options.externalTypes); }
  catch (error) {
    return failure({
      code: "SC4030", loc: { file: resolve(entry), start: 0, end: 0 },
      message: `type acquisition failed: ${error instanceof Error ? error.message : String(error)}`,
      hint: "Use --types-mode=local to diagnose installed declarations without downloads. Acquiring types does not supply a runtime implementation.",
    });
  }
  return withDeclarationOverlay(overlay, run);
}

/** Async counterpart of analyze. The synchronous API remains local-only. */
export async function analyzeAsync(entry: string, options: AsyncAnalyzeOptions = {}): Promise<AnalyzeResult> {
  return withAcquiredTypes(entry, { ...options, typeAcquisition: options.typeAcquisition ?? { mode: "auto" } }, () => analyze(entry, options), diagnostic => ({
    coverage: {
      file: entry, dynamic: options.dynamic ?? false, preflightFailed: true,
      stats: { statementsTotal: 0, statementsFailed: 0, statementsIsland: 0, functionsSkipped: 0 },
      diagnostics: [diagnostic],
    }, sourceTexts: new Map(),
  }));
}
