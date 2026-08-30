import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { RustRuntimeFeature } from "./runtime-features.js";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);

interface CommandOutput {
  stdout: string;
  stderr: string;
}

export interface RustCompileOptions {
  sourcePath: string;
  outPath: string;
  optimization?: "release" | "dev";
  sanitize?: boolean;
  runtimeFeatures?: readonly RustRuntimeFeature[];
  linkInputs?: readonly string[];
  systemLibraries?: readonly string[];
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
  const runtimeFeatures = [...new Set(options.runtimeFeatures ?? [])].sort();
  const cargoArgs = [
    "build",
    "--manifest-path", manifestPath,
    "--target-dir", targetDir,
    "--locked",
    "--offline",
    "--message-format=json-render-diagnostics",
    "--no-default-features",
    ...(runtimeFeatures.length === 0 ? [] : ["--features", runtimeFeatures.join(",")]),
    ...(profile === "release" ? ["--release"] : []),
  ];
  const cargo = await run("cargo", cargoArgs, "building the Rust runtime");

  const runtimeRlib = rustRuntimeArtifact(cargo.stdout);
  await mkdir(dirname(options.outPath), { recursive: true });
  const rustcArgs = [
    options.sourcePath,
    "--crate-name", "scriptc_program",
    "--edition", "2024",
    "--extern", `scriptc_runtime=${runtimeRlib}`,
    "-L", `dependency=${join(targetDir, profile, "deps")}`,
    "-C", options.optimization === "dev" ? "opt-level=0" : "opt-level=2",
    "-C", "debuginfo=0",
    ...(options.linkInputs ?? []).flatMap((input) => ["-C", `link-arg=${input}`]),
    ...(options.systemLibraries ?? []).flatMap((name) => ["-l", name]),
    "-o", options.outPath,
  ];
  await run("rustc", rustcArgs, "compiling the generated Rust program");
}

function rustRuntimeArtifact(output: string): string {
  for (const line of output.trim().split("\n").reverse()) {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    const artifact = message as {
      reason?: unknown;
      target?: { name?: unknown };
      filenames?: unknown;
    };
    if (artifact.reason !== "compiler-artifact" || artifact.target?.name !== "scriptc_runtime" ||
        !Array.isArray(artifact.filenames)) continue;
    const rlib = artifact.filenames.find(
      (filename): filename is string => typeof filename === "string" && filename.endsWith(".rlib"),
    );
    if (rlib !== undefined) return rlib;
  }
  throw new RustCompileError("building the Rust runtime did not report its rlib artifact");
}

async function run(command: string, args: string[], purpose: string): Promise<CommandOutput> {
  try {
    return await execFileAsync(command, args, {
      env: process.env,
      encoding: "utf8",
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
