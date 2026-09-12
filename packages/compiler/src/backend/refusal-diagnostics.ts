import type { ScrDiagnostic } from "../diagnostics/diagnostic.js";
import type { SrcLoc } from "../ir/ir.js";
import type { LlvmUnsupportedError } from "./llvm/emitter.js";
import type { RustUnsupportedError } from "./rust/emitter.js";

/** The LLVM backend's tier refusal as a diagnostic. SC3xxx = backend
 * coverage (the program is fine — this backend doesn't compile it yet);
 * the parenthesized kind tag is machine-readable for the differential
 * harness's histogram. */
export function llvmRefusalDiag(err: LlvmUnsupportedError, entryPath: string): ScrDiagnostic {
  return {
    code: "SC3001",
    message: err.message,
    loc: err.loc ?? { file: entryPath, start: 0, end: 0 },
  };
}

function rustRefusalDiag(err: RustUnsupportedError, entryPath: string): ScrDiagnostic {
  return {
    code: "SC3001",
    message: err.message,
    loc: err.loc ?? { file: entryPath, start: 0, end: 0 },
  };
}

/** Every refusal one emission collected (SCRIPTC_RUST_REFUSALS=all), the
 * first one alone otherwise; identical (message, location) pairs once. */
export function rustRefusalDiags(err: RustUnsupportedError, entryPath: string): ScrDiagnostic[] {
  const seen = new Set<string>();
  const out: ScrDiagnostic[] = [];
  for (const refusal of [err, ...err.also]) {
    const diag = rustRefusalDiag(refusal, entryPath);
    const key = `${diag.message}@${diag.loc.file}:${diag.loc.start}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(diag);
  }
  return out;
}

/** A valid IR surface the explicitly-selected code generator cannot host.
 * SC3001 is backend coverage (as with an LLVM tier refusal), not a target
 * capability gap: wasm32-wasi's production LLVM lane still accepts it. */
export function backendRefusalDiag(
  backend: "c" | "llvm" | "rust",
  target: string,
  surface: string,
  loc: SrcLoc,
): ScrDiagnostic {
  return {
    code: "SC3001",
    message: `${backend} backend does not support ${surface} for ${target}${backend === "rust" ? "" : "; use --backend llvm"}`,
    loc,
  };
}

/** A valid program surface that the selected execution target cannot host.
 * SC3xxx stays the backend/target-coverage family: source semantics are
 * valid, but this target deliberately refuses them instead of emitting a
 * binary that traps later. */
export function targetRefusalDiag(target: string, surface: string, loc: SrcLoc): ScrDiagnostic {
  return {
    code: "SC3002",
    message: `${target} target does not support ${surface}`,
    loc,
  };
}
