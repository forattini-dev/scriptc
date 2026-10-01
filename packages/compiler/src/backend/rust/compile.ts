import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, realpath, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { withNativeBuildSlot } from "../native-build-slot.js";
import { featuresEmbedIsland, type RustRuntimeFeature } from "./runtime-features.js";

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
  allowEngine?: boolean;
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

/** A provisionable toolchain error, not an unsupported source construct or ICE. */
export class RustBuildConfigurationError extends RustCompileError {
  constructor(message: string, stdout = "", stderr = "") {
    super(message, stdout, stderr);
    this.name = "RustBuildConfigurationError";
  }
}

interface RustSanitizer {
  toolchain: string;
  rustcPath: string;
  target: string;
  flags: string[];
  identity: string;
}

async function rustSanitizer(): Promise<RustSanitizer> {
  const toolchain = process.env["SCRIPTC_RUST_SAN_TOOLCHAIN"] ?? "";
  const date = toolchain.slice("nightly-".length);
  if (!/^nightly-\d{4}-\d{2}-\d{2}$/.test(toolchain) ||
      Number.isNaN(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) {
    throw new RustBuildConfigurationError(
      "Rust AddressSanitizer requires SCRIPTC_RUST_SAN_TOOLCHAIN=nightly-YYYY-MM-DD naming an installed, dated nightly; floating nightly and stable toolchains are not accepted",
    );
  }
  for (const name of ["RUSTC", "RUSTC_WRAPPER", "RUSTC_WORKSPACE_WRAPPER", "CARGO_BUILD_RUSTC", "CARGO_BUILD_RUSTC_WRAPPER", "CARGO_BUILD_RUSTC_WORKSPACE_WRAPPER"]) {
    if (process.env[name]) throw new RustBuildConfigurationError(
      `Rust AddressSanitizer cannot verify the pinned compiler while ${name} is set; unset it for the sanitizer build`,
    );
  }
  let version: CommandOutput;
  try {
    version = await run("rustup", ["run", toolchain, "rustc", "-vV"], "checking the Rust sanitizer toolchain");
  } catch (error) {
    if (!(error instanceof RustCompileError)) throw error;
    throw new RustBuildConfigurationError(
      `Rust AddressSanitizer requires the installed toolchain ${toolchain}; provision it with rustup toolchain install ${toolchain} --profile minimal`,
      error.stdout, error.stderr,
    );
  }
  const target = /^host: (\S+)$/m.exec(version.stdout)?.[1] ?? "";
  const supported = ["x86_64-unknown-linux-gnu", "aarch64-unknown-linux-gnu", "x86_64-apple-darwin", "aarch64-apple-darwin"];
  if (!/^release: .*nightly/m.test(version.stdout) || !supported.includes(target)) {
    throw new RustBuildConfigurationError(`Rust AddressSanitizer requires a nightly compiler on a supported native Linux GNU or macOS target; reported host '${target}'`);
  }
  let rustcPath: string;
  try {
    rustcPath = (await run("rustup", ["which", "--toolchain", toolchain, "rustc"], "locating the pinned Rust sanitizer compiler")).stdout.trim();
  } catch (error) {
    if (!(error instanceof RustCompileError)) throw error;
    throw new RustBuildConfigurationError(`Rust AddressSanitizer could not locate rustc in the installed toolchain ${toolchain}`, error.stdout, error.stderr);
  }
  if (!isAbsolute(rustcPath)) throw new RustBuildConfigurationError(`Rust AddressSanitizer requires an absolute rustc path from rustup for ${toolchain}`);
  const encoded = process.env["CARGO_ENCODED_RUSTFLAGS"];
  const ambientFlags = encoded !== undefined
    ? encoded.split("\x1f").filter(Boolean)
    : (process.env["RUSTFLAGS"] ?? "").trim().split(/\s+/).filter(Boolean);
  if (ambientFlags.some(flag => flag.startsWith("--target") || flag.includes("sanitizer="))) {
    throw new RustBuildConfigurationError("Rust AddressSanitizer owns --target and -Zsanitizer; remove conflicting RUSTFLAGS or CARGO_ENCODED_RUSTFLAGS");
  }
  const flags = [...ambientFlags, "-Zsanitizer=address", "-C", "force-frame-pointers=yes", "-C", "debuginfo=1"];
  return { toolchain, rustcPath, target, flags, identity: [toolchain, rustcPath, version.stdout, target, ...flags].join("\0") };
}

function runRustTool(tool: "cargo" | "rustc", args: string[], purpose: string, sanitizer?: RustSanitizer, environment?: NodeJS.ProcessEnv): Promise<CommandOutput> {
  return sanitizer === undefined
    ? run(tool, args, purpose, environment)
    : run("rustup", ["run", sanitizer.toolchain, tool, ...args], purpose, { ...environment, RUSTUP_TOOLCHAIN: sanitizer.toolchain });
}

/**
 * Build the cached Rust runtime crate, then let rustc produce the final
 * executable. No C translation unit or C compiler participates in this path.
 */
export async function compileRust(options: RustCompileOptions): Promise<void> {
  if (options.allowEngine === false && featuresEmbedIsland(options.runtimeFeatures ?? [])) {
    throw new RustCompileError("--no-engine forbids JavaScript engine runtime features");
  }
  await withNativeBuildSlot(() => compileRustUnbounded(options));
}

async function compileRustUnbounded(options: RustCompileOptions): Promise<void> {
  const context = await prepareRustBuild(options);
  await mkdir(dirname(options.outPath), { recursive: true });
  const rustcArgs = [
    ...rustcBaseArgs(options.sourcePath, context, options.optimization),
    // Optimize across the generated program and runtime in release executables.
    // Keep library objects available for the separate native localization pass.
    ...(options.optimization === "dev" ? [] : ["-C", "lto=fat"]),
    // The runtime rlib carries std's debug sections; without stripping they
    // dominate a small executable. Library archives keep their symbols for
    // the nm/ld localization pass, so this applies to executables only.
    // SCRIPTC_KEEP_SYMBOLS=1 keeps the symbol table in a release binary so
    // perf/gdb can attribute time to runtime and engine functions.
    ...(context.sanitizer !== undefined || options.optimization === "dev" || process.env.SCRIPTC_KEEP_SYMBOLS === "1" ? [] : ["-C", "strip=symbols"]),
    ...(options.linkInputs ?? []).flatMap((input) => ["-C", `link-arg=${input}`]),
    ...(options.systemLibraries ?? []).flatMap((name) => ["-l", name]),
    "-o", options.outPath,
  ];
  await runRustTool("rustc", rustcArgs, "compiling the generated Rust program", context.sanitizer);
}

/** Compile a generated library-mode module into a C-linkable static archive. */
export async function compileRustLibrary(
  options: RustLibraryCompileOptions,
): Promise<void> {
  await withNativeBuildSlot(() => compileRustLibraryUnbounded(options));
}

async function compileRustLibraryUnbounded(
  options: RustLibraryCompileOptions,
): Promise<void> {
  const context = await prepareRustBuild({ ...options, library: true });
  await mkdir(dirname(options.outPath), { recursive: true });
  await runRustTool(
    "rustc",
    [
      ...rustcBaseArgs(options.sourcePath, context, options.optimization),
      "--crate-type", "staticlib",
      "-o", options.outPath,
    ],
    "compiling the generated Rust library",
    context.sanitizer,
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
  sanitizer?: RustSanitizer;
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
  const sanitizer = options.sanitize ? await rustSanitizer() : undefined;

  const runtimePackage = require.resolve("@scriptc/runtime-rust/package.json");
  const runtimeRoot = dirname(runtimePackage);
  const manifestPath = join(runtimeRoot, "Cargo.toml");
  const cacheBase = process.env["SCRIPTC_CACHE_DIR"] ??
    join(process.env["XDG_CACHE_HOME"] ?? join(homedir(), ".cache"), "scriptc");
  const profile = options.optimization === "dev" ? "debug" : "release";
  const preserveLibraryObjects = options.library === true && profile === "release";
  const runtimeFeatures = [...new Set(options.runtimeFeatures ?? [])].sort();
  const targetDir = rustRuntimeTargetDir(
    cacheBase,
    await realpath(runtimeRoot),
    runtimeFeatures,
    preserveLibraryObjects,
    sanitizer?.identity,
  );
  const cargoArgs = [
    "build",
    "--manifest-path", manifestPath,
    "--target-dir", targetDir,
    "--locked",
    // Let Cargo populate cold caches and honor its explicit offline configuration.
    "--message-format=json-render-diagnostics",
    "--no-default-features",
    ...(sanitizer === undefined ? [] : ["--target", sanitizer.target]),
    ...(runtimeFeatures.length === 0 ? [] : ["--features", runtimeFeatures.join(",")]),
    ...(profile === "release" ? ["--release"] : []),
  ];
  const cargo = await runRustTool(
    "cargo",
    cargoArgs,
    "building the Rust runtime",
    sanitizer,
    {
      ...(preserveLibraryObjects ? { CARGO_PROFILE_RELEASE_LTO: "false", CARGO_PROFILE_RELEASE_STRIP: "none" } : {}),
      ...(sanitizer === undefined ? {} : {
        // Environment overrides Cargo config files as well as rustup's proxy
        // selection: an ambient build.rustc/wrapper must not bypass this pin.
        RUSTC: sanitizer.rustcPath,
        RUSTC_WRAPPER: "",
        RUSTC_WORKSPACE_WRAPPER: "",
        CARGO_ENCODED_RUSTFLAGS: sanitizer.flags.join("\x1f"),
        CARGO_PROFILE_RELEASE_STRIP: "none",
        CARGO_PROFILE_RELEASE_DEBUG: "1",
      }),
    },
  );

  return {
    runtimeRlib: rustRuntimeArtifact(cargo.stdout),
    targetDir,
    profile,
    ...(sanitizer === undefined ? {} : { sanitizer }),
  };
}

/**
 * Cargo's top-level `libscriptc_runtime.rlib` is not content-addressed. A
 * shared target directory therefore lets a different worktree or feature
 * build replace the artifact after our Cargo process exits but before rustc
 * links it. Keep only ABI-compatible runtime builds in one target directory.
 */
export function rustRuntimeTargetDir(
  cacheBase: string,
  canonicalRuntimeRoot: string,
  runtimeFeatures: readonly RustRuntimeFeature[],
  preserveLibraryObjects: boolean,
  sanitizerIdentity?: string,
): string {
  const identity = createHash("sha256")
    .update(canonicalRuntimeRoot)
    .update("\0")
    .update([...new Set(runtimeFeatures)].sort().join("\0"))
    .update(sanitizerIdentity === undefined ? "" : `\0asan\0${sanitizerIdentity}`)
    .digest("hex")
    .slice(0, 16);
  return join(
    cacheBase,
    sanitizerIdentity === undefined
      ? (preserveLibraryObjects ? "rust-runtime-v2-library" : "rust-runtime-v2")
      : (preserveLibraryObjects ? "rust-runtime-v3-asan-library" : "rust-runtime-v3-asan"),
    identity,
  );
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
    "-L", `dependency=${join(context.targetDir, ...(context.sanitizer === undefined ? [] : [context.sanitizer.target]), context.profile, "deps")}`,
    "-C", optimization === "dev" ? "opt-level=0" : "opt-level=2",
    ...(context.sanitizer === undefined ? ["-C", "debuginfo=0"] : ["--target", context.sanitizer.target, ...context.sanitizer.flags]),
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
