#!/usr/bin/env node

import { spawn } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { enableCompileCache } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { LEGACY_C_EXECUTABLE_WARNING, shouldWarnLegacyCExecutable } from "./legacy-c-warning.js";
import { CLI_OPTIONS, USAGE } from "./usage.js";

// Node 24 can persist V8's compiled module bytecode. scriptc's CLI imports
// the compiler and its lowering/backend graph before handling any command, so
// enabling this in the tiny bootstrap avoids reparsing that graph on every
// edit/build invocation.
try {
  enableCompileCache();
} catch {
  // Bytecode caching is an optimization boundary. A read-only temp directory
  // must never prevent the compiler from running.
}

function packageVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  try {
    return (JSON.parse(requireText(join(here, "..", "package.json"))) as { version?: string }).version ?? "unknown";
  } catch {
    return "unknown";
  }
}

function requireText(path: string): string {
  // This tiny synchronous read keeps --version free of the compiler graph and
  // preserves the package manifest as the one release-version authority.
  const { readFileSync } = process.getBuiltinModule("node:fs") as typeof import("node:fs");
  return readFileSync(path, "utf8");
}

async function tryFastPath(): Promise<number | null> {
  let parsed: ReturnType<typeof parseArgs<{ options: typeof CLI_OPTIONS; allowPositionals: true; allowNegative: true }>>;
  try {
    parsed = parseArgs({ options: CLI_OPTIONS, allowPositionals: true, allowNegative: true });
  } catch {
    return null; // main owns exact user-error wording
  }
  const { values, positionals } = parsed;
  if (values.version) {
    process.stdout.write(`${packageVersion()}\n`);
    return 0;
  }
  if (values.help || positionals.length === 0) {
    process.stdout.write(USAGE);
    return values.help ? 0 : 1;
  }
  const [command, inputArg] = positionals;
  if (
    (command !== "build" && command !== "run") || inputArg === undefined ||
    (values.emit !== undefined && values.emit !== "exe") ||
    values.print !== undefined ||
    values["emit-ir"] ||
    values.lib || values.engine === false || values["from-c"] || values["provenance-sources"] ||
    (values["external-types"] ?? []).length > 0 || (values["types-mode"] !== undefined && values["types-mode"] !== "local") ||
    values["types-lock"] !== undefined || values["types-cache"] !== undefined || values["frozen-types-lock"]
  ) return null;
  const backend = values.backend ?? "rust";
  // Only explicit C/LLVM selections may restore their legacy cached artifacts.
  if (backend !== "c" && backend !== "llvm") return null;
  const targetArg = values.target;
  const islandModules = (values["island-module"] ?? [])
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter((value) => value !== "");
  const conditions = (values.conditions ?? [])
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter((value) => value !== "");
  const optimization = values.optimization;
  if (optimization !== undefined && optimization !== "release" && optimization !== "dev") return null;
  const npmRaw = (values["npm-static"] ?? [])
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter((value) => value !== "");
  let npmStatic: string[] | "auto" | null = null;
  if (npmRaw.includes("auto")) {
    if (npmRaw.length !== 1) return null;
    npmStatic = "auto";
  } else if (npmRaw.length > 0) {
    npmStatic = npmRaw;
  }

  let startup: typeof import("@scriptc/compiler/startup-cache");
  let buildPlatform: string;
  try {
    startup = await import("@scriptc/compiler/startup-cache");
    buildPlatform = startup.configuredTargetPlatform();
  } catch {
    return null;
  }
  if (command === "run" && buildPlatform === "wasi") return null;
  const input = resolve(inputArg);
  // The runtime target joins the cache key exactly as the full CLI
  // computes it; an invalid spelling leaves the error to the full CLI.
  if (targetArg !== undefined && !startup.isRuntimeTargetId(targetArg)) return null;
  let runtimeTarget: string;
  try {
    runtimeTarget = startup.runtimeTargetKey(startup.resolveRuntimeTarget(input, targetArg).profile, conditions);
  } catch {
    return null;
  }
  const outDir = values.out ? dirname(resolve(values.out)) : join(dirname(input), ".scriptc");
  const stem = basename(input).replace(/\.(ts|mts|cts|js|mjs|cjs|c|ll)$/, "");
  const defaultName = buildPlatform === "win32"
    ? `${stem}.exe`
    : buildPlatform === "wasi"
      ? `${stem}.wasm`
      : stem;
  const outPath = values.out ? resolve(values.out) : join(outDir, defaultName);
  const ffiPath = values.ffi === undefined ? null : resolve(values.ffi);
  const ffiBytes = ffiPath === null ? null : await readFile(ffiPath).catch(() => null);
  if (ffiPath !== null && ffiBytes === null) return null;
  const root = await startup.prepareBuildCacheRoot(startup.resolveBuildCacheRoot());
  // This must exactly mirror the ordinary LLVM executable's route in the
  // full compiler. Otherwise a valid helper/runtime-pack cache entry has a
  // different target/compiler identity and bootstrap must unnecessarily load
  // the whole compiler graph to rediscover it.
  const helperRuntimePackTarget = backend !== "c" && !values.sanitize
    ? startup.precompiledRuntimePackTarget()
    : null;
  const helperObjectRoute = helperRuntimePackTarget !== null;
  let nativeEnvironment: string | null;
  try {
    nativeEnvironment = helperObjectRoute
      ? await startup.executableLinkerEnvironmentFingerprint(
        process.env,
        helperRuntimePackTarget.defaultLinker,
      )
      : await startup.executableNativeEnvironmentFingerprint();
  } catch {
    nativeEnvironment = null;
  }
  if (nativeEnvironment === null) return null;
  const hit = await startup.readRoutedExecutableCache(root, {
    entryPath: input,
    outDir,
    outPath,
    emitIr: values["emit-ir"],
    sanitize: values.sanitize,
    dynamic: values.dynamic,
    backend,
    ...(optimization === "dev" ? { optimization: "dev" as const } : {}),
    npmStatic,
    typeAcquisition: values["types-mode"] === "local" ? "local" : "auto",
    ffiProfile: ffiPath === null ? null : { path: ffiPath, bytes: ffiBytes! },
    target: `${process.env["SCRIPTC_TARGET"] ?? "native"}:${buildPlatform}:${process.arch}:${
      helperObjectRoute ? "runtime-pack" : "driver-tu"
    }`,
    runtimeTarget,
    islandModules,
    islandSourceStore: startup.resolveIslandSourceStore(
      values["island-store"] === "raw" || values["island-store"] === "deflate" ? values["island-store"] : undefined,
    ),
    compiler: [helperObjectRoute
      ? startup.resolvePlatformLinker(process.env, helperRuntimePackTarget.defaultLinker)
      : (process.env["SCRIPTC_CC"] ?? "clang")],
    nativeEnvironment,
    nodeVersion: process.version,
  });
  if (hit === null) return null;
  if (shouldWarnLegacyCExecutable({
    executable: true,
    fromC: false,
    backend,
    sanitize: values.sanitize,
  })) {
    process.stderr.write(LEGACY_C_EXECUTABLE_WARNING);
  }
  if (hit.native.llvmRefusal !== undefined) {
    process.stderr.write(`scriptc: backend c (llvm refused: ${hit.native.llvmRefusal})\n`);
  }
  // Source-primary invocations can replace a previously cached executable.
  // A routed hit restores that executable without loading the full compiler,
  // so mirror its output-kind cleanup before returning from the fast path.
  await rm(join(outDir, `${stem}.ir.json`), { force: true });
  if (!values["keep-c"]) await rm(hit.cPath, { force: true });
  if (command === "build") {
    process.stdout.write(`${outPath}\n`);
    return 0;
  }
  return new Promise<number>((resolveExit) => {
    const child = spawn(outPath, [], { stdio: "inherit" });
    child.on("exit", (code, signal) => {
      if (signal) {
        process.stderr.write(`scriptc: program killed by ${signal}\n`);
        resolveExit(1);
      } else {
        resolveExit(code ?? 0);
      }
    });
  });
}

const fastExit = await tryFastPath();
if (fastExit === null) {
  await import("./main.js");
} else {
  process.exitCode = fastExit;
}
