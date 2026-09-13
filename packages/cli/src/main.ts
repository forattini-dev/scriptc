import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { RUNTIME_TARGET_IDS, analyzeAsync, compile, compileExternalC, compileLibrary, describeRuntimeTargetOrigin, isExactExternalTypeSpecifier, isRuntimeTargetId, renderCoverage, renderDiagnostics, resolveProvenanceSources, resolveRuntimeTarget, setProvenanceSources, sourceTargetPlatform, type TypeAcquisitionOptions, type NativeCacheWarmProfile, warmNativeCaches, writeProjectTiers } from "@scriptc/compiler";
import { LEGACY_C_EXECUTABLE_WARNING, shouldWarnLegacyCExecutable } from "./legacy-c-warning.js";
import { resolveOutputOptions } from "./output-options.js";
import { selectOutputPaths } from "./paths.js";
import { CLI_OPTIONS, USAGE } from "./usage.js";

/** The version of the installed package. Read from the manifest rather than
 * baked in by the build, so a stamped release and a source checkout answer
 * the same way. */
function version(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // dist/main.js at install time, src/main.ts under tsx: the manifest is
  // one level up from either.
  const manifest = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")) as { version?: string };
  return manifest.version ?? "unknown";
}

/* The exit discipline: NEVER process.exit() after writing output. stdout/
 * stderr to a PIPE are async streams — process.exit() drops whatever libuv
 * hasn't flushed yet, which truncates large diagnostic renders at the pipe
 * buffer (observed: 64KB cut mid-code-frame). Every path sets
 * process.exitCode and returns instead; Node exits naturally once the
 * streams drain. */
class CliExit extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}

function fail(msg: string): never {
  process.stderr.write(msg + "\n");
  throw new CliExit(1);
}

/** parseArgs, with its throw turned into the CLI's own one-line error.
 * Unparseable arguments are a USER error — an unknown flag or a missing
 * value used to reach the top level as an uncaught ERR_PARSE_ARGS_* and
 * print a Node stack trace over the user's terminal. */
function parseCli(): ReturnType<typeof parseArgs<{ options: typeof CLI_OPTIONS; allowPositionals: true; allowNegative: true }>> {
  try {
    return parseArgs({ options: CLI_OPTIONS, allowPositionals: true, allowNegative: true });
  } catch (err) {
    // parseArgs appends a paragraph about `--` and positionals to the
    // unknown-option message; the first sentence is the part that names
    // what was wrong, and USAGE below already covers what was meant.
    const raw = err instanceof Error ? err.message : String(err);
    const msg = raw.split("\n")[0]!.split(". ")[0]!;
    fail(`scriptc: ${msg}\n\n${USAGE}`);
  }
}

async function main(): Promise<number> {
  const { values, positionals } = parseCli();
  const externalTypeArgs = values["external-types"] ?? [];

  if (values.version) {
    process.stdout.write(`${version()}\n`);
    return 0;
  }

  if (values.help || positionals.length === 0) {
    process.stdout.write(USAGE);
    return values.help ? 0 : 1;
  }

  const [command, inputArg] = positionals;
  const explicitTypes = values["types-mode"] !== undefined || values["types-lock"] !== undefined || values["types-cache"] !== undefined || values["frozen-types-lock"];
  if (explicitTypes && (command === "cache" || values.lib || values["from-c"])) {
    fail("declaration acquisition options apply to TypeScript/JavaScript builds, runs and coverage");
  }
  const typesMode = values["types-mode"] ?? "auto";
  if (typesMode !== "auto" && typesMode !== "local" && typesMode !== "offline") fail("--types-mode must be auto, local or offline");
  if (typesMode === "local" && (values["types-lock"] !== undefined || values["types-cache"] !== undefined || values["frozen-types-lock"])) fail("local type mode does not use a declaration lock or download cache");
  const typeAcquisition: TypeAcquisitionOptions = {
    mode: typesMode,
    ...(values["types-lock"] === undefined ? {} : { lockPath: values["types-lock"] }),
    ...(values["types-cache"] === undefined ? {} : { cacheDir: values["types-cache"] }),
    frozenLock: values["frozen-types-lock"],
  };

  if (values.engine === false && (command === "cache" || values.lib || values["from-c"])) {
    fail("--no-engine applies to TypeScript/JavaScript executable builds, runs and coverage");
  }
  if (command === "cache") {
    if (inputArg !== "warm") fail(`unknown cache command "${inputArg ?? ""}" (supported: warm)\n\n${USAGE}`);
    if (values.emit !== undefined || values.print !== undefined || values.lib || values.dynamic || values.backend !== undefined || values.target !== undefined || (values.conditions ?? []).length > 0 || values["from-c"] || values.ffi !== undefined || values.profile !== undefined || (values["npm-static"] ?? []).length > 0 || values["provenance-sources"] || externalTypeArgs.length > 0 || values.out !== undefined || values["emit-ir"] || !values["keep-c"]) {
      fail(`scriptc cache warm takes only native optimization/sanitizer options and profile names\n\n${USAGE}`);
    }
    const optimization = values.optimization;
    if (optimization !== undefined && optimization !== "release" && optimization !== "dev") {
      fail(`unknown optimization "${optimization}" (supported: release, dev)\n\n${USAGE}`);
    }
    const profileArgs = positionals.slice(2);
    const knownProfiles = new Set<NativeCacheWarmProfile>(["runtime", "tls", "dynamic"]);
    for (const profile of profileArgs) {
      if (!knownProfiles.has(profile as NativeCacheWarmProfile)) {
        fail(`unknown cache warm profile "${profile}" (supported: runtime, tls, dynamic)`);
      }
    }
    let result;
    try {
      result = await warmNativeCaches({
        ...(optimization === undefined ? {} : { optimization }),
        sanitize: values.sanitize,
        ...(profileArgs.length === 0
          ? {}
          : { profiles: profileArgs as NativeCacheWarmProfile[] }),
      });
    } catch (error) {
      fail(`scriptc: ${error instanceof Error ? error.message : String(error)}`);
    }
    process.stdout.write(`${result.cacheRoot}\n`);
    for (const profile of result.profiles) {
      process.stdout.write(`${profile.profile}\t${Math.round(profile.elapsedMs)}ms\n`);
    }
    return 0;
  }
  if (command !== "build" && command !== "run" && command !== "coverage") {
    fail(`unknown command "${command}"\n\n${USAGE}`);
  }
  if (values.lib) {
    // LIBRARY mode: the profile names the entry module and pins the
    // emission; the executable lane's mode flags have no meaning here
    // (library artifacts are static-tier only, and there is no fallback
    // concept — bare npm specifiers are static-or-refuse: the npm-static
    // eligibility bar runs automatically, eligible packages compile into
    // the graph, ineligible ones refuse with SC4013).
    if (command !== "build") fail(`--lib is a build mode (scriptc build --lib --profile <p.json>)\n\n${USAGE}`);
    const profileArg = values.profile;
    if (!profileArg) fail(`scriptc build --lib needs --profile <profile.json>\n\n${USAGE}`);
    if (inputArg) {
      fail("scriptc build --lib takes no input positional: the profile names the entry module");
    }
    if (values.dynamic || values.backend !== undefined || values.emit !== undefined || values.print !== undefined || values.optimization !== undefined || values.ffi !== undefined || (values["npm-static"] ?? []).length > 0 || externalTypeArgs.length > 0) {
      fail(
        "scriptc build --lib takes no --dynamic/--backend/--emit/--print/--optimization/--npm-static/--ffi/--external-types: the profile pins the emission and optimization, npm imports are judged automatically, outbound FFI belongs to executable builds, and external type mappings belong to coverage",
      );
    }
    if (values.target !== undefined || (values.conditions ?? []).length > 0 || (values["island-module"] ?? []).length > 0) {
      fail("scriptc build --lib takes no --target/--conditions/--island-module: library archives are Node-semantics, static-only artifacts");
    }
    const profilePath = resolve(profileArg);
    const libOutDir = values.out ? dirname(resolve(values.out)) : join(dirname(profilePath), ".scriptc");
    const result = await compileLibrary({
      profilePath,
      outDir: libOutDir,
      ...(values.out ? { outPath: resolve(values.out) } : {}),
      emitIr: values["emit-ir"],
      sanitize: values.sanitize,
    });
    if (!result.ok) {
      const color = process.stderr.isTTY ?? false;
      process.stderr.write(renderDiagnostics(result.diagnostics, result.sourceTexts, { color }) + "\n");
      const n = result.diagnostics.length;
      process.stderr.write(`\n${n} error${n === 1 ? "" : "s"}.\n`);
      return 1;
    }
    if (!values["keep-c"]) rmSync(result.cPath, { force: true });
    process.stdout.write(`${result.archivePath}\n`);
    // The contract sidecar rides the same invocation when the profile
    // declares one — name it so the embedder's tooling knows where to look.
    if (result.sidecarPath !== undefined) process.stdout.write(`${result.sidecarPath}\n`);
    return 0;
  }
  if (values["emit-ir"] && (command === "build" || command === "run")) {
    process.stderr.write("scriptc: warning: --emit-ir is deprecated; use --emit=ir for IR as the primary output\n");
  }
  if (!inputArg) fail(`missing input file\n\n${USAGE}`);
  const input = resolve(inputArg);
  if (command === "coverage" && values.emit !== undefined) {
    fail(`--emit is a build/run option\n\n${USAGE}`);
  }
  if (values.print !== undefined && values.print !== "native-link-info") {
    fail(`unknown print kind "${values.print}" (supported: native-link-info)\n\n${USAGE}`);
  }
  const printNativeLinkInfo = values.print === "native-link-info";
  if (printNativeLinkInfo && command !== "build") {
    fail(`--print=native-link-info is a build option\n\n${USAGE}`);
  }
  if (printNativeLinkInfo && values.emit !== undefined && values.emit !== "obj") {
    fail(`--print=native-link-info requires --emit=obj\n\n${USAGE}`);
  }
  if (externalTypeArgs.length > 0 && command !== "coverage") {
    fail(`--external-types is a coverage-only option\n\n${USAGE}`);
  }
  const externalTypes: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const mapping of externalTypeArgs) {
    const equals = mapping.indexOf("=");
    if (equals <= 0 || equals === mapping.length - 1) {
      fail(`invalid --external-types mapping ${JSON.stringify(mapping)} (expected <specifier=file.d.ts>)`);
    }
    const specifier = mapping.slice(0, equals).trim();
    const declarationArg = mapping.slice(equals + 1).trim();
    if (!isExactExternalTypeSpecifier(specifier)) {
      fail(`invalid --external-types specifier ${JSON.stringify(specifier)} (expected an exact bare package specifier)`);
    }
    if (!/\.d\.(?:ts|mts|cts)$/.test(declarationArg)) {
      fail(`invalid --external-types declaration ${JSON.stringify(declarationArg)} (expected a .d.ts, .d.mts, or .d.cts file)`);
    }
    if (externalTypes[specifier] !== undefined) {
      fail(`duplicate --external-types mapping for ${JSON.stringify(specifier)}`);
    }
    const declarationPath = resolve(declarationArg);
    try {
      if (!statSync(declarationPath).isFile()) throw new Error("not a file");
    } catch {
      fail(`--external-types declaration does not name a readable file: ${declarationPath}`);
    }
    externalTypes[specifier] = declarationPath;
  }
  const ffiProfilePath = values.ffi !== undefined ? resolve(values.ffi) : undefined;
  const requestedBackend = values.backend ?? "rust";
  if (requestedBackend !== undefined && requestedBackend !== "c" && requestedBackend !== "llvm" && requestedBackend !== "rust") {
    fail(`unknown backend "${requestedBackend}" (supported: c, llvm, rust)\n\n${USAGE}`);
  }
  const optimization = values.optimization;
  if (optimization !== undefined && optimization !== "release" && optimization !== "dev") {
    fail(`unknown optimization "${optimization}" (supported: release, dev)\n\n${USAGE}`);
  }
  // --target: an explicit runtime target, else the project's own pins
  // decide (and a one-line note says which file did). --conditions is
  // repeatable and comma-splittable like --npm-static.
  const targetArg = values.target;
  if (targetArg !== undefined && !isRuntimeTargetId(targetArg)) {
    fail(`unknown target "${targetArg}" (supported: ${RUNTIME_TARGET_IDS.join(", ")})\n\n${USAGE}`);
  }
  let runtimeTarget;
  try {
    runtimeTarget = resolveRuntimeTarget(input, targetArg);
  } catch (error) {
    fail(`scriptc: ${error instanceof Error ? error.message : String(error)}`);
  }
  const targetNote = describeRuntimeTargetOrigin(runtimeTarget);
  if (targetNote !== null) process.stderr.write(`${targetNote}\n`);
  const target = runtimeTarget.profile.id;
  const conditions = (values.conditions ?? []).flatMap((v) => v.split(",")).map((v) => v.trim()).filter((v) => v !== "");
  const islandModules = (values["island-module"] ?? []).flatMap((v) => v.split(",")).map((v) => v.trim()).filter((v) => v !== "");
  const islandStore = values["island-store"];
  if (islandStore !== undefined && islandStore !== "raw" && islandStore !== "deflate") {
    fail(`--island-store takes raw or deflate, not '${islandStore}'`);
  }
  if (islandModules.length > 0 && !values.dynamic) {
    fail(`--island-module runs program modules in the embedded engine and needs --dynamic\n\n${USAGE}`);
  }
  if (values["write-tiers"] && !islandModules.includes("auto")) {
    fail(`--write-tiers persists the frontier an --island-module auto run computes\n\n${USAGE}`);
  }
  const persistTiers = (): void => {
    if (!values["write-tiers"]) return;
    const file = writeProjectTiers();
    process.stderr.write(`tiers: wrote ${file}\n`);
  };
  const output = command === "coverage"
    ? null
    : resolveOutputOptions(command, {
        ...(values.emit === undefined && !printNativeLinkInfo
          ? {}
          : { emit: values.emit ?? "obj" }),
        emitIr: values["emit-ir"],
        ...(values.backend === undefined ? {} : { backend: values.backend }),
        fromC: values["from-c"],
        keepC: values["keep-c"],
        sanitize: values.sanitize,
        ...(values.optimization === undefined ? {} : { optimization: values.optimization }),
        ...(values.ffi === undefined ? {} : { ffi: values.ffi }),
      });
  if (output !== null && !output.ok) fail(`${output.message}\n\n${USAGE}`);
  const backend = output?.ok ? output.backend ?? requestedBackend : requestedBackend;

  // --npm-static: repeatable and comma-splittable; the literal "auto"
  // switches to eligibility-based detection (mixing "auto" with names
  // is rejected — the shapes answer different questions).
  const npmStaticRaw = (values["npm-static"] ?? []).flatMap((v) => v.split(",")).map((v) => v.trim()).filter((v) => v !== "");
  let npmStatic: string[] | "auto" | undefined;
  if (npmStaticRaw.includes("auto")) {
    if (npmStaticRaw.length > 1) fail(`--npm-static auto cannot be combined with package names\n\n${USAGE}`);
    npmStatic = "auto";
  } else if (npmStaticRaw.length > 0) {
    npmStatic = npmStaticRaw;
  }

  // --provenance-sources resolves BEFORE the program loads (tsgo needs the
  // source "paths" at creation): attestations and source trees fetch (or
  // ride the content-addressed cache / the offline manifest), the registry
  // installs, and every fallback prints as a note — never a failure.
  const provenance = values["provenance-sources"] ? await resolveProvenanceSources(input) : null;
  if (provenance !== null) {
    setProvenanceSources(provenance);
    for (const pkg of provenance.packages) {
      process.stderr.write(
        `provenance: ${pkg.name}@${pkg.version} ← ${pkg.repo.replace(/^git\+/, "")} @ ${pkg.commit.slice(0, 12)} (source compiles statically)\n`,
      );
    }
    for (const note of provenance.notes) process.stderr.write(`provenance: ${note}\n`);
  }

  if (command === "coverage") {
    const { coverage, sourceTexts } = await analyzeAsync(input, {
      ...(backend === undefined ? {} : { backend }),
      ...(values.engine === false ? { allowEngine: false } : {}),
      target,
      ...(conditions.length > 0 ? { conditions } : {}),
      ...(islandModules.length > 0 ? { islandModules } : {}),
      dynamic: values.dynamic,
      ...(npmStatic !== undefined ? { npmStatic } : {}),
      typeAcquisition,
      ...(ffiProfilePath !== undefined ? { ffiProfilePath } : {}),
      ...(Object.keys(externalTypes).length > 0 ? { externalTypes } : {}),
    });
    const color = process.stdout.isTTY ?? false;
    process.stdout.write(renderCoverage(coverage, { color, sourceTexts }) + "\n");
    if (!coverage.preflightFailed) persistTiers();
    return coverage.preflightFailed || ((backend !== undefined || values.engine === false) && coverage.diagnostics.length > 0) ? 1 : 0;
  }

  if (output === null || !output.ok) throw new Error("internal output-option state");
  const { outDir, outPath, defaultOutputPath } = selectOutputPaths(input, output.cliOutputKind, values.out);

  // SCRIPTC_CC remains a migration escape hatch for explicit C, sanitizer,
  // and comparison builds. The normal LLVM executable route is controlled by
  // SCRIPTC_LINKER, which receives objects and archives only.
  if (shouldWarnLegacyCExecutable({
    executable: output.outputKind === "exe",
    fromC: values["from-c"],
    backend,
    sanitize: values.sanitize,
  })) {
    process.stderr.write(LEGACY_C_EXECUTABLE_WARNING);
  }

  let nativeLinkInfo: object | undefined;
  const build = async (): Promise<string> => {
    if (values["from-c"]) {
      if (ffiProfilePath !== undefined) {
        fail("--ffi is a TypeScript/JavaScript compiler feature and cannot be combined with --from-c");
      }
      await compileExternalC({
        cPath: input,
        outPath,
        sanitize: values.sanitize,
        dynamic: values.dynamic,
        ...(optimization !== undefined ? { optimization } : {}),
      });
      return outPath;
    }
    const result = await compile(input, {
      ...(values.engine === false ? { allowEngine: false } : {}),
      target,
      ...(conditions.length > 0 ? { conditions } : {}),
      ...(islandModules.length > 0 ? { islandModules } : {}),
      ...(islandStore === "raw" || islandStore === "deflate" ? { islandSourceStore: islandStore } : {}),
      outPath,
      outDir,
      outputKind: output.outputKind,
      defaultOutputPath,
      emitIr: output.emitIr,
      sanitize: values.sanitize,
      dynamic: values.dynamic,
      ...(output.outputKind !== "ir" && backend !== undefined ? { backend } : {}),
      ...(optimization !== undefined ? { optimization } : {}),
      ...(npmStatic !== undefined ? { npmStatic } : {}),
      typeAcquisition,
      ...(ffiProfilePath !== undefined ? { ffiProfilePath } : {}),
      ...(printNativeLinkInfo ? { nativeLinkInfo: true } : {}),
    });
    if (!result.ok) {
      const color = process.stderr.isTTY ?? false;
      process.stderr.write(renderDiagnostics(result.diagnostics, result.sourceTexts, { color }) + "\n");
      const n = result.diagnostics.length;
      process.stderr.write(`\n${n} error${n === 1 ? "" : "s"}.\n`);
      throw new CliExit(1);
    }
    persistTiers();
    if (result.artifact.kind === "exe") {
      if (result.artifact.llvmRefusal !== undefined) {
        process.stderr.write(`scriptc: backend c (llvm refused: ${result.artifact.llvmRefusal})\n`);
      }
      if (!values["keep-c"]) rmSync(result.artifact.translationUnitPath, { force: true });
    } else if (result.artifact.kind === "obj") {
      nativeLinkInfo = result.artifact.nativeLinkInfo;
    }
    return result.artifact.path;
  };

  const binary = await build();

  if (command === "run") {
    return new Promise<number>((resolveExit) => {
      let child;
      if (sourceTargetPlatform() === "wasi") {
        const builtRunner = fileURLToPath(new URL("./wasi-runner.js", import.meta.url));
        const runner = existsSync(builtRunner)
          ? builtRunner
          : fileURLToPath(new URL("./wasi-runner.ts", import.meta.url));
        child = spawn(
          process.execPath,
          [...process.execArgv, "--no-warnings", runner, binary],
          { stdio: "inherit" },
        );
      } else {
        child = spawn(binary, [], { stdio: "inherit" });
      }
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
  if (printNativeLinkInfo) {
    if (nativeLinkInfo === undefined) throw new Error("internal native-link-info state");
    // Keep stdout pure JSON for tooling; the ordinary artifact path is in
    // program.object inside the document.
    process.stdout.write(`${JSON.stringify(nativeLinkInfo, null, 2)}\n`);
  } else {
    process.stdout.write(`${binary}\n`);
  }
  return 0;
}

try {
  process.exitCode = await main();
} catch (err) {
  if (err instanceof CliExit) process.exitCode = err.code;
  else throw err;
}
