import type { CompileRequestOptions } from "./index.js";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { type NativeArtifactDependency } from "./backend/native-toolchain.js";
import { assertLegacyCExecutablePipelineEnabled, compileExternalC, legacyCExecutablePathRequested } from "./backend/external-c.js";
import { emitNativeArtifact } from "./backend/native-codegen.js";
import { privateSiblingPath } from "./backend/build-cache.js";
import { nativeCodegenTarget } from "./backend/targets.js";
import { RuntimePackError } from "./backend/runtime-pack.js";
import { createNativeLinkPlan } from "./backend/link-plan.js";
import { linkNativeExecutable, platformLinkerSupportsPersistentCache } from "./backend/linker.js";
import { splitLlvmProgram } from "./backend/llvm/split.js";
import { nativeCodegenDiag, type ScrDiagnostic } from "./diagnostics/diagnostic.js";
import { moduleEmbedsBuiltin, moduleEmbedsCompressedNpm, moduleUsesAssert, moduleUsesCopying, moduleUsesDc, moduleUsesDgram, moduleUsesDynAsync, moduleUsesDynInvoke, moduleUsesEmitter, moduleUsesFetch, moduleUsesFileHandle, moduleUsesFsWatch, moduleUsesHttp2, moduleUsesHttpServer, moduleUsesInspect, moduleUsesLegacyTextDecoder, moduleUsesNet, moduleUsesNodeTest, moduleUsesParseArgs, moduleUsesProcessEvents, moduleUsesQs, moduleUsesRegex, moduleUsesSearchParams, moduleUsesStream, moduleUsesSymbol, moduleUsesTls, moduleUsesTlsCa, moduleUsesZlib, type IrModule } from "./ir/ir.js";
import { type FfiProfile } from "./ffi/ffi-manifest.js";
import { hasForeignFfiCallback } from "./backend/ffi-callbacks.js";
import { type EarlyExecutableNativeFeatures } from "./executable/executable-cache.js";

export function executableNativeFeatures(
  mod: IrModule,
  backend: "c" | "llvm",
  dynamic: boolean,
  optimization: "release" | "dev",
  llvmRefusal?: string,
): EarlyExecutableNativeFeatures {
  return {
    backend,
    ...(optimization === "dev" ? { optimization: "dev" as const } : {}),
    ...(llvmRefusal === undefined ? {} : { llvmRefusal }),
    dynamic,
    regex: moduleUsesRegex(mod),
    copying: moduleUsesCopying(mod),
    textDecoderLegacy: moduleUsesLegacyTextDecoder(mod),
    fileHandle: moduleUsesFileHandle(mod),
    fetch: moduleUsesFetch(mod),
    netIsland:
      moduleEmbedsBuiltin(mod, "node:http") ||
      moduleEmbedsBuiltin(mod, "node:https") ||
      moduleEmbedsBuiltin(mod, "node:net") ||
      moduleEmbedsBuiltin(mod, "node:tls"),
    zlib: moduleUsesZlib(mod) || moduleEmbedsCompressedNpm(mod),
    assert: moduleUsesAssert(mod),
    inspect: moduleUsesInspect(mod),
    dynInvoke: moduleUsesDynInvoke(mod),
    dc: moduleUsesDc(mod),
    dynAsync: moduleUsesDynAsync(mod),
    events: moduleUsesProcessEvents(mod),
    emitter: moduleUsesEmitter(mod),
    symbol: moduleUsesSymbol(mod),
    searchParams: moduleUsesSearchParams(mod),
    qs: moduleUsesQs(mod),
    parseArgs: moduleUsesParseArgs(mod),
    stream: moduleUsesStream(mod),
    net: moduleUsesNet(mod),
    http: moduleUsesHttpServer(mod),
    http2: moduleUsesHttp2(mod),
    dgram: moduleUsesDgram(mod),
    watch: moduleUsesFsWatch(mod),
    foreignFfi: hasForeignFfiCallback(mod.ffiImports ?? []),
    nodeTest: moduleUsesNodeTest(mod),
    tls: moduleUsesTls(mod),
    tlsCa: moduleUsesTlsCa(mod),
  };
}

export async function compileExecutableNative(
  features: EarlyExecutableNativeFeatures,
  cPath: string,
  outPath: string,
  sanitize: boolean,
  ffi: FfiProfile | null,
  programSplit: ReturnType<typeof splitLlvmProgram> = null,
  programObjectDependencies: readonly NativeArtifactDependency[] = [],
  onArtifactReady?: NonNullable<Parameters<typeof compileExternalC>[0]["onArtifactReady"]>,
): Promise<void> {
  const programIsObject = /\.(?:o|obj)$/.test(cPath);
  const runtimePackTarget = programIsObject && !sanitize && process.env["SCRIPTC_RUNTIME_PACK"] !== "0"
    ? nativeCodegenTarget()
    : null;
  if (runtimePackTarget !== null) {
    const plan = await createNativeLinkPlan({
      target: runtimePackTarget,
      programObject: cPath,
      outPath,
      features,
      ffi,
      optimization: features.optimization ?? "release",
      programObjectDependencies,
    });
    const cacheableLinker =
      onArtifactReady !== undefined && ffi === null && platformLinkerSupportsPersistentCache(
        process.env,
        runtimePackTarget,
      );
    await linkNativeExecutable(plan, {
      // A caller-selected linker can be a mutable wrapper with hidden inputs,
      // and a PATH-selected `clang` can be one too. FFI profiles and mutable
      // linker search environments likewise name transitive files that the
      // top-level dependency snapshot cannot prove. Only a direct driver in a
      // stable link environment may publish a reusable final executable.
      ...(cacheableLinker ? { onArtifactReady } : {}),
    });
    return;
  }
  const effectiveProgramSplit =
    programSplit ??
    (!programIsObject && features.optimization === "dev" && features.backend === "llvm" && !sanitize
      ? splitLlvmProgram(await readFile(cPath, "utf8"))
      : null);
  const objectLinkDir = programIsObject
    ? await mkdtemp(join(tmpdir(), "scriptc-object-link-"))
    : null;
  const linkDriverSource = objectLinkDir === null
    ? cPath
    : join(objectLinkDir, "driver.c");
  if (objectLinkDir !== null) await writeFile(linkDriverSource, "/* scriptc object link driver */\n");
  try {
    assertLegacyCExecutablePipelineEnabled();
    await compileExternalC({
      cPath: linkDriverSource,
      outPath,
      cacheIdentity: "scriptc-generated-v1",
      ...(features.optimization === "dev" ? { optimization: "dev" as const } : {}),
      ...(effectiveProgramSplit === null
        ? {}
        : {
            programShards: effectiveProgramSplit.shards,
            programPublicSymbols: effectiveProgramSplit.publicSymbols,
          }),
      sanitize,
      dynamic: features.dynamic,
      regex: features.regex,
      copying: features.copying,
      textDecoderLegacy: features.textDecoderLegacy,
      fileHandle: features.fileHandle,
      fetch: features.fetch,
      netIsland: features.netIsland,
      zlib: features.zlib,
      assert: features.assert,
      inspect: features.inspect,
      dynInvoke: features.dynInvoke,
      dc: features.dc,
      dynAsync: features.dynAsync,
      events: features.events,
      emitter: features.emitter,
      symbol: features.symbol,
      searchParams: features.searchParams,
      qs: features.qs,
      parseArgs: features.parseArgs,
      stream: features.stream,
      net: features.net,
      http: features.http,
      http2: features.http2,
      dgram: features.dgram,
      watch: features.watch,
      foreignFfi: features.foreignFfi,
      nodeTest: features.nodeTest,
      tls: features.tls,
      tlsCa: features.tlsCa,
      ...(onArtifactReady === undefined ? {} : { onArtifactReady }),
      ...(ffi === null && !programIsObject
        ? {}
        : {
            linkInputs: [
              ...(programIsObject ? [cPath] : []),
              ...(ffi?.libraries ?? []),
            ],
            ...(ffi === null ? {} : { systemLibraries: ffi.systemLibraries }),
          }),
    });
  } finally {
    if (objectLinkDir !== null) {
      await rm(objectLinkDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

export async function emitNativeProgramObject(
  entryPath: string,
  opts: CompileRequestOptions,
  llvm: string,
): Promise<{ linkPath: string; artifactPath: string; dependencies: NativeArtifactDependency[] }> {
  const stem = basename(entryPath).replace(/\.(ts|mts|cts|js|mjs|cjs)$/, "");
  const artifactPath = join(opts.outDir, `${stem}.helper.o`);
  // compileExecutableNative recognizes object inputs by suffix. The random
  // private name isolates concurrent builds; retain .o so the driver links
  // it rather than attempting to compile it as source.
  const linkPath = `${privateSiblingPath(artifactPath, "native-program-object")}.o`;
  try {
    const artifact = await emitNativeArtifact({
      outputPath: linkPath,
      llvm,
      outputKind: "obj",
      sourcePath: entryPath,
      optimization: opts.optimization === "dev" ? "0" : "2",
      ...(opts.sanitize === undefined ? {} : { sanitize: opts.sanitize }),
    });
    return { linkPath, artifactPath, dependencies: artifact.dependencies };
  } catch (error) {
    await rm(linkPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export function usesPrecompiledRuntimePack(
  opts: CompileRequestOptions,
  backend: "c" | "llvm",
): boolean {
  if (
    backend !== "llvm" || opts.sanitize === true ||
    process.env["SCRIPTC_RUNTIME_PACK"] === "0" ||
    process.env["SCRIPTC_FETCH_CURL"] === "1" || legacyCExecutablePathRequested()
  ) return false;
  return nativeCodegenTarget() !== null;
}

export function runtimePackDiagnostic(error: RuntimePackError, entryPath: string): ScrDiagnostic {
  return nativeCodegenDiag(error.code === "unsupported" ? "SC3002" : "SC3005", error.message, entryPath);
}
