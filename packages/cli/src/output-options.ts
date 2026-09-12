import type { CompileOutputKind } from "@scriptc/compiler";
import type { CliOutputKind } from "./paths.js";

export interface OutputOptionValues {
  emit?: string;
  emitIr: boolean;
  backend?: string;
  fromC: boolean;
  keepC: boolean;
  sanitize: boolean;
  optimization?: string;
  ffi?: string;
}

export type OutputOptionResolution =
  | {
      ok: true;
      outputKind: CompileOutputKind;
      cliOutputKind: CliOutputKind;
      backend?: "c" | "llvm" | "rust";
      emitIr: boolean;
      deprecateEmitIr: boolean;
    }
  | { ok: false; message: string };

const SOURCE_KINDS = new Set<CliOutputKind>(["ir", "c", "rust", "llvm"]);
const NATIVE_ARTIFACT_KINDS = new Set<CliOutputKind>(["asm", "obj"]);

/** Pure compatibility/validation matrix for build/run output selection. */
export function resolveOutputOptions(
  command: "build" | "run",
  values: OutputOptionValues,
): OutputOptionResolution {
  if (values.backend !== undefined && values.backend !== "c" && values.backend !== "llvm" && values.backend !== "rust") {
    return { ok: false, message: `unknown backend "${values.backend}" (supported: c, llvm, rust)` };
  }
  const backend = values.backend as "c" | "llvm" | "rust" | undefined;
  const rawEmit = values.emit;
  if (
    rawEmit !== undefined && rawEmit !== "ir" && rawEmit !== "c" && rawEmit !== "rust" && rawEmit !== "llvm" &&
    rawEmit !== "asm" && rawEmit !== "obj" && rawEmit !== "exe"
  ) {
    return {
      ok: false,
      message: `unknown emit kind "${rawEmit}" (supported: ir, c, rust, llvm, asm, obj, exe)`,
    };
  }
  const emit = (rawEmit ?? "exe") as CliOutputKind;
  if (command === "run" && emit !== "exe") {
    return { ok: false, message: `scriptc run requires --emit=exe` };
  }
  if (values.emitIr && rawEmit !== undefined && emit !== "ir" && emit !== "exe") {
    return { ok: false, message: `--emit-ir cannot be combined with --emit=${emit}; use --emit=ir` };
  }
  if (values.emitIr && emit === "ir") {
    return { ok: false, message: `--emit-ir and --emit=ir select the same output; use --emit=ir` };
  }
  if (values.fromC && emit !== "exe") {
    return { ok: false, message: `--from-c only supports --emit=exe` };
  }
  if (emit === "ir" && backend !== undefined) {
    return { ok: false, message: `--emit=ir cannot be combined with --backend; IR is emitted before backend selection` };
  }
  if (emit === "c" && backend !== undefined && backend !== "c") {
    return { ok: false, message: `--emit=c cannot be combined with --backend=${backend}` };
  }
  if ((emit === "llvm" || NATIVE_ARTIFACT_KINDS.has(emit)) && backend !== undefined && backend !== "llvm") {
    return { ok: false, message: `--emit=${emit} cannot be combined with --backend=${backend}` };
  }
  if (emit === "rust" && backend !== undefined && backend !== "rust") {
    return { ok: false, message: `--emit=rust cannot be combined with --backend=${backend}` };
  }
  if (SOURCE_KINDS.has(emit)) {
    if (!values.keepC) {
      return { ok: false, message: `--no-keep-c is only meaningful with --emit=exe` };
    }
    if (values.sanitize) {
      return { ok: false, message: `--sanitize is only meaningful with --emit=exe` };
    }
    if (values.optimization !== undefined) {
      return { ok: false, message: `--optimization is only meaningful with --emit=exe` };
    }
  }
  if (NATIVE_ARTIFACT_KINDS.has(emit) && !values.keepC) {
    return { ok: false, message: `--no-keep-c is only meaningful with --emit=exe` };
  }
  const outputKind = emit as CompileOutputKind;
  return {
    ok: true,
    outputKind,
    cliOutputKind: emit,
    ...(emit === "rust" ? { backend: "rust" as const } : emit === "c"
      ? { backend: "c" as const }
      : emit === "llvm" || NATIVE_ARTIFACT_KINDS.has(emit)
        ? { backend: "llvm" as const }
        : backend === undefined ? {} : { backend }),
    emitIr: values.emitIr && emit === "exe",
    deprecateEmitIr: values.emitIr,
  };
}
