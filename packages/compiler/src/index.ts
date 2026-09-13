import { executableNativeFeatures, compileExecutableNative, emitNativeProgramObject, usesPrecompiledRuntimePack, runtimePackDiagnostic } from "./native-emission.js";
import { resolveLibrarySection, libraryIntSlotConfig, mergeSidecarIntSlots } from "./library/section-resolution.js";
import { llvmRefusalDiag, rustRefusalDiags, backendRefusalDiag, targetRefusalDiag } from "./backend/refusal-diagnostics.js";
import { InternalCompilerError } from "./errors.js";
import { ffiNativeBuildDetail } from "./ffi/native-build-detail.js";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { clearCcCaches, configuredTargetPlatform, type NativeArtifactDependency } from "./backend/native-toolchain.js";
import { buildCacheRoot, prepareBuildCacheRoot, pruneBuildCache } from "./backend/build-cache.js";
import {
  CcCompileError,
  compileExternalCLibrary,
  executableNativeEnvironmentFingerprint,
  mobileLibraryTarget,
  mobileTargetRefusal,
  resolveCc,
  targetPlatform,
} from "./backend/external-c.js";
import { emitCModule } from "./backend/c/c-emitter.js";
import { emitLlvmModule, LlvmUnsupportedError } from "./backend/llvm/emitter.js";
import { nativeModuleBackendDiagnostics } from "./backend/native-module-support.js";
import { moduleWasiUnavailableSurface } from "./backend/wasi-surface.js";
import { compileRust, compileRustLibrary, RustCompileError } from "./backend/rust/compile.js";
import { emitRustModule, RustUnsupportedError } from "./backend/rust/emitter.js";
import { resolveIslandSourceStore, rustRuntimeFeatures, withIslandStore } from "./backend/rust/runtime-features.js";
import { executionProfile, noEngineDiagnostics, type ExecutionProfile } from "./backend/execution-profile.js";
export type { ExecutionProfile } from "./backend/execution-profile.js";
import { emitNativeArtifact, NativeCodegenError } from "./backend/native-codegen.js";
import { nativeCodegenTarget, nativeCodegenTargetRefusal } from "./backend/targets.js";
import { createNativeLinkInfo, type NativeLinkInfo } from "./backend/native-link-info.js";
import { RuntimePackError } from "./backend/runtime-pack.js";
import {
  executableLinkerEnvironmentFingerprint,
  resolvePlatformLinker,
} from "./backend/linker.js";
import { splitLlvmLibraryProgram, splitLlvmProgram } from "./backend/llvm/split.js";
import { rebaseLibrarySourceComments, replaceLibraryIdentity, stripLibraryIdentity, stripLibrarySourceComments } from "./backend/library-identity-markers.js";
import { checkerPanicDiag, ffiNativeBuildDiag, libAsyncSurfaceDiag, libIntBoundaryDiag, libNpmIneligibleDiag, iceDiag, isCheckerPanic, nativeCodegenDiag, type ScrDiagnostic } from "./diagnostics/diagnostic.js";
import { checkLibraryIntegerSlots, hasIntSlots } from "./library/int-infer.js";
import { loadLibraryProfile, type LibraryProfile } from "./library/library-profile.js";
import { clearFenceEvalCaches, decorateLibraryRefusals, evaluateLibraryFences } from "./library/fence-eval.js";
import {
  buildSidecar,
  canonicalModuleGraph,
  canonicalPath,
  clearSidecarCaches,
  compilerReleaseVersion,
  libraryIdentityHashes,
  updateSidecarIdentity,
} from "./library/sidecar.js";
import { validateSidecar } from "./library/sidecar-validate.js";
import { entryFunctionExports, type EntryExportInfo } from "./frontend/lib-exports.js";
import { entryContractFacts, type ContractFacts } from "./frontend/lib-contract.js";
import { moduleLibAsyncSurface, moduleLibNondeterministicSurface, moduleUsesAssert, moduleUsesCopying, moduleUsesEmitter, moduleUsesInspect, moduleUsesLegacyTextDecoder, moduleUsesRegex, moduleUsesSearchParams, moduleUsesSymbol, moduleUsesZlib, type IrFfiImport, type IrModule, type SrcLoc } from "./ir/ir.js";
import { serializeModule } from "./ir/serialize.js";
import { validateModule } from "./ir/validate.js";
import { checkPreflight, loadProgram } from "./frontend/program.js";
import { npmStaticOffenders, npmStaticPackageOfPath } from "./frontend/npm-static.js";
import { provenanceSources } from "./frontend/provenance-registry.js";
import { clearResolveCaches } from "./frontend/resolve.js";
import { retryNpmCallbackContext } from "./frontend/npm-static-context.js";
import { detectAutoPackages, filterExternalNpmPackages, findSingleNpmSurfaceOffender, packagesNamedByDiag } from "./frontend/npm-static-auto.js";
import { lowerToIr, type LowerOptions, type LowerResult } from "./frontend/lowering/lowerer.js";
import type { CoverageInput, NpmStaticStatus } from "./coverage/report.js";
import { loadFfiProfile, type FfiProfile } from "./ffi/ffi-manifest.js";
import { FrontendInputTracker, trackedReadFile } from "./frontend/input-tracker.js";
import { libraryFrontendImplementationFingerprint, publishEarlyLibraryCache, readEarlyLibraryCache, readSemanticLibraryCache, type EarlyLibraryCacheOptions, type EarlyLibraryCachePublish, type EarlyLibraryNativeFeatures, type SemanticLibraryCacheHit } from "./library/library-cache.js";
import { createSourceLineRebaser } from "./library/semantic-source.js";
import { publishEarlyExecutableCache, publishEarlyExecutableRoute, readEarlyExecutableCache, type EarlyExecutableCacheOptions } from "./executable/executable-cache.js";
import { compilerImplementationIdentity } from "./library/compiler-self-identity.js";

export const VERSION = "0.0.1";

export {
  EXTERNAL_OBJECT_ABI_STABILITY,
  RUNTIME_ABI_MARKER,
  RUNTIME_ABI_VERSION,
} from "./backend/runtime-abi.js";
export type { NativeLinkInfo, NativeLinkFeatures } from "./backend/native-link-info.js";

export { InternalCompilerError } from "./errors.js";
import { RUNTIME_TARGETS, activeRuntimeTargetKey, resolveRuntimeTarget, setActiveRuntimeTarget, type RuntimeTargetId } from "./compat/runtime-target.js";
import { addAutoIslandModule, autoIslandTiering, isIslandModulePath, islandModulePatterns, setIslandModules } from "./frontend/tiering.js";
export { globToRegExp, writeProjectTiers, type ModuleTierRow } from "./frontend/tiering.js";
export {
  compileExternalC as compileC,
  compileExternalC,
  runtimeSrcDir,
  warmNativeCaches,
  type CcOptions,
  type NativeCacheWarmProfile,
  type WarmNativeCachesOptions,
  type WarmNativeCachesResult,
} from "./backend/external-c.js";
export { ANDROID_MIN_API, IPHONEOS_MIN_VERSION, isAndroidTarget, isIosTarget, isMobileTarget, mobileLibraryTarget, mobileTargetRefusal } from "./backend/external-c.js";
export {
  emitCModule,
  emitCModule as emitModule,
  type CEmitOptions,
} from "./backend/c/c-emitter.js";
export type { ScrDiagnostic } from "./diagnostics/diagnostic.js";
export {
  renderDiagnostics,
  renderDiagnostics as renderAll,
  renderDiagnostic,
} from "./diagnostics/render.js";
export { renderCoverage, type CoverageInput } from "./coverage/report.js";
export {
  generateSurfaceManifest,
  renderSurfaceManifest,
  MANIFEST_SCHEMA_VERSION,
  type SurfaceManifest, type SurfaceManifestEntry, type SurfaceEntryBackends,
  BACKEND_IDS, BACKEND_LIB_CALLS, type BackendId,
} from "./coverage/surface-manifest.js";
export {
  NODE24_FETCH_COMPAT_PROFILE,
  type FetchCompatEvidence,
  type FetchCompatFacet,
  type FetchCompatInventory,
  type FetchCompatInventoryEntry,
  type FetchCompatInventoryExclusion,
  type FetchCompatInventoryPlacement,
  type FetchCompatInventoryStatus,
  type FetchCompatOperation,
  type FetchCompatOption,
  type FetchCompatProfile,
} from "./compat/fetch-profile.js";
export { COMPAT_PROFILES } from "./compat/registry.js";
export {
  BUN_VERSION,
  RUNTIME_TARGETS,
  RUNTIME_TARGET_IDS,
  describeRuntimeTargetOrigin,
  isRuntimeTargetId,
  resolveRuntimeTarget,
  type ResolvedRuntimeTarget,
  type RuntimeTargetId,
  type RuntimeTargetProfile,
} from "./compat/runtime-target.js";
export {
  NODE24_EVENTS_COMPAT_PROFILE,
  type EventsCompatFacet,
  type EventsCompatOperation,
  type EventsCompatProfile,
} from "./compat/events-profile.js";
export {
  NODE24_URL_COMPAT_PROFILE,
  type UrlCompatFacet,
  type UrlCompatOperation,
  type UrlCompatProfile,
} from "./compat/url-profile.js";
export {
  NODE_COMPAT_MATRIX,
  NODE24_TARGET_ID,
  NODE24_VERSION,
  NODE26_TARGET_ID,
  NODE26_VERSION,
} from "./compat/node-matrix.js";
export {
  compatEvidenceKey,
  compatOnTargets,
  compatRowName,
  compatRowOnTarget,
  compatRowTargetLabel,
  compatTargetFor,
  compatTargetLabel,
  compatTargetList,
  type CompatEvidence,
  type CompatFenceCode,
  type CompatInterfaceSource,
  type CompatInventory,
  type CompatInventoryEntry,
  type CompatInventoryExclusion,
  type CompatInventoryPlacement,
  type CompatInventoryStatus,
  type CompatOperation,
  type CompatOption,
  type CompatProfileProjection,
  type CompatRuntimeTarget,
  type CompatTargets,
} from "./compat/profile-schema.js";
export { LIB_FN_SIGS, validateModule } from "./ir/validate.js";
export { deserializeModule, IR_VERSION, serializeModule } from "./ir/serialize.js";
export { resolveLibraryFences, type LibraryFenceDecl, type ResolvedLibraryFence } from "./library/fence-eval.js";
export {
  loadLibraryProfile,
  profileTeaching,
  profileRemediation,
  LIB_PARAM_CLASSES,
  LIB_RETURN_CLASSES,
  type LibraryProfile,
  type LibraryExportEntry,
  type LibrarySidecarConfig,
  type LibParamClass,
  type LibReturnClass,
} from "./library/library-profile.js";
export {
  loadFfiProfile,
  FFI_CALLBACK_PARAM_CLASSES,
  FFI_PARAM_CLASSES,
  FFI_RETURN_CLASSES,
  type FfiCallbackParam,
  type FfiCallbackParamClass,
  type FfiContextParam,
  type FfiFunction,
  type FfiParamClass,
  type FfiProfile,
  type FfiReturnClass,
  type FfiValueParamClass,
} from "./ffi/ffi-manifest.js";
export {
  assembleTrapTeaching,
  TRAP_TEACHING_MARKER,
  TRAP_TEACHING_SEP,
} from "./library/trap-teaching.js";
export {
  abiExportSuffixes,
  buildSidecar,
  canonicalModuleGraph,
  canonicalPath,
  compilerReleaseVersion,
  libraryIdentityHashes,
  SIDECAR_FORMAT,
  type SidecarDoc,
  type SidecarBuildInput,
  type SidecarBuildResult,
  type TypeRef,
  type PayloadDescriptor,
} from "./library/sidecar.js";
export { validateSidecar } from "./library/sidecar-validate.js";
export { BUILD_ID_SEED, SOURCE_HASH_SEED, hex16, lengthPrefixedStream, wyhash64 } from "./library/wyhash.js";
export { ISLAND_SURFACE, STATIC_MATH_PROPS, type IslandFnEntry } from "./frontend/lowering/surfaces.js";
export { ambientDtsPath, isExactExternalTypeSpecifier, overridesDtsPath } from "./frontend/program.js";
export { resolveProvenanceSources } from "./frontend/provenance.js";
export { wasiGuestPath, type HostPathFlavor } from "./wasi-paths.js";
export {
  setProvenanceSources,
  type ProvenancePackageSource,
  type ProvenanceSources,
} from "./frontend/provenance-registry.js";
export * as ir from "./ir/ir.js";

export type CompileOutputKind = "ir" | "c" | "rust" | "llvm" | "asm" | "obj" | "exe";

export interface CompileBaseOptions {
  /** The runtime target the binary reproduces (--target): node24 (the
   * default), node26, or bun. Selects the ambient type surface, the
   * runtime export/imports conditions, the builtin-module table and
   * globals, and the per-runtime semantic switches. Unset infers from the
   * project (packageManager bun@…, .node-version, engines.node). */
  target?: RuntimeTargetId;
  /** Extra runtime export/imports conditions (--conditions), matched after
   * the target's own. */
  conditions?: readonly string[];
  /** --island-module: globs naming program modules that embed as engine source (the
   * island tier) instead of lowering statically; static code binds their exports as
   * engine handles. Requires --dynamic. See frontend/tiering.ts. */
  islandModules?: readonly string[];
  islandSourceStore?: "raw" | "deflate"; // --island-store: raw (V8's default) or deflate (boa's)
  /** Output executable path. Default: <outDir>/<stem>. */
  outPath: string;
  /** Where generated intermediates and compatibility side artifacts land. */
  outDir: string;
  /** True only when outPath was selected by scriptc's default-path policy.
   * This authorizes cleanup of stale generated siblings; explicit paths must
   * leave neighboring caller-owned files untouched. */
  defaultOutputPath?: boolean;
  /** Compatibility-only additive IR side artifact for executable builds.
   * The CLI's deprecated --emit-ir flag supplies this option. */
  emitIr?: boolean;
  sanitize?: boolean;
  /** Embed the dynamic-island engine (--dynamic). Off = the static default:
   * island constructs are diagnostics and nothing about codegen or linking
   * changes. */
  dynamic?: boolean;
  /** false rejects engine-backed IR and deferred unsupported functionality,
   * independently of --dynamic and persisted island module configuration. */
  allowEngine?: boolean;
  /** Code generator. Rust is the default and emits safe Rust directly.
   * C and LLVM require explicit selection. Every backend reports unsupported
   * constructs instead of silently changing generators. Rust currently
   * supports native builds; cross targets require an explicit C/LLVM backend. */
  backend?: "c" | "llvm" | "rust";
  /** Native optimization posture. Release is the shipped -O2 default; dev
   * uses -O0 and stable multi-TU object caching for large LLVM programs. */
  optimization?: "release" | "dev";
  /** --npm-static: package names whose shipped, unminified JS compiles
   * STATICALLY as program modules (inference types the bodies; statements
   * the lowering cannot prove become runtime fences). "auto" opts in every
   * reachable package passing the eligibility heuristics (own
   * .d.ts, unminified JS, no build-transform markers). A package whose
   * preflight refuses marks itself an offender and falls back to the
   * island (--dynamic) or the requires-dynamic diagnostic (static builds)
   * — never a silent misbuild. Off by default: nothing changes without
   * the flag. */
  npmStatic?: readonly string[] | "auto";
  /** Outbound native FFI manifest. Its signature-only TypeScript bindings
   * lower to direct C ABI calls. Source outputs retain those declarations;
   * archive/system-library inputs join only an executable link. */
  ffiProfilePath?: string;
  /** Attach the machine-readable external link recipe to an object result.
   * Valid only with outputKind "obj"; it never invokes a linker. */
  nativeLinkInfo?: boolean;
}

/** Executable compile options. This remains the compatibility type for the
 * historical compile() API, whose omitted output kind means executable. */
export interface CompileOptions extends CompileBaseOptions {
  outputKind?: "exe";
  /** Internal validation lane retained for helper-object artifact tests.
   * Supported ordinary LLVM executable builds select this path automatically. */
  nativeProgramObject?: boolean;
}

/** Source-artifact compile options, discriminated by the required kind. */
export interface CompileSourceOptions extends CompileBaseOptions {
  outputKind: Exclude<CompileOutputKind, "exe">;
}

/** Internal/dynamic request shape for callers that select the kind at runtime.
 * Statically executable/source callers should prefer the narrower interfaces. */
export interface CompileRequestOptions extends CompileBaseOptions {
  outputKind?: CompileOutputKind;
  /** Internal validation lane for executable requests. */
  nativeProgramObject?: boolean;
}

export type CompileArtifact =
  | { kind: "ir"; path: string }
  | { kind: "c"; path: string }
  | { kind: "rust"; path: string }
  | { kind: "llvm"; path: string }
  | { kind: "asm"; path: string }
  | { kind: "obj"; path: string; nativeLinkInfo?: NativeLinkInfo }
  | {
      kind: "exe";
      path: string;
      translationUnitPath: string;
      backend: "c" | "llvm" | "rust";
      llvmRefusal?: string;
    };

export type CompileFailure = {
  ok: false;
  diagnostics: ScrDiagnostic[];
  sourceTexts: Map<string, string>;
};

export type CompileSourceResult =
  | { ok: true; artifact: Extract<CompileArtifact, { kind: "ir" | "c" | "rust" | "llvm" | "asm" | "obj" }> }
  | CompileFailure;

/** Historical executable result shape retained for source compatibility. */
export type CompileResult =
  /** `cPath` names the generated source (.rs/.ll/.c) for compatibility.
   * `backend` identifies the selected generator. `llvmRefusal` is retained
   * for legacy cache metadata; new builds never fall back to another backend. */
  | { ok: true; binaryPath: string; cPath: string; sourcePath?: string; irPath?: string; backend: "c" | "llvm"; llvmRefusal?: string; execution: ExecutionProfile; runtimeFences?: ScrDiagnostic[] }
  | { ok: true; binaryPath: string; cPath: string; sourcePath: string; irPath?: string; backend: "rust"; safetyProfile: "rust-only" | "rust+external-ffi"; llvmRefusal?: never; execution: ExecutionProfile; runtimeFences: ScrDiagnostic[] }
  | { ok: false; diagnostics: ScrDiagnostic[]; sourceTexts: Map<string, string> };

export type CompileExecutableResult =
  | (Extract<CompileResult, { ok: true }> & { artifact: Extract<CompileArtifact, { kind: "exe" }> })
  | CompileFailure;

export type CompileRequestResult = CompileSourceResult | CompileExecutableResult;



export interface AnalyzeResult {
  coverage: CoverageInput;
  sourceTexts: Map<string, string>;
}

/** The platform the BUILD is for — the SCRIPTC_TARGET triple's OS under a
 * cross compile, the host's otherwise. The frontend needs it too (the
 * whole program compiles for ONE platform, so path.sep / os.EOL literals
 * and the path-module binding are compile-time constants); a malformed
 * SCRIPTC_CC/SCRIPTC_TARGET combination reports at compileC exactly as
 * before, so analysis falls back to the host here rather than throwing. */
export function buildTargetPlatform(env: NodeJS.ProcessEnv = process.env): string {
  try {
    return targetPlatform(resolveCc(env));
  } catch {
    return process.platform;
  }
}

/** Target-platform classification without compiler or SDK discovery. Source
 * artifacts need target semantics for lowering, but do not need a native
 * toolchain merely to decide whether that target is Windows, WASI, etc. */
export function sourceTargetPlatform(env: NodeJS.ProcessEnv = process.env): string {
  return configuredTargetPlatform(env);
}

export interface AnalyzeOptions {
  /** When selected, also validate IR and check this backend's emission. */
  backend?: CompileOptions["backend"];
  allowEngine?: boolean;
  /** See CompileOptions.target / conditions / islandModules. */
  target?: RuntimeTargetId;
  conditions?: readonly string[];
  islandModules?: readonly string[];
  /** Analyze as a --dynamic build (island constructs lower instead of
   * producing requires-dynamic diagnostics). */
  dynamic?: boolean;
  /** --npm-static (see CompileOptions.npmStatic): the analysis compiles
   * opted-in packages' JS as program modules and the coverage report
   * carries each package's static/fallback status. */
  npmStatic?: readonly string[] | "auto";
  /** Analyze with the outbound native bindings from this FFI manifest. */
  ffiProfilePath?: string;
  /** Coverage-only external host type surfaces: exact bare module
   * specifier → local declaration file. The checker uses the declarations
   * to analyze project code, but imported runtime values remain explicit
   * SC1010 blockers rather than being counted as executable. */
  externalTypes?: Readonly<Record<string, string>>;
}

/* ── the frontend, one pipeline shape ───────────────────────────────────
 * Load → preflight → lowering all ride the ONE tsgo program (program.ts +
 * lowering/ over the ts7 adapter) — the native TypeScript compiler is the
 * only frontend since the phase-4 flip retired the 5.9.3 pipeline
 * (typescript@5.9.3 survives solely as the sanctioned islands: npm.ts's
 * parse scan and lower-comptime's transpileModule). Everything after
 * lowering is IR-world, so analyze() and compile() consume this one
 * Frontend shape. */
interface Frontend {
  preflight: ScrDiagnostic[];
  /** The entry source file's text (emitCModule's header comment input). */
  entryText: () => string;
  /** Library mode's resolution input: the entry file's exported function
   * declarations (call before dispose — it reads the ts7 AST). */
  entryExports: () => Map<string, EntryExportInfo>;
  /** The contract sidecar's projection input: the entry file's exported
   * function signatures and convention consts, plus the whole graph's
   * exported type declarations, in declaration order (call before
   * dispose — it reads the ts7 AST). */
  entryContract: () => ContractFacts;
  sourceTexts: () => Map<string, string>;
  lower: (opts: LowerOptions) => LowerResult;
  /** Every program module in evaluation order (the tiering fixpoint's
   * universe of movable modules). */
  moduleFiles: () => readonly string[];
  /** --npm-static: each requested (or auto-detected) package's outcome —
   * compiled statically, or fallen back with the first refusal reason. */
  npmStatic: NpmStaticStatus[];
  /** Library mode only (empty otherwise): each judged npm package's first
   * import site, the anchor for the SC4020 static-or-refuse teaching. */
  npmImportSites: ReadonlyMap<string, SrcLoc>;
  /** Releases the frontend's resources (the spawned tsgo server). Call
   * exactly once, after the last lower(). */
  dispose: () => void;
}

/** The one frontend, three npm postures: `undefined`/explicit package
 * lists and `"auto"` are the executable lane's (--npm-static; fallback =
 * island). `"lib"` is library mode's mandatory auto twin — the same
 * eligibility bar and the same opt-in machinery, but every fallback
 * status the shared loops record becomes compileLibrary's SC4020
 * static-or-refuse teaching. Both auto modes close over the opted-in
 * packages' own bare edges; explicit lists retain their named scope. */
function runFrontend(
  entryPath: string,
  npmStatic?: readonly string[] | "auto" | "lib",
  externalTypes?: Readonly<Record<string, string>>,
  dynamic = false,
): Frontend {
  // Resolver package/workspace metadata is intentionally shared across the
  // several load attempts of ONE auto-detection fixpoint, but never across
  // separate compiles in a long-lived process.  A cache miss must observe
  // package.json edits before it can publish a new early-library entry.
  clearResolveCaches();
  const statuses: NpmStaticStatus[] = [];
  const npmSites = new Map<string, SrcLoc>();
  const judged = new Set<string>();
  let requested: string[] = [];
  let reusableScout: ReturnType<typeof loadProgram> | null = null;
  let reusablePreflight: ScrDiagnostic[] | null = null;
  if (npmStatic === "auto" || npmStatic === "lib") {
    const scout = loadProgram(entryPath, { externalTypes });
    let retained = false;
    try {
      const scoutPreflight = checkPreflight(scout);
      requested = detectAutoPackages(scout, statuses, npmStatic, judged, npmSites, !dynamic);
      // With no package to opt in, the scout already IS the final frontend:
      // same roots, resolution posture, preflight, and module order. Retain it
      // instead of spawning a second tsgo server and checking the whole graph
      // again — the common library-mode path has no bare npm imports.
      if (requested.length === 0) {
        reusableScout = scout;
        reusablePreflight = scoutPreflight;
        retained = true;
      }
    } finally {
      if (!retained) scout.dispose();
    }
  } else if (npmStatic !== undefined) {
    requested = [...new Set(npmStatic)];
  }

  // One exact --external-types mapping makes the containing package an
  // external host boundary, which cannot simultaneously be compiled as a
  // package-wide --npm-static program graph. External wins; retain the
  // ordinary npm-static fallback record so explicit and auto requests both
  // explain why the package did not compile statically.
  requested = filterExternalNpmPackages(requested, statuses, externalTypes);

  // The all-or-nothing fallback loop: a preflight diagnostic ANCHORED in
  // an opted-in package's files (an unsupported require form, a builtin
  // fence) — or an offender the resolution itself reported — drops that
  // package from the set and the whole frontend reloads without it, so
  // its import takes the ordinary island path. Static compilation of a
  // package must never turn a working --dynamic build into a build
  // failure.
  //
  // CONSUMER-anchored attribution (the second source): an opted-in
  // package whose inferred export surface breaks the typecheck reports at
  // its IMPORT SITES — errors in program files no path-shaped attribution
  // reaches, but whose MESSAGES name the package ("Module '"pkg"' has no
  // exported member", "typeof import("…/pkg/dist/index")"). Bundle-shaped
  // dists carry surfaces inference can only partly reach (type-only
  // re-exports have no JS value to chase), and the ratified behavior is
  // graceful PER-PACKAGE degradation: the named package drops to the
  // island with a note, never a failed gate. Explicit opt-ins degrade
  // exactly like auto's — "the user asked for these packages" buys the
  // attempt, not a broken build.
  let load = reusableScout ?? loadProgram(entryPath, { npmStatic: requested, externalTypes });
  let preflight = reusablePreflight ?? checkPreflight(load);
  // Automatic admission's fixpoint: opted-in packages' files joined the
  // program just now, and THEIR bare edges (import statements and
  // top-level requires) name packages the scout could not see. Judge each
  // by the same bar — eligible ones join the set and the frontend
  // reloads; ineligible ones record fallback (a refusal in library mode).
  // Bounded by the dependency count (every iteration settles
  // at least one new package for good).
  if (npmStatic === "auto" || npmStatic === "lib") {
    for (;;) {
      const grown = filterExternalNpmPackages(
        detectAutoPackages(load, statuses, npmStatic, judged, npmSites, !dynamic), statuses, externalTypes,
      );
      if (grown.length === 0) break;
      requested = [...requested, ...grown];
      load.dispose();
      load = loadProgram(entryPath, { npmStatic: requested, externalTypes });
      preflight = checkPreflight(load);
    }
  }
  const effective = new Set(requested);
  while (effective.size > 0) {
    const reasons = new Map<string, string>(npmStaticOffenders());
    for (const d of preflight) {
      const pkg = npmStaticPackageOfPath(d.loc.file);
      if (pkg !== null && !reasons.has(pkg)) reasons.set(pkg, `${d.code}: ${d.message}`);
    }
    if (![...reasons.keys()].some((p) => effective.has(p))) {
      const named = new Map<string, number>();
      for (const d of preflight) {
        if (d.code !== "SC0001") continue;
        for (const pkg of packagesNamedByDiag(d.message, effective)) {
          named.set(pkg, (named.get(pkg) ?? 0) + 1);
        }
      }
      for (const [pkg, count] of named) {
        reasons.set(
          pkg,
          `its inferred export surface breaks ${count} import site${count === 1 ? "" : "s"} in program files${npmStatic === "lib" ? "" : " — the package serves from the island instead"} (bundler-emitted surfaces type only as far as inference reaches)`,
        );
      }
    }
    const dropping = [...reasons.keys()].filter((p) => effective.has(p));
    if (dropping.length === 0) break;
    for (const p of dropping) {
      effective.delete(p);
      statuses.push({ package: p, status: "fallback", detail: reasons.get(p)! });
      if (process.env["SCRIPTC_TRACE_FENCE"]) process.stderr.write(`[drop] ${p}: ${reasons.get(p)}\n`);
    }
    load.dispose();
    load = loadProgram(entryPath, { npmStatic: effective, externalTypes });
    preflight = checkPreflight(load);
  }
  // Preserve the original strict authoring gate when only callback
  // contextual types disappear across an inferred npm any boundary.
  const contextual = retryNpmCallbackContext(entryPath, effective, load, preflight, externalTypes);
  if (contextual !== null) ({ load, preflight } = contextual);
  // The last resort, ALL modes: an opt-in can change the PROGRAM's OWN
  // typecheck through errors that name no package at all (the inferred
  // surface replaces the shipped .d.ts — the commander name()/description()
  // chaining shape, or a .d.ts type-GUARD an inferred JS function cannot
  // reproduce, so every catch-clause narrowing site reports "'err' is of
  // type 'unknown'"). Those SC0001s anchor in USER files no offender or
  // message attribution reaches. First try removing one package while
  // retaining its peers; otherwise use conservative SOLO attribution.
  // Survivors must pass a full preflight or they all fall back with a
  // note. Explicit opt-ins
  // degrade the same way — the ratified stance for bundle-shaped dists is
  // graceful per-package degradation, never a failed gate the user cannot
  // act on (the note carries the why).
  if (effective.size > 0 && preflight.some((d) => d.code === "SC0001")) {
    const dropWithNote = (p: string): void => {
      effective.delete(p);
      statuses.push({
        package: p,
        status: "fallback",
        detail:
          npmStatic === "auto"
            ? "auto: the program does not typecheck against its inferred surface"
            : npmStatic === "lib"
              ? "the program does not typecheck against its inferred surface (type-only declarations and .d.ts type guards have no JS value inference can chase)"
              : "the program does not typecheck against its inferred surface (type-only declarations and .d.ts type guards have no JS value inference can chase) — the package serves from the island instead",
      });
    };
    // Preserve the graph when one removal clears the errors; otherwise use SOLO probes, then recheck survivors.
    // Probes only need the entry, packages and copied diagnostics: release the unused checker before opening them.
    load.dispose();
    const single = findSingleNpmSurfaceOffender(entryPath, effective, externalTypes);
    if (single !== null) dropWithNote(single);
    else for (const p of [...effective]) {
      const probe = loadProgram(entryPath, { npmStatic: [p], externalTypes });
      const probeDiags = checkPreflight(probe);
      probe.dispose();
      if (probeDiags.some((d) => d.code === "SC0001")) dropWithNote(p);
    }
    load = loadProgram(entryPath, { npmStatic: effective, externalTypes });
    preflight = checkPreflight(load);
    if (preflight.some((d) => d.code === "SC0001") && effective.size > 0) {
      for (const p of [...effective]) dropWithNote(p);
      load.dispose();
      load = loadProgram(entryPath, { npmStatic: effective, externalTypes });
      preflight = checkPreflight(load);
    }
  }
  for (const p of requested) {
    if (effective.has(p)) statuses.push({ package: p, status: "static" });
  }

  const finalLoad = load;
  return {
    preflight,
    entryText: () => finalLoad.entry.text,
    entryExports: () => entryFunctionExports(finalLoad.entry),
    // The contract scans the PROGRAM's source files, not the runtime
    // module order: a type-only module (nothing but exported types) has no
    // runtime edge and never joins moduleOrder, yet its declarations are
    // contract surface. Declaration files (default libs, @types) stay out,
    // and so do statically-compiled npm packages' files: their .d.ts is
    // dropped by construction (inference types the bodies), so no npm
    // declaration can name a wire-contract type — the contract vocabulary
    // is authored program surface only, and a workspace-linked package's
    // shipped .ts must not smuggle same-name declarations into the type
    // table.
    entryContract: () =>
      entryContractFacts(
        finalLoad.entry,
        finalLoad.program.getSourceFiles().filter((sf) => !sf.isDeclarationFile && npmStaticPackageOfPath(sf.fileName) === null),
      ),
    // Runtime evaluation order first, then any type-only program modules
    // (no runtime edge, so absent from moduleOrder — but they are contract
    // surface now, and the library identity hashes cover the WHOLE module
    // graph; the Map dedups by fileName). Statically-compiled npm modules
    // are in moduleOrder like any program module, so their bytes join the
    // library identity hashes (source_hash/build_id) — compiled code is
    // identity, whatever directory it came from.
    sourceTexts: () =>
      new Map<string, string>(
        [finalLoad.entry, ...finalLoad.moduleOrder, ...finalLoad.program.getSourceFiles().filter((sf) => !sf.isDeclarationFile)].map(
          (sf) => [sf.fileName, sf.text],
        ),
      ),
    lower: (opts) => lowerToIr(finalLoad.program, finalLoad.entry, finalLoad.moduleOrder, {
      ...opts,
      startupCrash: finalLoad.startupCrash ?? null,
      externalTypes: finalLoad.externalTypes,
      externalTypeSpecifiersByFile: finalLoad.externalTypeSpecifiersByFile,
    }),
    moduleFiles: () => finalLoad.moduleOrder.map((sf) => sf.fileName),
    npmStatic: statuses,
    npmImportSites: npmSites,
    dispose: finalLoad.dispose,
  };
}

/** Analysis without codegen: how much of the program compiles statically.
 * Unlike compile(), lowering diagnostics are data here, not failure. */
/** Diagnostics that never move a module by themselves: cascade markers
 * (a use inheriting its declaration's blocker), import-form fences, the
 * requires-dynamic and island-embedding refusals, checker and internal
 * errors. The module owning the ROOT blocker moves instead. */
const TIERING_CASCADE_CODES: ReadonlySet<string> = new Set([
  "SC0001", "SC0002", "SC0003", "SC0004",
  "SC1010", "SC1012", "SC1013", "SC1014", "SC1015",
  "SC2004", "SC2013", "SC2030", "SC9001",
]);

/** Lowers to the static-frontier FIXPOINT under `--island-module auto`:
 * every program module (never the entry) that owns a root blocker moves
 * to the island and the program lowers again, until a round moves
 * nothing. Each round is a COVERAGE lowering — the reached pass plus the
 * unreached remainder — because a poisoned module hides its dependents'
 * bodies from the reached pass, and discovering the frontier one module
 * per round would take as many rounds as the longest import chain. The
 * final lowering carries the caller's options. Explicit-only tiering and
 * static builds lower exactly once. */
function lowerWithFrontier(fe: Frontend, options: LowerOptions): LowerResult {
  if (!autoIslandTiering() || options.dynamic !== true) return fe.lower(options);
  const roundOptions: LowerOptions = { ...options, coverage: true };
  let lowered = fe.lower(roundOptions);
  const blockers = (result: LowerResult): ScrDiagnostic[] => [
    ...result.diagnostics,
    ...(result.unreached?.diagnostics ?? []),
  ];
  const maxRounds = Number(process.env["SCRIPTC_TIERING_ROUNDS"] ?? "24") || 24;
  const trace = process.env["SCRIPTC_TIERING_TRACE"] === "1";
  for (let round = 0; round < maxRounds && blockers(lowered).length > 0; round++) {
    // The module universe is re-read every round: modules reached only
    // through dynamic import() join the evaluation order during a
    // lowering, and the entry is never movable.
    const files = fe.moduleFiles().map((f) => resolve(f));
    const entryFile = files[files.length - 1] ?? "";
    const movable = new Set(files.filter((f) => f !== entryFile));
    const offenders = new Map<string, string>();
    const skipped = new Map<string, number>();
    for (const d of blockers(lowered)) {
      if (TIERING_CASCADE_CODES.has(d.code)) { skipped.set(`cascade:${d.code}`, (skipped.get(`cascade:${d.code}`) ?? 0) + 1); continue; }
      const file = resolve(d.loc.file);
      if (!movable.has(file)) { skipped.set(`not-movable:${file}`, (skipped.get(`not-movable:${file}`) ?? 0) + 1); continue; }
      if (isIslandModulePath(file)) { skipped.set(`already-island:${file}`, (skipped.get(`already-island:${file}`) ?? 0) + 1); continue; }
      if (offenders.has(file)) continue;
      offenders.set(file, `${d.code} ${d.message}`);
    }
    if (trace) {
      process.stderr.write(`scriptc tiering-trace ${JSON.stringify({ round: round + 1, blockers: blockers(lowered).length, offenders: [...offenders.keys()], skipped: [...skipped.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40) })}\n`);
    }
    if (offenders.size === 0) break;
    for (const [file, reason] of offenders) addAutoIslandModule(file, `round ${round + 1}: ${reason}`);
    if (process.env["SCRIPTC_TIMING"]) {
      process.stderr.write(`scriptc tiering ${JSON.stringify({ round: round + 1, moved: offenders.size })}\n`);
    }
    lowered = fe.lower(roundOptions);
  }
  return options.coverage === true ? lowered : fe.lower(options);
}

export function analyze(entryPath: string, opts: AnalyzeOptions = {}): AnalyzeResult {
  opts = { ...opts, backend: opts.backend ?? "rust" };
  setActiveRuntimeTarget(resolveRuntimeTarget(resolve(entryPath), opts.target).profile, opts.conditions ?? []);
  setIslandModules(opts.islandModules ?? [], resolve(entryPath));
  let ffi: FfiProfile | null = null;
  if (opts.ffiProfilePath !== undefined) {
    const loaded = loadFfiProfile(opts.ffiProfilePath);
    if (!loaded.ok) {
      return {
        coverage: {
          file: entryPath,
          dynamic: opts.dynamic ?? false,
          stats: { statementsTotal: 0, statementsFailed: 0, statementsIsland: 0, functionsSkipped: 0 },
          diagnostics: loaded.diagnostics,
          preflightFailed: true,
        },
        sourceTexts: new Map(),
      };
    }
    ffi = loaded.profile;
  }
  const fe = runFrontend(entryPath, opts.npmStatic, opts.externalTypes, opts.dynamic);
  try {
    const emptyStats = { statementsTotal: 0, statementsFailed: 0, statementsIsland: 0, functionsSkipped: 0 };

    const preflight = fe.preflight;
    // Import-FORM fences don't stop the analysis: the module graph is still
    // computable (a fenced import contributes no edges), the imported
    // bindings poison at their use sites, and the fences join the blockers
    // list beside statement-level ones — the report shows a statement
    // percentage instead of stopping at the import lines. Everything else —
    // tsc errors, config incompatibilities, circular imports — still stops
    // at preflight (no trustworthy program to lower). Builds are unchanged:
    // compile() fails on every preflight diagnostic exactly as before.
    const IMPORT_FENCES = new Set(["SC1010", "SC1012", "SC1013", "SC1014", "SC1015"]);
    if (preflight.some((d) => !IMPORT_FENCES.has(d.code))) {
      return {
        coverage: {
          file: entryPath,
          dynamic: opts.dynamic ?? false,
          stats: emptyStats,
          diagnostics: preflight,
          ...(fe.npmStatic.length > 0 ? { npmStatic: fe.npmStatic } : {}),
          preflightFailed: true,
        },
        sourceTexts: fe.sourceTexts(),
      };
    }
    // Coverage is whole-program by design: builds stop at what the entry
    // reaches, but the analysis additionally lowers the unreached remainder
    // (throwaway) so the report covers everything the source declares — with
    // the unreached share in its own group.
    const lowered = lowerWithFrontier(fe, {
      dynamic: opts.dynamic ?? false,
      coverage: true,
      targetPlatform: buildTargetPlatform(),
      ...(ffi !== null ? { ffiImports: ffi.functions } : {}),
    });
    const provenance = provenanceSources();
    const diagnostics = [...preflight, ...lowered.diagnostics];
    let execution: ExecutionProfile | undefined;
    if (lowered.module !== null && (opts.backend !== undefined || opts.allowEngine === false)) {
      const mod = lowered.module;
      const backend = opts.backend ?? "rust";
      execution = executionProfile(backend, opts.dynamic ?? false, ffi !== null, mod);
      diagnostics.push(...validateModule(mod).map((v) => iceDiag(v.message, v.loc)));
      diagnostics.push(...nativeModuleBackendDiagnostics(mod, backend));
      if (opts.allowEngine === false) diagnostics.push(...noEngineDiagnostics(mod, backend, opts.dynamic ?? false, lowered.runtimeFences));
      if (diagnostics.length === 0) {
        try {
          if (backend === "rust") {
            const target = process.env["SCRIPTC_TARGET"];
            if (target !== undefined && target !== "" && target !== "native") {
              diagnostics.push(backendRefusalDiag("rust", target, "this target", { file: entryPath, start: 0, end: 0 }));
            } else {
              emitRustModule(mod);
            }
          } else if (backend === "c") {
            emitCModule(mod);
          } else {
            emitLlvmModule(mod);
          }
        } catch (error) {
          if (error instanceof RustUnsupportedError) diagnostics.push(...rustRefusalDiags(error, entryPath));
          else if (error instanceof LlvmUnsupportedError) diagnostics.push(llvmRefusalDiag(error, entryPath));
          else throw error;
        }
      }
    }
    return {
      coverage: {
        file: entryPath,
        dynamic: opts.dynamic ?? false,
        stats: lowered.stats,
        // The import fences report as blockers alongside the statement-level
        // ones (use sites of the fenced bindings emit matching diagnostics,
        // which the report groups with these).
        diagnostics,
        ...(opts.backend === undefined ? {} : { backend: opts.backend }),
        ...(execution === undefined ? {} : { execution }),
        ...(lowered.runtimeFences.length > 0 ? { runtimeFences: lowered.runtimeFences } : {}),
        ...(lowered.unreached ? { unreached: lowered.unreached } : {}),
        ...(lowered.npmBuiltins ? { npmBuiltins: lowered.npmBuiltins } : {}),
        ...(lowered.npmLazyTraps ? { npmLazyTraps: lowered.npmLazyTraps } : {}),
        ...(lowered.tiers !== undefined ? { tiers: lowered.tiers } : {}),
        ...(fe.npmStatic.length > 0 ? { npmStatic: fe.npmStatic } : {}),
        // --provenance-sources: the per-package attribution inputs (the
        // report aggregates statsByFile under each package's source dir).
        ...(provenance !== null ? { provenance } : {}),
        ...(lowered.statsByFile ? { statsByFile: lowered.statsByFile } : {}),
        ...(lowered.provenanceElided ? { provenanceElided: lowered.provenanceElided } : {}),
        preflightFailed: false,
      },
      sourceTexts: fe.sourceTexts(),
    };
  } finally {
    fe.dispose();
  }
}

/** The whole pipeline: load → preflight → lower → validate → emit C → clang. */
function clearCompileSessionCaches(): void {
  clearResolveCaches();
  clearCcCaches();
  clearSidecarCaches();
  clearFenceEvalCaches();
}

export function compile(
  entryPath: string,
  opts: CompileSourceOptions,
): Promise<CompileSourceResult>;
export function compile(
  entryPath: string,
  opts: CompileOptions,
): Promise<CompileExecutableResult>;
export function compile(entryPath: string, opts: CompileRequestOptions): Promise<CompileRequestResult>;
export async function compile(entryPath: string, opts: CompileRequestOptions): Promise<CompileRequestResult> {
  const requiredBackend = opts.outputKind === "rust" ? "rust"
    : opts.outputKind === "c" ? "c"
    : opts.outputKind === "llvm" || opts.outputKind === "asm" || opts.outputKind === "obj" ? "llvm"
    : undefined;
  if (opts.backend !== undefined &&
      (opts.outputKind === "ir" || requiredBackend !== undefined && opts.backend !== requiredBackend)) {
    return { ok: false, diagnostics: [nativeCodegenDiag(
      "SC3002", `output kind '${opts.outputKind}' cannot be combined with backend '${opts.backend}'`, resolve(entryPath),
    )], sourceTexts: new Map() };
  }
  opts = { ...opts, backend: opts.backend ?? (opts.outputKind === "c" ? "c" : opts.outputKind === "llvm" || opts.outputKind === "asm" || opts.outputKind === "obj" ? "llvm" : "rust") };
  clearCompileSessionCaches();
  const frontendInputs = new FrontendInputTracker();
  return frontendInputs.run(() => compileTracked(entryPath, opts, frontendInputs));
}

/** Build-time API compatibility fence: a caller's existing CompileOptions
 * variable must retain the executable result aliases without narrowing. */
async function assertCompileOptionsCompatibility(
  entryPath: string,
  opts: CompileOptions,
): Promise<void> {
  const result = await compile(entryPath, opts);
  if (result.ok) {
    const binaryPath: string = result.binaryPath;
    void binaryPath;
  }
}
void assertCompileOptionsCompatibility;

/** The historical exported CompileResult itself remains executable-shaped. */
function assertCompileResultCompatibility(result: CompileResult): void {
  if (result.ok) {
    const binaryPath: string = result.binaryPath;
    void binaryPath;
  }
}
void assertCompileResultCompatibility;

async function compileTracked(
  entryPath: string,
  opts: CompileRequestOptions,
  frontendInputs: FrontendInputTracker,
): Promise<CompileRequestResult> {
  entryPath = resolve(entryPath);
  setActiveRuntimeTarget(resolveRuntimeTarget(entryPath, opts.target).profile, opts.conditions ?? []);
  setIslandModules(opts.islandModules ?? [], entryPath);
  const rustBackend = opts.backend === "rust";
  const outputKind = opts.outputKind ?? "exe";
  if (opts.nativeLinkInfo === true && outputKind !== "obj") {
    return {
      ok: false,
      diagnostics: [nativeCodegenDiag(
        "SC3002",
        "native link info is available only for object output",
        entryPath,
      )],
      sourceTexts: new Map(),
    };
  }
  if (opts.nativeProgramObject === true &&
      (outputKind !== "exe" || opts.backend !== "llvm")) {
    return {
      ok: false,
      diagnostics: [nativeCodegenDiag(
        "SC3002",
        "native program-object validation requires an executable build with backend explicitly set to llvm",
        entryPath,
      )],
      sourceTexts: new Map(),
    };
  }
  let ffi: FfiProfile | null = null;
  let ffiProfileBytes: Uint8Array | null = null;
  if (opts.ffiProfilePath !== undefined) {
    const ffiProfilePath = resolve(opts.ffiProfilePath);
    const loaded = loadFfiProfile(ffiProfilePath);
    if (!loaded.ok) {
      return { ok: false, diagnostics: loaded.diagnostics, sourceTexts: new Map() };
    }
    ffi = loaded.profile;
    ffiProfileBytes = loaded.profileBytes;
  }
  let buildPlatform: string;
  if (outputKind === "exe") {
    // Target semantics are needed before choosing the helper/runtime-pack
    // path. Do not make them contingent on the legacy C-driver resolver:
    // an LLVM-owned WASI build deliberately needs no SCRIPTC_CC.
    try {
      buildPlatform = sourceTargetPlatform();
    } catch (err) {
      return {
        ok: false,
        diagnostics: [{
          code: "SC3002",
          message: err instanceof Error ? err.message : String(err),
          loc: { file: entryPath, start: 0, end: 0 },
        }],
        sourceTexts: new Map(),
      };
    }
  } else {
    try {
      buildPlatform = sourceTargetPlatform();
    } catch (err) {
      return {
        ok: false,
        diagnostics: [{
          code: "SC3002",
          message: err instanceof Error ? err.message : String(err),
          loc: { file: entryPath, start: 0, end: 0 },
        }],
        sourceTexts: new Map(),
      };
    }
    if (outputKind === "asm" || outputKind === "obj") {
      const refusal = nativeCodegenTargetRefusal();
      if (refusal !== null) {
        return {
          ok: false,
          diagnostics: [nativeCodegenDiag("SC3002", refusal, entryPath)],
          sourceTexts: new Map(),
        };
      }
      if (opts.sanitize === true) {
        return {
          ok: false,
          diagnostics: [nativeCodegenDiag(
            "SC3002",
            `--sanitize is not supported with --emit=${outputKind}; AddressSanitizer instrumentation parity is not available in the LLVM native helper yet`,
            entryPath,
          )],
          sourceTexts: new Map(),
        };
      }
    }
  }
  // Mobile triples are library-mode targets: the archive an embedding app
  // links is the artifact, and only the library-admissible runtime surface
  // is verified on those device classes. The executable lane refuses before
  // any frontend work — a pure env check, so the refusal needs no toolchain.
  if (outputKind === "exe") {
    const entryLoc: SrcLoc = { file: entryPath, start: 0, end: 0 };
    const mobileTarget = mobileLibraryTarget();
    if (mobileTarget !== null) {
      return {
        ok: false,
        diagnostics: [
          targetRefusalDiag(
            mobileTarget,
            "standalone executable builds — mobile targets produce library-mode static archives (SCRIPTC_CC=zigcc scriptc build --lib --profile <profile.json>) for an embedding app to link",
            entryLoc,
          ),
        ],
        sourceTexts: new Map(),
      };
    }
    const rawTarget = process.env["SCRIPTC_TARGET"] ?? "";
    const mobileRefusal = mobileTargetRefusal(rawTarget);
    if (mobileRefusal !== null) {
      return {
        ok: false,
        diagnostics: [{ code: "SC3002", message: mobileRefusal, loc: entryLoc }],
        sourceTexts: new Map(),
      };
    }
  }
  // Rust bypasses this incomplete cache; skip C/LLVM tool discovery for it too.
  const cacheRoot = outputKind === "exe" && !rustBackend && opts.allowEngine !== false && provenanceSources() === null
    ? await prepareBuildCacheRoot(buildCacheRoot())
    : null;
  let earlyCacheOptions: EarlyExecutableCacheOptions | null = null;
  if (outputKind === "exe" && opts.backend !== "rust") {
    const implementation = await compilerImplementationIdentity();
    const helperObjectRoute = opts.nativeProgramObject === true ||
      (opts.backend !== "c" && usesPrecompiledRuntimePack(opts, "llvm"));
    earlyCacheOptions = {
      entryPath,
      outDir: opts.outDir,
      outPath: opts.outPath,
      emitIr: opts.emitIr ?? false,
      sanitize: opts.sanitize ?? false,
      dynamic: opts.dynamic ?? false,
      backend: opts.backend ?? "auto",
      ...(opts.optimization === "dev" ? { optimization: "dev" as const } : {}),
      npmStatic: opts.npmStatic ?? null,
      ffiProfile:
        opts.ffiProfilePath === undefined || ffiProfileBytes === null
          ? null
          : { path: opts.ffiProfilePath, bytes: ffiProfileBytes },
      target: `${process.env["SCRIPTC_TARGET"] ?? "native"}:${buildPlatform}:${process.arch}:${
        opts.nativeProgramObject === true
          ? "helper-object"
          : helperObjectRoute ? "runtime-pack" : "driver-tu"
      }`,
      runtimeTarget: activeRuntimeTargetKey(),
      islandModules: [...islandModulePatterns()],
      islandSourceStore: resolveIslandSourceStore(opts.islandSourceStore),
      compiler: [
        helperObjectRoute
          ? resolvePlatformLinker(process.env, nativeCodegenTarget()?.defaultLinker)
          : (process.env["SCRIPTC_CC"] ?? "clang"),
      ],
      nativeEnvironment: helperObjectRoute
        ? await executableLinkerEnvironmentFingerprint(
          process.env,
          nativeCodegenTarget()?.defaultLinker,
        )
        : await executableNativeEnvironmentFingerprint(),
      nodeVersion: process.version,
      implementation: implementation.digest,
      implementationDependencies: implementation.dependencies,
    };
  }
  const earlyHit = earlyCacheOptions === null
    ? null
    : await readEarlyExecutableCache(cacheRoot, earlyCacheOptions);
  if (earlyHit !== null) {
    if (earlyCacheOptions === null) {
      throw new InternalCompilerError("executable cache hit without executable cache options");
    }
    const executableCacheOptions = earlyCacheOptions;
    if (!opts.emitIr) {
      const stem = basename(entryPath).replace(/\.(ts|mts|cts|js|mjs|cjs)$/, "");
      await rm(join(opts.outDir, `${stem}.ir.json`), { force: true });
    }
    // Route/proof metadata is independently evictable. A full-compiler
    // fallback that still finds the validated payload repairs that lightweight
    // index so the next identical CLI invocation can avoid this module graph.
    await publishEarlyExecutableRoute(cacheRoot, executableCacheOptions).catch(() => undefined);
    if (earlyHit.executableRestored) {
      await pruneBuildCache(cacheRoot);
      return {
        ok: true,
        artifact: {
          kind: "exe",
          path: opts.outPath,
          translationUnitPath: earlyHit.cPath,
          backend: earlyHit.native.backend,
          ...(earlyHit.native.llvmRefusal === undefined
            ? {}
            : { llvmRefusal: earlyHit.native.llvmRefusal }),
        },
        binaryPath: opts.outPath,
        cPath: earlyHit.cPath,
        backend: earlyHit.native.backend,
        execution: executionProfile(earlyHit.native.backend, opts.dynamic ?? false, ffi !== null),
        ...(earlyHit.irPath === undefined ? {} : { irPath: earlyHit.irPath }),
        ...(earlyHit.native.llvmRefusal === undefined
          ? {}
          : { llvmRefusal: earlyHit.native.llvmRefusal }),
      };
    }
    let nativeInputPath = earlyHit.cPath;
    let nativeProgramObject: {
      linkPath: string;
      artifactPath: string;
      dependencies: NativeArtifactDependency[];
    } | null = null;
    const useRuntimePack = opts.nativeProgramObject === true ||
      usesPrecompiledRuntimePack(opts, earlyHit.native.backend);
    if (useRuntimePack) {
      if (earlyHit.native.backend !== "llvm") {
        throw new InternalCompilerError(
          "native program-object cache hit restored a non-LLVM translation unit",
        );
      }
      try {
        nativeProgramObject = await emitNativeProgramObject(
          entryPath,
          opts,
          await readFile(earlyHit.cPath, "utf8"),
        );
        nativeInputPath = nativeProgramObject.linkPath;
      } catch (err) {
        if (!(err instanceof NativeCodegenError)) throw err;
        return {
          ok: false,
          diagnostics: [nativeCodegenDiag(err.diagnosticCode, err.message, entryPath)],
          sourceTexts: new Map(),
        };
      }
    }
    try {
      await compileExecutableNative(
        earlyHit.native,
        nativeInputPath,
        opts.outPath,
        opts.sanitize ?? false,
        ffi,
        null,
        nativeProgramObject?.dependencies,
        opts.nativeProgramObject === true ? undefined : async ({ dependencies }) => {
          await publishEarlyExecutableCache(cacheRoot, executableCacheOptions, {
            ...earlyHit,
            executableRestored: true,
            nativeDependencies: dependencies,
            frontend: earlyHit.frontend,
          });
        },
      );
      if (nativeProgramObject !== null && opts.nativeProgramObject === true) {
        await rename(nativeProgramObject.linkPath, nativeProgramObject.artifactPath);
      }
    } catch (err) {
      if (err instanceof RuntimePackError) {
        return { ok: false, diagnostics: [runtimePackDiagnostic(err, entryPath)], sourceTexts: new Map() };
      }
      if (ffi !== null && err instanceof CcCompileError) {
        return {
          ok: false,
          diagnostics: [ffiNativeBuildDiag(
            ffiNativeBuildDetail(err),
            opts.ffiProfilePath ?? entryPath,
          )],
          sourceTexts: new Map(),
        };
      }
      throw err;
    } finally {
      if (nativeProgramObject !== null) {
        await rm(nativeProgramObject.linkPath, { force: true }).catch(() => undefined);
      }
    }
    await pruneBuildCache(cacheRoot);
    return {
      ok: true,
      artifact: {
        kind: "exe",
        path: opts.outPath,
        translationUnitPath: earlyHit.cPath,
        backend: earlyHit.native.backend,
        ...(earlyHit.native.llvmRefusal === undefined
          ? {}
          : { llvmRefusal: earlyHit.native.llvmRefusal }),
      },
      binaryPath: opts.outPath,
      cPath: earlyHit.cPath,
      backend: earlyHit.native.backend,
      execution: executionProfile(earlyHit.native.backend, opts.dynamic ?? false, ffi !== null),
      ...(earlyHit.irPath === undefined ? {} : { irPath: earlyHit.irPath }),
      ...(earlyHit.native.llvmRefusal === undefined
        ? {}
        : { llvmRefusal: earlyHit.native.llvmRefusal }),
    };
  }
  const fe = runFrontend(entryPath, opts.npmStatic, undefined, opts.dynamic);
  let lowered: LowerResult;
  let entryText: string;
  let sourceTexts: Map<string, string>;
  // The frontend (and its tsgo server) is released as soon as lowering
  // ends — clang and the link never hold it open.
  try {
    const fail = (diagnostics: ScrDiagnostic[]): CompileFailure => ({
      ok: false,
      diagnostics,
      sourceTexts: fe.sourceTexts(),
    });

    if (fe.preflight.length > 0) return fail(fe.preflight);

    try {
      lowered = lowerWithFrontier(fe, {
        dynamic: opts.dynamic ?? false,
        targetPlatform: buildPlatform,
        ...(ffi !== null ? { ffiImports: ffi.functions } : {}),
      });
    } catch (e) {
      // The last-resort panic fence: an upstream tsgo panic that crossed a
      // checker call no statement/collection fence wrapped still becomes a
      // clean failed compile (anchored at the entry), never a crashed CLI.
      if (!isCheckerPanic(e)) throw e;
      return fail([
        checkerPanicDiag(e.message.split("\n", 1)[0]!, { file: entryPath, start: 0, end: 0 }),
      ]);
    }
    if (lowered.module === null) return fail(lowered.diagnostics);

    if (opts.allowEngine === false) {
      const diagnostics = noEngineDiagnostics(lowered.module, opts.backend ?? "rust", opts.dynamic ?? false, lowered.runtimeFences);
      if (diagnostics.length > 0) return fail(diagnostics);
    }

    const validation = validateModule(lowered.module);
    if (validation.length > 0) {
      return fail(validation.map((v) => iceDiag(v.message, v.loc)));
    }
    const backendDiagnostics = outputKind === "ir" ? [] : nativeModuleBackendDiagnostics(lowered.module, opts.backend ?? "rust");
    if (backendDiagnostics.length > 0) return fail(backendDiagnostics);
    if (buildPlatform === "wasi") {
      const entryLoc: SrcLoc = { file: entryPath, start: 0, end: 0 };
      if (opts.sanitize) {
        return fail([targetRefusalDiag("wasm32-wasi", "--sanitize", entryLoc)]);
      }
      if (ffi !== null) {
        return fail([targetRefusalDiag("wasm32-wasi", "native FFI manifests", entryLoc)]);
      }
      const unavailable = moduleWasiUnavailableSurface(lowered.module);
      if (unavailable !== null) {
        return fail([targetRefusalDiag("wasm32-wasi", unavailable.surface, unavailable.loc)]);
      }
      if (opts.backend === "c" || outputKind === "c") {
        const asyncSurface = moduleLibAsyncSurface(lowered.module);
        if (asyncSurface !== null) {
          return fail([
            backendRefusalDiag("c", "wasm32-wasi", asyncSurface.surface, asyncSurface.loc),
          ]);
        }
      }
    }
    entryText = fe.entryText();
    sourceTexts = fe.sourceTexts();
  } finally {
    fe.dispose();
  }

  const stem = basename(entryPath).replace(/\.(ts|mts|cts|js|mjs|cjs)$/, "");
  const defaultSourcePaths = {
    ir: join(opts.outDir, `${stem}.ir.json`),
    c: join(opts.outDir, `${stem}.c`),
    llvm: join(opts.outDir, `${stem}.ll`),
    rust: join(opts.outDir, `${stem}.rs`),
    asm: join(opts.outDir, `${stem}.s`),
    obj: join(opts.outDir, `${stem}.o`),
  } as const;
  const defaultExecutablePaths = [
    join(opts.outDir, stem),
    join(opts.outDir, `${stem}.exe`),
    join(opts.outDir, `${stem}.wasm`),
  ];
  const removeStaleSourceArtifacts = async (keep: readonly string[]): Promise<void> => {
    const kept = new Set(keep.map((path) => resolve(path)));
    const candidates = outputKind === "exe"
      // Executable builds can generate only these compatibility/translation
      // unit siblings. Assembly and object outputs are independent primary
      // artifacts, so an executable build must never claim or delete them.
      ? [defaultSourcePaths.ir, defaultSourcePaths.c, defaultSourcePaths.llvm]
      : opts.defaultOutputPath === true
        ? [...Object.values(defaultSourcePaths), ...defaultExecutablePaths]
        : [];
    await Promise.all(
      candidates
        .filter((path) => !kept.has(resolve(path)))
        .map((path) => rm(path, { force: true })),
    );
  };

  if (outputKind === "ir") {
    await mkdir(dirname(opts.outPath), { recursive: true });
    await writeFile(opts.outPath, serializeModule(lowered.module));
    await removeStaleSourceArtifacts([opts.outPath]);
    return { ok: true, artifact: { kind: "ir", path: opts.outPath } };
  }

  if (outputKind === "rust") {
    let source: string;
    try { source = emitRustModule(withIslandStore(lowered.module!, opts.islandSourceStore)); }
    catch (error) {
      if (!(error instanceof RustUnsupportedError)) throw error;
      return { ok: false, diagnostics: rustRefusalDiags(error, entryPath), sourceTexts };
    }
    await mkdir(dirname(opts.outPath), { recursive: true });
    await writeFile(opts.outPath, source);
    await removeStaleSourceArtifacts([opts.outPath]);
    return { ok: true, artifact: { kind: "rust", path: opts.outPath } };
  }

  if (outputKind === "c") {
    await mkdir(dirname(opts.outPath), { recursive: true });
    await writeFile(opts.outPath, emitCModule(lowered.module, entryText));
    await removeStaleSourceArtifacts([opts.outPath]);
    return { ok: true, artifact: { kind: "c", path: opts.outPath } };
  }

  if (outputKind === "llvm" || outputKind === "asm" || outputKind === "obj") {
    let llvm: string;
    try {
      llvm = emitLlvmModule(lowered.module, {
        pointerBits: buildPlatform === "wasi" ? 32 : 64,
        wasi: buildPlatform === "wasi",
        runtimeAbiMarker: outputKind === "obj",
      });
    } catch (err) {
      if (!(err instanceof LlvmUnsupportedError)) throw err;
      return { ok: false, diagnostics: [llvmRefusalDiag(err, entryPath)], sourceTexts };
    }
    if (outputKind === "llvm") {
      await mkdir(dirname(opts.outPath), { recursive: true });
      await writeFile(opts.outPath, llvm);
    } else {
      try {
        await emitNativeArtifact({
          outputPath: opts.outPath,
          llvm,
          outputKind,
          sourcePath: entryPath,
          optimization: opts.optimization === "dev" ? "0" : "2",
          ...(opts.sanitize === undefined ? {} : { sanitize: opts.sanitize }),
        });
      } catch (err) {
        if (!(err instanceof NativeCodegenError)) throw err;
        return {
          ok: false,
          diagnostics: [nativeCodegenDiag(err.diagnosticCode, err.message, entryPath)],
          sourceTexts,
        };
      }
    }
    await removeStaleSourceArtifacts([opts.outPath]);
    if (outputKind === "obj" && opts.nativeLinkInfo === true) {
      const target = nativeCodegenTarget();
      if (target === null) {
        throw new InternalCompilerError("native object emitted without a native target");
      }
      return {
        ok: true,
        artifact: {
          kind: "obj",
          path: opts.outPath,
          nativeLinkInfo: await createNativeLinkInfo({
            programObject: opts.outPath,
            target,
            features: executableNativeFeatures(
              lowered.module,
              "llvm",
              opts.dynamic ?? false,
              opts.optimization ?? "release",
            ),
            ffi,
            optimization: opts.optimization ?? "release",
          }),
        },
      };
    }
    return { ok: true, artifact: { kind: outputKind, path: opts.outPath } };
  }

  await mkdir(opts.outDir, { recursive: true });
  if (rustBackend) {
    const rustTarget = process.env["SCRIPTC_TARGET"];
    if (rustTarget !== undefined && rustTarget !== "" && rustTarget !== "native") {
      return {
        ok: false,
        diagnostics: [backendRefusalDiag("rust", rustTarget, "this target", {
          file: entryPath,
          start: 0,
          end: 0,
        })],
        sourceTexts,
      };
    }
    if (opts.sanitize) {
      return {
        ok: false,
        diagnostics: [{
          code: "SC3001",
          message: "rust backend sanitizer support is not wired to the pinned nightly lane yet",
          loc: { file: entryPath, start: 0, end: 0 },
        }],
        sourceTexts,
      };
    }
    let rustSource: string;
    try {
      rustSource = emitRustModule(withIslandStore(lowered.module!, opts.islandSourceStore));
    } catch (error) {
      if (!(error instanceof RustUnsupportedError)) throw error;
      return { ok: false, diagnostics: rustRefusalDiags(error, entryPath), sourceTexts };
    }
    const execution = executionProfile("rust", opts.dynamic ?? false, ffi !== null, lowered.module!);
    const runtimeFeatures = rustRuntimeFeatures(lowered.module!);
    const sourcePath = join(opts.outDir, `${stem}.rs`);
    await writeFile(sourcePath, rustSource);
    await Promise.all([
      rm(join(opts.outDir, `${stem}.c`), { force: true }),
      rm(join(opts.outDir, `${stem}.ll`), { force: true }),
    ]);
    let irPath: string | undefined;
    if (opts.emitIr) {
      irPath = join(opts.outDir, `${stem}.ir.json`);
      await writeFile(irPath, serializeModule(lowered.module));
    }
    try {
      await compileRust({
        sourcePath,
        outPath: opts.outPath,
        optimization: opts.optimization ?? "release",
        runtimeFeatures,
        ...(opts.allowEngine === undefined ? {} : { allowEngine: opts.allowEngine }),
        ...(ffi === null
          ? {}
          : { linkInputs: ffi.libraries, systemLibraries: ffi.systemLibraries }),
      });
    } catch (error) {
      if (!(error instanceof RustCompileError)) throw error;
      if (ffi !== null) {
        return {
          ok: false,
          diagnostics: [ffiNativeBuildDiag(
            ffiNativeBuildDetail({ driver: "rustc", stderr: error.stderr }),
            opts.ffiProfilePath ?? entryPath,
          )],
          sourceTexts,
        };
      }
      throw new InternalCompilerError(
        `${error.message}${error.stderr === "" ? "" : `\n${error.stderr}`}`,
      );
    }
    return {
      ok: true,
      artifact: { kind: "exe", path: opts.outPath, translationUnitPath: sourcePath, backend: "rust" },
      binaryPath: opts.outPath,
      cPath: sourcePath,
      sourcePath,
      backend: "rust",
      safetyProfile: ffi === null ? "rust-only" : "rust+external-ffi",
      execution,
      runtimeFences: lowered.runtimeFences,
      ...(irPath === undefined ? {} : { irPath }),
    };
  }
  // Explicit C/LLVM builds share the in-memory IR and clang toolchain.
  // An emission refusal never changes the selected backend.
  let cPath = join(opts.outDir, `${stem}.c`);
  let backend: "c" | "llvm" = "c";
  let llvmSource: string | null = null;
  if (opts.backend !== "c") {
    try {
      const ll = emitLlvmModule(lowered.module!, {
        pointerBits: buildPlatform === "wasi" ? 32 : 64,
        wasi: buildPlatform === "wasi",
        runtimeAbiMarker:
          opts.nativeProgramObject === true ||
          usesPrecompiledRuntimePack(opts, "llvm"),
      });
      cPath = defaultSourcePaths.llvm;
      await writeFile(cPath, ll);
      llvmSource = ll;
      backend = "llvm";
    } catch (err) {
      if (!(err instanceof LlvmUnsupportedError)) throw err;
      return { ok: false, diagnostics: [llvmRefusalDiag(err, entryPath)], sourceTexts };
    }
  }
  if (backend === "c") {
    await writeFile(cPath, emitCModule(lowered.module!, entryText));
  }
  // Kept-TU honesty: outDir persists across builds (the CLI's .scriptc/),
  // so a lane change would leave the PREVIOUS lane's TU beside the fresh
  // one — remove the loser so the surviving TU is always the one the
  // binary below was linked from.
  let irPath: string | undefined;
  if (opts.emitIr) {
    irPath = defaultSourcePaths.ir;
    await writeFile(irPath, serializeModule(lowered.module));
  }
  await removeStaleSourceArtifacts([
    cPath,
    ...(irPath === undefined ? [] : [irPath]),
  ]);

  const nativeFeatures = executableNativeFeatures(
    lowered.module,
    backend,
    opts.dynamic ?? false,
    opts.optimization ?? "release",
  );
  const programSplit =
    backend === "llvm" && (opts.optimization ?? "release") === "dev" &&
      !(opts.sanitize ?? false) && llvmSource !== null
      ? splitLlvmProgram(llvmSource)
      : null;
  await mkdir(dirname(opts.outPath), { recursive: true });
  if (earlyCacheOptions === null) {
    throw new InternalCompilerError("executable emission without executable cache options");
  }
  const executableCacheOptions = earlyCacheOptions;
  let publishedExecutable = false;
  let nativeProgramObject: {
    linkPath: string;
    artifactPath: string;
    dependencies: NativeArtifactDependency[];
  } | null = null;
  try {
    const useRuntimePack = opts.nativeProgramObject === true ||
      usesPrecompiledRuntimePack(opts, backend);
    if (useRuntimePack) {
      if (backend !== "llvm" || llvmSource === null) {
        throw new InternalCompilerError("native program-object validation requires the LLVM backend");
      }
      try {
        nativeProgramObject = await emitNativeProgramObject(entryPath, opts, llvmSource);
      } catch (err) {
        if (!(err instanceof NativeCodegenError)) throw err;
        return {
          ok: false,
          diagnostics: [nativeCodegenDiag(err.diagnosticCode, err.message, entryPath)],
          sourceTexts,
        };
      }
    }
    await compileExecutableNative(
      nativeFeatures,
      nativeProgramObject?.linkPath ?? cPath,
      opts.outPath,
      opts.sanitize ?? false,
      ffi,
      programSplit,
      nativeProgramObject?.dependencies,
      opts.nativeProgramObject === true ? undefined : async ({ dependencies }) => {
        await publishEarlyExecutableCache(cacheRoot, executableCacheOptions, {
          cPath,
          native: nativeFeatures,
          executableRestored: true,
          nativeDependencies: dependencies,
          frontend: frontendInputs.snapshot(),
          ...(irPath === undefined ? {} : { irPath }),
        });
        publishedExecutable = true;
      },
    );
    if (nativeProgramObject !== null && opts.nativeProgramObject === true) {
      await rename(nativeProgramObject.linkPath, nativeProgramObject.artifactPath);
    }
  } catch (err) {
    if (err instanceof RuntimePackError) {
      return { ok: false, diagnostics: [runtimePackDiagnostic(err, entryPath)], sourceTexts };
    }
    if (ffi !== null && err instanceof CcCompileError) {
      return {
        ok: false,
        diagnostics: [
          ffiNativeBuildDiag(
            ffiNativeBuildDetail(err),
            opts.ffiProfilePath ?? entryPath,
          ),
        ],
        sourceTexts,
      };
    }
    throw err;
  } finally {
    if (nativeProgramObject !== null) {
      await rm(nativeProgramObject.linkPath, { force: true }).catch(() => undefined);
    }
  }
  if (!publishedExecutable) {
    await publishEarlyExecutableCache(cacheRoot, executableCacheOptions, {
      cPath,
      native: nativeFeatures,
      executableRestored: false,
      frontend: frontendInputs.snapshot(),
      ...(irPath === undefined ? {} : { irPath }),
    }).catch(() => undefined);
  }
  await pruneBuildCache(cacheRoot);
  return {
    ok: true,
    artifact: {
      kind: "exe",
      path: opts.outPath,
      translationUnitPath: cPath,
      backend,
    },
    binaryPath: opts.outPath,
    cPath,
    backend,
    execution: executionProfile(backend, opts.dynamic ?? false, ffi !== null),
    runtimeFences: lowered.runtimeFences,
    ...(irPath !== undefined ? { irPath } : {}),
  };
}

/* ── library emission mode ───────────────────────────────────────────────
 * `scriptc build --lib --profile <file>`: compile the profile's ONE entry module
 * to a linkable static archive (<name>.lib.a) exporting exactly the
 * profile-declared C-ABI symbols — no main, no event loop, no signal
 * handlers, traps to the host's registered sink. The profile pins the
 * emission; there is no fallback concept on this path (an out-of-tier
 * program under emission "llvm" is SC3001, fail-loudly). */

export interface CompileLibraryOptions {
  profilePath: string;
  /** Where the archive and the kept program TU land. */
  outDir: string;
  /** Archive path. Default: <outDir>/<stem>.lib.a. */
  outPath?: string;
  emitIr?: boolean;
  sanitize?: boolean;
}

export type CompileLibraryResult =
  /** `sidecarPath` is present exactly when the profile declares a
   * `sidecar` section: the contract JSON written beside the archive by
   * the same invocation (ask 2). */
  | { ok: true; archivePath: string; cPath: string; backend: "c" | "llvm" | "rust"; irPath?: string; sidecarPath?: string }
  | { ok: false; diagnostics: ScrDiagnostic[]; sourceTexts: Map<string, string> };

function libraryNativeFeatures(
  mod: IrModule,
  backend: "c" | "llvm",
): EarlyLibraryNativeFeatures {
  return {
    backend,
    regex: moduleUsesRegex(mod),
    assert: moduleUsesAssert(mod),
    inspect: moduleUsesInspect(mod),
    symbol: moduleUsesSymbol(mod),
    searchParams: moduleUsesSearchParams(mod),
    emitter: moduleUsesEmitter(mod),
    zlib: moduleUsesZlib(mod),
    copying: moduleUsesCopying(mod),
    textDecoderLegacy: moduleUsesLegacyTextDecoder(mod),
    ...(mod.lib?.identity !== undefined ? { buildId: mod.lib.identity.buildId } : {}),
  };
}

function libraryLocalizeSymbols(profile: LibraryProfile): string[] | undefined {
  return profile.localizeRuntime
    ? [
        profile.initSymbol,
        profile.sinkRegisterSymbol,
        ...(profile.collectSymbol !== null ? [profile.collectSymbol] : []),
        ...(profile.resultResetSymbol !== null ? [profile.resultResetSymbol] : []),
        ...(profile.callbackRegisterSymbol !== null ? [profile.callbackRegisterSymbol] : []),
        ...(profile.sidecar !== null
          ? [profile.sidecar.buildIdSymbol, profile.sidecar.abiVersionSymbol]
          : []),
        ...profile.exports.map((entry) => entry.symbol),
      ]
    : undefined;
}

async function compileLibraryNative(
  profile: LibraryProfile,
  cPath: string,
  archivePath: string,
  sanitize: boolean,
  features: EarlyLibraryNativeFeatures,
): Promise<void> {
  if (profile.emission === "rust") {
    throw new InternalCompilerError("Rust library emission reached the C/LLVM archive compiler");
  }
  const localizeSymbols = libraryLocalizeSymbols(profile);
  let identityCSource: string | undefined;
  let programSource: string | undefined;
  if (
    profile.sidecar !== null || profile.emission === "c" ||
    (profile.emission === "llvm" && profile.optimization === "dev" && !sanitize)
  ) {
    const publicSource = await readFile(cPath, "utf8");
    programSource = publicSource;
  }
  if (profile.sidecar !== null) {
    if (features.buildId === undefined) throw new InternalCompilerError("library identity TU has no build id");
    const withoutIdentity = stripLibraryIdentity(programSource!, profile.emission);
    if (withoutIdentity === programSource) {
      throw new InternalCompilerError("generated public library TU has no identity region");
    }
    programSource = withoutIdentity;
    identityCSource = [
      "#include <stdint.h>",
      "#include <inttypes.h>",
      `uint64_t ${profile.sidecar.buildIdSymbol}(void) { return UINT64_C(0x${features.buildId}); }`,
      `uint32_t ${profile.sidecar.abiVersionSymbol}(void) { return ${profile.sidecar.abiVersion}u; }`,
      "",
    ].join("\n");
  }
  if (profile.emission === "c") {
    programSource = stripLibrarySourceComments(programSource!, profile.entry);
  }
  const llvmSplit =
    profile.emission === "llvm" && profile.optimization === "dev" && !sanitize && programSource !== undefined
      ? splitLlvmLibraryProgram(programSource)
      : null;
  await compileExternalCLibrary({
    cPath,
    ...(programSource !== undefined ? { programSource } : {}),
    ...(identityCSource !== undefined ? { identityCSource } : {}),
    ...(llvmSplit !== null
      ? {
          programShards: llvmSplit.shards,
          programPublicSymbols: llvmSplit.publicSymbols,
        }
      : {}),
    outPath: archivePath,
    cacheIdentity: "scriptc-generated-library-v1",
    sanitize,
    optimization: profile.optimization,
    ...(localizeSymbols !== undefined ? { localizeSymbols } : {}),
    ...(profile.instancePerThread ? { threadInstances: true } : {}),
    regex: features.regex,
    assert: features.assert,
    inspect: features.inspect,
    symbol: features.symbol,
    searchParams: features.searchParams,
    emitter: features.emitter,
    zlib: features.zlib,
    copying: features.copying,
    textDecoderLegacy: features.textDecoderLegacy,
  });
}

async function emitSemanticLibraryHit(
  hit: SemanticLibraryCacheHit,
  profile: LibraryProfile,
  opts: CompileLibraryOptions,
  archivePath: string,
  cacheRoot: string | null,
  cacheOptions: EarlyLibraryCacheOptions,
  timing: (phase: string, detail?: Record<string, unknown>) => void,
): Promise<CompileLibraryResult> {
  if (profile.emission === "rust") {
    throw new InternalCompilerError("Rust library emission reached the C/LLVM semantic cache");
  }
  const mod = hit.mod;
  const backendDiagnostics = nativeModuleBackendDiagnostics(mod, profile.emission);
  if (backendDiagnostics.length > 0) {
    return {
      ok: false,
      diagnostics: decorateLibraryRefusals(backendDiagnostics, profile),
      sourceTexts: hit.sourceTexts,
    };
  }
  const rootDir = dirname(resolve(opts.profilePath));
  let sidecarJson = hit.sidecarJson;
  if (profile.sidecar !== null) {
    if (mod.lib?.identity === undefined || sidecarJson === null) {
      throw new InternalCompilerError("semantic library cache lost sidecar identity metadata");
    }
    const modules = canonicalModuleGraph(rootDir, hit.sourceTexts);
    const { buildId, sourceHash } = libraryIdentityHashes(
      compilerReleaseVersion(),
      profile.profileBytes,
      modules,
    );
    mod.lib.identity.buildId = buildId;
    hit.native.buildId = buildId;
    sidecarJson = updateSidecarIdentity(sidecarJson, buildId, sourceHash);
  }
  const validation = validateModule(mod);
  if (validation.length > 0) {
    return {
      ok: false,
      diagnostics: validation.map((violation) => iceDiag(violation.message, violation.loc)),
      sourceTexts: hit.sourceTexts,
    };
  }
  await mkdir(opts.outDir, { recursive: true });
  const stem = basename(profile.entry).replace(/\.(ts|mts|cts|js|mjs|cjs)$/, "");
  const cPath = join(opts.outDir, `${stem}.lib.${profile.emission === "llvm" ? "ll" : "c"}`);
  let translationUnit = hit.translationUnit;
  if (profile.sidecar !== null) {
    translationUnit = replaceLibraryIdentity(translationUnit, profile.emission, mod.lib!.identity!);
  }
  if (profile.emission === "llvm") {
    await writeFile(cPath, translationUnit);
  } else {
    const previous = hit.previousSources.get(mod.sourceFile);
    const current = hit.sourceTexts.get(mod.sourceFile);
    if (previous === undefined || current === undefined) {
      throw new InternalCompilerError("semantic library cache lost the entry source text");
    }
    translationUnit = rebaseLibrarySourceComments(
      translationUnit,
      mod.sourceFile,
      createSourceLineRebaser(mod.sourceFile, previous, current),
    );
    await writeFile(cPath, translationUnit);
  }
  timing("semantic-tu-restore", { output_bytes: Buffer.byteLength(translationUnit) });
  await rm(join(opts.outDir, `${stem}.lib.${profile.emission === "llvm" ? "c" : "ll"}`), { force: true });
  let irPath: string | undefined;
  if (opts.emitIr) {
    irPath = join(opts.outDir, `${stem}.lib.ir.json`);
    await writeFile(irPath, serializeModule(mod));
  }
  await compileLibraryNative(
    profile,
    cPath,
    archivePath,
    opts.sanitize ?? false,
    hit.native,
  );
  timing("native-archive");
  let sidecarPath: string | undefined;
  if (sidecarJson !== null) {
    sidecarPath = profile.sidecar!.path !== null
      ? resolve(dirname(archivePath), profile.sidecar!.path)
      : `${archivePath}.contract.json`;
    await writeFile(sidecarPath, sidecarJson);
  }
  await publishEarlyLibraryCache(cacheRoot, cacheOptions, {
    cPath,
    native: hit.native,
    frontend: hit.frontend,
    semantic: { mod, sources: hit.sourceTexts },
    ...(irPath !== undefined ? { irPath } : {}),
    ...(sidecarPath !== undefined ? { sidecarPath } : {}),
  }).catch(() => undefined);
  await pruneBuildCache(cacheRoot);
  timing("semantic-cache-publish");
  timing("complete");
  return {
    ok: true,
    archivePath,
    cPath,
    backend: profile.emission,
    ...(irPath !== undefined ? { irPath } : {}),
    ...(sidecarPath !== undefined ? { sidecarPath } : {}),
  };
}

export async function compileLibrary(opts: CompileLibraryOptions): Promise<CompileLibraryResult> {
  clearCompileSessionCaches();
  const frontendInputs = new FrontendInputTracker();
  return frontendInputs.run(() => compileLibraryTracked(opts, frontendInputs));
}

async function compileLibraryTracked(
  opts: CompileLibraryOptions,
  frontendInputs: FrontendInputTracker,
): Promise<CompileLibraryResult> {
  const timingOn = process.env["SCRIPTC_TIMING"] === "1";
  const timingStart = performance.now();
  let timingLast = timingStart;
  const timing = (phase: string, detail: Record<string, unknown> = {}): void => {
    if (!timingOn) return;
    const now = performance.now();
    process.stderr.write(
      `scriptc timing ${JSON.stringify({
        phase,
        phase_ms: Math.round((now - timingLast) * 10) / 10,
        total_ms: Math.round((now - timingStart) * 10) / 10,
        rss_mb: Math.round(process.memoryUsage().rss / 1024 / 1024),
        ...detail,
      })}\n`,
    );
    timingLast = now;
  };
  const loadedProfile = loadLibraryProfile(resolve(opts.profilePath));
  timing("profile-load");
  if (!loadedProfile.ok) {
    return { ok: false, diagnostics: loadedProfile.diagnostics, sourceTexts: new Map() };
  }
  const profile = loadedProfile.profile;
  const entryPath = profile.entry;
  const buildPlatform = buildTargetPlatform();
  const profileDir = dirname(resolve(opts.profilePath));
  for (let directory = dirname(entryPath); ; directory = dirname(directory)) {
    for (const name of ["tsconfig.json", "package.json"]) {
      // Project configuration and package-realm metadata can affect the
      // frontend even when TypeScript did not request their bytes through
      // its delegated filesystem callbacks (tsgo may read them server-side).
      frontendInputs.run(() => {
        const path = join(directory, name);
        trackedReadFile(path);
      });
    }
    if (directory === profileDir || dirname(directory) === directory) break;
  }
  const archivePath = opts.outPath ?? join(
    opts.outDir,
    `${basename(entryPath).replace(/\.(ts|mts|cts|js|mjs|cjs)$/, "")}.lib.a`,
  );

  // Mobile-target admission first — a pure env/host check, so a refused
  // pairing never reaches toolchain discovery. iOS targets (device and
  // simulator) build on darwin hosts only: the Apple SDK sysroot and the
  // Mach-O localization linker live there. Android builds from any host
  // with an NDK; a near-miss mobile spelling refuses with the supported
  // set named.
  {
    const mobileRefusal = mobileTargetRefusal(process.env["SCRIPTC_TARGET"] ?? "");
    if (mobileRefusal !== null) {
      return {
        ok: false,
        diagnostics: decorateLibraryRefusals(
          [{ code: "SC3002", message: mobileRefusal, loc: { file: entryPath, start: 0, end: 0 } }],
          profile,
        ),
        sourceTexts: new Map(),
      };
    }
  }

  // Multi-instance library mode (abi.localize_runtime) localizes per
  // OBJECT FORMAT: ELF and COFF archives localize from any host (cross
  // ELF merges through the cross driver's own lld; COFF merges and
  // demotes in process — see native-toolchain.ts's localizeLibraryObjects), and Mach-O
  // localization runs the macOS host linker, so macos and ios targets
  // admit darwin hosts only (the mobile admission above already refused
  // an ios triple off darwin). Everything else refuses before frontend/
  // backend work, naming the pairing. WASI retains the general
  // library-mode refusal below.
  if (profile.localizeRuntime && buildPlatform !== "wasi") {
    const driver = resolveCc();
    const platform = targetPlatform(driver);
    const targetArch = driver.target?.split("-", 1)[0] ?? null;
    // Native Linux retains its host-binutils implementation. Cross ELF is
    // rebuilt in process and currently accepts the two verified ELF64,
    // little-endian architectures; COFF is rebuilt in process and accepts
    // AMD64 only. Keep this preflight in lockstep with object-localize.ts so
    // unsupported object classes refuse before frontend/backend work.
    const supported =
      (platform === "linux" &&
        (driver.target === null || targetArch === "x86_64" || targetArch === "aarch64")) ||
      (platform === "win32" &&
        (driver.target === null ? process.arch === "x64" : targetArch === "x86_64")) ||
      (platform === "darwin" && process.platform === "darwin");
    if (!supported) {
      const subject =
        platform === "win32"
          ? "runtime-localized (multi-instance) library archives (COFF localization currently requires x86_64)"
          : platform === "linux" && driver.target !== null
            ? "runtime-localized (multi-instance) library archives (cross-ELF localization currently requires x86_64 or aarch64)"
            : platform === "darwin"
              ? `runtime-localized (multi-instance) library archives on ${process.platform} hosts (Mach-O localization runs the macOS host linker)`
              : "runtime-localized (multi-instance) library archives";
      return {
        ok: false,
        diagnostics: decorateLibraryRefusals([
          targetRefusalDiag(
            driver.target ?? platform,
            subject,
            { file: entryPath, start: 0, end: 0 },
          ),
        ], profile),
        sourceTexts: new Map(),
      };
    }
  }

  const cacheRoot = profile.emission !== "rust" && provenanceSources() === null
    ? await prepareBuildCacheRoot(buildCacheRoot())
    : null;
  const earlyCacheOptions: EarlyLibraryCacheOptions = {
    profilePath: opts.profilePath,
    profileBytes: profile.profileBytes,
    entryPath,
    outDir: opts.outDir,
    ...(opts.outPath !== undefined ? { outPath: opts.outPath } : {}),
    emitIr: opts.emitIr ?? false,
    sanitize: opts.sanitize ?? false,
    target: `${process.env["SCRIPTC_TARGET"] ?? "native"}:${buildPlatform}:${process.arch}`,
    compiler: [process.env["SCRIPTC_CC"] ?? "clang"],
    nodeVersion: process.version,
    implementation: await libraryFrontendImplementationFingerprint(),
  };
  const earlyHit = await readEarlyLibraryCache(
    cacheRoot,
    earlyCacheOptions,
    profile.sidecar === null ? undefined : profile.sidecar.path,
  );
  if (earlyHit !== null) {
    timing("early-cache-hit");
    await compileLibraryNative(
      profile,
      earlyHit.cPath,
      archivePath,
      opts.sanitize ?? false,
      earlyHit.native,
    );
    timing("native-archive");
    timing("complete");
    return {
      ok: true,
      archivePath,
      cPath: earlyHit.cPath,
      backend: earlyHit.native.backend,
      ...(earlyHit.irPath !== undefined ? { irPath: earlyHit.irPath } : {}),
      ...(earlyHit.sidecarPath !== undefined ? { sidecarPath: earlyHit.sidecarPath } : {}),
    };
  }
  timing("early-cache-miss");
  const semanticHit = await readSemanticLibraryCache(
    cacheRoot,
    earlyCacheOptions,
    profile.sidecar === null ? undefined : profile.sidecar.path,
  );
  if (semanticHit !== null) {
    timing("semantic-cache-hit", { changed_sources: semanticHit.changedSources.length });
    return emitSemanticLibraryHit(
      semanticHit,
      profile,
      opts,
      archivePath,
      cacheRoot,
      earlyCacheOptions,
      timing,
    );
  }
  timing("semantic-cache-miss");

  // Bare npm specifiers in a library graph take the STATIC-OR-REFUSE
  // posture: "lib" runs the same auto-detection and eligibility bar as
  // the executable lane's --npm-static (own .d.ts, unminified shipped JS,
  // no build-transform markers), automatically — the library path has no
  // island/dynamic tier to offer (SC4006's ground), so eligibility needs
  // no flag and a miss is a refusal, never a fallback.
  // Library archives are Node-semantics artifacts: the runtime target is
  // the matrix primary regardless of what the project pins.
  setActiveRuntimeTarget(RUNTIME_TARGETS.node24);
  const fe = runFrontend(entryPath, "lib");
  timing("frontend-load", {
    entry_bytes: fe.entryText().length,
    source_files: fe.sourceTexts().size,
  });
  let lowered: LowerResult;
  let entryText: string;
  let sourceTexts: Map<string, string>;
  let entryInfo: Map<string, EntryExportInfo>;
  let contractFacts: ContractFacts | null;
  try {
    // Every library refusal leaves through the ask-5 teaching decoration:
    // profile text attaches by code, manifest id, or fence coverage as the
    // attributed note (the SC4004/SC4005 rider generalized).
    const fail = (diagnostics: ScrDiagnostic[]): CompileLibraryResult => ({
      ok: false,
      diagnostics: decorateLibraryRefusals(diagnostics, profile),
      sourceTexts: fe.sourceTexts(),
    });
    // Library mode emits a host-embedded static archive with native trap and
    // C-ABI contracts. wasm32-wasi executable modules are supported, but the
    // archive/reactor contract is not; refuse before emitting a host-width
    // LLVM TU or asking Zig to compile the native library runtime for WASI.
    if (buildPlatform === "wasi") {
      return fail([
        targetRefusalDiag(
          "wasm32-wasi",
          "library-mode archive builds",
          { file: entryPath, start: 0, end: 0 },
        ),
      ]);
    }
    // The npm verdicts FIRST: whatever the shared frontend would have
    // served from the island — an eligibility miss, an untyped install, a
    // preflight offender inside a package's files, a dropped inferred
    // surface — refuses here with the package and the specific bar it
    // missed. Checked before the general preflight, whose diagnostics for
    // these same imports speak executable-lane teachings (SC1010/SC0001 at
    // the unresolvable edge); the library answer is this one.
    const npmRefused = fe.npmStatic.filter((s) => s.status === "fallback");
    if (npmRefused.length > 0) {
      return fail(
        npmRefused.map((s) =>
          libNpmIneligibleDiag(
            s.package,
            // The one shared offender reason that narrates the executable
            // lane's fallback loses that clause here — no island exists on
            // this path to serve anything.
            (s.detail ?? "its static compilation was refused").replace("; the island serves the package", ""),
            fe.npmImportSites.get(s.package) ?? { file: entryPath, start: 0, end: 0 },
          ),
        ),
      );
    }
    if (fe.preflight.length > 0) return fail(fe.preflight);
    contractFacts = profile.sidecar !== null ? fe.entryContract() : null;
    // Ask 4, contract-surface reachability: when the sidecar declares ANY
    // integer slot, the designated init/update/subscriptions exports and
    // every contract helper (model-first exported function) seed lowering
    // too. They are attested surface — a declared record-field or msg-arm
    // class obligates EVERY write those bodies perform, and a declared
    // helper param is checked at their internal call sites — so the
    // attestation must cover COMPILED bodies, never a dead-stripped
    // vacuity (the bug this closes: a model-slot declaration whose only
    // writers were dead-stripped attested without any proof).
    const contractSurfaceRoots: string[] = [];
    if (profile.sidecar !== null && profile.sidecar.integerSlots.length > 0) {
      const sc = profile.sidecar;
      const fnNames = new Set(contractFacts!.functions.filter((f) => !f.generic).map((f) => f.name));
      for (const name of [sc.initExport, sc.updateExport, sc.subscriptionsExport]) {
        if (fnNames.has(name)) contractSurfaceRoots.push(name);
      }
      for (const fn of contractFacts!.functions) {
        if (fn.generic) continue;
        const first = fn.params[0];
        if (first !== undefined && first.shape !== null && first.shape.k === "ref" && first.shape.name === sc.model) {
          contractSurfaceRoots.push(fn.name);
        }
      }
    }
    // The profile's host-callback channels ride the FFI import machinery:
    // each channel is a signature-only ambient binding whose direct calls
    // lower to ffiCall nodes (the classes are a subset of the FFI's), and
    // `libraryCallbacks` flips the recognition to the library flavor —
    // SC4024 diagnostics, unused channels legal, undeclared references
    // refused with the callback teaching. The library lane never loads a
    // native-FFI manifest, so the channel set owns the surface outright.
    const cbImports: IrFfiImport[] = profile.callbacks.map((cb) => ({
      name: cb.name,
      symbol: cb.name,
      params: [...cb.params],
      returns: cb.returns,
    }));
    try {
      lowered = fe.lower({
        dynamic: false,
        targetPlatform: buildPlatform,
        ...(cbImports.length > 0 ? { ffiImports: cbImports, libraryCallbacks: true } : {}),
        // The profile-mapped exports are called from OUTSIDE the graph:
        // they seed reachability beside the entry's top level (an
        // executable build would dead-strip an uncalled export). A helper
        // with a declared integer slot (ask 4) seeds too: its attestation
        // must cover a COMPILED body, never a dead-stripped vacuity — the
        // sidecar advertises the slot's class, so the proof must exist.
        libRoots: [
          ...new Set([
            ...profile.exports.map((e) => e.export),
            ...(profile.sidecar?.integerSlots ?? [])
              .map((s) => /^helpers\.([^.]+)\.(?:params\[\d+\]|return)$/.exec(s.slot)?.[1])
              .filter((n): n is string => n !== undefined),
            ...contractSurfaceRoots,
          ]),
        ],
      });
      timing("lower", {
        lib_roots: profile.exports.length + contractSurfaceRoots.length,
      });
    } catch (e) {
      if (!isCheckerPanic(e)) throw e;
      return fail([checkerPanicDiag(e.message.split("\n", 1)[0]!, { file: entryPath, start: 0, end: 0 })]);
    }
    if (lowered.module === null) return fail(lowered.diagnostics);
    entryInfo = fe.entryExports();
    entryText = fe.entryText();
    sourceTexts = fe.sourceTexts();
  } finally {
    fe.dispose();
  }
  const mod = lowered.module!;
  timing("frontend-dispose");

  const fail = (diagnostics: ScrDiagnostic[]): CompileLibraryResult => ({
    ok: false,
    diagnostics: decorateLibraryRefusals(diagnostics, profile),
    sourceTexts,
  });
  const backendDiagnostics = nativeModuleBackendDiagnostics(mod, profile.emission);
  if (backendDiagnostics.length > 0) return fail(backendDiagnostics);

  // Export resolution first (SC4002/SC4003/SC4004/SC4007 anchor at the
  // mapped declaration — a mapped async export reports as SC4004, not the
  // graph-wide gate), then the async_free requirement (ratified, SC4005),
  // then the profile's determinism fences (ask 5, SC4008) over the same
  // compiled graph the attestation scan reads: all refused before anything
  // is emitted, so the narrowed library link set below is structural fact.
  const resolved = resolveLibrarySection(profile, entryInfo, mod, entryPath);
  if ("diagnostics" in resolved) return fail(resolved.diagnostics);
  const asyncSurface = moduleLibAsyncSurface(mod);
  if (asyncSurface !== null) {
    return fail([libAsyncSurfaceDiag(asyncSurface.surface, asyncSurface.loc)]);
  }
  const fenced = evaluateLibraryFences(mod, profile);
  if (fenced.length > 0) return fail(fenced);
  mod.lib = resolved.lib;

  // Ask 4's declared integer slots: the export map's i64/u64 classes
  // seed the config here; sidecar-declared slots (record fields, msg
  // arms, helper params/returns) merge in after the projection resolves
  // them below.
  let intCfg = libraryIntSlotConfig(profile);

  // The ask-2 contract sidecar rides the same invocation. Identity first
  // (schema §2's worked build_id definition over compiler version, profile
  // bytes, and the sorted canonical module graph; source_hash per the
  // profile's "module-graph" contract) — the u64 lands on the IR so native
  // archive assembly emits the identity getters from the ONE value the
  // sidecar records (V12's coherence by construction), then the projection into
  // the schema (declaration orders from the AST) and the V1–V14
  // self-check before anything is written.
  let sidecarJson: string | null = null;
  if (profile.sidecar !== null) {
    const rootDir = dirname(resolve(opts.profilePath));
    const modules = canonicalModuleGraph(rootDir, sourceTexts);
    const { buildId, sourceHash } = libraryIdentityHashes(compilerReleaseVersion(), profile.profileBytes, modules);
    mod.lib.identity = {
      buildIdSymbol: profile.sidecar.buildIdSymbol,
      abiVersionSymbol: profile.sidecar.abiVersionSymbol,
      buildId,
      abiVersion: profile.sidecar.abiVersion,
    };
    const built = buildSidecar({
      profile,
      facts: contractFacts!,
      compilerVersion: compilerReleaseVersion(),
      entry: canonicalPath(rootDir, entryPath),
      buildId,
      sourceHash,
      deterministic: moduleLibNondeterministicSurface(mod) === null,
    });
    if (!built.ok) return fail(built.diagnostics);
    const violations = validateSidecar(built.doc);
    if (violations.length > 0) {
      // The projection above refuses every user-caused shape; a rule
      // violation surviving to here is an emitter bug.
      return fail(violations.map((v) => iceDiag(`sidecar self-check failed — ${v}`, { file: entryPath, start: 0, end: 0 })));
    }
    sidecarJson = built.json;
    const merged = mergeSidecarIntSlots(intCfg, built.integerSlotFacts, mod);
    if (!merged.ok) return fail([merged.diagnostic]);
    intCfg = merged.config;
  }
  timing("contract-sidecar", { source_files: sourceTexts.size });

  // Ask 4: the integer-boundary inference — every value that can reach a
  // profile-declared i64/u64 slot must PROVE representability, wholeness,
  // and range, or the build refuses with the failed obligation, the
  // observed evidence, and the author's fix (SC4021/SC4022/SC4023). Runs
  // only when at least one integer slot is declared; the sidecar (already
  // built above, written only on success) may then attest the classes —
  // §5's invariant that an attested integer class means the proof was
  // discharged holds because no artifact leaves this function otherwise.
  if (hasIntSlots(intCfg)) {
    const refusals = checkLibraryIntegerSlots(mod, intCfg).filter((v) => v.outcome === "refuse");
    if (refusals.length > 0) {
      return fail(refusals.map((v) => libIntBoundaryDiag(v.path, v.cls, v.obligation!, v.detail!, v.fix!, v.loc)));
    }
  }
  timing("integer-proof");

  const validation = validateModule(mod);
  if (validation.length > 0) return fail(validation.map((v) => iceDiag(v.message, v.loc)));
  timing("ir-validate");

  await mkdir(opts.outDir, { recursive: true });
  const stem = basename(entryPath).replace(/\.(ts|mts|cts|js|mjs|cjs)$/, "");
  if (profile.emission === "rust") {
    let rustSource: string;
    try {
      rustSource = emitRustModule(withIslandStore(mod, undefined));
    } catch (error) {
      if (!(error instanceof RustUnsupportedError)) throw error;
      return fail(rustRefusalDiags(error, entryPath));
    }
    const sourcePath = join(opts.outDir, `${stem}.lib.rs`);
    await writeFile(sourcePath, rustSource);
    await Promise.all([
      rm(join(opts.outDir, `${stem}.lib.c`), { force: true }),
      rm(join(opts.outDir, `${stem}.lib.ll`), { force: true }),
    ]);
    let irPath: string | undefined;
    if (opts.emitIr) {
      irPath = join(opts.outDir, `${stem}.lib.ir.json`);
      await writeFile(irPath, serializeModule(mod));
    }
    const localizeSymbols = libraryLocalizeSymbols(profile);
    try {
      await compileRustLibrary({
        sourcePath,
        outPath: archivePath,
        optimization: profile.optimization,
        sanitize: opts.sanitize ?? false,
        runtimeFeatures: rustRuntimeFeatures(mod),
        ...(localizeSymbols === undefined ? {} : { localizeSymbols }),
      });
    } catch (error) {
      if (!(error instanceof RustCompileError)) throw error;
      throw new InternalCompilerError(
        `${error.message}${error.stderr === "" ? "" : `\n${error.stderr}`}`,
      );
    }
    let sidecarPath: string | undefined;
    if (sidecarJson !== null) {
      sidecarPath =
        profile.sidecar!.path !== null
          ? resolve(dirname(archivePath), profile.sidecar!.path)
          : `${archivePath}.contract.json`;
      await writeFile(sidecarPath, sidecarJson);
    }
    await pruneBuildCache(cacheRoot);
    timing("complete");
    return {
      ok: true,
      archivePath,
      cPath: sourcePath,
      backend: "rust",
      ...(irPath !== undefined ? { irPath } : {}),
      ...(sidecarPath !== undefined ? { sidecarPath } : {}),
    };
  }
  let cPath: string;
  if (profile.emission === "llvm") {
    try {
      const ll = emitLlvmModule(mod);
      timing("llvm-emit", { output_bytes: Buffer.byteLength(ll) });
      cPath = join(opts.outDir, `${stem}.lib.ll`);
      await writeFile(cPath, ll);
      timing("llvm-write");
    } catch (err) {
      if (!(err instanceof LlvmUnsupportedError)) throw err;
      // The profile PINS the emission — fail-loudly, never a lane change.
      return fail([llvmRefusalDiag(err, entryPath)]);
    }
  } else {
    cPath = join(opts.outDir, `${stem}.lib.c`);
    await writeFile(cPath, emitCModule(mod, entryText));
  }
  await rm(join(opts.outDir, `${stem}.lib.${profile.emission === "llvm" ? "c" : "ll"}`), { force: true });

  let irPath: string | undefined;
  if (opts.emitIr) {
    irPath = join(opts.outDir, `${stem}.lib.ir.json`);
    await writeFile(irPath, serializeModule(mod));
  }

  const nativeFeatures = libraryNativeFeatures(mod, profile.emission);
  await compileLibraryNative(
    profile,
    cPath,
    archivePath,
    opts.sanitize ?? false,
    nativeFeatures,
  );
  timing("native-archive");

  // The sidecar lands beside the compiled object, written by the same
  // invocation (profile-declared name; the neutral default when the
  // profile states none is <out>.contract.json).
  let sidecarPath: string | undefined;
  if (sidecarJson !== null) {
    sidecarPath =
      profile.sidecar!.path !== null
        ? resolve(dirname(archivePath), profile.sidecar!.path)
        : `${archivePath}.contract.json`;
    await writeFile(sidecarPath, sidecarJson);
  }
  const earlyPublish: EarlyLibraryCachePublish = {
    cPath,
    native: nativeFeatures,
    frontend: frontendInputs.snapshot(),
    semantic: { mod, sources: sourceTexts },
    ...(irPath !== undefined ? { irPath } : {}),
    ...(sidecarPath !== undefined ? { sidecarPath } : {}),
  };
  await publishEarlyLibraryCache(cacheRoot, earlyCacheOptions, earlyPublish).catch(() => undefined);
  await pruneBuildCache(cacheRoot);
  timing("early-cache-publish");
  timing("complete");
  return {
    ok: true,
    archivePath,
    cPath,
    backend: profile.emission,
    ...(irPath !== undefined ? { irPath } : {}),
    ...(sidecarPath !== undefined ? { sidecarPath } : {}),
  };
}
