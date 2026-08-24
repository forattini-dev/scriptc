import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);

export interface RustCompileOptions {
  sourcePath: string;
  outPath: string;
  optimization?: "release" | "dev";
  sanitize?: boolean;
}

export class RustCompileError extends Error {
  constructor(
    message: string,
    readonly stdout = "",
    readonly stderr = "",
  ) {
    super(message);
    this.name = "RustCompileError";
  }
}

/**
 * Build the cached Rust runtime crate, then let rustc produce the final
 * executable. No C translation unit or C compiler participates in this path.
 */
export async function compileRust(options: RustCompileOptions): Promise<void> {
  const target = process.env["SCRIPTC_TARGET"];
  if (target !== undefined && target !== "" && target !== "native") {
    throw new RustCompileError(`rust backend target '${target}' is not implemented yet`);
  }
  if (options.sanitize) {
    throw new RustCompileError(
      "rust backend sanitizers require the pinned nightly lane, which is not wired yet",
    );
  }

  const runtimePackage = require.resolve("@scriptc/runtime-rust/package.json");
  const runtimeRoot = dirname(runtimePackage);
  const manifestPath = join(runtimeRoot, "Cargo.toml");
  const cacheBase = process.env["SCRIPTC_CACHE_DIR"] ??
    join(process.env["XDG_CACHE_HOME"] ?? join(homedir(), ".cache"), "scriptc");
  const targetDir = join(cacheBase, "rust-runtime-v1");
  const profile = options.optimization === "dev" ? "debug" : "release";
  const cargoArgs = [
    "build",
    "--manifest-path", manifestPath,
    "--target-dir", targetDir,
    "--locked",
    "--offline",
    ...(profile === "release" ? ["--release"] : []),
  ];
  await run("cargo", cargoArgs, "building the Rust runtime");

  const runtimeRlib = join(targetDir, profile, "libscriptc_runtime.rlib");
  await mkdir(dirname(options.outPath), { recursive: true });
  const rustcArgs = [
    options.sourcePath,
    "--crate-name", "scriptc_program",
    "--edition", "2024",
    "--extern", `scriptc_runtime=${runtimeRlib}`,
    "-L", `dependency=${join(targetDir, profile, "deps")}`,
    "-C", options.optimization === "dev" ? "opt-level=0" : "opt-level=2",
    "-C", "debuginfo=0",
    "-o", options.outPath,
  ];
  await run("rustc", rustcArgs, "compiling the generated Rust program");
}

async function run(command: string, args: string[], purpose: string): Promise<void> {
  try {
    await execFileAsync(command, args, {
      env: process.env,
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (error) {
    const result = error as Error & { stdout?: string; stderr?: string };
    throw new RustCompileError(
      `${purpose} failed: ${result.message}`,
      result.stdout ?? "",
      result.stderr ?? "",
    );
  }
}
