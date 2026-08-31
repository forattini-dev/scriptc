import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
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

export interface RustLibraryCompileOptions {
  sourcePath: string;
  outPath: string;
  optimization?: "release" | "dev";
  sanitize?: boolean;
  runtimeFeatures?: readonly RustRuntimeFeature[];
  localizeSymbols?: readonly string[];
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
  const context = await prepareRustBuild(options);
  await mkdir(dirname(options.outPath), { recursive: true });
  const rustcArgs = [
    ...rustcBaseArgs(options.sourcePath, context, options.optimization),
    // The runtime rlib carries std's debug sections; without stripping they
    // dominate a small executable. Library archives keep their symbols for
    // the nm/ld localization pass, so this applies to executables only.
    ...(options.optimization === "dev" ? [] : ["-C", "strip=symbols"]),
    ...(options.linkInputs ?? []).flatMap((input) => ["-C", `link-arg=${input}`]),
    ...(options.systemLibraries ?? []).flatMap((name) => ["-l", name]),
    "-o", options.outPath,
  ];
  await run("rustc", rustcArgs, "compiling the generated Rust program");
}

/** Compile a generated library-mode module into a C-linkable static archive. */
export async function compileRustLibrary(
  options: RustLibraryCompileOptions,
): Promise<void> {
  const context = await prepareRustBuild({ ...options, library: true });
  await mkdir(dirname(options.outPath), { recursive: true });
  await run(
    "rustc",
    [
      ...rustcBaseArgs(options.sourcePath, context, options.optimization),
      "--crate-type", "staticlib",
      "-o", options.outPath,
    ],
    "compiling the generated Rust library",
  );
  if (options.localizeSymbols !== undefined) {
    await localizeRustLibrary(options.outPath, options.localizeSymbols);
  }
}

async function localizeRustLibrary(
  archivePath: string,
  keepSymbols: readonly string[],
): Promise<void> {
  if (process.platform !== "linux" && process.platform !== "darwin") {
    throw new RustCompileError(
      `runtime localization for Rust libraries is not implemented on ${process.platform} yet`,
    );
  }
  const work = await mkdtemp(join(dirname(archivePath), ".scriptc-rust-localize-"));
  try {
    const combined = join(work, "library.o");
    const localized = join(work, "library.a");
    const keepFile = join(work, "keep.syms");
    if (process.platform === "darwin") {
      await writeFile(keepFile, keepSymbols.map((symbol) => `_${symbol}\n`).join(""));
      await run("ld", [
        "-r",
        ...keepSymbols.flatMap((symbol) => ["-u", `_${symbol}`]),
        archivePath,
        "-o", combined,
        "-exported_symbols_list", keepFile,
      ], "localizing the Rust library archive");
    } else {
      await writeFile(keepFile, keepSymbols.map((symbol) => `${symbol}\n`).join(""));
      await run("ld", [
        "-r",
        "--force-group-allocation",
        ...keepSymbols.flatMap((symbol) => ["-u", symbol]),
        archivePath,
        "-o", combined,
      ], "combining the Rust library archive");
      await run(
        "objcopy",
        [`--keep-global-symbols=${keepFile}`, combined],
        "localizing the Rust library symbols",
      );
    }
    await run("ar", ["rcs", localized, combined], "repacking the localized Rust library");
    await rename(localized, archivePath);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

interface RustBuildContext {
  runtimeRlib: string;
  targetDir: string;
  profile: "debug" | "release";
}

async function prepareRustBuild(
  options: Pick<RustCompileOptions, "optimization" | "sanitize" | "runtimeFeatures"> & {
    library?: boolean;
  },
): Promise<RustBuildContext> {
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
  const profile = options.optimization === "dev" ? "debug" : "release";
  const preserveLibraryObjects = options.library === true && profile === "release";
  const targetDir = join(
    cacheBase,
    preserveLibraryObjects ? "rust-runtime-v1-library" : "rust-runtime-v1",
  );
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
  const cargo = await run(
    "cargo",
    cargoArgs,
    "building the Rust runtime",
    preserveLibraryObjects
      ? { CARGO_PROFILE_RELEASE_LTO: "false", CARGO_PROFILE_RELEASE_STRIP: "none" }
      : undefined,
  );

  return {
    runtimeRlib: rustRuntimeArtifact(cargo.stdout),
    targetDir,
    profile,
  };
}

function rustcBaseArgs(
  sourcePath: string,
  context: RustBuildContext,
  optimization: "release" | "dev" | undefined,
): string[] {
  return [
    sourcePath,
    "--crate-name", "scriptc_program",
    "--edition", "2024",
    "--extern", `scriptc_runtime=${context.runtimeRlib}`,
    "-L", `dependency=${join(context.targetDir, context.profile, "deps")}`,
    "-C", optimization === "dev" ? "opt-level=0" : "opt-level=2",
    "-C", "debuginfo=0",
  ];
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

async function run(
  command: string,
  args: string[],
  purpose: string,
  environment?: NodeJS.ProcessEnv,
): Promise<CommandOutput> {
  try {
    return await execFileAsync(command, args, {
      env: { ...process.env, ...environment },
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
