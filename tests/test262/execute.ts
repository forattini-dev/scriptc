import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { compileFailureStatus, completion, harnessSource, prepare } from "./support.mjs";

export interface Outcome {
  status: string;
  reason?: string;
  phase?: string;
  backend?: string;
  llvmRefusal?: string;
  stdout?: string;
  stderr?: string;
  diagnostics?: unknown[];
  workDir?: string;
}

interface ProcessResult {
  code: number | null;
  signal: string | null;
  timeout: boolean;
  overflow: boolean;
  stdout: string;
  stderr: string;
}

export function boundedRun(command: string, args: string[], timeoutMs: number): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const grouped = process.platform !== "win32";
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], detached: grouped });
    let stdout = "";
    let stderr = "";
    let timeout = false;
    let overflow = false;
    const stop = () => {
      try {
        if (grouped && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") reject(error);
      }
    };
    const timer = setTimeout(() => { timeout = true; stop(); }, timeoutMs);
    const collect = (chunk: Buffer, stream: "stdout" | "stderr") => {
      if (overflow) return;
      if (stream === "stdout") stdout += chunk.toString();
      else stderr += chunk.toString();
      if (stdout.length + stderr.length > 1024 * 1024) { overflow = true; stop(); }
    };
    child.stdout.on("data", (chunk) => collect(chunk, "stdout"));
    child.stderr.on("data", (chunk) => collect(chunk, "stderr"));
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, timeout, overflow, stdout, stderr });
    });
  });
}

export async function runSource(source: string, options: {
  backend?: "default" | "llvm" | "c";
  sanitize?: boolean;
  compileTimeoutMs?: number;
  runtimeTimeoutMs?: number;
  keep?: boolean;
} = {}): Promise<Outcome> {
  // Keep sources OUTSIDE node_modules: scriptc intentionally treats imports
  // under that directory as package code, with different compilation rules.
  const workDir = mkdtempSync(join(tmpdir(), "scriptc-test262-"));
  const entry = join(workDir, "main.js");
  const binary = join(workDir, process.platform === "win32" ? "program.exe" : "program");
  const resultFile = join(workDir, "compile.json");
  const requestFile = join(workDir, "request.json");
  let phase = "compile";
  try {
    writeFileSync(entry, prepare(source));
    writeFileSync(join(workDir, "harness.ts"), harnessSource);
    writeFileSync(requestFile, JSON.stringify({
      entry, binary, workDir, result: resultFile,
      backend: options.backend ?? "default", sanitize: options.sanitize ?? false,
    }));
    const compiled = await boundedRun(process.execPath, [
      "--import", "tsx", fileURLToPath(new URL("./compile-worker.ts", import.meta.url)), requestFile,
    ], options.compileTimeoutMs ?? 120_000);
    const finish = (outcome: Outcome): Outcome => ({ ...outcome, ...(options.keep ? { workDir } : {}) });
    if (compiled.timeout) return finish({ status: "timeout", phase });
    if (compiled.signal) return finish({ status: "crash", phase, reason: compiled.signal, stderr: compiled.stderr });
    if (compiled.code !== 0 || compiled.overflow) {
      return finish({ status: "build-error", phase, stdout: compiled.stdout, stderr: compiled.stderr, reason: compiled.signal ?? "compiler process failed" });
    }
    const build = JSON.parse(readFileSync(resultFile, "utf8"));
    if (!build.ok) {
      return finish({ status: compileFailureStatus(build.diagnostics), phase, diagnostics: build.diagnostics });
    }
    phase = "runtime";
    const result = await boundedRun(binary, [], options.runtimeTimeoutMs ?? 10_000);
    const common = { backend: build.backend, ...(build.llvmRefusal ? { llvmRefusal: build.llvmRefusal } : {}) };
    if (result.timeout) return finish({ ...common, status: "timeout", phase });
    if (result.signal) return finish({ ...common, status: "crash", phase, reason: result.signal, stderr: result.stderr });
    const stderr = options.sanitize
      ? result.stderr.replace(/^==\d+==WARNING: ASan doesn't fully support makecontext\/swapcontext.*\n/gm, "")
      : result.stderr;
    if (result.code === 86 && stderr === "SCRIPTC_TEST262_HARNESS: reference equality requires an identity-preserving adapter\n") {
      return finish({ ...common, status: "harness-refusal", phase, reason: "reference-assertion", stderr });
    }
    if (result.code === 0 && !result.overflow && stderr === "" && result.stdout === `${completion}\n`) {
      return finish({ ...common, status: "pass" });
    }
    // Require the entire diagnostic, so a sanitizer report following a known
    // refusal cannot be hidden by the regression expectation.
    const fence = /^Uncaught Error: [^\n]+\[(SC\d{4}) at ([^\n]+):\d+\]\n$/.exec(stderr);
    return finish({
      ...common,
      status: fence ? (fence[2]!.endsWith("/harness.ts") ? "harness-refusal" : "runtime-refusal") : "fail",
      phase, reason: fence?.[1] ?? `exit ${result.code}; completion marker required`,
      stdout: result.stdout, stderr,
    });
  } catch (error) {
    return { status: "runner-error", phase, reason: String(error), ...(options.keep ? { workDir } : {}) };
  } finally {
    if (!options.keep) await rm(workDir, { recursive: true, force: true });
  }
}
