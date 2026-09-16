import { coercibleValue } from "./value-coercion.js";
import { directExternalTypeSpecifiersByFile } from "./external-type-specifiers.js";
import { checkNativeCallResult } from "./native-call-result.js";
import { jsArrayInferenceBinding, jsArrayInferenceExpression } from "../js-array-field-types.js";
import { fsConstantValue } from "./fs-constants.js";
import { ScopeEnv, type FnCtx } from "./scope-env.js";
import { isNpmStaticTypeFile } from "../npm-static-types.js";
import { activeRuntimeTarget, runtimeTargetIr } from "../../compat/runtime-target.js";
import { isIslandModulePath, islandModuleReason, type ModuleTierRow } from "../tiering.js";
/* AST + checker → IR.
 *
 * Invariants:
 * - Runs only on programs that passed preflight (tsc-clean), so the lowerer
 *   may assume the checker's guarantees (no undeclared identifiers, no
 *   ill-typed operators) and every remaining rejection is a *scriptc*
 *   limitation with its own SC1xxx/SC2xxx code.
 * - Collects ALL diagnostics instead of stopping at the first: an
 *   unsupported construct poisons its enclosing statement (PoisonError),
 *   the statement is skipped, and lowering continues. The user sees every
 *   blocker at once — this list is the seed of the coverage report.
 * - Lexical scoping is resolved here: locals get function-unique ids
 *   ("x.0", "x.1" for shadowing); the IR is scope-flat.
 */
import { resolve } from "node:path";
import { tsgoPath } from "../dts-paths.js";
import * as ts from "../ts7/adapter.js";
import {
  type ScrDiagnostic, anyOpRequiresDynamicDiag,
  blockedBindingUseDiag,
  checkerPanicDiag,
  componentTypeDiag,
  isCheckerPanic,
  genericSignatureTypeDiag,
  indexSignatureTypeDiag,
  intersectionTypeDiag,
  noLoweringDiag,
  overloadedSignatureTypeDiag,
  recordShapeMismatchDiag,
  requiresDynamicApiDiag,
  requiresDynamicPackageDiag,
  requiresDynamicTypeDiag,
  unionMismatchDiag,
  UNSUPPORTED,
  unsupportedDiag,
  unsupportedTypeDiag,
} from "../../diagnostics/diagnostic.js";
import type {
  IrClassDef,
  IrExpr,
  IrFfiImport,
  IrFunction,
  IrGlobal,
  IrLocal,
  IrModule,
  IrParam,
  IrRecordShape,
  IrStmt,
  IrType,
  IrUnionDef,
  SrcLoc,
} from "../../ir/ir.js";
import { BOOL, canCrossIslandBoundary, canExitIslandToType, DYN, F64, isJsonSafeType, isJsonStringifySafeType, isUndefinedArmedUnion, JSVAL, RUNTIME_ERROR_CLASSES, STRING, typeEquals, UNDEFINED_T, VOID } from "../../ir/ir.js";
import { type DynamicImportResolution, type NpmBuiltinUse, type NpmLazyTrap } from "../npm.js";
import { provenanceActive } from "../provenance-registry.js";
import {
  ambientDtsPath,
  canonicalBuiltinModule,
  type StartupCrash,
  cjsExportAssignmentOf,
  cjsExportDiscardReason,
  fallbackDtsPath,
  isCjsExportTableLiteral,
  isJsSourceFile,
  isNodeEsmFile,
  isNodeTypesPath,
  locOf,
  overridesDtsPath,
  npmStaticDepSf7,
  requireSpecOf,
  resolveImport,
  workspacePackageOfPath,
} from "../program.js"; import { describeSignatureBlocker } from "../type-explain.js";
import {
  containsRecord,
  containsUnion,
  describeComponentBlocker,
  describeRecordMemberBlocker,
  formatIrType,
  ISLAND_AMBIENT_TYPES,
  mapType,
  ShapeRegistry,
  type DeclaredOrderPriorityRef,
  typeKey,
  type TypeMapperCtx,
  UnionRegistry,
} from "../type-mapper.js";
import { CompoundOp, IslandFnEntry, boundaryIntoIslandMsg, boundaryOutOfIslandMsg, BuiltinModuleFn, builtinConstLit, builtinModuleConstOf, builtinModulesArrayLit, builtinFenceHintOf, builtinModuleFnOf, stdlibMemberFence, isStdlibMember, isStdlibSymbol, isStdlibGlobal, stdlibGlobalMember, nodeTypesOnlySymbol } from "./surfaces.js";
import { noteNativeImportSource, lowerNativeImportAssertion } from "./lower-native-import-boundary.js";
import { prepareModuleInits, lowerFileInit, pruneUnusedNativeModuleCaches } from "./lower-module-init.js";
import { FileParts, splitFiles, collectProgram, collectNpmImports, collectJsonImports, collectAssetImports, moduleArtifacts, collectGlobals, declSymbolOf, defaultExportSymbolOf, lowerDefaultExport, buildMain, appendDynamicImportModules } from "./lower-modules.js";
import { ClassInfo, ClassIteratorInfo, GenericClassInfo, registerBuiltinErrorClasses, registerBuiltinEmitterClass, registerBuiltinStreamClasses, builtinErrorInfoOf, builtinEmitterInfoOf, builtinStreamInfoOf, analyzeClassDecoration, classIteratorDrainCall, classIteratorNextCall, classIteratorOf, classIteratorOpenCall, classIteratorRestDrainCall, classMemberNameOf, classValueRef, collectClassShape, exactClassOfReceiver, collectClassShapeInner, ctorAbiEquals, findMethodOn, findStaticOn, genericClassInstanceType, isSubclassOf, inHierarchy, overrideBelow, staticShadowBelow, upcastTo, lowerClassMembers, lowerClassCtor, lowerClassExpression, lowerClassExpressionInfo, lowerClassMethodMember, lowerClassValueProperty, lowerStaticMethod, throwingSetterFn, fieldInitStmts, lowerStaticFieldInits, lowerStaticFieldRead, lowerDerivedCtorBody, superCallStmt, lowerSuperMethodCall, superThisRef, lowerSuperAccessorRead, lowerSuperAccessorWrite, inheritsBuiltinErrorCtor, inheritsBuiltinEmitterCtor, errorMessageArg, lowerNew, accessorCall } from "./lower-classes.js"; import { MixinFnShape, mixinCallClassInfoOf, mixinIntersectionInstanceType } from "./lower-mixins.js";
import { ParamShape, FnSig, GenericFnInfo, GenericInstance, bodyReadsArguments, implicitMonoFile, isThisParameter, paramShape, paramShapes, checkDefaultParamBodyType, completeArgs, wrappedUndefined, undefinedArgFor, requireExactArityValue, bodyReturnType, declaredReturnType, collectSignature, collectSignatureInner, collectGenericSignature, genericFnOf, lowerGenericCall, lowerGenericFnValue, inferTypeParamBindings, lowerGenericInstance, lowerCall, lowerFfiCall, lowerTimersMemberCall, lowerPromiseMethodCall, lowerFilterNarrowCall, isTopLevelFnSymbol, lowerNestedFunctionDecl, lambdaSignature, lowerLambda, lowerFunction, validateFfiImports } from "./lower-calls.js";
import { lowerArrayMethodCall, lowerBufferStaticCall, lowerBytesMethodCall, lowerBytesNew, lowerMapMethodCall, lowerMapForEachCall, buildMapForEachFn, lowerEnvToPairsHelper, lowerSetMethodCall, lowerSetForEachCall, buildSetForEachFn, lowerRegexMethodCall, lowerStringMethodCall } from "./lower-containers.js";
import { lowerStreamModuleCall } from "./lower-stream.js";
import { lowerEmitOverrideSpec, type EmitSpecCtx, type EmitSpecRequest } from "./lower-event-emitter.js";
import { builtinImportOf, createRequireBindingDecl, createRequireNamespaceDecl, createRequireSpecOf, stripTypeCasts, lowerBuiltinModuleCall, lowerTimersPromisesSetInterval, lowerFsToUnixTimestampCall, lowerFsLadderCall, lowerChildArgsArg, lowerSpawnSyncCall, lowerSpawnCall, lowerExecSyncCall, recordToEnvPairs, lowerJsonMethodCall, fencedBuiltinImportOf, lowerCryptoComposedCall, lowerUrlMethodCall, lowerSearchParamsMethodCall, lowerStatsMethodCall, lowerChildMethodCall, lowerAtomicsCall, lowerBuiltinExtraProperty, promisifiedExecFileDecl, lowerExecFileAsyncCall, execFileAsyncHelper, lowerStringDecoderMethodCall, strdecHelper, lowerReadlineMethodCall, lowerDcChannelMethodCall, lowerDcChannelProperty, lowerAlsMethodCall, lowerDcTracingChannelMethodCall, lowerDcTracingChannelProperty, lowerJsonProperty, lowerErrorCodeProperty, lowerProcessProperty, lowerNavigatorProperty, isProcessEnv, envValueType, lowerProcessEnvGet, lowerProcessMethodCall, lowerProcessOptionalMethodCall, lowerTimeoutMethodCall, envSnapshotHelper, isConsoleLog, consoleCallMember, lowerNumberStaticCall, lowerNumberStaticProperty, lowerDateCall, lowerTextCodecCall, lowerCryptoModuleCall, lowerFsConstantsProperty, lowerBuiltinConstantsProperty, builtinConstantBindingOf, builtinConstantsDestructureDecl, lowerProcessStreamProperty, lowerStringStaticCall, lowerStringLastIndexOfCall, lowerPromiseStaticCall, textCodecBindingClassOf } from "./lower-builtins.js";
import { fenceFetchObjectAssignment, fenceFetchObjectBinding, fenceStaticAbortControllerMemberRead, fenceStaticHeadersIteration, fenceStaticHeadersMember, fenceStaticReadableStreamMember, fenceStaticResponseMember, fenceUnsupportedFetchConstructorMember, isIslandExpr, jsvalIn, requireDynamicApi, islandGlobalFnOf, lowerAbortControllerNew, lowerDynamicHeadersIteratorCall, lowerDynamicHeadersSpread, lowerDynamicImportCall, lowerFetchCall, lowerFetchElementMethodCall, lowerResponseNew, lowerStaticFetchCompanionCall, lowerStaticAbortControllerCall, lowerStaticAbortSignalListenerCall, lowerStaticReadableStreamCancelCall, lowerStaticReadableStreamControllerCall, lowerStaticReadableStreamNew, lowerStaticReadableStreamReaderCall, lowerStaticResponseCall, lowerIslandMethodCall, lowerMathProperty, npmPackageOf, npmMemberFence, npmPackageOfSymbol } from "./lower-island.js";
import { lowerRequestNew } from "./lower-request.js";
import { lowerHttpHeadersElement, lowerNetModuleCall, lowerServerMethodCall, lowerServerProperty, lowerTlsRootCertificates } from "./lower-server.js";
import { lowerDgramDnsModuleCall, lowerDgramMethodCall } from "./lower-dgram.js";
import { lowerNodeTestModuleCall, lowerTestDirectCall, lowerTestMethodCall, lowerTestCtxProperty } from "./lower-test.js";
import { lowerAssertModuleCall, lowerAssertDirectCall } from "./lower-assert.js";
import { lowerUtilModuleCall } from "./lower-inspect.js";
import { lowerComptime, comptimeBakeable, rejectComptimeCaptures, comptimeValueToIr } from "./lower-comptime.js";
import { lowerStmts, noteBlockedBindings, isBlockedBinding, lowerScopedBlock, predeclareForwardCapture, predeclareForwardFnDecl, predeclareForwardVar, lowerStmt, lowerVarStatement, lowerDestructuringDecl, lowerDestructuringAssignParts, lowerBindingPattern, lowerJsvalBindingPattern, checkBindingElement, bindPatternTarget, isParseArgsDynCheckerType, lowerVarDeclList, lowerVarDecl, lowerSwitch, lowerTry, lowerExprStatement, lowerForOf, lowerForStatement } from "./lower-stmts.js";
import { FieldTarget, lowerExpr, maybeNarrow, lowerUnitComparison, lowerNullishCoalesce, lowerOptionalChain, finishOptionalChain, lowerCondition, ensureBool, requireTruthyUnion, eqComparableUnion, lowerIntrinsicProperty, lowerArrayLiteral, lowerShorthandValue, rejectThisInObjectMethod, lowerElementAccess, lowerElementWrite, lowerRecordKeyRead, ensureString, lowerTemplate, lowerAsExpression, lowerPrefixUnary, lowerBinary, lowerCaughtTypeofTest, caughtRead, caughtLocalOf, caughtToString, lowerInstanceOf, lowerRegexLiteral, lowerFieldRead, lowerUnionProperty, fieldTarget, fieldGetExpr, fieldSetStmt, lowerFieldCompound, uniqueSymbolKeyOf, foldedStringKeyOf } from "./lower-exprs.js";
import { lowerObjectLiteral } from "./lower-object-literal.js";
import type { ExpandoMember } from "./lower-expando.js";
import { lowerRecordFieldCall, lowerObjectMethodCall } from "./lower-calls.js"; import { familiesIr, noteFamily } from "./lower-families.js";
import { fenceCrossBlockNsRef, nsPathPrefix } from "./lower-namespaces.js";
import { varRef } from "../../ir/build.js";
import {
  cleanFuncAdaptable,
  coerceInto,
  coerceToExpected,
  dynConvertible,
  intoIndexValueSlot,
  lowerExprExpecting,
  lowerReturnStmt,
  lowerReturnValue,
  provenUnitAnyOf,
  withUndefinedArmOf,
} from "./lower-coercion.js";
import {
  applyWidthLift,
  arrayWidthHelper,
  classStaticsProjection,
  describeRecordWidthBlocker,
  emptyArrayLiftHelper,
  objRecordWidthHelper,
  objToRecordPlan,
  recordClassWidthHelper,
  recordToClassPlan,
  recordWidthHelper,
  recordWidthPlan,
  tupleArrayWidthHelper,
  unitOnlyElem,
  widthCoerce,
  widthLiftPlan,
} from "./lower-width-coercion.js";
import {
  dynRestIslandAdapter,
  funcCoerceAdapter,
  funcReturnWidthAdapter,
  spawnResFnAdapter,
  spawnResFnAdapterPlan,
} from "./lower-function-adapters.js";
import {
  deferredReadHelper,
  narrowedArmHelper,
  narrowedRetagHelper,
  strandedCoercionTrap,
  strandedUnitTrap,
  unionRetagHelper,
  unionRetagMappable,
} from "./lower-union-retag.js";
import {
  arrayToJsvalArrayHelper,
  arrayToJsvalHelper,
  jsvalLiftExpr,
  jsvalLiftable,
  recordToJsvalHelper,
  unionToJsvalHelper,
} from "./lower-jsval-lift.js";
import {
  analyzeRuntimeOptionalArrayReads,
  isRuntimeOptionalArithmeticGlobal,
  isRuntimeOptionalField,
  isRuntimeOptionalGlobal,
  promoteRuntimeOptionalFunctionReturn,
  promoteRuntimeOptionalParameter,
  runtimeOptionalBindingType,
  runtimeOptionalFieldKey,
  runtimeOptionalFunctionReturnType,
  runtimeOptionalIdentifierValue,
  runtimeOptionalPropertyReceiver,
  runtimeOptionalRecordField,
  runtimeOptionalRootOf,
  runtimeOptionalSourceValue,
  runtimeOptionalType,
  runtimeOptionalWidening,
} from "./lower-runtime-optional.js";
/** Entry function name. '%' cannot appear in a TS identifier, so a user
 * function can never collide with it (mangling is injective per prefix). */
export const ENTRY_NAME = "%main";

interface GenericDemandOwner {
  priority?: readonly [phase: number, order: number];
  functionDemands: GenericInstance[];
  classDemands: ClassInfo[];
}

/** One step of the copy-reshape width relation (widthLiftPlan): how a
 * source-typed value enters a destination slot. Pure data — the plan half;
 * applyWidthLift is the build half. */
export type WidthLift =
  | { how: "copy" }
  | { how: "wrap"; tag: number }
  | { how: "retag" }
  | { how: "liftWrap"; tag: number; arm: IrType }
  | { how: "width" }
  | { how: "arr" }
  | { how: "tupleArr" }
  | { how: "emptyArr" }
  | { how: "objWidth" }
  | { how: "clsWidth" }
  | { how: "narrow" }
  | { how: "dynIn" }
  | { how: "dynView" }
  | { how: "upcast" }
  | { how: "funcAdapt" };

export class PoisonError extends Error {}

/** Own-property lookup for the surface tables. They are plain object
 * literals, so a bare `table[name]` would also find Object.prototype
 * members ("toLocaleString", "constructor", "valueOf") — genuine member
 * NAMES user code can spell now that the real lib declares them; treating
 * an inherited function as a table entry would mis-lower or ICE. */
export function own<T>(table: Record<string, T | undefined>, key: string): T | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

/* ── the island boundary, in one voice ────────────────────────────────
 * Whether a value can cross between the static world and the island is
 * ONE question — canCrossIslandBoundary (ir.ts), asked here through
 * boundarySafe() — and each rejected direction has ONE message builder,
 * so the rule and its wording cannot drift apart across the implicit
 * coercion path, the explicit marshal path, and the exact-type fence. */

export interface LowerStats {
  /** Statements the lowerer attempted (nested statements count individually;
   * statements inside a poisoned construct were never reached and don't). */
  statementsTotal: number;
  statementsFailed: number;
  /** Statements that LOWERED but contain island constructs (jsOp/jsExit —
   * package calls, island-backed lib members): they compile, but their
   * work runs in the embedded engine. Only a --dynamic analysis produces
   * these; coverage renders them as "compile dynamically". */
  statementsIsland: number;
  /** Functions whose signature couldn't be analyzed (bodies not counted). */
  functionsSkipped: number;
}

/** IrStmt discriminants — the island walk below must not descend into
 * NESTED statements (each is counted individually by its own lowerStmts
 * visit; descending would attribute a nested island statement to every
 * enclosing construct too). The top-level statement object itself is
 * always visited. */
const IR_STMT_KINDS = new Set([
  "varDecl", "assign", "exprStmt", "if", "while", "doWhile", "switch",
  "arraySet", "arraySetLength", "arraySetUndefined", "arrayDelete", "forOf", "return", "fieldSet", "recordSet", "break",
  "continue", "block", "tryCatch", "throw", "rethrow", "runtimeFence",
]);

/** True when a lowered statement's OWN expressions contain island
 * constructs — a generic JSON walk (like moduleUsesRegex): `kind`
 * discriminants live only on IR objects, so user string values can never
 * false-positive. Nested statements are skipped (counted separately). */
/** Every identifier a binding name binds: the identifier itself, or all
 * identifiers of a (possibly nested) destructuring pattern in source
 * order. */
export function boundIdentifiersOf(name: ts.BindingName): ts.Identifier[] {
  if (ts.isIdentifier(name)) return [name];
  const out: ts.Identifier[] = [];
  for (const el of name.elements) {
    // Elisions: OmittedExpression in 5.9.3, a NAMELESS BindingElement in 7
    // (the parity battery's pinned finding 2) — both spell "no binding".
    if (ts.isOmittedExpression(el) || el.name === undefined) continue;
    out.push(...boundIdentifiersOf(el.name));
  }
  return out;
}

export function stmtUsesIsland(stmts: IrStmt | IrStmt[]): boolean {
  let found = false;
  const visit = (v: unknown, root: boolean): void => {
    if (found || v === null || typeof v !== "object") return;
    if (Array.isArray(v)) {
      for (const item of v) visit(item, root);
      return;
    }
    const kind = (v as { kind?: unknown }).kind;
    if (!root && typeof kind === "string" && IR_STMT_KINDS.has(kind)) return;
    const fn = (v as { fn?: unknown }).fn;
    if (
      kind === "jsOp" || kind === "jsExit" || kind === "jsBridgePromise" ||
      fn === "island.eval" || fn === "island.import" || fn === "island.importDyn" ||
      fn === "island.importDynPath" ||
      fn === "island.castFail"
    ) {
      found = true;
      return;
    }
    for (const value of Object.values(v)) visit(value, false);
  };
  visit(stmts, true);
  return found;
}

export interface LowerResult {
  /** Present iff diagnostics is empty. */
  module: IrModule | null;
  diagnostics: ScrDiagnostic[];
  /** JS statements whose compile fences DEFERRED to runtime (runtimeFence
   * statements in the module) — off the build, on the coverage report. */
  runtimeFences: ScrDiagnostic[];
  stats: LowerStats;
  /** --provenance-sources only: per-file statement attribution (the
   * coverage report aggregates it per provenance package). */
  statsByFile?: Map<string, { total: number; failed: number; island: number }>;
  /** --provenance-sources only: diagnostics of elided pure-annotated dead
   * consts in fetched source modules — off the build, on the report. */
  provenanceElided?: ScrDiagnostic[];
  /** Coverage only (LowerOptions.coverage): the unreached remainder,
   * lowered in a throwaway pass — blockers in it can never fail a build. */
  unreached?: { diagnostics: ScrDiagnostic[]; stats: LowerStats };
  /** The static frontier (present when any module is island-classified):
   * every program module with its tier and the reason. */
  tiers?: ModuleTierRow[];
  /** --dynamic only: every Node builtin the embedded npm graph imports,
   * shimmed or not — the coverage report's island honesty. */
  npmBuiltins?: NpmBuiltinUse[];
  /** --dynamic only: unresolvable specifiers reached ONLY by require()/
   * import() edges — the build embeds Node's call-time error as a runtime
   * trap; the coverage report lists them beside the builtins. */
  npmLazyTraps?: NpmLazyTrap[];
}

export interface LowerOptions {
  /** Runtime capability: stateful regex execution and match metadata. */
  statefulRegex?: boolean;
  nativePromiseViews?: boolean;
  /** Rust arrays are dense: synthetic loops never pre-grow an output array. */
  nativeDenseArrays?: boolean;
  /** --dynamic: the island engine is linked, so island constructs
   * (__island_eval) may lower. Off by default — without it they produce a
   * requires-dynamic diagnostic instead. */
  dynamic?: boolean;
  /** Coverage: additionally lower the unreached remainder (bodies nothing
   * on the entry path reaches) in a throwaway pass and report its
   * diagnostics and stats under `unreached` — the whole-program analysis
   * builds deliberately gave up. */
  coverage?: boolean;
  /** The platform the build TARGETS ("win32" under a windows cross triple,
   * the host platform otherwise — see buildTargetPlatform in index.ts).
   * The whole program compiles for one platform, so the platform-keyed
   * surfaces are compile-time constants: on win32 the bare path module
   * binds path.win32 (Node on Windows IS path.win32) and path.sep /
   * path.delimiter / os.EOL lower as the win32 literals; path.posix and
   * path.win32 keep answering THEIR platform everywhere, like Node's. */
  targetPlatform?: string;
  /** Node's startup refusal (LoadResult.startupCrash — preflight's
   * resolution walk and named-import link checks): the program
   * compiles to that startup crash. */
  startupCrash?: StartupCrash | null;
  /** LIBRARY mode's reachability roots: the profile-mapped exports of the
   * entry module. Executable builds root at the entry's top level alone
   * (an unreferenced export dead-strips); a library's exports are called from
   * OUTSIDE the graph, so discovery seeds them alongside the init
   * bodies. Names are the entry file's unqualified declaration names. */
  libRoots?: readonly string[];
  /** Outbound native FFI declarations from a validated format-1 manifest.
   * Calls of their exact ambient TypeScript bindings lower to direct C ABI
   * imports; without this option ambient declarations keep Node's ordinary
   * ReferenceError behavior. */
  ffiImports?: readonly IrFfiImport[];
  /** LIBRARY mode's host-callback surface marker: the `ffiImports` above
   * are profile-declared callback channels, not native-manifest bindings.
   * Flips the binding diagnostics to the library flavor (SC4024), keeps a
   * channel legal when no program declaration references it (an unused
   * channel is capacity, not an error), and refuses a CALL of any other
   * program-authored signature-only ambient function with the callback
   * teaching instead of the ambient ReferenceError lowering. */
  libraryCallbacks?: boolean;
  /** Coverage-only external host type surfaces. Their declarations inform
   * the checker, while every runtime value use remains an SC1010 fence. */
  externalTypes?: ReadonlyMap<string, string>;
  /** The mapped entries plus relative declaration dependencies, attributed
   * to their owning external specifier. */
  externalTypeSpecifiersByFile?: ReadonlyMap<string, readonly string[]>;
}

interface RuntimeFenceFallback {
  code: `SC${number}`;
  message: string;
}

interface RuntimeFenceBase {
  /** Used only by catches that can legitimately have no fresh diagnostic. */
  fallback?: RuntimeFenceFallback;
  /** Legacy function-body fences throw the diagnostic text without a site suffix. */
  bareMessage?: boolean;
  /** The closure-probe fallback historically applies inside diagnostic captures. */
  allowDiagSink?: boolean;
}

interface RuntimeFenceStatementTarget extends RuntimeFenceBase {
  kind: "statement";
}

interface RuntimeFenceFunctionTarget extends RuntimeFenceBase {
  kind: "function";
  name: string | (() => string);
  params?: IrParam[];
  returnType: IrType;
  paramsMutable?: boolean;
  async?: true;
  generator?: NonNullable<IrFunction["generator"]>;
}

interface RuntimeFenceClosureTarget extends Omit<RuntimeFenceFunctionTarget, "kind"> {
  kind: "closure";
  type: IrType & { kind: "func" };
}

type RuntimeFenceTarget =
  | RuntimeFenceStatementTarget
  | RuntimeFenceFunctionTarget
  | RuntimeFenceClosureTarget;

/** The Lowerer's pass configuration (see lowerToIr). */
export interface LowererMode {
  statefulRegex?: boolean;
  nativePromiseViews?: boolean;
  /** Rust arrays are dense: synthetic loops never pre-grow an output array. */
  nativeDenseArrays?: boolean;
  /** Names of bodies a prior reachability pass reached; null lowers everything. */
  reachable?: ReadonlySet<string> | null;
  /** Coverage remainder: lower ONLY bodies outside `reachable`, skip the
   * always-reachable init bodies and module building, and report deferred
   * collection diagnostics nothing flushed. */
  remainder?: boolean;
  /** Symbols whose deferred diagnostics reachable emit already flushed —
   * the remainder must not report them a second time. */
  alreadyFlushed?: ReadonlySet<ts.Symbol>;
  /** The build's target platform (LowerOptions.targetPlatform — lowerToIr
   * passes it to every pass). Defaults to the host. */
  targetPlatform?: string;
  /** Node's startup refusal (preflight's resolution walk / named-import
   * link checks): %main opens with exactly this throw, before any
   * module init — Node refuses the whole graph before anything evaluates,
   * so nothing runs. */
  startupCrash?: StartupCrash | null;
  /** The build's outbound native FFI declarations. */
  ffiImports?: readonly IrFfiImport[];
  /** LowerOptions.libraryCallbacks (see there). */
  libraryCallbacks?: boolean;
  /** Program-validated ambient declaration symbols for each FFI name.
   * Undefined in discovery's legacy call-local validation path. */
  ffiBindingSymbols?: ReadonlyMap<string, ReadonlySet<ts.Symbol>>;
  /** LowerOptions.externalTypes, threaded through every lowering pass. */
  externalTypes?: ReadonlyMap<string, string>;
  /** LowerOptions.externalTypeSpecifiersByFile, shared by every pass. */
  externalTypeSpecifiersByFile?: ReadonlyMap<string, readonly string[]>;
}

/** Build lowering runs as a reachability worklist over the ts.Program:
 *
 * 1. REACHABLE EMIT — a worklist computes the set of reachable bodies.
 *    Seeds are
 *    the per-file init bodies (module top-level statements always run, in
 *    import order); lowering a body yields IR whose call/closure/new/
 *    virtualCall nodes are the edges that enqueue further bodies. The pass
 *    retains that IR. Once the graph closes, those functions are assembled in
 *    deterministic declaration order beside the already-lowered init,
 *    generic-instance, and lifted bodies. Checker-backed IR construction
 *    therefore happens once instead of once for discovery and again for
 *    emission.
 *
 * `coverage: true` adds a second pass — the REMAINDER — that lowers only
 * the bodies reachable emit did NOT mark (plus deferred collection
 * diagnostics nothing flushed), reported separately: whole-program analysis without
 * letting unreached code fail builds. */
export function lowerToIr(
  program: ts.Program,
  entry: ts.SourceFile,
  moduleOrder: ts.SourceFile[],
  options: LowerOptions = {},
): LowerResult {
  const phaseTiming = process.env["SCRIPTC_TIMING"] === "1";
  const phaseStarted = performance.now();
  let phaseLast = phaseStarted;
  const timing = (phase: string, detail: Record<string, unknown> = {}): void => {
    if (!phaseTiming) return;
    const now = performance.now();
    process.stderr.write(
      `scriptc lowering ${JSON.stringify({
        phase,
        phase_ms: Math.round((now - phaseLast) * 10) / 10,
        total_ms: Math.round((now - phaseStarted) * 10) / 10,
        ...detail,
      })}\n`,
    );
    phaseLast = now;
  };
  const dynamic = options.dynamic ?? false;
  const targetPlatform = options.targetPlatform ?? process.platform;
  const startupCrash = options.startupCrash ?? null;
  // Modules reachable only through literal import() of the
  // program's own files join the compiled graph here, ONCE, before any
  // pass constructs (nothing calls their %init at startup — the import()
  // site's namespace builder does, in its module job, Node's
  // evaluation point for them). Inadmissible static cycles inside the
  // added subgraph are minted here and handed to reachable emit after this
  // extension of the shared array; no later pass re-walks the subgraph.
  const dynamicCycleDiags: ScrDiagnostic[] = [];
  {
    appendDynamicImportModules(program, moduleOrder, (cycle, reason) => {
      dynamicCycleDiags.push(
        unsupportedDiag("SC1016", { file: entry.fileName, start: 0, end: 0 }, `circular imports (${cycle}; ${reason})`),
      );
    });
  }
  const ffiImports = options.ffiImports ?? [];
  const libraryCallbacks = options.libraryCallbacks ?? false;
  const externalTypes = options.externalTypes ?? new Map<string, string>();
  const externalTypeSpecifiersByFile = options.externalTypeSpecifiersByFile ??
    directExternalTypeSpecifiersByFile(externalTypes);
  const validation = new Lowerer(program, entry, moduleOrder, dynamic, {
    statefulRegex: options.statefulRegex ?? false,
    nativePromiseViews: options.nativePromiseViews ?? false,
    nativeDenseArrays: options.nativeDenseArrays ?? false,
    targetPlatform,
    startupCrash,
    ffiImports,
    libraryCallbacks,
    externalTypes,
    externalTypeSpecifiersByFile,
  });
  const ffiValidation = validateFfiImports(validation);
  timing("ffi-validate");
  // Reachability must use the same exact-symbol ownership as FFI validation.
  // Otherwise a local function shadowing a configured ambient name is mistaken for FFI
  // while computing reachability, even though ordinary lowering would
  // correctly handle it as TypeScript. FFI-free builds reuse the validation
  // lowerer because validation is an immediate no-op there.
  const reachableEmit = ffiImports.length === 0
    ? validation
    : new Lowerer(program, entry, moduleOrder, dynamic, {
        statefulRegex: options.statefulRegex ?? false,
        nativePromiseViews: options.nativePromiseViews ?? false,
        nativeDenseArrays: options.nativeDenseArrays ?? false,
        targetPlatform,
        startupCrash,
        ffiImports,
        libraryCallbacks,
        externalTypes,
        externalTypeSpecifiersByFile,
        ffiBindingSymbols: ffiValidation.symbolsByName,
      });
  for (const d of dynamicCycleDiags) reachableEmit.pushDiag(d);
  for (const d of ffiValidation.diagnostics) reachableEmit.pushDiag(d);
  const emitted = reachableEmit.emitReachable(options.libRoots);
  const { reachable } = emitted;
  let result = emitted.result;
  let resultLowerer = reachableEmit;
  timing("reachable-emit", { reachable: reachable.size });
  // A generic class-rest support decision can depend on record metadata
  // whose historical owner is discovered only while retained bodies lower.
  // If the settled answer is a fence, rerun the ordinary reachable emit so
  // the PoisonError occurs in its original statement window: later
  // declarators stay unvisited, bindings block, cascades and stats match the
  // historical compiler. This is a rare compatibility fallback; programs
  // without such a settled fence retain checker-backed IR exactly once.
  if (reachableEmit.requiresHistoricalOrderRelower) {
    const emit = new Lowerer(program, entry, moduleOrder, dynamic, {
      reachable,
      statefulRegex: options.statefulRegex ?? false,
      nativePromiseViews: options.nativePromiseViews ?? false,
      nativeDenseArrays: options.nativeDenseArrays ?? false,
      targetPlatform,
      startupCrash,
      ffiImports,
      libraryCallbacks,
      ffiBindingSymbols: ffiValidation.symbolsByName,
      externalTypes,
      externalTypeSpecifiersByFile,
    });
    for (const d of dynamicCycleDiags) emit.pushDiag(d);
    for (const d of ffiValidation.diagnostics) emit.pushDiag(d);
    result = emit.run();
    resultLowerer = emit;
    timing("historical-order-relower");
  }
  if (options.coverage !== true) return result;
  const remainder = new Lowerer(program, entry, moduleOrder, dynamic, {
    reachable,
    remainder: true,
    alreadyFlushed: resultLowerer.flushedSymbols,
    statefulRegex: options.statefulRegex ?? false,
    nativePromiseViews: options.nativePromiseViews ?? false,
    nativeDenseArrays: options.nativeDenseArrays ?? false,
    targetPlatform,
    ffiImports,
    libraryCallbacks,
    ffiBindingSymbols: ffiValidation.symbolsByName,
    externalTypes,
    externalTypeSpecifiersByFile,
  });
  const rem = remainder.run();
  return { ...result, unreached: { diagnostics: rem.diagnostics, stats: rem.stats } };
}

/** The island-handle type a `import(...)` initializer gives a binding
 * whose DECLARED type has no static mapping (`Promise<typeof
 * import("./m")>` — module-namespace types don't map): the direct form
 * holds the static promise-of-handle, the awaited form holds the handle
 * itself. Null for every other initializer shape. */
export function importCallHandleType(expr: ts.Expression | undefined): IrType | null {
  if (!expr) return null;
  let e = expr;
  let awaited = false;
  for (;;) {
    if (ts.isParenthesizedExpression(e)) {
      e = e.expression;
    } else if (ts.isAwaitExpression(e)) {
      awaited = true;
      e = e.expression;
    } else {
      break;
    }
  }
  if (ts.isCallExpression(e) && e.expression.kind === ts.SyntaxKind.ImportKeyword) {
    return awaited ? JSVAL : { kind: "promise", inner: JSVAL };
  }
  return null;
}

/** True when `expr` is a call that resolved to an overload SIGNATURE of a
 * source-implemented function whose implementation returns an island value
 * (`any` under --dynamic): tsc never checks overload return types against
 * the body — only the implementation signature is checked — so the
 * overload's return is an unverifiable claim about an island value. The
 * binding stores the HANDLE instead of trap-extracting the claimed type
 * (reconcileOverloadReturn keeps the call jsval by the same rule), and
 * uses dispatch to engine ops — exactly the value Node's binding holds.
 * Ambient (.d.ts) declarations never reach this: they have no compiled
 * implementation, so their calls lower through the island/builtin paths
 * whose validated exits keep the checker-trust trap. */
export function uncheckedOverloadHandleCall(lowerer: Lowerer, expr: ts.Expression | undefined): boolean {
  if (!lowerer.dynamic || !expr) return false;
  let e = expr;
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  // Tagged templates are calls too (tag(strings, ...values)) and resolve
  // overload sets the same way — foo1`${1}` against a TemplateStringsArray
  // overload of an any-returning implementation stores the handle.
  if (!ts.isCallExpression(e) && !ts.isTaggedTemplateExpression(e)) return false;
  const rsig = lowerer.checker.getResolvedSignature(e);
  const rdecl = rsig ? lowerer.checker.signatureDeclaration(rsig) : undefined;
  if (!rsig || !rdecl) return false;
  if (!(ts.isFunctionDeclaration(rdecl) || ts.isMethodDeclaration(rdecl)) || rdecl.body) return false;
  const name = rdecl.name;
  const symbol = name ? lowerer.checker.getSymbolAtLocation(name) : undefined;
  if (!symbol) return false;
  const impl = lowerer.checker
    .declarationsOf(symbol)
    .find((d) => (ts.isFunctionDeclaration(d) || ts.isMethodDeclaration(d)) && (d as ts.FunctionDeclaration).body !== undefined);
  if (!impl) return false;
  const implSig = lowerer.checker.getSignatureFromDeclaration(impl);
  if (!implSig) return false;
  return lowerer.mapTypeOf(lowerer.checker.getReturnTypeOfSignature(implSig))?.kind === "jsval";
}

/** The JavaScript declaration fallback for unmappable binding types (see
 * irTypeOf): `any` and every other inference residue is the checked-
 * dynamic 'unknown' kind, and array types keep their array-ness with the
 * fallback applied to the ELEMENT (any[]/never[] evolving arrays become
 * unknown[], so length/push/index still lower). Null for TypeScript
 * files and for void (no value exists to represent). */
/** A JS-file type carrying `never[]` (or a never element) ANYWHERE in its
 * array/tuple/union structure: tsc's inference residue for evolving and
 * information-free shapes — the bare `const gb = []` (never[]), the mixed
 * command tuple `['pwd', []]` ((string | never[])[]). never's f64
 * representation (mapType's uninhabited stance, sound for genuinely dead
 * TS reads) must not capture these VALUES — a later dyn push would
 * dynCheck strings into a number array, a union arm would re-tag as
 * number[] and fence. Callers treat a tainted type as unmappable so the
 * checked-dynamic fallbacks apply, the pre-never-mapping behavior. Bare
 * `never` at the ROOT stays out (`for (const v of [])`'s loop var — the
 * dead read the f64 mapping is FOR). */
export function neverTaintedJsType(lowerer: Lowerer, node: ts.Node, t: ts.Type): boolean {
  if (!isJsSourceFile(node.getSourceFile())) return jsArrayInferenceExpression(node, lowerer.checker);
  const walk = (x: ts.Type, depth: number): boolean => {
    if (depth === 0) return false;
    if (x.isUnionType()) return ts.constituentTypes(x).some((a) => walk(a, depth - 1));
    if (lowerer.checker.isArrayType(x) || lowerer.checker.isTupleType(x)) {
      return lowerer.checker
        .getTypeArguments(x as ts.TypeReference)
        .some((a) => (a.flags & ts.TypeFlags.Never) !== 0 || walk(a, depth - 1));
    }
    return false;
  };
  return walk(t, 4);
}

/** The dyn undefined value — what an uninitialized checked-dynamic
 * binding holds (JS: declared bindings read `undefined` before any
 * assignment). A NULL dyn slot is a trap, never a value, so every dyn
 * binding that is READABLE before its first assignment must start here:
 * `let x;` declarations, hoisted `var`s (function and module scope,
 * forward captures included), and the implicit-return completion
 * (lower-calls' own copy of this pattern predates the helper). */
export function dynUndefinedExpr(loc: SrcLoc): IrExpr {
  return {
    kind: "dynFrom",
    value: { kind: "unitLit", unit: "undefined", type: UNDEFINED_T, loc },
    type: DYN,
    loc,
  };
}

/** An always-throwing Node-parity error expression (the error.nodeThrow
 * libCall — the lowered form of arms Node rejects unconditionally:
 * ERR_INVALID_THIS receivers, ERR_MISSING_ARGS arity ladders, the
 * symbol-to-string TypeError). kind 0 Error / 1 TypeError / 2 RangeError;
 * an empty code means no code slot. `type` is the replaced expression's
 * own (never materialized — the global.undefRead pattern). */
export function nodeThrowExpr(kind: 0 | 1 | 2, code: string, message: string, type: IrType, loc: SrcLoc): IrExpr {
  return {
    kind: "libCall",
    fn: "error.nodeThrow",
    args: [
      { kind: "numLit", value: kind, type: F64, loc },
      { kind: "strLit", value: code, type: STRING, loc },
      { kind: "strLit", value: message, type: STRING, loc },
    ],
    type,
    loc,
  };
}

/** The runtime-TRAP throw for a use of a trapped-module binding
 * (shared.ts's TRAP_RUNTIME_MODULES — bun:sqlite/bun:ffi/v8): kind-0
 * Node-parity Error naming the module and member, `type` the replaced
 * expression's own (never materialized — it never returns). The
 * diagnostic joins the runtime-fence ledger so the coverage report says
 * so instead of silently trapping. */
export function trapUseThrowExpr(
  lowerer: Lowerer,
  tm: { module: string; member: string },
  node: ts.Node,
  mapped: IrType | null,
  loc: SrcLoc,
): IrExpr {
  const d = noLoweringDiag(
    `runtime trap: '${tm.module}.${tm.member}' has no compiled-binary equivalent (the module requires the runtime that provides it)`,
    loc,
  );
  lowerer.runtimeFences.push(d);
  const runtime = tm.module === "bun" || tm.module.startsWith("bun:") ? "Bun" : "V8";
  return nodeThrowExpr(
    0,
    "",
    `the '${tm.member}' of '${tm.module}' is not available in a compiled binary (requires the ${runtime} runtime)`,
    mapped && mapped.kind !== "void" && mapped.kind !== "undefinedT" ? mapped : STRING,
    loc,
  );
}

/** The post-validation fence STRING a validation-ladder Chk libCall
 * throws after its Node-order checks pass: the same SC2020 text the
 * per-statement runtime fence would have thrown (message + "[code at
 * file:line]"), rendered eagerly so the runtime can throw it verbatim
 * (scr_throw_lowering_fence). The diagnostic joins the runtime-fence
 * ledger exactly like a deferred statement fence — nothing silently
 * drops off the coverage report. */
export function ladderFenceExpr(lowerer: Lowerer, surface: string, node: ts.Node, hint?: string): IrExpr {
  const loc = locOf(node);
  const d = noLoweringDiag(surface, loc, hint);
  lowerer.runtimeFences.push(d);
  const sf = node.getSourceFile();
  const pos = ts.getLineAndCharacterOfPosition(sf, loc.start);
  return {
    kind: "strLit",
    value: `${d.message} [${d.code} at ${loc.file}:${pos.line + 1}]`,
    type: STRING,
    loc,
  };
}

/** The checked-dynamic declaration fallback for unmappable binding types
 * (see irTypeOf), two gates over one story:
 *
 * JAVASCRIPT files: `any` and every other inference residue is the
 * checked-dynamic 'unknown' kind, and array types keep their array-ness
 * with the fallback applied to the ELEMENT (any[]/never[] evolving arrays
 * become unknown[], so length/push/index still lower).
 *
 * TYPESCRIPT files: genuine checker-`any` residue ONLY — a bare `any`
 * binding (`flags & Any`), or a single-call-signature function type whose
 * only unmappable pieces are `any` (`(value: any) => value is string` —
 * the arrow the binding holds lowers those params to dyn, so the binding
 * keeps its func-ness with the same per-piece fallback). The honest
 * static subset of `any` is a binding whose VALUES are dyn-representable:
 * the binding is 'unknown' storage with the boundary conversions
 * coerceToExpected already applies (dynFrom into the slot, validated
 * dynCheck out) and per-site SC2011 fences for the operations the checked-dynamic tree
 * cannot carry JS-exactly (the island still lifts those). Every OTHER
 * unmappable TS type keeps its own diagnostic — annotations exist there,
 * and the fence names the real blocker. `--dynamic` builds never reach
 * this fallback for `any` (mapType answers jsval first).
 *
 * Null for void (no value exists to represent). */
export function dynFallbackType(lowerer: Lowerer, node: ts.Node, t: ts.Type): IrType | null {
  if (t.flags & ts.TypeFlags.Void) return null;
  if (!isJsSourceFile(node.getSourceFile())) {
    if (t.flags & ts.TypeFlags.Any) return DYN;
    // TS single-call-signature function types: per-piece fallback, but
    // ONLY `any` pieces fall to dyn — any other unmappable piece keeps
    // the whole type's own fence.
    return anyPiecedFuncType(lowerer, node, t);
  }
  if (lowerer.checker.isArrayType(t)) {
    const elem = lowerer.checker.getTypeArguments(t as ts.TypeReference)[0];
    const elemTainted =
      elem !== undefined &&
      ((elem.flags & ts.TypeFlags.Never) !== 0 || neverTaintedJsType(lowerer, node, elem));
    const mappedElem = elem !== undefined && !elemTainted ? lowerer.mapTypeOf(elem) : null;
    // A mappable element keeps the static array; an unmappable one makes
    // the WHOLE value dyn (the checked-dynamic tree has real arrays — length/index/push
    // read through the keyed-dyn paths; dyn-element STATIC arrays have no
    // backend representation).
    if (mappedElem) return { kind: "array", elem: mappedElem };
  }
  // A PURE single-call-signature type (an implicit-any JS function —
  // `exports.check = function (certs) {...}`, common/tls's shape): keep
  // its func-ness like arrays keep array-ness, with the fallback applied
  // per PIECE — unmappable params/returns become the checked-dynamic
  // kind, so direct calls stay static calls and value uses cross the
  // boundary by boxing (canBoxFuncIntoDyn). Generics, rest params,
  // construct signatures, overloads, and function-with-properties shapes
  // stay out (the whole value falls to dyn below, where every reached
  // use meets its own fence or boxes as-is).
  const sig = pureSingleCallSignatureOf(lowerer, t);
  if (sig) {
    const params = sig.getParameters().map((p): IrType => {
      const pt = lowerer.checker.getTypeOfSymbolAtLocation(p, node);
      return lowerer.mapTypeOf(pt) ?? DYN;
    });
    const retT = lowerer.checker.getReturnTypeOfSignature(sig);
    const ret: IrType =
      retT.flags & ts.TypeFlags.Void ? VOID : lowerer.mapTypeOf(retT) ?? DYN;
    return { kind: "func", params, ret };
  }
  return DYN;
}

/** The one call signature of a PURE function type — single signature, no
 * properties, no construct signatures, no type parameters, no rest params
 * (declared or synthesized from an `arguments` read). Null for every
 * other shape. The structural gate both dynFallbackType arms share. */
function pureSingleCallSignatureOf(lowerer: Lowerer, t: ts.Type): ts.Signature | null {
  if (!(t.flags & ts.TypeFlags.Object)) return null;
  const sigs = lowerer.checker.getCallSignatures(t);
  if (
    sigs.length === 1 &&
    lowerer.checker.getPropertiesOfType(t).length === 0 &&
    lowerer.checker.getConstructSignatures(t).length === 0 &&
    sigs[0]!.getTypeParameters().length === 0 &&
    sigs[0]!.getParameters().every(
      (p) => {
        const pDecl = lowerer.checker.valueDeclarationOf(p);
        return !pDecl || !ts.isParameter(pDecl) || pDecl.dotDotDotToken === undefined;
      },
    ) &&
    // A SYNTHESIZED rest param (tsc's `arguments` inference — no
    // valueDeclaration to carry the dotDotDot): param-count mismatch
    // against the signature's declaration; the whole value stays dyn.
    (() => {
      const sigDecl = lowerer.checker.signatureDeclaration(sigs[0]!);
      const declParams = sigDecl !== undefined && ts.isFunctionLike(sigDecl) ? sigDecl.parameters : undefined;
      if (declParams !== undefined && declParams.length !== sigs[0]!.getParameters().length) return false;
      // tsgo never synthesizes the `arguments` pseudo-rest into the
      // inferred signature (5.9.3 did — the count mismatch above was the
      // whole detector there), so ask the declaration's body directly.
      return !(sigDecl !== undefined && ts.isFunctionLike(sigDecl) && bodyReadsArguments(sigDecl as { body?: ts.Node }));
    })()
  ) {
    return sigs[0]!;
  }
  return null;
}

/** The TS arm's function-shape fallback: a pure single-call-signature
 * type whose only UNMAPPABLE pieces are `any`-flavored keeps its
 * func-ness with those pieces as dyn (`(value: any) => value is string`
 * — the arrow the binding holds lowers its params through the same
 * irTypeOf fallback, so the binding type and the closure type agree).
 * A piece that fails to map for any other reason answers null — the
 * whole type keeps its own diagnostic. */
function anyPiecedFuncType(lowerer: Lowerer, node: ts.Node, t: ts.Type): IrType | null {
  const sig = pureSingleCallSignatureOf(lowerer, t);
  if (!sig) return null;
  const params: IrType[] = [];
  for (const p of sig.getParameters()) {
    const pt = lowerer.checker.getTypeOfSymbolAtLocation(p, node);
    const mapped = lowerer.mapTypeOf(pt) ?? (pt.flags & ts.TypeFlags.Any ? DYN : null);
    if (!mapped || mapped.kind === "void") return null;
    params.push(mapped);
  }
  const retT = lowerer.checker.getReturnTypeOfSignature(sig);
  const ret: IrType | null =
    retT.flags & (ts.TypeFlags.Void | ts.TypeFlags.Never) ? VOID
    : lowerer.mapTypeOf(retT) ?? (retT.flags & ts.TypeFlags.Any ? DYN : null);
  if (!ret) return null;
  return { kind: "func", params, ret };
}

/** The best-effort JS `Function.prototype.name` of an expression flowing
 * into a dyn slot (the boxed function kind's inspect/error name):
 * identifier and property reads answer the referenced NAME (a
 * REFERENCE-SITE approximation of JS's creation-site naming — an aliased
 * binding reports the alias; SEMANTICS.md), named function expressions
 * their own name, anonymous function/arrow expressions their
 * NamedEvaluation home (a variable initializer or property assignment).
 * Null when nothing names the value (the box stays anonymous). */
export function jsFuncNameOf(node: ts.Node): string | null {
  let n: ts.Node = node;
  while (ts.isParenthesizedExpression(n)) n = n.expression;
  if (ts.isIdentifier(n)) return n.text;
  if (ts.isPropertyAccessExpression(n)) return n.name.text;
  if ((ts.isFunctionExpression(n) || ts.isFunctionDeclaration(n)) && n.name) return n.name.text;
  if (ts.isFunctionExpression(n) || ts.isArrowFunction(n)) {
    const p = n.parent;
    if (p && ts.isVariableDeclaration(p) && p.initializer === n && ts.isIdentifier(p.name)) {
      return p.name.text;
    }
    if (p && ts.isPropertyAssignment(p) && p.initializer === n && ts.isIdentifier(p.name)) {
      return p.name.text;
    }
  }
  return null;
}

export class Lowerer {
  readonly statefulRegex: boolean;
  readonly nativePromiseViews: boolean;
  readonly nativeDenseArrays: boolean;
  readonly checker: ts.TypeChecker;
  readonly diags: ScrDiagnostic[] = [];
  readonly fnSigsBySymbol = new Map<ts.Symbol, FnSig>();
  readonly genericFnsBySymbol = new Map<ts.Symbol, GenericFnInfo>();
  /** Object-literal GENERIC methods (`{ m<T>(x: T) {...} }`), interned by
   * their function-like node — instances ride the same monomorphization
   * queue (objLitGenericFnInfoOf). */
  readonly objLitGenericFns = new Map<ts.Node, GenericFnInfo>();
  /** Generic arrow/function-expression INITIALIZERS of never-reassigned
   * bindings (`const f = <T>(x: T) => x`), interned by the function-like
   * node — registered in genericFnsBySymbol under the binding's symbol
   * (and a named function expression's own inner name), so calls and
   * pinned values resolve through genericFnOf exactly like top-level
   * generic function declarations (bindingGenericFnInfoOf). */
  readonly bindingGenericFns = new Map<ts.Node, GenericFnInfo>();
  /** Per-symbol result of the never-reassigned file scan
   * (bindingNeverReassigned — object-literal generic-method receivers). */
  readonly neverReassignedCache = new Map<ts.Symbol, boolean>();
  /** TRAP bindings: declarations whose initializer provably throws before
   * producing a value (its chain roots at an ambient-undefined name —
   * ambientUndefVarRootOf). Module init unwinds at the declaration, so no
   * reference to the binding can ever execute; the statement lowers to the
   * root's throw, no storage exists, and references lower to the same
   * trap shape (never reached — sound whatever the type). */
  readonly trapBindings = new Set<ts.Symbol>();
  /** NULLISH bindings of unmappable (generic-signature) types: `const i:
   * I<A & B> = null as any` — the binding provably holds null/undefined
   * forever (every write's RHS is nullish too), so no storage exists and
   * each READ knows the value. Member reads and method calls through one
   * lower to Node's exact TypeError ("Cannot read properties of null
   * (reading 'fn')"); nullish-to-nullish flows lower to nothing. The map
   * answers which unit the binding holds (the TypeError names it). Null
   * entries cache probed non-qualifiers. */
  readonly nullishBindings = new Map<ts.Symbol, "null" | "undefined" | null>();
  /** DEAD bindings of unmappable types: never READ anywhere in the
   * program, declared with no initializer or a value-only one (a function
   * literal), every write's RHS side-effect-free. Node materializes the
   * value and drops it — zero observable effect — so the declaration and
   * its writes lower to nothing, and no type fence fires for a value the
   * program never consumes. */
  readonly deadBindings = new Set<ts.Symbol>();
  /** IMPLICIT-ANY function-value bindings (npm-static JS — `const knownBy
   * = (cmd) => ...`), by their VariableDeclaration: the registered info,
   * or null for probed non-qualifiers (implicitLocalFnNodeOf). */
  readonly implicitLocalFns = new Map<ts.Node, GenericFnInfo | null>();
  /** Monomorphization worklist: instances queued by call sites, drained in
   * run() (processing an instance body can queue more). */
  readonly instantiationQueue: { info: GenericFnInfo; inst: GenericInstance }[] = [];
  /** Historical emit rank of the retained declaration/init body currently
   * lowering, and the earliest such owner that demanded each generic
   * instance. Reachability can encounter a later caller first; the minimum
   * rank recovers the old emitter's source-order monomorphization queue. */
  private genericDemandOwner: GenericDemandOwner | null = null;
  private readonly genericDemandRoots: GenericDemandOwner[] = [];
  private readonly genericFunctionDemandOwner = new Map<GenericInstance, GenericDemandOwner>();
  private readonly genericClassDemandOwner = new Map<ClassInfo, GenericDemandOwner>();
  private readonly genericDemandPriority = new Map<GenericInstance, DeclaredOrderPriorityRef>();
  private readonly genericClassDemandPriority = new Map<ClassInfo, DeclaredOrderPriorityRef>();

  private withGenericDemandOwner<T>(
    owner: GenericDemandOwner,
    fn: () => T,
  ): T {
    const previous = this.genericDemandOwner;
    this.genericDemandOwner = owner;
    try {
      return fn();
    } finally {
      this.genericDemandOwner = previous;
    }
  }

  noteGenericInstanceDemand(inst: GenericInstance): void {
    const owner = this.genericDemandOwner;
    owner?.functionDemands.push(inst);
    const ref = this.genericDemandPriority.get(inst) ?? { rank: [4, Number.MAX_SAFE_INTEGER] };
    const currentRank = owner?.priority;
    if (currentRank && (
      currentRank[0] < ref.rank[0]! ||
      (currentRank[0] === ref.rank[0] && currentRank[1] < (ref.rank[1] ?? 0))
    )) {
      ref.rank = currentRank;
    }
    this.genericDemandPriority.set(inst, ref);
  }

  noteGenericClassInstanceDemand(info: ClassInfo): void {
    const owner = this.genericDemandOwner;
    owner?.classDemands.push(info);
    const ref = this.genericClassDemandPriority.get(info) ?? { rank: [4, Number.MAX_SAFE_INTEGER] };
    const currentRank = owner?.priority;
    if (currentRank && (
      currentRank[0] < ref.rank[0]! ||
      (currentRank[0] === ref.rank[0] && currentRank[1] < (ref.rank[1] ?? 0))
    )) {
      ref.rank = currentRank;
    }
    this.genericClassDemandPriority.set(info, ref);
  }

  /** The old emitter lowered all reachable declarations in source order,
   * then every init, before draining generic instances FIFO. Reorder the
   * retained queue from those recorded demands before any generic body
   * lowers, so immediate support decisions see the same shape metadata too. */
  private restoreGenericInstanceOrder(from = 0): void {
    const tail = this.instantiationQueue.slice(from);
    const discoveryOrder = new Map(tail.map((entry, index) => [entry.inst, index] as const));
    tail.sort((left, right) => {
      const a = this.genericDemandPriority.get(left.inst)?.rank;
      const b = this.genericDemandPriority.get(right.inst)?.rank;
      if (a !== undefined && b !== undefined) {
        const phase = a[0]! - b[0]!;
        if (phase !== 0) return phase;
        const order = a[1]! - b[1]!;
        if (order !== 0) return order;
      } else if (a !== undefined) {
        return -1;
      } else if (b !== undefined) {
        return 1;
      }
      return discoveryOrder.get(left.inst)! - discoveryOrder.get(right.inst)!;
    });
    this.instantiationQueue.splice(from, tail.length, ...tail);
  }

  private restoreGenericClassInstanceOrder(from = 0): void {
    const tail = this.genericClassInstances.slice(from);
    const discoveryOrder = new Map(tail.map((info, index) => [info, index] as const));
    tail.sort((left, right) => {
      const a = this.genericClassDemandPriority.get(left)?.rank;
      const b = this.genericClassDemandPriority.get(right)?.rank;
      if (a !== undefined && b !== undefined) {
        const phase = a[0]! - b[0]!;
        if (phase !== 0) return phase;
        const order = a[1]! - b[1]!;
        if (order !== 0) return order;
      } else if (a !== undefined) {
        return -1;
      } else if (b !== undefined) {
        return 1;
      }
      return discoveryOrder.get(left)! - discoveryOrder.get(right)!;
    });
    this.genericClassInstances.splice(from, tail.length, ...tail);
  }

  private settleGenericDemandPriorities(): void {
    const functionQueue: GenericInstance[] = [];
    const classQueue: ClassInfo[] = [];
    const seenFunctions = new Set<GenericInstance>();
    const seenClasses = new Set<ClassInfo>();
    const enqueue = (owner: GenericDemandOwner): void => {
      for (const info of owner.classDemands) {
        if (seenClasses.has(info)) continue;
        seenClasses.add(info);
        classQueue.push(info);
      }
      for (const inst of owner.functionDemands) {
        if (seenFunctions.has(inst)) continue;
        seenFunctions.add(inst);
        functionQueue.push(inst);
      }
    };
    for (const root of [...this.genericDemandRoots].sort((a, b) => {
      const left = a.priority!;
      const right = b.priority!;
      return left[0] - right[0] || left[1] - right[1];
    })) enqueue(root);
    let classIndex = 0;
    let functionIndex = 0;
    let order = 0;
    while (classIndex < classQueue.length || functionIndex < functionQueue.length) {
      while (classIndex < classQueue.length) {
        const info = classQueue[classIndex++]!;
        this.genericClassDemandPriority.get(info)!.rank = [4, order++];
        const owner = this.genericClassDemandOwner.get(info);
        if (owner) enqueue(owner);
      }
      while (functionIndex < functionQueue.length) {
        const inst = functionQueue[functionIndex++]!;
        this.genericDemandPriority.get(inst)!.rank = [4, order++];
        const owner = this.genericFunctionDemandOwner.get(inst);
        if (owner) enqueue(owner);
      }
    }
    for (const info of this.genericClassInstances) {
      const ref = this.genericClassDemandPriority.get(info);
      if (ref && ref.rank[1] === Number.MAX_SAFE_INTEGER) ref.rank = [4, order++];
    }
    for (const { inst } of this.instantiationQueue) {
      const ref = this.genericDemandPriority.get(inst);
      if (ref && ref.rank[1] === Number.MAX_SAFE_INTEGER) ref.rank = [4, order++];
    }
  }
  /** Non-null while an instance body lowers: type-parameter symbol →
   * concrete IR type, consulted inside mapType's recursion. */
  typeParamBindings: Map<ts.Symbol, IrType> | null = null;
  /** The ts-level twin of typeParamBindings, non-null while a CALL-keyed
   * instance body lowers: type-parameter symbol → the bound CHECKER type,
   * consulted where the mapped IrType has already widened away information
   * the body needs — indexed accesses (`T[K]` needs K's literal key) and
   * keyed record reads (`o[k]` where k's type is a literal-bound K). */
  typeParamTsBindings: Map<ts.Symbol, ts.Type> | null = null;
  /** Non-null while an IMPLICIT-ANY instance body lowers (npm-static JS —
   * lower-calls' implicit-monomorphization section): bound param symbol →
   * the call site's checker type, consulted by typeOf for identifier
   * references the checker still types `any`. The implicit twin of
   * typeParamBindings — the checker has no `T` to substitute, so the
   * binding rides the node-type accessor instead of mapType. */
  implicitParamTypes: Map<ts.Symbol, ts.Type> | null = null;
  /** IMPLICIT-ANY instances lowered EAGERLY at first demand (their return
   * types are inferred from the body — the call site needs them settled),
   * collected here for run()'s function list (the liftedFns discipline). */
  readonly implicitFns: IrFunction[] = [];
  /** ALIASED-TYPEOF narrowing (npm-static JS — ms's `var type = typeof
   * val; if (type === 'string') ...`): while a branch such a test proves
   * lowers, the tested operand's symbol maps to the proven ARM's checker
   * type here, and typeOf answers it — the checker only narrows const
   * aliases, so this carries the var/let form the checker cannot.
   * Scoped strictly by narrowingAliases (lowerIf / lowerCondition). */
  readonly aliasNarrowTypes = new Map<ts.Symbol, ts.Type>();
  /** Locals widened beyond the checker's type because an inferred indexed
   * read can be absent at runtime. Bare reads preserve that union until a
   * surrounding JavaScript guard/default consumes it. */
  readonly runtimeOptionalLocals = new Set<IrLocal>();
  /** All storage slots widened for runtime absence, including slots whose
   * current control-flow branch has temporarily narrowed the value. */
  readonly runtimeOptionalStorageLocals = new Set<IrLocal>();
  /** Globals whose checker-bare type was widened because an indexed read can
   * carry undefined at runtime. Identifier reads keep the union tag so
   * typeof and later boundaries observe the real value. */
  readonly runtimeOptionalGlobals = new Set<IrGlobal>();
  /** Bindings whose unchecked string arithmetic can produce either a number
   * (NaN for an absent read) or a string. Preserve that result union at bare
   * reads instead of applying the checker-bare string narrowing adapter. */
  readonly runtimeOptionalArithmeticLocals = new Set<IrLocal>();
  readonly runtimeOptionalArithmeticGlobals = new Set<IrGlobal>();
  /** Binding symbols whose IR storage type was widened by the indexed-read
   * prepass. This includes explicit annotations: unchecked TS annotations do
   * not prove that an array property read produced a value. */
  readonly runtimeOptionalBindingTypes = new Map<ts.Symbol, IrType>();
  /** Concise callback/lambda returns promoted by the HOF callback prepass;
   * arrows have no declaration symbol to key in fnSigsBySymbol. */
  readonly runtimeOptionalFunctionReturns = new WeakMap<ts.Node, IrType>();
  /** Arithmetic over an unchecked string read can answer either NaN or a
   * string. Bindings and returns use this marker to retain that result union
   * through checker-bare string annotations. */
  readonly runtimeOptionalArithmeticTypes = new WeakMap<ts.Node, IrType>();
  /** Record fields promoted to an undefined-armed union by an indexed-read
   * value. The key is the concrete emitted shape and field name. */
  readonly runtimeOptionalFields = new Set<string>();
  /** Callback pattern parameters carry an optional source without making
   * every name destructured from a present source optional. */
  readonly runtimeOptionalPatternTypes = new WeakMap<ts.Node, IrType>();
  readonly runtimeOptionalReduceTypes = new WeakMap<ts.CallExpression, IrType>();
  /** Capture entries and their origin share one mutable box. Normalize each
   * entry to the origin so writes and flow proofs stay synchronized. */
  readonly runtimeOptionalRoots = new Map<IrLocal, IrLocal>();

  runtimeOptionalRootOf(local: IrLocal): IrLocal {
    return runtimeOptionalRootOf(this, local);
  }

  runtimeOptionalBindingType(node: ts.Node): IrType | null;
  runtimeOptionalBindingType(node: ts.Node, fallback: IrType): IrType;
  runtimeOptionalBindingType(node: ts.Node, fallback?: IrType): IrType | null {
    return runtimeOptionalBindingType(this, node, fallback);
  }

  runtimeOptionalIdentifierValue(node: ts.Expression): { value: IrExpr; present: IrType; unionId: string } | null {
    return runtimeOptionalIdentifierValue(this, node);
  }

  runtimeOptionalSourceValue(node: ts.Expression, value: IrExpr): IrExpr | null {
    return runtimeOptionalSourceValue(this, node, value);
  }

  runtimeOptionalPropertyReceiver(node: ts.Expression, value: IrExpr, expected: IrType, member: string): IrExpr | null {
    return runtimeOptionalPropertyReceiver(this, node, value, expected, member);
  }

  runtimeOptionalFieldKey(shapeId: string, field: string): string {
    return runtimeOptionalFieldKey(this, shapeId, field);
  }

  isRuntimeOptionalField(shapeId: string, field: string): boolean {
    return isRuntimeOptionalField(this, shapeId, field);
  }

  isRuntimeOptionalGlobal(global: IrGlobal): boolean {
    return isRuntimeOptionalGlobal(this, global);
  }

  isRuntimeOptionalArithmeticGlobal(global: IrGlobal): boolean {
    return isRuntimeOptionalArithmeticGlobal(this, global);
  }

  runtimeOptionalWidening(actual: IrType, expected: IrType): IrType | null {
    return runtimeOptionalWidening(this, actual, expected);
  }

  runtimeOptionalType(t: IrType): IrType {
    return runtimeOptionalType(this, t);
  }

  promoteRuntimeOptionalParameter(node: ts.Node, type: IrType): IrType {
    return promoteRuntimeOptionalParameter(this, node, type);
  }

  promoteRuntimeOptionalFunctionReturn(node: ts.Node, type: IrType): IrType {
    return promoteRuntimeOptionalFunctionReturn(this, node, type);
  }

  runtimeOptionalFunctionReturnType(node: ts.Node, fallback: IrType): IrType {
    return runtimeOptionalFunctionReturnType(this, node, fallback);
  }

  runtimeOptionalRecordField(type: IrType, field: string, fieldType: IrType): IrType {
    return runtimeOptionalRecordField(this, type, field, fieldType);
  }


  /** Runs `fn` with the given aliased-typeof narrows applied (and restored
   * after) — the branch-scoping primitive. */
  narrowingAliases<T>(narrows: readonly { sym: ts.Symbol; tsArm: ts.Type }[], fn: () => T): T {
    if (narrows.length === 0) return fn();
    const saved = narrows.map((n) => [n.sym, this.aliasNarrowTypes.get(n.sym)] as const);
    for (const n of narrows) this.aliasNarrowTypes.set(n.sym, n.tsArm);
    try {
      return fn();
    } finally {
      for (const [sym, old] of saved) {
        if (old === undefined) this.aliasNarrowTypes.delete(sym);
        else this.aliasNarrowTypes.set(sym, old);
      }
    }
  }
  /** Non-null while an instance body lowers: appended to every diagnostic
   * so a body error names WHICH instantiation triggered it. */
  instantiationContext: string | null = null;
  /** True while re-lowering a base function's 2nd+ instance: the same source
   * statements were already counted for the first instance. */
  suppressStats = false;
  /** Synthetic array-HOF loop functions (map/filter/forEach desugar),
   * interned per method + element/callback-result type: key → fn name. */
  readonly arrHofHelpers = new Map<string, string>();
  /** Derived shape metadata that depends on another shape's declaration
   * order. These settle before helper bodies rebuild from that metadata. */
  readonly shapeOrderMetadataFinalizers: (() => void)[] = [];
  /** Settled generic class-rest metadata requires the historical emit
   * fallback so its fence can poison the original statement atomically. */
  requiresHistoricalOrderRelower = false;
  /** Helpers that snapshot shape declaration order into their bodies.
   * Reachability lowers inits before the declarations they discover, so
   * these rebuild after the worklist restores historical shape metadata. */
  readonly shapeOrderHelperFinalizers: (() => void)[] = [];
  /** Emit-override specializations (`%C.emit:<event>` — lower-event-emitter.ts's
   * emit-overrides block): interned names, the drive-loop queue, and the
   * currently-lowering specialization's context (the super-forward
   * interception reads it). */
  readonly emitSpecDone = new Set<string>();
  readonly emitSpecQueue: EmitSpecRequest[] = [];
  emitSpecCtx: EmitSpecCtx | null = null;
  /** Width-coercion helpers (%rec.width.N / %arr.width.N), interned per
   * (from, to) shape pair — see widthCoerce. */
  readonly widthHelpers = new Map<string, string>();
  /** (fromShape, toShape) pairs whose width plan is being computed — the
   * cycle guard for RECURSIVE shapes (a self-referential record narrowing
   * into a self-referential subset). Re-entering an in-progress pair
   * answers "assume coercible" (the greatest fixed point: every OTHER
   * constraint of the cycle is still checked by the outer call, and the
   * built helper terminates because recordWidthHelper interns its name
   * before building the body, so the recursive reference resolves to the
   * helper itself). */
  readonly widthPlanning = new Set<string>();

  /** Interned node:assert helpers (deep-equality comparisons keyed by
   * typeKey, throws wrappers keyed by callback type + expected class) —
   * the widthHelpers pattern with its own namespace. */
  readonly assertHelpers = new Map<string, string>();
  /** util.inspect's per-type traversal helpers (%util.insp.N), interned
   * by typeKey — the assertHelpers pattern with its own namespace. */
  readonly inspectHelpers = new Map<string, string>();
  /** Union re-tag helpers (%union.retag.N), interned per (from, to)
   * unionId pair — see unionRetagHelper. */
  readonly retagHelpers = new Map<string, string>();
  /** Callee names of every interned coercion helper whose CALL mints a
   * FRESH closure per evaluation (%fn.width.*, %fn.adapt.*,
   * %fnval.spawnres.*). Registered at the mint site — NOT recovered by
   * name-prefix matching — because retained-FFI release identity is the
   * runtime closure pointer: a coercion adapter allocates a different
   * closure at the registration and release sites, so lowerFfiCall must
   * refuse these forms at compile time (SC5003). Any new closure-minting
   * adapter helper MUST add its name here, or the identity guard silently
   * reopens and the mismatch surfaces as a runtime release trap instead. */
  readonly freshClosureAdapters = new Set<string>();
  /** Symbols bound by `const x = promisify(execFile)` — the one lowered
   * util.promisify shape. Declarations register here and emit nothing;
   * calls through the binding lower (lowerExecFileAsyncCall) and value
   * uses fence. */
  readonly promisifiedExecFile = new Set<ts.Symbol>();
  /** Symbols bound by `const process = globalThis.process` (and the other
   * stdlib-global snapshot spellings): pure alias plumbing — receiver
   * checks resolve through this map (stdlibGlobalNameOf), declarations
   * emit nothing. */
  readonly stdlibGlobalAliases = new Map<ts.Symbol, string>();
  /** CJS export-table ACCESSORS (`module.exports = { get path() {...} }`),
   * lifted lazily as module-level functions and interned per accessor
   * declaration: member reads call the getter (lower-exprs). */
  readonly cjsAccessorFns = new Map<ts.Node, { fnName: string; type: IrType & { kind: "func" } }>();
  readonly narrowHelpers = new Map<string, string>();
  /** Exact members of narrowHelpers produced by narrowedArmHelper. This
   * lets property consumers recognize an earlier checked extraction by
   * provenance instead of relying on its generated-name prefix. */
  readonly checkedNarrowHelpers = new Set<string>();

  /** `<shapeId>:<field>` of object-literal methods lowered with the literal
   * itself as `this` (lower-object-literal's %self binding). JavaScript binds
   * a method's `this` at the CALL, so this lowering is exact only while the
   * method is invoked on its own object: reading one as a VALUE would carry
   * the defining literal into a receiver it never had, and fieldGetExpr
   * refuses that read by name. */
  readonly literalThisMethods = new Set<string>();
  /** Interned `%iter.drain.<n>` helpers (classIteratorDrainCall): one per
   * receiver class — the eager drain of a class iterable's protocol into
   * a fresh element array, behind array/call spreads. */
  readonly iterDrainHelpers = new Map<string, string>();
  /** Island-lift builder helpers (%jsin.rec.N / %jsin.arr.N /
   * %jsin.elems.N), interned per source type — see jsvalLiftExpr. */
  readonly jsinHelpers = new Map<string, string>();
  /** Synthetic Map.forEach loop functions, interned per key/value type +
   * callback arity: key → fn name (see lowerMapForEachCall). */
  readonly mapHofHelpers = new Map<string, string>();
  /** Synthetic Set.forEach loop functions, interned per element type +
   * callback arity/return — Map's pattern. */
  readonly setHofHelpers = new Map<string, string>();
  /** Synthetic URLSearchParams.forEach loop functions, interned per
   * callback arity/return — Map's pattern over the sp index walk. */
  readonly spHofHelpers = new Map<string, string>();
  /** The primitive-constructor VALUES (`String`/`Number`/`Boolean` as
   * bare identifiers — CLI option tables store and compare them): one
   * synthesized coercion function per constructor per program, interned
   * here by name so every reference is the SAME zero-capture closure and
   * `opt.type === String` is JS identity (see primitiveCtorClosure). */
  readonly primitiveCtorFns = new Map<string, string>();
  /** Optional-chain lowering state. While a chain body lowers, the guarded
   * receiver NODE reads as a chainRecv (typed by the narrowed arm) instead
   * of re-lowering, its checker type reads non-nullish (typeOf), and the
   * node carrying the ?. token is marked handled so the receiver-typed
   * lowerings stop declining it (chainBlocked). */
  readonly chainRecvByNode = new Map<ts.Node, IrExpr>();
  readonly chainNarrowedType = new Map<ts.Node, ts.Type>();
  readonly chainHandled = new Set<ts.Node>();
  /** for-of-over-matchAll bindings whose `.index` reads the companion-index
   * array: binding SYMBOL → the hidden number[] of match start indices plus
   * the hidden cursor holding THIS iteration's position (registered while
   * the loop body lowers; the property path serves `m.index` as
   * idxs[cur] — computed only at an actual read, so a drain row is never
   * touched for bodies that ignore it). */
  readonly matchAllIndexBindings = new Map<ts.Symbol, { idxsLocalId: string; curLocalId: string }>();
  /** STORED matchAll drains: `const rows = s.matchAll(re)` lowers through
   * matchAllInto with a hidden companion index array, registered here so a
   * later `for (const m of rows)` in the SAME function serves `m.index`
   * (the ctx guard keeps hidden locals out of closures — a cross-function
   * walk falls back to the plain array walk and the fence). */
  readonly matchAllDrainIndexes = new Map<ts.Symbol, { idxsLocalId: string; ctx: FnCtx }>();
  /** STORED numeric value iterators: `const it = numbers.values()` (and
   * the equivalent `[Symbol.iterator]()` spelling) over number[] or a
   * represented typed array has no first-class IR value, so its statically
   * known protocol state lives in hidden source/cursor/done locals. A
   * later for-of in the SAME function reads and advances them.
   * `doneLocalId` is sticky: once next() observes the end, later source
   * changes do not revive the exhausted iterator, exactly like Node. */
  readonly numericIterators = new Map<
    ts.Symbol,
    { sourceLocalId: string; sourceType: IrType; indexLocalId: string; doneLocalId: string; ctx: FnCtx }
  >();
  chainCounter = 0;
  /** Keyed by program-wide qualified class name (what IR object types carry). */
  readonly classes = new Map<string, ClassInfo>();
  readonly classBySymbol = new Map<ts.Symbol, ClassInfo>();
  /** The class whose members are lowering — `super` binds lexically to it
   * (arrows inside methods lower within this window, so they see it too). */
  currentClass: ClassInfo | null = null;
  readonly globalsBySymbol = new Map<ts.Symbol, IrGlobal>();
  /** Expando function members (`foo.bar = 12` on a module-level function
   * or callable const): per function symbol, each written member's module
   * global — string keys for spelled/folded names, ts.Symbols for
   * unique-symbol keys (lower-expando.ts). */
  readonly expandoMembers = new Map<ts.Symbol, Map<string | ts.Symbol, ExpandoMember>>();
  /** CJS export globals ALSO key by their declaration NODE: the checker
   * hands importers a distinct (late-bound) symbol for `module.exports`
   * property exports — different object, same declaration — so globalOf
   * falls back through the shared node (collectGlobals registers both). */
  readonly globalsByDeclNode = new Map<ts.Node, IrGlobal>();
  readonly globalsList: IrGlobal[] = [];
  /** npm-import init statements (--dynamic), keyed by file AND import
   * declaration: the island.import assignments/side-effect loads for that
   * statement. lowerFileInit splices them into the importing file's %init
   * header at the statement's position — Node evaluates each imported
   * module (island packages included) where the import appears, so an
   * `import "polyfill"` before an `import "./app.js"` runs the package
   * top-level BEFORE app's init, not after. */
  readonly npmInitActions = new Map<ts.SourceFile, Map<ts.Statement, IrStmt[]>>();
  /** Per-file %init PRELUDE statements for JSON imports: bakeable DATA
   * assignments with no observable evaluation order of their own —
   * prepended by lowerFileInit so the bindings are live before any
   * top-level statement runs. */
  readonly jsonInitActions = new Map<ts.SourceFile, IrStmt[]>();
  /** The embedded npm runtime graph (collectNpmImports), attached to the
   * emitted module. Null without npm imports or without --dynamic. */
  npmEmbedded: IrModule["embedded"] | null = null;
  npmBuiltins: NpmBuiltinUse[] | null = null;
  npmLazyTraps: NpmLazyTrap[] | null = null;
  /** Dynamic `import("literal")` resolutions, keyed
   * `fileName\u0000specifier` (collectDynamicImports fills it during npm
   * collection; lowerDynamicImportCall reads it per site). */
  readonly dynImports = new Map<string, DynamicImportResolution>();
  /** createRequire-require resolutions of BARE npm specifiers, keyed
   * `fileName\u0000specifier` (collectCreateRequires fills it during npm
   * collection under --dynamic — the require-condition entry key plus its
   * embedded format; lowerCreateRequireCall reads it per site; "" marks a
   * failed resolution already reported at collection). */
  readonly createRequireImports = new Map<string, { entryKey: string; format: "esm" | "cjs" | "json" } | "">();
  /** Module → the name of its synthesized namespace-BUILDER function
   * (lowerOwnModuleImport): every `import()` of the same program module
   * shares one builder. */
  readonly nativeImportSources = new WeakMap<IrExpr, ts.Expression>();
  readonly nativeExportFunctions = new Map<string, { valueId: string; readyId: string }>();
  readonly nativeImportTargets = new Set<ts.SourceFile>();
  readonly dynNsBuilders = new Map<ts.SourceFile, string>();
  /** Parameters forced to the island-handle type (jsval) regardless of
   * their checker type: then-handler params whose settled value is an
   * engine handle (a dynamic import's namespace object) — paramShape's
   * early-out. */
  readonly jsvalParamOverrides = new Set<ts.ParameterDeclaration>();
  /** File → qualifier prefix: "" for the entry, "%mI." otherwise. */
  readonly fileTag = new Map<ts.SourceFile, string>();
  /** Namespace ModuleBlocks this program lowers, filled by splitFiles:
   * "flattened" — an instantiated namespace whose body joined the file's
   * parts (members resolve statically); "typeOnly" — a skipped
   * non-instantiated one (its only value members are import= aliases,
   * still resolved statically). Ambient blocks never register — their
   * members keep the ReferenceError/fence paths (lower-namespaces.ts). */
  readonly nsBlocks = new Map<ts.Node, "flattened" | "typeOnly">();
  /** File → its %init function name, filled by prepareModuleInits before
   * any body lowers: import headers and inline require statements call
   * dependency inits by these names. */
  readonly initNameOf = new Map<ts.SourceFile, string>();
  /** File → the id of its run-once guard global (a bool module global,
   * false at program start). Every non-entry module gets one: its %init
   * may be called from several importers/requirers, and the guard is what
   * makes each call after the first a Node-style cache hit. The entry has
   * none — %main calls it exactly once (a dependency edge back to the
   * entry would be a fenced cycle). */
  readonly moduleGuardOf = new Map<ts.SourceFile, string>();
  /** Files whose module evaluation is asynchronous: direct top-level
   * await/for-await modules plus their static ESM importers. Their %init
   * bodies run on fibers and every async dependency edge awaits the
   * dependency promise before the importer body starts. Synchronous files
   * stay synchronous — adding even an already-settled await would insert
   * an observable microtask hop. */
  readonly asyncInitFiles = new Set<ts.SourceFile>();
  /** Async module → its cached evaluation-promise global. The emitted
   * spawn wrapper fills this on first evaluation and returns a retained
   * reference on cache hits, matching Node's one ModuleJob promise per
   * module even across diamonds and concurrent dynamic imports. */
  readonly modulePromiseOf = new Map<ts.SourceFile, string>();
  /** Synchronous ESM evaluation records retain the original thrown value. */
  readonly syncModulePromiseOf = new Map<ts.SourceFile, string>();
  /** Async import-cycle member → the cycle's deterministic graph
   * representative. Used to recognize internal SCC edges; this is NOT
   * necessarily the runtime evaluation root, because a dynamically-only
   * cycle can first be entered through any member. */
  readonly asyncCycleRepresentativeOf = new Map<ts.SourceFile, ts.SourceFile>();
  /** Async import-cycle member → the shared completion-promise global for
   * its SCC. Every member's spawn wrapper temporarily publishes its own
   * promise while eager recursive evaluation unwinds; the outermost
   * wrapper (the member actually requested first at runtime) writes last
   * and therefore becomes the cycle's evaluation root. Dynamic imports
   * wait on this shared verdict rather than a build-time-selected member. */
  readonly asyncCyclePromiseOf = new Map<ts.SourceFile, string>();
  /** Record-shape interner: canonical (name-sorted) field list → shapeId.
   * Threaded into every mapType call; its `shapes` array becomes
   * IrModule.records. */
  readonly shapes = new ShapeRegistry();
  /** Union interner: canonical (typeKey-sorted) arm list → unionId.
   * Threaded into every mapType call; its `unions` array becomes
   * IrModule.unions. An arm's index in the canonical list is its runtime
   * tag. */
  readonly unions = new UnionRegistry();
  /** Context-free successful type mappings. See TypeMapperCtx.typeMemo. */
  readonly typeMemo = new Map<string, IrType>();
  readonly ambient = ambientDtsPath();
  readonly overridesAmbient = overridesDtsPath();
  readonly fallbackAmbient = fallbackDtsPath();
  /** The one mapType context: registries + hooks, assembled in the
   * constructor (typeParamResolver reads the CURRENT instantiation bindings
   * through `this`, so the same ctx serves generic bodies too). */
  readonly typeCtx: TypeMapperCtx;

  readonly stats: LowerStats = {
    statementsTotal: 0,
    statementsFailed: 0,
    statementsIsland: 0,
    functionsSkipped: 0,
  };

  /** Reachability edge sink: every resolution of
   * a reference to a lowerable body reports its name here — recorded even
   * when the enclosing statement later poisons. */
  onEdge: ((name: string) => void) | null = null;

  /** The lexical environment: the function-context stack and identifier/`this` resolution (scope-env.ts). Its hooks
   * reach back into statement lowering (JS hoisting) and the runtime-optional analysis (capture roots). */
  readonly env = new ScopeEnv({
    predeclare: (symbol) =>
      predeclareForwardCapture(this, symbol) || predeclareForwardFnDecl(this, symbol) || predeclareForwardVar(this, symbol),
    captureThreaded: (parent, entry) => {
      const root = this.runtimeOptionalRootOf(parent);
      if (this.runtimeOptionalStorageLocals.has(root)) this.runtimeOptionalRoots.set(entry, root);
    },
    refuse: (symbol, blame, message) =>
      this.unsupported("SC1090", blame ?? this.checker.declarationsOf(symbol)[0] ?? this.entry, message),
  });

  /** The open function contexts, outermost first. Read-only: functions open through `env.inFunction`. */
  get fnStack(): readonly FnCtx[] {
    return this.env.frames;
  }
  readonly liftedFns: IrFunction[] = [];
  lambdaCounter = 0;

  /** Statement lists currently mid-lowering, innermost last: the forward-
   * capture machinery (predeclareForwardCapture) needs to know which later
   * statements of an OPEN list a symbol's declaration sits in, which scope
   * frame list-level declarations register into, and where to insert the
   * scope-entry TDZ varDecl (before the statement being lowered). */
  readonly activeStmtLists: {
    stmts: readonly ts.Statement[];
    index: number;
    ctx: FnCtx;
    frame: Map<ts.Symbol, IrLocal>;
    out: IrStmt[];
  }[] = [];
  /** Forward-captured consts pre-declared as TDZ boxes, keyed by symbol:
   * lowerVarDecl consumes the entry when the source declaration arrives and
   * emits the initializing `assign` instead of a fresh declaration. */
  readonly tdzPredeclared = new Map<ts.Symbol, IrLocal>();
  /** Nested function DECLARATIONS lowered eagerly by the forward-hoisting
   * machinery (predeclareForwardFnDecl — a reference above the declaration
   * in the same function, JS's function hoisting): the statement loop skips
   * the source statement when it arrives. */
  readonly hoistedFnDecls = new Set<ts.FunctionDeclaration>();
  /** `var` bindings hoisted to their function root (hoistVarBinding), keyed
   * by the checker's merged symbol — every same-name `var` in one function
   * is one symbol, so one slot. Module-scope vars live in globalsBySymbol
   * instead. */
  readonly hoistedVars = new Map<ts.Symbol, IrLocal>();
  /** Per-file `var` module globals whose type carries an undefined arm:
   * lowerFileInit assigns them the interned undefined right after the
   * run-once guard — JS hoists module vars to `undefined` at entry, so a
   * function called above the declaration statement reads that, never a
   * NULL slot. Filled by collectGlobals. */
  readonly varGlobalEntryInits = new Map<ts.SourceFile, IrGlobal[]>();

  get ctx(): FnCtx {
    return this.env.current;
  }

  /** The current function's block scopes, outermost first. Read-only: scopes open through `env.inScope`. */
  get scopes(): readonly Map<ts.Symbol, IrLocal>[] {
    return this.env.current.scopes;
  }

  /** Names of bodies a prior reachability pass reached; null lowers everything. */
  readonly reachable: ReadonlySet<string> | null;
  /** Reachability computed by this same Lowerer when retained worklist IR
   * is assembled directly. The configured reachable set remains null so
   * demand-driven instance lowering keeps its existing gates. */
  reachableForArtifacts: ReadonlySet<string> | null = null;
  /** Coverage remainder mode: the reachability gate inverts (see wantBody)
   * and no module is built. */
  readonly remainder: boolean;
  /** Deferred collection diagnostics (failed signatures/class shapes) by
   * declaration symbol: an unreached declaration must not fail the build,
   * so its diagnostics wait until a reference makes them relevant. */
  readonly deferredDiags = new Map<ts.Symbol, ScrDiagnostic[]>();
  /** Deferred classes by qualified IR name — for flush sites that only
   * know the class name (typed receivers, module class retention). */
  readonly deferredClassByName = new Map<string, ts.Symbol>();
  /** Symbols whose deferred diagnostics THIS pass flushed (handed to the
   * coverage remainder as alreadyFlushed). */
  readonly flushedSymbols = new Set<ts.Symbol>();
  readonly alreadyFlushed: ReadonlySet<ts.Symbol>;
  /** The build's target platform ("win32" | "darwin" | "linux" | ...):
   * selects the platform-keyed builtin surfaces (builtinModuleFnsOf /
   * builtinModuleConstOf in surfaces.ts). */
  readonly targetPlatform: string;
  /** LowererMode.startupCrash — buildMain opens %main with the throw. */
  readonly startupCrash: StartupCrash | null;
  /** Outbound native bindings by their source-level ambient name. */
  readonly ffiImports: readonly IrFfiImport[];
  readonly libraryCallbacks: boolean;
  readonly ffiImportsByName: ReadonlyMap<string, IrFfiImport>;
  /** Non-null after whole-program FFI declaration validation. */
  readonly ffiBindingSymbols: ReadonlyMap<string, ReadonlySet<ts.Symbol>> | null;
  /** Exact specifier mappings and their reverse declaration-file lookup. */
  readonly externalTypes: ReadonlyMap<string, string>;
  readonly externalTypeSpecifiersByFile: ReadonlyMap<string, readonly string[]>;
  /** Symbols a POISONED declaration statement would have bound: the
   * declaration's own diagnostic is already recorded, and no local/global
   * registered, so later references fall through every resolution step —
   * the fallthroughs report the inherited-blocker cascade (SC2004)
   * instead of misattributing the reference. */
  readonly blockedBindings = new Set<ts.Symbol>();
  /** True while collectProgram runs: resolution helpers must not flush
   * deferred diagnostics (collection itself resolves symbols — extends
   * clauses — and collection order must not decide what reports). */
  collecting = false;
  /** Non-null redirects pushDiag into a capture buffer (the deferred
   * collection wrapper). */
  diagSink: ScrDiagnostic[] | null = null;
  /** Diagnostics converted into runtimeFence statements (JS sources —
   * see lowerStmts): off the build, preserved here so coverage reporting
   * can still name every deferred fence. */
  readonly runtimeFences: ScrDiagnostic[] = [];
  /** --provenance-sources: diagnostics of ELIDED pure-annotated dead
   * consts in fetched source modules (lowerStmts's elision rule) — off
   * the build entirely (the statement lowers to its poisoned bindings and
   * nothing throws), preserved for the coverage report's provenance
   * section. */
  readonly provenanceElided: ScrDiagnostic[] = [];
  /** --provenance-sources: per-file statement attribution (mirrors the
   * stats counters, keyed by fileName) so the coverage report can answer
   * "did the PACKAGE's statements compile static?" per provenance
   * package. Only populated while the registry is active; the remainder
   * pass skips it (attribution describes the build). */
  readonly statsByFile = new Map<string, { total: number; failed: number; island: number }>();

  /** Bumps the per-file attribution counter (no-op unless provenance is
   * active and this is the emit/discovery lane — mirror the CALLER's
   * suppressStats guard, this method only gates remainder). */
  bumpFileStat(file: string, kind: "total" | "failed" | "island"): void {
    if (this.remainder || !provenanceActive()) return;
    let s = this.statsByFile.get(file);
    if (!s) this.statsByFile.set(file, (s = { total: 0, failed: 0, island: 0 }));
    s[kind]++;
  }

  constructor(
    readonly program: ts.Program,
    readonly entry: ts.SourceFile,
    readonly moduleOrder: ts.SourceFile[],
    readonly dynamic: boolean,
    mode: LowererMode = {},
  ) {
    this.statefulRegex = mode.statefulRegex ?? false;
    this.nativePromiseViews = mode.nativePromiseViews ?? false;
    this.nativeDenseArrays = mode.nativeDenseArrays ?? false;
    this.reachable = mode.reachable ?? null;
    this.remainder = mode.remainder ?? false;
    this.alreadyFlushed = mode.alreadyFlushed ?? new Set();
    this.targetPlatform = mode.targetPlatform ?? process.platform;
    this.startupCrash = mode.startupCrash ?? null;
    this.ffiImports = mode.ffiImports ?? [];
    this.libraryCallbacks = mode.libraryCallbacks ?? false;
    this.ffiImportsByName = new Map(this.ffiImports.map((entry) => [entry.name, entry]));
    this.ffiBindingSymbols = mode.ffiBindingSymbols ?? null;
    this.externalTypes = mode.externalTypes ?? new Map();
    this.externalTypeSpecifiersByFile = mode.externalTypeSpecifiersByFile ??
      directExternalTypeSpecifiersByFile(this.externalTypes);
    this.checker = program.getTypeChecker();
    this.typeCtx = {
      checker: this.checker,
      shapes: this.shapes,
      unions: this.unions,
      classNamer: this.classNamer,
      resolveTypeParam: this.typeParamResolver, noteFamily: (id) => noteFamily(this, id),
      resolveTypeParamTs: this.typeParamTsResolver,
      genericClassInstance: (decl, ref) => this.genericClassInstanceType(decl, ref),
      mixinClassInstance: (decl) =>
        this.mixinTypeContext && this.mixinTypeContext.classNode === decl
          ? { kind: "object", className: this.mixinTypeContext.className }
          : null,
      mixinIntersectionInstance: (widened) => mixinIntersectionInstanceType(this, widened),
      isStdlibFile: this.isStdlibFile,
      isNpmFile: this.isNpmFile,
      isExternalTypeFile: (sf) =>
        this.externalTypeSpecifiersByFile.has(tsgoPath(resolve(sf.fileName))),
      dynamic: this.dynamic,
      typeMemo: this.typeMemo,
      canMemoizeType: () =>
        this.typeParamBindings === null &&
        this.typeParamTsBindings === null &&
        this.mixinTypeContext === null,
      // fileTag is filled just below; the hook is only ever CALLED during
      // lowering, long after the constructor completes.
      isProgramFile: (sf) => this.fileTag.has(sf),
      isIslandModuleFile: (sf) => isIslandModulePath(sf.fileName),
    };
    // --dynamic: modules reachable only through dynamic import() joined
    // moduleOrder BEFORE any pass constructed — lowerToIr runs
    // appendDynamicImportModules once on the shared array (a per-pass run
    // here would repeatedly extend the graph and duplicate cycle reports).
    this.moduleOrder.forEach((sf, i) => {
      // Island modules (--island-module) are not program files: they embed
      // as engine source and their declarations map to handles.
      if (sf !== entry && isIslandModulePath(sf.fileName)) return;
      this.fileTag.set(sf, sf === entry ? "" : `%m${i}.`);
    });
    if (this.moduleOrder.length === 0) this.fileTag.set(entry, "");
    this.registerBuiltinErrorClasses();
    registerBuiltinEmitterClass(this);
    registerBuiltinStreamClasses(this);
  }

  registerBuiltinErrorClasses(): void {
    return registerBuiltinErrorClasses(this);
  }

  builtinErrorInfoOf(symbol: ts.Symbol | null | undefined): ClassInfo | null {
    return builtinErrorInfoOf(this, symbol);
  }

  builtinEmitterInfoOf(symbol: ts.Symbol | null | undefined): ClassInfo | null {
    return builtinEmitterInfoOf(this, symbol);
  }

  builtinStreamInfoOf(symbol: ts.Symbol | null | undefined): ClassInfo | null {
    return builtinStreamInfoOf(this, symbol);
  }

  /** Program-wide qualified name for a top-level declaration. */
  qualify(sf: ts.SourceFile, name: string): string {
    return `${this.fileTag.get(sf) ?? ""}${name}`;
  }

  /** Whether whole-program validation assigned this exact source symbol to
   * the named manifest binding. Same-named local functions remain ordinary
   * TypeScript declarations and never become native calls. */
  ownsValidatedFfiSymbol(name: string, symbol: ts.Symbol): boolean {
    return (
      this.ffiImportsByName.has(name) &&
      this.ffiBindingSymbols?.get(name)?.has(symbol) === true
    );
  }

  /** The IR name mapType gives class instance types — must agree with
   * collectClassShape's registration. Namespace-nested classes carry the
   * namespace path (nsPathPrefix), so `namespace A { export class C }`
   * and a top-level `class C` never collide. Class EXPRESSIONS name by
   * SOURCE POSITION (`%cx<start>.<name>`): deterministic across the
   * builds (no counter can drift between invocations),
   * program-unique through the file qualifier, and collision-free with
   * user identifiers ('%'). */
  readonly classNamer = (decl: ts.ClassLikeDeclaration): string =>
    ts.isClassExpression(decl)
      ? this.qualify(decl.getSourceFile(), `%cx${decl.getStart()}.${decl.name?.text ?? ""}`)
      : this.qualify(decl.getSourceFile(), nsPathPrefix(decl) + (decl.name ? decl.name.text : "%anon"));

  /** Follows import aliases to the original declaration's symbol. Every
   * value reference resolves through here, so it doubles as the flush
   * point for deferred collection diagnostics: resolving a reference to a
   * broken declaration reports what collection deferred. */
  resolveValueSymbol(ident: ts.Identifier): ts.Symbol | null {
    let symbol = this.checker.getSymbolAtLocation(ident);
    // A shorthand property's NAME resolves to the property symbol; the
    // VALUE binding it reads is the checker's shorthand-value symbol
    // (the option-object parsers lower `{ cwd }` through the identifier).
    if (ident.parent && ts.isShorthandPropertyAssignment(ident.parent) && ident.parent.name === ident) {
      symbol = this.checker.getShorthandAssignmentValueSymbol(ident.parent) ?? symbol;
    }
    // tsgo synthesizes no expando symbol at a CJS MEMBER-EXPORT use site
    // (`common.GREETING` where the exporter attached GREETING with
    // `module.exports.GREETING = ...` — 5.9.3 answered the expando
    // property symbol here), but the exporter's MODULE symbol still
    // carries the member in its exports table; resolve through it so both
    // ends of the export key one symbol identity, like 5.9.3's.
    if (!symbol && ident.parent && ts.isPropertyAccessExpression(ident.parent) && ident.parent.name === ident) {
      const recv = ident.parent.expression;
      if (ts.isIdentifier(recv) && this.cjsLocalModuleBindingOf(recv)) {
        const recvSym = this.checker.getSymbolAtLocation(recv);
        const recvDecls = recvSym ? this.checker.declarationsOf(recvSym) : [];
        const recvDecl = recvDecls.find(ts.isImportClause) ?? recvDecls[0];
        if (recvDecl && ts.isVariableDeclaration(recvDecl) && recvDecl.initializer) {
          const spec = requireSpecOf(recvDecl.initializer);
          const dep = spec === null
            ? null
            : resolveImport(this.program, recvDecl.getSourceFile(), spec) ??
              npmStaticDepSf7(this.program, recvDecl.getSourceFile(), spec);
          if (dep) symbol = this.cjsModuleExportSymbol(dep, ident.text);
        } else if (recvDecl && ts.isImportClause(recvDecl)) {
          // The DEFAULT-import spelling of the same binding: the dep is
          // the import declaration's resolved CJS module.
          const dep = this.cjsDefaultImportDepOf(recvDecl);
          if (dep) symbol = this.cjsModuleExportSymbol(dep, ident.text);
        }
      }
    }
    if (!symbol) return null;
    // Bare references across MERGED-namespace blocks fence here (Node's
    // transform throws ReferenceError where tsc's emit would qualify —
    // lower-namespaces.ts); a no-op for programs without namespaces.
    fenceCrossBlockNsRef(this, ident, symbol);
    if (symbol.flags & ts.SymbolFlags.Alias) {
      // SNAPSHOT aliases own storage keyed by the PRE-alias symbol
      // (`import x = N.y` of a mutable target — collectGlobals): the
      // reference reads the snapshot, never the live target, exactly like
      // Node's emitted `var x = N.y`. Only those aliases register this
      // way; every other alias resolves through to its declaration.
      if (this.globalsBySymbol.has(symbol)) {
        this.flushDeferred(symbol);
        return symbol;
      }
      // DEFAULT-SNAPSHOT storage lives on the EXPORTER'S default alias
      // symbol (`export default someLet` — collectGlobals registers the
      // Node-semantics snapshot there). getAliasedSymbol would resolve
      // PAST it to the live let; walk the default-import hops and stop at
      // the first default symbol carrying storage instead.
      const snap = this.defaultSnapshotSymbolOf(symbol);
      if (snap) {
        this.flushDeferred(snap);
        return snap;
      }
      symbol = this.checker.getAliasedSymbol(symbol);
    }
    // CommonJS export plumbing: a binding that resolved to a PROPERTY of a
    // top-level `module.exports = { ... }` literal (shorthand, or a plain
    // identifier value — renames included) re-resolves to the local
    // declaration the property references. The export table is then pure
    // alias plumbing, exactly like an ESM export list: importers land on
    // the original function/const/class symbols and every existing
    // registry (globals, fn signatures, classes) applies unchanged.
    const cjsValue = this.cjsExportValueSymbol(symbol);
    if (cjsValue) symbol = cjsValue;
    this.flushDeferred(symbol);
    return symbol;
  }

  /** The configured external host module owning an expression's runtime
   * value, or null. Alias chains are followed to their declaration file so
   * direct imports and local re-export facades classify identically. Type
   * references never call this helper and remain ordinary checker input. */
  externalTypeSpecifierOf(expr: ts.Expression): string | null {
    if (this.externalTypes.size === 0) return null;

    let value: ts.Expression = expr;
    while (
      ts.isParenthesizedExpression(value) ||
      ts.isAsExpression(value) ||
      ts.isTypeAssertion(value) ||
      ts.isNonNullExpression(value)
    ) {
      value = value.expression;
    }
    if (ts.isCallExpression(value)) {
      if (value.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const spec = value.arguments[0];
        return spec !== undefined && ts.isStringLiteralLike(spec) && this.externalTypes.has(spec.text)
          ? spec.text
          : null;
      }
      if (
        ts.isIdentifier(value.expression) &&
        value.expression.text === "require" &&
        value.arguments.length === 1
      ) {
        const spec = value.arguments[0]!;
        if (ts.isStringLiteralLike(spec) && this.externalTypes.has(spec.text)) return spec.text;
      }
      return this.externalTypeSpecifierOf(value.expression);
    }
    if (ts.isNewExpression(value)) return this.externalTypeSpecifierOf(value.expression);
    if (ts.isTaggedTemplateExpression(value)) {
      return this.externalTypeSpecifierOf(value.tag);
    }
    if (ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value)) {
      // Follow the runtime RECEIVER, not the property's declaration: a
      // project-owned record may use an interface declared by the mapped
      // file and remains ordinary static data (`const x: HostType = ...;
      // x.field`). Only a value rooted in the imported module is external.
      const receiver = this.externalTypeSpecifierOf(value.expression);
      if (receiver !== null) return receiver;
      const member = ts.isPropertyAccessExpression(value)
        ? value.name.text
        : value.argumentExpression !== undefined && ts.isStringLiteralLike(value.argumentExpression)
          ? value.argumentExpression.text
          : null;
      return member !== null
        ? this.externalTypeSpecifierOfNamespaceMember(value.expression, member)
        : null;
    }
    if (!ts.isIdentifier(value)) return null;
    return this.externalTypeSpecifierOfSymbol(this.checker.getSymbolAtLocation(value));
  }

  /** The source file a checker-resolved module-specifier node names. The
   * checker path is preferred; resolveImport is the canonical fallback for
   * every project-module spelling. */
  private moduleSourceFileOf(from: ts.SourceFile, spec: ts.StringLiteral): ts.SourceFile | null {
    const moduleSymbol = this.checker.getSymbolAtLocation(spec);
    for (const decl of moduleSymbol ? this.checker.declarationsOf(moduleSymbol) : []) {
      if (ts.isSourceFile(decl)) return decl;
    }
    return resolveImport(this.program, from, spec.text);
  }

  /** Follow one project-module export through the checker's resolved export
   * table, then recover its exact external route where alias declarations
   * retain one. */
  private externalTypeSpecifierOfModuleExport(
    sf: ts.SourceFile,
    exportName: string,
    seenSymbols: Set<ts.Symbol>,
    seenExports: Set<string>,
  ): string | null {
    const exportKey = `${tsgoPath(resolve(sf.fileName))}\0${exportName}`;
    if (seenExports.has(exportKey)) return null;
    seenExports.add(exportKey);
    // Ask the checker which symbol the module ACTUALLY exports under this
    // name. Syntax-only `export *` scanning cannot answer shadowing: a local
    // or explicit export wins over a same-named star export, and a star
    // contributes only names its target really exports. The resolved symbol
    // retains route-aware ExportSpecifier/NamespaceExport declarations for
    // exact mappings, while star exports resolve to the mapped declaration
    // owner through externalTypeSpecifiersByFile.
    const moduleSymbol = this.checker.getSymbolAtLocation(sf);
    const exported = moduleSymbol?.getExports().get(exportName as ts.__String);
    return this.externalTypeSpecifierOfSymbol(exported, seenSymbols, seenExports);
  }

  private externalTypeSpecifierOfNamespaceMember(expr: ts.Expression, member: string): string | null {
    let value = expr;
    while (
      ts.isParenthesizedExpression(value) ||
      ts.isAsExpression(value) ||
      ts.isTypeAssertion(value) ||
      ts.isNonNullExpression(value)
    ) {
      value = value.expression;
    }
    if (!ts.isIdentifier(value)) return null;
    const symbol = this.checker.getSymbolAtLocation(value);
    const namespaceDecl = symbol
      ? this.checker.declarationsOf(symbol).find(ts.isNamespaceImport)
      : undefined;
    if (namespaceDecl === undefined) return null;
    const importDecl = namespaceDecl.parent.parent;
    if (!ts.isImportDeclaration(importDecl) || !ts.isStringLiteral(importDecl.moduleSpecifier)) return null;
    if (this.externalTypes.has(importDecl.moduleSpecifier.text)) return importDecl.moduleSpecifier.text;
    const dep = this.moduleSourceFileOf(importDecl.getSourceFile(), importDecl.moduleSpecifier);
    return dep !== null && !dep.isDeclarationFile
      ? this.externalTypeSpecifierOfModuleExport(dep, member, new Set(), new Set())
      : null;
  }

  private externalTypeSpecifierOfSymbol(
    symbol: ts.Symbol | undefined,
    seenSymbols: Set<ts.Symbol> = new Set(),
    seenExports: Set<string> = new Set(),
  ): string | null {
    if (symbol === undefined || seenSymbols.has(symbol)) return null;
    seenSymbols.add(symbol);
    const declarations = this.checker.declarationsOf(symbol);

    // Route-aware alias hops run before declaration-file ownership. An
    // exact import must keep the specifier it actually named, rather than
    // inheriting whichever alias happened to register the shared file last.
    for (const decl of declarations) {
      let specNode: ts.Expression | undefined;
      let importedName: string | null = null;
      if (ts.isImportSpecifier(decl)) {
        const importDecl: ts.Node = decl.parent.parent.parent;
        if (ts.isImportDeclaration(importDecl)) specNode = importDecl.moduleSpecifier;
        importedName = (decl.propertyName ?? decl.name).text;
      } else if (ts.isImportClause(decl)) {
        if (ts.isImportDeclaration(decl.parent)) specNode = decl.parent.moduleSpecifier;
        importedName = "default";
      } else if (ts.isNamespaceImport(decl)) {
        const importDecl: ts.Node = decl.parent.parent;
        if (ts.isImportDeclaration(importDecl)) specNode = importDecl.moduleSpecifier;
        importedName = null;
      } else if (ts.isExportSpecifier(decl)) {
        const exportDecl: ts.Node = decl.parent.parent;
        if (ts.isExportDeclaration(exportDecl)) specNode = exportDecl.moduleSpecifier;
        importedName = (decl.propertyName ?? decl.name).text;
      } else if (ts.isNamespaceExport(decl)) {
        const exportDecl: ts.Node = decl.parent;
        if (ts.isExportDeclaration(exportDecl)) specNode = exportDecl.moduleSpecifier;
        importedName = "*";
      } else {
        continue;
      }
      if (specNode === undefined || !ts.isStringLiteral(specNode)) continue;
      if (this.externalTypes.has(specNode.text)) return specNode.text;
      // A namespace OBJECT from a project module is not wholly external;
      // property accesses resolve their selected member separately above.
      if (importedName === null) return null;
      const dep = this.moduleSourceFileOf(decl.getSourceFile(), specNode);
      return dep !== null && !dep.isDeclarationFile
        ? this.externalTypeSpecifierOfModuleExport(dep, importedName, seenSymbols, seenExports)
        : null;
    }

    for (const decl of declarations) {
      const owners = this.externalTypeSpecifiersByFile.get(
        tsgoPath(resolve(decl.getSourceFile().fileName)),
      );
      if (owners !== undefined && owners.length > 0) return owners[0]!;
    }
    if ((symbol.flags & ts.SymbolFlags.Alias) === 0) return null;
    return this.externalTypeSpecifierOfSymbol(
      this.checker.getAliasedSymbol(symbol),
      seenSymbols,
      seenExports,
    );
  }

  /** The default-snapshot storage symbol a DEFAULT-import alias chain
   * lands on, or null. A mutable entity-name default (`export default
   * someLet`) registers its Node-semantics snapshot global under the
   * exporter's default ALIAS symbol; the checker's getAliasedSymbol
   * resolves through that symbol to the live let, so this walk follows
   * the default hops syntactically — default import clauses, `{ default
   * as x }` specifiers, `export { default } from` re-exports — and stops
   * at the first default symbol carrying registered storage. Local
   * `export { x as default }` specifiers (no module specifier) are LIVE
   * bindings in Node and fall through to ordinary alias resolution. */
  defaultSnapshotSymbolOf(alias: ts.Symbol): ts.Symbol | null {
    let sym: ts.Symbol | undefined = alias;
    for (let hop = 0; sym !== undefined && hop < 32; hop++) {
      if (hop > 0 && sym.flags & ts.SymbolFlags.Alias && this.globalsBySymbol.has(sym)) return sym;
      const d = this.checker
        .declarationsOf(sym)
        .find((x) => ts.isImportClause(x) || ts.isImportSpecifier(x) || ts.isExportSpecifier(x));
      let spec: ts.Expression | undefined;
      let name: string | undefined;
      if (d && ts.isImportClause(d) && ts.isImportDeclaration(d.parent)) {
        spec = d.parent.moduleSpecifier;
        name = "default";
      } else if (d && ts.isImportSpecifier(d)) {
        const idecl: ts.Node = d.parent.parent.parent;
        if (ts.isImportDeclaration(idecl)) spec = idecl.moduleSpecifier;
        name = (d.propertyName ?? d.name).text;
      } else if (d && ts.isExportSpecifier(d)) {
        const edecl: ts.Node = d.parent.parent;
        if (ts.isExportDeclaration(edecl)) spec = edecl.moduleSpecifier;
        name = (d.propertyName ?? d.name).text;
      }
      if (d === undefined || spec === undefined || !ts.isStringLiteral(spec) || name !== "default") return null;
      const dep = resolveImport(this.program, d.getSourceFile(), spec.text);
      if (!dep) return null;
      sym = defaultExportSymbolOf(this, dep) ?? undefined;
    }
    return null;
  }

  /** A module's CJS export-table member symbol by NAME (the checker's
   * module-symbol exports map — present in tsgo even where no expando
   * property symbol exists at the attachment/use sites). */
  cjsModuleExportSymbol(sf: ts.SourceFile, name: string): ts.Symbol | undefined {
    const moduleSym = this.checker.getSymbolAtLocation(sf);
    return moduleSym?.getExports().get(name as ts.__String);
  }

  /** The local VALUE symbol behind a CJS export-table property symbol —
   * see resolveValueSymbol. Null when `symbol` is not such a property (or
   * the property's value is not a plain identifier reference). */
  private cjsExportValueSymbol(symbol: ts.Symbol): ts.Symbol | null {
    const d = this.checker.declarationsOf(symbol)[0];
    if (!d) return null;
    // MEMBER-form class exports (`exports.C = C` — commander's error.js):
    // alias plumbing exactly like a table entry, so importers land on the
    // class declaration and the class registry applies unchanged (a class
    // VALUE global would fence — builtin-derived classes have no
    // first-class value form). Only CLASS targets re-resolve this way;
    // every other member export keeps its snapshot storage semantics.
    const memberClass = this.cjsMemberExportClassSymbol(d);
    if (memberClass) return memberClass;
    const isShorthand = ts.isShorthandPropertyAssignment(d);
    const isIdentProp = ts.isPropertyAssignment(d) && ts.isIdentifier(d.initializer);
    if (!isShorthand && !isIdentProp) return null;
    if (!ts.isObjectLiteralExpression(d.parent) || !isCjsExportTableLiteral(d.parent)) return null;
    let value = isShorthand
      ? this.checker.getShorthandAssignmentValueSymbol(d)
      : this.checker.getSymbolAtLocation((d as ts.PropertyAssignment).initializer as ts.Identifier);
    if (!value) return null;
    if (value.flags & ts.SymbolFlags.Alias) value = this.checker.getAliasedSymbol(value);
    return value;
  }

  /** The CLASS symbol a member-form CJS export declaration forwards to:
   * `d` (an export property symbol's declaration) sits in a top-level
   * `exports.C = <ident>` / `module.exports.C = <ident>` statement of a
   * JS module, the statement is not discarded by a later table, and the
   * identifier resolves to a class declaration. Null otherwise. */
  cjsMemberExportClassSymbol(d: ts.Node): ts.Symbol | null {
    const assign = ts.isBinaryExpression(d)
      ? d
      : ts.isPropertyAccessExpression(d) && d.parent !== undefined && ts.isBinaryExpression(d.parent)
        ? d.parent
        : null;
    if (!assign || assign.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return null;
    if (!ts.isIdentifier(assign.right)) return null;
    const stmt = assign.parent;
    if (!stmt || !ts.isExpressionStatement(stmt) || !ts.isSourceFile(stmt.parent)) return null;
    if (!isJsSourceFile(stmt.parent)) return null;
    const cjs = cjsExportAssignmentOf(stmt);
    if (cjs?.kind !== "member" || cjs.expr !== assign) return null;
    if (cjsExportDiscardReason(stmt) !== null) return null;
    let value = this.checker.getSymbolAtLocation(assign.right);
    if (!value) return null;
    if (value.flags & ts.SymbolFlags.Alias) value = this.checker.getAliasedSymbol(value);
    const isClass = this.checker
      .declarationsOf(value)
      .some((decl) => ts.isClassDeclaration(decl));
    return isClass ? value : null;
  }

  /** The CommonJS JS module a DEFAULT-import binding's declaration loads
   * (`import d from "./lib.cjs"`), or null: Node's ESM-CJS interop binds
   * the default to module.exports — exactly a require binding — so those
   * bindings ride the CJS namespace machinery below. ESM dependencies
   * (any .ts, ESM-syntax .js/.mjs) answer null and keep the ESM default
   * machinery. */
  private cjsDefaultImportDepOf(clause: ts.ImportClause): ts.SourceFile | null {
    const importDecl = clause.parent;
    if (!ts.isImportDeclaration(importDecl) || !ts.isStringLiteral(importDecl.moduleSpecifier)) {
      return null;
    }
    const spec = importDecl.moduleSpecifier.text;
    // Project aliases/self-references resolve through the same entry point as
    // relative imports; an opted-in --npm-static package is the fallback.
    const dep = resolveImport(this.program, importDecl.getSourceFile(), spec) ??
      npmStaticDepSf7(this.program, importDecl.getSourceFile(), spec);
    if (!dep || !isJsSourceFile(dep) || isNodeEsmFile(dep)) return null;
    return dep;
  }

  /** True when `expr` is an identifier bound by a top-level
   * `const x = require("./local")` of a project module — relative,
   * tsconfig-aliased, or package.json-mediated — or of a bare specifier
   * naming an opted-in --npm-static package (its CJS entry is a program
   * module, so the binding is the same namespace over the same export table), or by a
   * DEFAULT import of a CommonJS JS module (`import d from "./lib.cjs"`:
   * Node binds d to module.exports, the same value require answers).
   * Member accesses on it resolve through the export table (property
   * symbols → resolveValueSymbol); the bare value keeps the
   * namespace-object fence, like ESM namespace imports of builtins. */
  cjsLocalModuleBindingOf(expr: ts.Expression): boolean {
    if (!ts.isIdentifier(expr)) return false;
    const sym = this.checker.getSymbolAtLocation(expr);
    const decls = sym ? this.checker.declarationsOf(sym) : [];
    const decl = decls.find(ts.isImportClause) ?? decls[0];
    if (!decl) return false;
    if (ts.isImportClause(decl)) {
      if (decl.name === undefined || this.cjsDefaultImportDepOf(decl) === null) return false;
    } else {
      if (!ts.isVariableDeclaration(decl) || !ts.isIdentifier(decl.name) || !decl.initializer) {
        return false;
      }
      const spec = requireSpecOf(decl.initializer);
      if (spec === null) return false;
      const resolvedRequire = resolveImport(this.program, decl.getSourceFile(), spec);
      // `const codes = require("./codes.json")`: a JSON document is a
      // VALUE, not an export table — the binding is the baked comptime
      // global (collectJsonImports) and `codes.label` is an ordinary
      // record field read, never a member-name delegation.
      if (resolvedRequire?.fileName.endsWith(".json") === true) return false;
      if (
        resolvedRequire === null &&
        npmStaticDepSf7(this.program, decl.getSourceFile(), spec) === null
      ) {
        return false;
      }
    }
    // SINGLE-VALUE exporters (`module.exports = Countdown` / `= double` /
    // `= 42`): the requirer's binding IS the exported value, not a
    // namespace over an export table — the alias resolves straight to the
    // class/function/const declaration (or the scalar export= statement)
    // and every ordinary identifier path applies (new, calls, bare value).
    // Exported-const TABLES (a VariableDeclaration whose initializer is
    // the object literal) keep the namespace reading — member accesses
    // resolve through the table's property symbols.
    if (sym && sym.flags & ts.SymbolFlags.Alias) {
      const d = this.checker.declarationsOf(this.checker.getAliasedSymbol(sym))[0];
      if (d && (ts.isClassDeclaration(d) || ts.isFunctionDeclaration(d))) return false;
      if (d && ts.isVariableDeclaration(d)) {
        let init = d.initializer;
        while (init && ts.isParenthesizedExpression(init)) init = init.expression;
        if (!init || !ts.isObjectLiteralExpression(init)) return false;
      }
      // The scalar-literal export= symbol declares AT the `module.exports
      // =` statement itself; table/Proxy replacements share that
      // declaration node, so only scalar RHS reads as a single value.
      if (d && ts.isBinaryExpression(d)) {
        let r: ts.Expression = d.right;
        while (ts.isParenthesizedExpression(r)) r = r.expression;
        const scalar =
          ts.isNumericLiteral(r) || ts.isStringLiteral(r) || ts.isNoSubstitutionTemplateLiteral(r) ||
          r.kind === ts.SyntaxKind.TrueKeyword || r.kind === ts.SyntaxKind.FalseKeyword ||
          (ts.isPrefixUnaryExpression(r) && r.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(r.operand));
        if (scalar) return false;
      }
    }
    return true;
  }

  /** Assignment-target resolution: a function local (possibly captured) or
   * a module global. tsc has already rejected writes to consts. */
  resolveWritable(ident: ts.Identifier): IrLocal | null {
    const local = this.resolveLocal(ident);
    if (local?.type.kind === "caught") {
      // tsc admits writes (the binding types as `unknown`), but the
      // snapshot is read-only by design — bind a new local instead.
      this.unsupported("SC1090", ident, "assignments to catch bindings");
    }
    if (local) return local;
    const g = this.globalOf(ident);
    if (g) return g;
    return null;
  }

  fnSigOf(ident: ts.Identifier): FnSig | null {
    const symbol = this.resolveValueSymbol(ident);
    return symbol ? (this.fnSigsBySymbol.get(symbol) ?? null) : null;
  }

  globalOf(ident: ts.Identifier): IrGlobal | null {
    const symbol = this.resolveValueSymbol(ident);
    if (!symbol) return null;
    const g = this.globalsBySymbol.get(symbol);
    if (g) return g;
    for (const d of this.checker.declarationsOf(symbol)) {
      const byDecl = this.globalsByDeclNode.get(d);
      if (byDecl) return byDecl;
    }
    return null;
  }

  splitFiles(): FileParts[] {
    return splitFiles(this);
  }

  collectProgram(parts: FileParts[]): void {
    return collectProgram(this, parts);
  }

  prepareModuleInits(parts: FileParts[]): void {
    prepareModuleInits(this, parts);
  }

  /** The lowering of a CommonJS `require("./local")` occurrence: a call of
   * the required module's run-once %init at exactly this statement's
   * position — Node's inline evaluation, with the guard supplying the
   * cache-hit behavior for every require after the first. Bare specifiers
   * naming an opted-in --npm-static package resolve to that package's
   * program entry (the same edge preflight admitted — bundle dists require
   * their external dependencies by name). Null for everything else
   * (builtins load nothing; the rest kept its preflight fence). */
  requireInitStmt(spec: string, node: ts.Node): IrStmt | null {
    // Project requires resolve within the program; another bare require can
    // be a program-module edge when it names an opted-in --npm-static package
    // (one package requiring another — the resolution answered its shipped
    // JS, the file is in the module order, and the reads alias its globals).
    // Without the guarded %init call at this position
    // those globals stay uninitialized: the dep's module body would never
    // run.
    const dep = resolveImport(this.program, node.getSourceFile(), spec) ??
      npmStaticDepSf7(this.program, node.getSourceFile(), spec);
    if (!dep || dep.fileName.endsWith(".json")) return null;
    if (this.asyncInitFiles.has(dep)) {
      this.unsupported(
        "SC1090",
        node,
        `require() of '${spec}' (its ES-module graph uses top-level await; use import() instead)`,
      );
    }
    const initName = this.initNameOf.get(dep);
    if (initName === undefined) return null;
    const loc = locOf(node);
    return {
      kind: "exprStmt",
      expr: { kind: "call", callee: initName, args: [], type: VOID, loc },
      loc,
    };
  }

  /** True when this body should lower: everything with no reachable set,
   * the marked bodies in an externally-gated pass, and exactly the
   * UNMARKED bodies in the coverage remainder. */
  wantBody(name: string): boolean {
    if (this.reachable === null) return true;
    return this.remainder ? !this.reachable.has(name) : this.reachable.has(name);
  }

  collectNpmImports(parts: FileParts[]): void {
    return collectNpmImports(this, parts);
  }

  collectJsonImports(parts: FileParts[]): void {
    return collectJsonImports(this, parts);
  }

  collectAssetImports(parts: FileParts[]): void {
    return collectAssetImports(this, parts);
  }

  analyzeRuntimeOptionalArrayReads(parts: FileParts[]): void {
    return analyzeRuntimeOptionalArrayReads(this, parts);
  }

  run(): LowerResult {
    const parts = this.splitFiles();
    // The coverage remainder deliberately visits every body that reachable
    // emit skipped. Those files are already phase-managed, so an ordinary
    // checker miss would stay a one-node IPC query instead of falling back
    // to the facade's whole-file batch. Coverage has no dead-body boundary
    // to preserve: prime each complete file now, reusing the answers the
    // reachable pass already memoized and batching only the cold remainder.
    if (this.remainder) {
      for (const fp of parts) this.checker.prefetchSourceFile(fp.sf);
    }
    this.collectProgram(parts);
    // Dense native arrays keep typed read/binding ABIs (see lower-dense-array-reads.ts).
    if (!this.nativeDenseArrays) this.analyzeRuntimeOptionalArrayReads(parts);
    // Decorated classes analyze AFTER the whole collection pass: a
    // decorator's return type may name a subclass declared below the
    // class, and reference lowering needs each class's rebindability
    // (valueGlobalId) settled before any body lowers.
    for (const info of this.classes.values()) analyzeClassDecoration(this, info);
    this.prepareModuleInits(parts);

    const functions: IrFunction[] = [];
    for (const fp of parts) {
      for (const decl of fp.fnDecls) {
        // Overload signatures / ambient declarations are type-world (no
        // body to lower — and they share the implementation's symbol, so
        // counting them as skips would double-count the declaration).
        if (!decl.body) continue;
        // Generic functions have no body of their own: they are lowered
        // per-instantiation, on demand, from the worklist below.
        const declSymbol = declSymbolOf(this, decl);
        if (declSymbol && this.genericFnsBySymbol.has(declSymbol)) continue;
        // Mixin functions likewise: no signature, no body of their own —
        // calls instantiate the class inside per site (lower-mixins.ts).
        if (this.mixinFnShapes.get(decl)) continue;
        const sig = declSymbol ? this.fnSigsBySymbol.get(declSymbol) : undefined;
        // A body nothing reaches never lowers: its constructs can't fail
        // the build and it leaves no trace in the emitted C.
        if (sig && !this.wantBody(sig.name)) continue;
        const fn = this.lowerFunction(decl);
        if (fn) functions.push(fn);
        else if (this.countsSkips()) this.stats.functionsSkipped++;
      }
      for (const decl of fp.classDecls) {
        const info = this.classes.get(this.classNamer(decl));
        if (info) functions.push(...this.lowerClassMembers(info));
        else if (this.countsSkips()) this.stats.functionsSkipped++;
      }
    }

    // Each file's top-level statements form its run-once init function.
    // %main calls only the ENTRY's init: each init's hoisted import header
    // runs its dependencies (npm island loads at their import positions),
    // inline require statements call theirs mid-body, and the guards make
    // revisits cache hits — Node's evaluation order over the WHOLE graph
    // falls out of the nesting. The coverage remainder skips them — they
    // are reachable by definition, already counted by reachable emit.
    if (!this.remainder) {
      for (const fp of parts) {
        functions.push(this.lowerFileInit(fp.sf, fp.topStmts, this.initNameOf.get(fp.sf)!));
      }
      functions.push(this.buildMain());
    }
    // Class EXPRESSIONS collected while the inits lowered: their members
    // lower here, wantBody-gated like declaration members (nested class
    // expressions inside these bodies are fenced, so the list is stable).
    // Monomorphization worklists: every site above queued the generic
    // instances it needs — function instances (calls, pinned values) and
    // class instantiations (type references) — and lowering any instance
    // body can queue more of EITHER kind (generic functions constructing
    // generic classes, generic methods calling generic functions) — the
    // index loops run to the joint fixpoint. Same-key recursion re-uses
    // its own entry; polymorphic recursion is cut off by
    // MAX_GENERIC_INSTANCES.
    {
      let ec = 0;
      let gc = 0;
      let gi = 0;
      let es = 0;
      while (
        ec < this.exprClasses.length ||
        gc < this.genericClassInstances.length ||
        gi < this.instantiationQueue.length ||
        es < this.emitSpecQueue.length
      ) {
        while (ec < this.exprClasses.length) {
          functions.push(...this.lowerClassMembers(this.exprClasses[ec++]!));
        }
        while (gc < this.genericClassInstances.length) {
          functions.push(...this.lowerClassMembers(this.genericClassInstances[gc++]!));
        }
        while (gi < this.instantiationQueue.length) {
          const { info, inst } = this.instantiationQueue[gi++]!;
          // A body-level poison outside the per-statement catches (a
          // generic method's this/super fence, a fenced parameter
          // default): the diagnostic is recorded — the instance skips
          // like a signature-blocked function (lowerFunction's rule).
          try {
            functions.push(this.lowerGenericInstance(info, inst));
          } catch (e) {
            if (!(e instanceof PoisonError)) throw e;
          }
        }
        // Emit-override specializations queued by the emit sites above (a
        // body can queue more — the super-forward chain — and generic
        // instances of its own; the joint fixpoint covers both).
        while (es < this.emitSpecQueue.length) {
          try {
            const fn = lowerEmitOverrideSpec(this, this.emitSpecQueue[es++]!);
            if (fn) functions.push(fn);
          } catch (e) {
            if (!(e instanceof PoisonError)) throw e;
          }
        }
      }
    }
    // Lambdas lifted while lowering any of the above (plus synthetic
    // array-HOF loop functions, which ride the same list), and the
    // implicit-any instances lowered eagerly at their first call sites.
    functions.push(...this.liftedFns);
    functions.push(...this.implicitFns);

    if (this.remainder) {
      // Deferred collection diagnostics nothing flushed — declarations no
      // reference ever made relevant. They belong to the unreached group
      // (collection order keeps them deterministic).
      for (const [symbol, diags] of this.deferredDiags) {
        if (this.alreadyFlushed.has(symbol)) continue;
        for (const d of diags) this.pushDiag(d);
      }
      return {
        module: null,
        diagnostics: this.diags,
        runtimeFences: this.runtimeFences,
        stats: this.stats,
        ...(this.statsByFile.size > 0 ? { statsByFile: this.statsByFile } : {}),
        ...(this.provenanceElided.length > 0 ? { provenanceElided: this.provenanceElided } : {}),
        ...(this.npmBuiltins ? { npmBuiltins: this.npmBuiltins } : {}),
        ...(this.npmLazyTraps ? { npmLazyTraps: this.npmLazyTraps } : {}),
      };
    }

    return this.finishModule(functions);
  }

  /** Final retention, pruning, and module assembly shared by ordinary emit
   * and the retained reachability worklist. */
  finishModule(functions: IrFunction[]): LowerResult {
    pruneUnusedNativeModuleCaches(this, functions);

    // Globals typed by a class that never REGISTERED (a JS class whose
    // collection fenced — Symbol-keyed fields, an unsupported base): the
    // declaration statement and every use compiled to runtime fences, but
    // the collection-time global still carries the object type, and the
    // emitter would name a struct that does not exist — invalid C, the
    // compile-C escape family. The storage is dead by construction (the
    // initializing assign never lowered; reads cascade to their own
    // fences), so drop it — guarded by a reference scan, with the
    // validator's registration check as the backstop for anything that
    // does slip through with a live reference.
    const brokenGlobals = this.globalsList.filter((g) => this.typeNamesUnregisteredClass(g.type));
    const brokenLocalFns = functions.filter((fn) =>
      fn.locals.some((l) => this.typeNamesUnregisteredClass(l.type)),
    );
    if (brokenGlobals.length > 0 || brokenLocalFns.length > 0) {
      const referencedIn = (root: unknown): Set<string> => {
        const referenced = new Set<string>();
        const scan = (node: unknown): void => {
          if (node === null || typeof node !== "object") return;
          if (Array.isArray(node)) {
            for (const item of node) scan(item);
            return;
          }
          const rec = node as Record<string, unknown>;
          const id = rec["localId"];
          if (typeof id === "string") referenced.add(id);
          const catchId = rec["catchLocalId"];
          if (typeof catchId === "string") referenced.add(catchId);
          // Closure captures name their source locals as PLAIN STRINGS
          // (captures: string[]) — a captured broken-class local is live.
          if (rec["kind"] === "closure" && Array.isArray(rec["captures"])) {
            for (const c of rec["captures"]) if (typeof c === "string") referenced.add(c);
          }
          for (const key of Object.keys(rec)) scan(rec[key]);
        };
        scan(root);
        return referenced;
      };
      if (brokenGlobals.length > 0) {
        const referenced = referencedIn(functions);
        for (const g of brokenGlobals) {
          if (referenced.has(g.id)) continue; // live reference — validator reports
          const i = this.globalsList.indexOf(g);
          if (i >= 0) this.globalsList.splice(i, 1);
        }
      }
      // LOCALS left behind the same way (`const countdown = new Countdown(...)`
      // inside an init body whose declaration fenced): the emitter declares
      // every local at function top, so an unreferenced one typed by the
      // unregistered class is the identical invalid-C escape.
      for (const fn of brokenLocalFns) {
        // Params and captures list their locals by id too — never prune
        // those out from under them.
        const referenced = referencedIn([fn.body, fn.params, fn.captures ?? []]);
        fn.locals = fn.locals.filter(
          (l) => referenced.has(l.id) || !this.typeNamesUnregisteredClass(l.type),
        );
      }
    }

    // Computed before the module gate: retention resolves every class name
    // the emitted program references, flushing deferred class diagnostics
    // that a reached type makes relevant.
    const artifacts = this.moduleArtifacts(functions);
    // Types still naming a class that never REGISTERED after retention's
    // flush (JS graphs whose class fences deferred to runtime — the
    // sentence-walker's path params, printer tables whose func-typed
    // fields spell the fenced class): the emitter would name a struct
    // that does not exist — the compile-C escape family. No instance of
    // such a class can ever exist (every construction site fenced), so
    // the slots are inert by construction: rewrite each to the f64 dummy
    // placeholder (boxNewC's uncollected-class stance, applied to unboxed
    // slots), uniformly across params/locals/globals/fields/body types so
    // every producer and consumer agrees. Programs with no unregistered
    // reference are untouched — byte-stability holds.
    if (this.diags.length === 0) {
      this.sanitizeUnregisteredClassTypes([functions, this.globalsList, artifacts.classes, artifacts.records, artifacts.unions]);
    }
    const module: IrModule | null =
      this.diags.length > 0
        ? null
        : {
            irVersion: 8,
            sourceFile: this.entry.fileName,
            runtimeTarget: runtimeTargetIr(activeRuntimeTarget()),
            ...(!isNodeEsmFile(this.entry) ? { entryCommonJs: true as const } : {}),
            functions,
            classes: artifacts.classes,
            records: artifacts.records,
            unions: artifacts.unions, ...(familiesIr(this).length > 0 ? { families: familiesIr(this) } : {}),
            globals: this.globalsList,
            ...(this.npmEmbedded ? { embedded: this.npmEmbedded } : {}),
            entry: ENTRY_NAME,
            ...(this.ffiImports.length > 0 ? { ffiImports: [...this.ffiImports] } : {}),
          };
    const tiers: ModuleTierRow[] = this.moduleOrder.map((sf) =>
      sf !== this.entry && isIslandModulePath(sf.fileName)
        ? { module: sf.fileName, tier: "island", reason: islandModuleReason(sf.fileName) ?? "island" }
        : { module: sf.fileName, tier: "static", reason: "static" });
    return {
      module,
      diagnostics: this.diags,
      runtimeFences: this.runtimeFences,
      stats: this.stats,
      ...(tiers.some((t) => t.tier === "island") ? { tiers } : {}),
      ...(this.statsByFile.size > 0 ? { statsByFile: this.statsByFile } : {}),
      ...(this.provenanceElided.length > 0 ? { provenanceElided: this.provenanceElided } : {}),
      ...(this.npmBuiltins ? { npmBuiltins: this.npmBuiltins } : {}),
      ...(this.npmLazyTraps ? { npmLazyTraps: this.npmLazyTraps } : {}),
    };
  }

  /** The unregistered-class type sweep (run()'s last step before the
   * module assembles): every `{kind:"object"}` TYPE naming a class with
   * no registered ClassInfo is rewritten IN PLACE to the f64 dummy.
   * classval types are exempt (they emit the class-independent
   * `ScrClassObj *` — inert-but-valid storage, the validator's own
   * stance), and only type objects rewrite — node-level classNames
   * (`new`, upcasts) cannot reach here (their lowerings fence without a
   * registered class), so the validator still backstops those. */
  sanitizeUnregisteredClassTypes(roots: unknown[]): void {
    const isUnregisteredObjectType = (v: unknown): boolean =>
      typeof v === "object" && v !== null &&
      (v as { kind?: unknown }).kind === "object" &&
      typeof (v as { className?: unknown }).className === "string" &&
      !this.classes.has((v as { className: string }).className);
    const sweep = (node: unknown): void => {
      if (node === null || typeof node !== "object") return;
      if (Array.isArray(node)) {
        node.forEach((item, i) => {
          if (isUnregisteredObjectType(item)) node[i] = F64;
          else sweep(item);
        });
        return;
      }
      const rec = node as Record<string, unknown>;
      for (const key of Object.keys(rec)) {
        if (key === "loc") continue;
        const v = rec[key];
        if (isUnregisteredObjectType(v)) rec[key] = F64;
        else sweep(v);
      }
    };
    for (const root of roots) sweep(root);
  }

  /** True when `t` (recursively) names a class instance type with no
   * registered ClassInfo — the shape of a JS class whose collection fenced.
   * Used by run()'s global pruning; shapes/unions recurse with a seen-set
   * (interned ids can nest). */
  typeNamesUnregisteredClass(t: IrType, seen: Set<string> = new Set()): boolean {
    switch (t.kind) {
      case "object":
        return !this.classes.has(t.className);
      case "array":
      case "set":
        return this.typeNamesUnregisteredClass(t.elem, seen);
      case "map":
        return (
          this.typeNamesUnregisteredClass(t.key, seen) ||
          this.typeNamesUnregisteredClass(t.value, seen)
        );
      case "promise":
        return this.typeNamesUnregisteredClass(t.inner, seen);
      case "func":
        return (
          t.params.some((p) => this.typeNamesUnregisteredClass(p, seen)) ||
          this.typeNamesUnregisteredClass(t.ret, seen)
        );
      case "record": {
        if (seen.has(t.shapeId)) return false;
        seen.add(t.shapeId);
        const shape = this.shapes.get(t.shapeId);
        if (!shape) return false;
        if (shape.indexValue && this.typeNamesUnregisteredClass(shape.indexValue, seen)) return true;
        return shape.fields.some((f) => this.typeNamesUnregisteredClass(f.type, seen));
      }
      case "union": {
        if (seen.has(t.unionId)) return false;
        seen.add(t.unionId);
        const def = this.unions.get(t.unionId);
        return !!def && def.arms.some((a) => this.typeNamesUnregisteredClass(a, seen));
      }
      default:
        return false;
    }
  }

  /** Whether run() counts a signature-blocked declaration in
   * stats.functionsSkipped: whole-program passes and the coverage
   * remainder do; an externally-gated emit pass leaves the counting to the
   * remainder (the declaration was never reached). */
  countsSkips(): boolean {
    return this.reachable === null || this.remainder;
  }

  /* ── reachability ─────────────────────────────────────────────────── */

  /** Reachable emit: computes the set of body names the program's entry
   * reaches and retains each body IR as it lowers. Seeds are the per-file
   * init bodies (top-level statements always run); edges fire from
   * RESOLUTION sites while a body lowers (noteEdge /
   * noteVirtualEdge) — direct calls, closure creation (a taken closure may
   * be called indirectly), `new`, super calls, accessor invocations, and
   * virtual dispatch. Recording at resolution time (not off the produced
   * IR) keeps edges from statements that later poison, so the callee's own
   * diagnostics still surface — the collect-everything invariant. Generic
   * instances ride the existing monomorphization queue (already
   * demand-driven) and lifted lambdas lower inline with their enclosing
   * body; both fire edges through the same hooks and are not units
   * themselves. */
  emitReachable(extraRoots?: readonly string[]): { reachable: Set<string>; result: LowerResult } {
    const parts = this.splitFiles();
    // Direct lowering callers do not necessarily run program preflight.
    // Establish the same managed header/top-level batch here before
    // collection, while the production path simply finds warm memos.
    this.checker.prefetchSourceFileStructures(parts.map((fp) => fp.sf));
    // Signature collection may read the initializer type of a default whose
    // body type still admits undefined (for example `value =
    // process.env.VALUE`). The expression executes only when reached, but
    // that type query is mandatory now; batch hot defaults across ordinary
    // declarations before collectProgram visits their signatures.
    this.checker.prefetchCollectionTypes(
      parts.flatMap((fp) =>
        fp.fnDecls
          .filter((decl) => decl.body !== undefined && decl.typeParameters === undefined)
          .flatMap((decl) =>
            decl.parameters.flatMap((param) => param.initializer ? [param.initializer] : []),
          ),
      ),
    );
    // JavaScript class shapes are partly declared by constructor-body
    // assignments. Batch those collection-time queries across declarations
    // before collectProgram visits them one by one; reached body lowering
    // will reuse the same answers later.
    this.prefetchClassCollection(parts.flatMap((fp) => fp.classDecls));
    this.collectProgram(parts);
    // Dense native arrays keep typed read/binding ABIs (see lower-dense-array-reads.ts).
    if (!this.nativeDenseArrays) this.analyzeRuntimeOptionalArrayReads(parts);
    // Decorated classes analyze post-collection here too: the %init seeds
    // lower the decoration calls, whose edges (decorator bodies, construct
    // thunks) reachable emit must see.
    for (const info of this.classes.values()) analyzeClassDecoration(this, info);
    this.prepareModuleInits(parts);

    // Every lowerable body, by emitted-function name. The names double as
    // retained-function keys and are deterministic by construction
    // (qualified declaration names).
    const units = new Map<string, {
      order: number;
      roots: readonly ts.Node[];
      lower: () => IrFunction | null;
    }>();
    const bodyRoots = (...roots: (ts.Node | undefined | null)[]): ts.Node[] =>
      roots.filter((root): root is ts.Node => root !== undefined && root !== null);
    const functionRoots = (decl: ts.FunctionLikeDeclaration): ts.Node[] => bodyRoots(
      ...decl.parameters.map((param) => param.initializer),
      decl.body,
    );
    const classCtorRoots = (info: ClassInfo): ts.Node[] => bodyRoots(
      ...(info.ctor?.parameters ?? []).map((param) => param.initializer),
      info.ctor?.body,
      ...info.fieldOrder.map((field) => field.initializer),
    );
    const classMemberRoots = (info: ClassInfo): ts.Node[] => [
      ...classCtorRoots(info),
      ...[...this.classMethodMembers(info)].flatMap(({ member }) => functionRoots(member)),
      ...[...(info.staticMethods?.values() ?? [])].flatMap(({ member }) => functionRoots(member)),
    ];
    let unitOrder = 0;
    for (const fp of parts) {
      for (const decl of fp.fnDecls) {
        // Overload signatures share the implementation's symbol (and so
        // its FnSig): only the with-body declaration is the unit, or the
        // signature's closure would shadow the implementation's.
        if (!decl.body) continue;
        const declSymbol = declSymbolOf(this, decl);
        if (!declSymbol || this.genericFnsBySymbol.has(declSymbol)) continue;
        const sig = this.fnSigsBySymbol.get(declSymbol);
        if (sig) {
          units.set(sig.name, {
            order: unitOrder++,
            roots: functionRoots(decl),
            lower: () => this.lowerFunction(decl),
          });
        }
      }
    }
    for (const info of this.classes.values()) {
      if (info.builtinError) continue; // runtime-provided; nothing lowers
      // Generic-class INSTANTIATIONS (and mixin instantiations) are
      // demand-driven, not units: their members lower unconditionally in
      // the instance drain below — the generic-fn instance rule.
      if (info.genericInstance || info.mixinInstance) continue;
      const cName = info.def.name;
      // A FAMILY has no constructor function and no instance members —
      // only its statics are units.
      if (!info.generic) {
        units.set(`%${cName}.constructor`, {
          order: unitOrder++,
          roots: classCtorRoots(info),
          lower: () => this.lowerClassCtor(info),
        });
        for (const { mName, member } of this.classMethodMembers(info)) {
          units.set(`%${cName}.${mName}`, {
            order: unitOrder++,
            roots: functionRoots(member),
            lower: () => this.lowerClassMethodMember(info, member),
          });
        }
        for (const prop of info.throwingSetters) {
          units.set(`%${cName}.set:${prop}`, {
            order: unitOrder++,
            roots: [],
            lower: () => this.throwingSetterFn(info, prop),
          });
        }
      }
      for (const [name, entry] of info.staticMethods ?? []) {
        units.set(`%${cName}.static:${name}`, {
          order: unitOrder++,
          roots: functionRoots(entry.member),
          lower: () => lowerStaticMethod(this, info, name),
        });
      }
    }
    // The old emit pass visited each file's functions and then its classes,
    // before every module init. Retained reachability discovers those
    // bodies from the inits, but first-seen record metadata still has to
    // follow that old order: Object.keys/JSON/inspect observe a shape's
    // declaredOrder. Keep output sorting separate — this rank controls only
    // that observable metadata.
    const metadataPriority = new Map<string, readonly [phase: number, order: number]>();
    let declarationMetadataOrder = 0;
    const rank = (name: string): void => {
      if (units.has(name) && !metadataPriority.has(name)) {
        metadataPriority.set(name, [1, declarationMetadataOrder++]);
      }
    };
    for (const fp of parts) {
      for (const decl of fp.fnDecls) {
        if (!decl.body) continue;
        const symbol = declSymbolOf(this, decl);
        if (symbol && !this.genericFnsBySymbol.has(symbol)) {
          const sig = this.fnSigsBySymbol.get(symbol);
          if (sig) rank(sig.name);
        }
      }
      for (const decl of fp.classDecls) {
        const info = this.classes.get(this.classNamer(decl));
        if (!info) continue;
        const cName = info.def.name;
        rank(`%${cName}.constructor`);
        for (const { mName } of this.classMethodMembers(info)) rank(`%${cName}.${mName}`);
        for (const name of info.staticMethods?.keys() ?? []) rank(`%${cName}.static:${name}`);
        for (const prop of info.throwingSetters) rank(`%${cName}.set:${prop}`);
      }
    }
    // Defensive fallback for declaration-like units registered outside
    // FileParts; they still precede init bodies in the old emit pass.
    for (const name of units.keys()) rank(name);
    let expressionMetadataOrder = 0;
    let instanceMetadataOrder = 0;
    const demandOwner = (priority?: readonly [number, number]): GenericDemandOwner => {
      const owner: GenericDemandOwner = {
        ...(priority ? { priority } : {}),
        functionDemands: [],
        classDemands: [],
      };
      if (priority) this.genericDemandRoots.push(owner);
      return owner;
    };
    const reachable = new Set<string>();
    const queue: string[] = [];
    const loweredUnits = new Map<string, IrFunction>();
    const initFunctions: IrFunction[] = [];
    const instanceFunctions: IrFunction[] = [];
    this.onEdge = (name: string): void => {
      if (reachable.has(name)) return;
      reachable.add(name);
      if (units.has(name)) queue.push(name);
    };
    // Class EXPRESSIONS collect while init bodies lower (below): their
    // member units register the moment collection finishes — before any
    // edge to them can fire (references require the collected class).
    this.onExprClassCollected = (info: ClassInfo): void => {
      const cName = info.def.name;
      const register = (
        name: string,
        roots: readonly ts.Node[],
        lower: () => IrFunction | null,
      ): void => {
        units.set(name, { order: unitOrder++, roots, lower });
        metadataPriority.set(name, [3, expressionMetadataOrder++]);
      };
      register(`%${cName}.constructor`, classCtorRoots(info), () => this.lowerClassCtor(info));
      for (const { mName, member } of this.classMethodMembers(info)) {
        register(
          `%${cName}.${mName}`,
          functionRoots(member),
          () => this.lowerClassMethodMember(info, member),
        );
      }
      for (const [name, entry] of info.staticMethods ?? []) {
        register(
          `%${cName}.static:${name}`,
          functionRoots(entry.member),
          () => lowerStaticMethod(this, info, name),
        );
      }
      for (const prop of info.throwingSetters) {
        register(`%${cName}.set:${prop}`, [], () => this.throwingSetterFn(info, prop));
      }
    };
    // Generic instances queued by the bodies above lower here (an instance
    // body fires edges of its own and can queue further instances of
    // either kind — function instances and class instantiations drain to
    // the joint fixpoint).
    let instLowered = 0;
    let clsInstLowered = 0;
    let specLowered = 0;
    const drainInstances = (): void => {
      while (
        instLowered < this.instantiationQueue.length ||
        clsInstLowered < this.genericClassInstances.length ||
        specLowered < this.emitSpecQueue.length
      ) {
        while (clsInstLowered < this.genericClassInstances.length) {
          const waveEnd = this.genericClassInstances.length;
          this.checker.prefetchRoots(
            this.genericClassInstances.slice(clsInstLowered, waveEnd).flatMap(classMemberRoots),
          );
          while (clsInstLowered < waveEnd) {
            const info = this.genericClassInstances[clsInstLowered++]!;
            const owner = demandOwner();
            this.genericClassDemandOwner.set(info, owner);
            const ref = this.genericClassDemandPriority.get(info) ?? { rank: [4, instanceMetadataOrder++] };
            this.genericClassDemandPriority.set(info, ref);
            instanceFunctions.push(...this.withGenericDemandOwner(owner, () =>
              this.shapes.withDeclaredOrderPriority(ref, () => this.lowerClassMembers(info))));
          }
        }
        while (instLowered < this.instantiationQueue.length) {
          const waveEnd = this.instantiationQueue.length;
          this.checker.prefetchRoots(
            this.instantiationQueue
              .slice(instLowered, waveEnd)
              .flatMap(({ info }) => functionRoots(info.decl)),
          );
          while (instLowered < waveEnd) {
            const { info, inst } = this.instantiationQueue[instLowered++]!;
            const owner = demandOwner();
            this.genericFunctionDemandOwner.set(inst, owner);
            const ref = this.genericDemandPriority.get(inst) ?? { rank: [4, instanceMetadataOrder++] };
            this.genericDemandPriority.set(inst, ref);
            // Body-level poisons skip the instance after retaining the
            // diagnostic and every edge fired before poisoning.
            try {
              instanceFunctions.push(this.withGenericDemandOwner(owner, () =>
                this.shapes.withDeclaredOrderPriority(ref, () => this.lowerGenericInstance(info, inst))));
            } catch (e) {
              if (!(e instanceof PoisonError)) throw e;
            }
          }
        }
        // Emit-override specialization bodies fire edges of their own
        // (the super-forward chain, closures, generic calls) — lower them
        // exactly like generic instances.
        while (specLowered < this.emitSpecQueue.length) {
          const waveEnd = this.emitSpecQueue.length;
          this.checker.prefetchRoots(
            this.emitSpecQueue
              .slice(specLowered, waveEnd)
              .flatMap(({ info }) =>
                info.emitOverride ? functionRoots(info.emitOverride.decl) : []),
          );
          while (specLowered < waveEnd) {
            try {
              const fn = this.shapes.withDeclaredOrderPriority(
                [4, instanceMetadataOrder++],
                () => lowerEmitOverrideSpec(this, this.emitSpecQueue[specLowered++]!),
              );
              if (fn) instanceFunctions.push(fn);
            } catch (e) {
              if (!(e instanceof PoisonError)) throw e;
            }
          }
        }
      }
    };

    // Module inits are the unconditional root wave. Structure prefetch
    // already covered ordinary top-level expressions, but this full-root
    // pass also picks up nested/lifted function bodies and the class
    // declaration-time code that splitFiles hoists out of topStmts.
    this.checker.prefetchRoots([
      ...parts.flatMap((fp) => fp.topStmts),
      ...[...this.classes.values()].flatMap((info) => [
        ...info.staticFields.map((field) => field.initializer),
        ...(info.staticBlocks ?? []),
        ...(info.classDecorators?.nodes ?? []),
      ]),
    ]);
    parts.forEach((fp, index) => {
      const priority = [2, index] as const;
      const owner = demandOwner(priority);
      initFunctions.push(
        this.withGenericDemandOwner(
          owner,
          () => this.shapes.withDeclaredOrderPriority(
            priority,
            () => this.lowerFileInit(fp.sf, fp.topStmts, this.initNameOf.get(fp.sf)!),
          ),
        ),
      );
    });
    // LIBRARY mode's extra reachability roots (LowerOptions.libRoots): the
    // profile-mapped exports are called from outside the graph, so they
    // seed the worklist beside the init bodies. Unknown names are inert
    // (the export-map resolution reports them as SC4002 later).
    for (const root of extraRoots ?? []) this.onEdge?.(root);
    const drainUnits = (): void => {
      while (queue.length > 0) {
        const wave = queue.splice(0);
        this.checker.prefetchRoots(wave.flatMap((name) => units.get(name)!.roots));
        for (const name of wave) {
          // A body-level poison outside the per-statement catches (a fenced
          // constructor/method parameter default lowered by declareParams):
          // every edge fired before poisoning remains retained; the diagnostic
          // stays recorded and the member stays omitted.
          try {
            const unit = units.get(name)!;
            const priority = metadataPriority.get(name) ?? [3, expressionMetadataOrder++];
            const owner = demandOwner(priority);
            const fn = this.withGenericDemandOwner(
              owner,
              () => this.shapes.withDeclaredOrderPriority(priority, unit.lower),
            );
            if (fn) loweredUnits.set(name, fn);
          } catch (e) {
            if (!(e instanceof PoisonError)) throw e;
          }
        }
      }
    };
    drainUnits();
    this.restoreGenericInstanceOrder();
    this.restoreGenericClassInstanceOrder();
    // Generic bodies can reach ordinary declarations, whose bodies can in
    // turn queue more instances. Continue to the joint fixpoint; the initial
    // queue above is the only portion whose discovery order differed from
    // historical emit order.
    for (;;) {
      drainInstances();
      if (queue.length === 0) break;
      drainUnits();
      this.restoreGenericInstanceOrder(instLowered);
      this.restoreGenericClassInstanceOrder(clsInstLowered);
    }
    const orderedUnits = [...loweredUnits]
      .sort(([left], [right]) => units.get(left)!.order - units.get(right)!.order)
      .map(([, fn]) => fn);
    this.settleGenericDemandPriorities();
    this.shapes.settleDeclaredOrderPriorities();
    for (const finalize of this.shapeOrderMetadataFinalizers) finalize();
    for (const finalize of this.shapeOrderHelperFinalizers) finalize();
    const functions = [
      ...orderedUnits,
      ...initFunctions,
      this.buildMain(),
      ...instanceFunctions,
      ...this.liftedFns,
      ...this.implicitFns,
    ];
    this.reachableForArtifacts = reachable;
    return { reachable, result: this.finishModule(functions) };
  }

  /** Reachability hook (see emitReachable): fires when lowering resolves a
   * reference to a lowerable body. */
  noteEdge(name: string): void {
    if (this.onEdge) this.onEdge(name);
  }

  /** Discovery hook for virtual dispatch: a virtualCall on `info`'s static
   * class reaches the nearest declaration at/above it plus every override
   * on a STRICT descendant (receivers of sibling branches can't flow into
   * this call site; a virtualCall through their own static classes marks
   * them). */
  noteVirtualEdge(info: ClassInfo, method: string): void {
    if (!this.onEdge) return;
    const above = this.findMethodOn(info, method);
    if (above) this.noteEdge(`%${above.declarer.def.name}.${method}`);
    const below = (c: ClassInfo): void => {
      for (const s of c.subclasses) {
        if (s.methods.has(method)) this.noteEdge(`%${s.def.name}.${method}`);
        below(s);
      }
    };
    below(info);
  }

  moduleArtifacts(functions: IrFunction[]): {
    classes: IrClassDef[];
    records: IrRecordShape[];
    unions: IrUnionDef[];
  } {
    return moduleArtifacts(this, functions);
  }

  /* ── diagnostics plumbing ─────────────────────────────────────────── */

  /** Converts diagnostics recorded since `diagsBefore` into a runtime
   * fence. ICEs stay on the compile-diagnostic path; every other captured
   * diagnostic moves to the runtime-fence ledger. Function targets share
   * the same capture-free trap-function construction, while statement
   * targets return the fence inline. Null means the conversion was not
   * eligible (probe mode, no diagnostic/fallback, or an ICE). */
  deferToRuntimeFence(
    diagsBefore: number,
    node: ts.Node,
    target: RuntimeFenceStatementTarget,
  ): IrStmt | null;
  deferToRuntimeFence(
    diagsBefore: number,
    node: ts.Node,
    target: RuntimeFenceFunctionTarget,
  ): IrFunction | null;
  deferToRuntimeFence(
    diagsBefore: number,
    node: ts.Node,
    target: RuntimeFenceClosureTarget,
  ): IrExpr | null;
  deferToRuntimeFence(
    diagsBefore: number,
    node: ts.Node,
    target: RuntimeFenceTarget,
  ): IrStmt | IrFunction | IrExpr | null {
    if (
      (this.diagSink !== null && target.allowDiagSink !== true) ||
      (this.diags.length <= diagsBefore && target.fallback === undefined)
    ) {
      return null;
    }
    const captured = this.diags.splice(diagsBefore);
    if (captured.some((d) => d.code === "SC9001")) {
      this.diags.push(...captured);
      return null;
    }
    this.runtimeFences.push(...captured);

    const first = captured[0];
    const loc = locOf(node);
    const code = first?.code ?? target.fallback!.code;
    const baseMessage = first?.message ?? target.fallback!.message;
    const messageLoc = first?.loc ?? loc;
    const source = first
      ? this.program.getSourceFile(messageLoc.file) ?? node.getSourceFile()
      : node.getSourceFile();
    const pos = ts.getLineAndCharacterOfPosition(source, messageLoc.start);
    const fence: IrStmt = {
      kind: "runtimeFence",
      code,
      message: target.bareMessage
        ? baseMessage
        : `${baseMessage} [${code} at ${messageLoc.file}:${pos.line + 1}]`,
      loc,
    };
    if (target.kind === "statement") return fence;

    const params = target.params ?? [];
    const name = typeof target.name === "function" ? target.name() : target.name;
    const fn: IrFunction = {
      name,
      params,
      returnType: target.returnType,
      locals: params.map((p) => ({
        id: p.localId,
        name: p.name,
        type: p.type,
        mutable: target.paramsMutable ?? false,
      })),
      body: [fence],
      loc,
    };
    if (target.async) fn.async = true;
    if (target.generator) fn.generator = target.generator;
    if (target.kind === "function") return fn;

    fn.captures = [];
    this.liftedFns.push(fn);
    return { kind: "closure", fnName: fn.name, captures: [], type: target.type, loc };
  }

  /** All diagnostics land here; while a generic instance body is lowering,
   * the instantiation context is appended so the user knows which concrete
   * types made the (source-anchored) construct fail. */
  pushDiag(diag: ScrDiagnostic): void {
    const d = this.instantiationContext
      ? { ...diag, message: `${diag.message} (${this.instantiationContext})` }
      : diag;
    // Deferred collection: the wrapper decides whether these ever report
    // (a reference flushes them; unreferenced declarations stay silent in
    // builds and report under coverage's unreached group).
    if (this.diagSink) {
      this.diagSink.push(d);
      return;
    }
    // One site, one report: some declarations map a type twice (module
    // globals pre-register before their initializers lower) — an exact
    // duplicate (code + span + message) adds noise, not information.
    if (
      this.diags.some(
        (p) =>
          p.code === d.code &&
          p.loc.start === d.loc.start &&
          p.loc.end === d.loc.end &&
          p.message === d.message,
      )
    ) {
      return;
    }
    this.diags.push(d);
  }

  unsupported(
    code: keyof typeof UNSUPPORTED & `SC${number}`,
    node: ts.Node,
    featureOverride?: string,
    hintOverride?: string,
  ): never {
    this.pushDiag(unsupportedDiag(code, locOf(node), featureOverride, hintOverride));
    throw new PoisonError();
  }

  externalHostFence(specifier: string, node: ts.Node, valueUse = true): never {
    this.unsupported(
      "SC1010",
      node,
      valueUse
        ? `values from the '${specifier}' external host module (types supplied by --external-types, but no runtime implementation or scriptc lowering was provided)`
        : `the '${specifier}' external host module (types supplied by --external-types, but no runtime implementation or scriptc lowering was provided)`,
      `the declaration mapping is analysis-only: coverage continues through project code, while executing ${valueUse ? "this value" : "this module"} requires an embedder integration with explicit runtime semantics`,
    );
  }

  /** The dynamic-family fence for an OPERATION on an `any`-origin
   * checked-dynamic value that only the engine can execute (operators,
   * iteration, computed member names, ...). Carries SC2011 — the same
   * code as the `any` type fence — so the coverage report groups it with
   * the dynamic-capable family and the two-tier retry knows the island
   * lifts the site. Use exactly when the blocking operand IS dyn-typed
   * and its checker type is `any`-flavored; genuine `unknown` keeps the
   * SC1100-family fences (tsc constrains what unknown can do, so those
   * sites are checker-error territory, not engine territory). */
  anyOpFence(feature: string, node: ts.Node): never {
    this.pushDiag(anyOpRequiresDynamicDiag(feature, locOf(node)));
    throw new PoisonError();
  }

  /** True when this expression's CHECKER type is `any`-flavored — the
   * gate anyOpFence's call sites use to tell `any`-origin dyn values
   * (the engine could run the operation) from genuine `unknown` ones. */
  anyOrigin(node: ts.Node): boolean {
    return (this.typeOf(node).flags & ts.TypeFlags.Any) !== 0;
  }

  badType(node: ts.Node, type: ts.Type): never {
    const widened = this.checker.getBaseTypeOfLiteralType(type);
    // Types declared by the ADOPTED @types/node (Buffer, NodeJS.Timeout,
    // the undici Response, ...) are supported-surface provenance, not npm
    // packages — their values never lower, so the honest blame is the
    // SC2020-family fence naming @types/node. Checked FIRST: Buffer has
    // an index signature and would otherwise get the misleading use-a-Map
    // hint below, and no user-side remedy the other messages suggest
    // applies to node-typed values.
    const typeSym = widened.getAliasSymbol() ?? widened.getSymbol();
    if (this.nodeTypesOnlySymbol(typeSym)) {
      this.pushDiag(noLoweringDiag(this.checker.typeToString(type), locOf(node), undefined, true));
      throw new PoisonError();
    }
    // Engine-backed ambient TYPES in a STATIC build report the per-site
    // SC2012 rather than the generic supported-types recitation. Native
    // fetch values map earlier to checked-dynamic handles and do not reach
    // here; constructor objects such as Headers still can.
    if (
      !this.dynamic &&
      typeSym &&
      (ISLAND_AMBIENT_TYPES as readonly string[]).includes(typeSym.name) &&
      this.isStdlibSymbol(typeSym)
    ) {
      this.pushDiag(requiresDynamicApiDiag(`a value of type '${typeSym.name}'`, locOf(node)));
      throw new PoisonError();
    }
    // ENUM OBJECTS (`typeof e` — a numeric enum's type carries the
    // reverse-map index signature, a string enum's just its members):
    // shaped like a hybrid record, but the enum identifier has no value
    // lowering, so the honest fence names the construct in the same voice
    // as the per-site identifier fence — never the index-signature
    // recitation.
    if (typeSym && (typeSym.flags & ts.SymbolFlags.Enum) !== 0) {
      this.pushDiag(
        unsupportedDiag(
          "SC1090",
          locOf(node),
          `enum objects as values ('${typeSym.name}' — member reads like '${typeSym.name}.X' compile to constants; the object itself has no runtime representation)`,
        ),
      );
      throw new PoisonError();
    }
    // Would-be records with INDEX SIGNATURES (`Record<string, T>`,
    // `{ [k: string]: T }`) get the index-signature fence (SC2006) naming
    // the supported key/value domain instead of the generic
    // supported-types recitation.
    if (
      widened.flags & (ts.TypeFlags.Object | ts.TypeFlags.Intersection) &&
      this.checker.getCallSignatures(widened).length === 0 &&
      this.checker.getConstructSignatures(widened).length === 0 &&
      !this.checker.isTupleType(widened) &&
      !this.checker.isArrayLikeType(widened) &&
      this.checker.getIndexInfosOfType(widened).length > 0
    ) {
      // STANDARD-LIBRARY interface/class types that carry index signatures
      // (the typed arrays — Int8Array..Float16Array): the honest story is
      // the lib fence naming the type (SC2020 — only the supported surface
      // compiles), not a use-a-Map hint no user can act on. NOMINAL lib
      // declarations only: a lib-declared ALIAS or mapped type
      // (`Record<string, object>`) is still a data shape whose own story
      // (the value type, the key domain) the fences below tell better.
      const ownSym = widened.getSymbol();
      if (
        ownSym &&
        this.checker.declarationsOf(ownSym).some(
          (d) =>
            (ts.isInterfaceDeclaration(d) || ts.isClassDeclaration(d)) &&
            this.isStdlibFile(d.getSourceFile()),
        )
      ) {
        this.pushDiag(noLoweringDiag(this.checker.typeToString(type), locOf(node)));
        throw new PoisonError();
      }
      // The MEASURED island probe, same mechanism as the general dynamic
      // reroute below: an index-signature shape the dynamic mapping
      // accepts (an `any`-valued signature absorbing into an island
      // object, jsval-entangled members) reports the retry-eligible
      // SC2011 choice instead of the static recitation.
      if (
        !this.dynamic &&
        !(widened.flags & ts.TypeFlags.Any) &&
        mapType(widened, { ...this.typeCtx, dynamic: true }) !== null
      ) { const detail = describeRecordMemberBlocker(widened, this.typeCtx) ?? describeSignatureBlocker(widened, this.typeCtx); if (detail !== null) { this.pushDiag(componentTypeDiag(this.checker.typeToString(type), detail, locOf(node))); throw new PoisonError(); } // the STATIC reason first: the member that blocks the shape names the kernel gap
        this.pushDiag(requiresDynamicTypeDiag(this.checker.typeToString(type), locOf(node)));
        throw new PoisonError();
      }
      this.pushDiag(indexSignatureTypeDiag(this.checker.typeToString(type), locOf(node)));
      throw new PoisonError();
    }
    // Package-declared types in a STATIC build: name the package, not the
    // type — the per-package requires-dynamic diagnostic (and the coverage
    // report's one-line-per-package attribution). Under --dynamic these
    // types map to jsval, so reaching here means the type is genuinely
    // unrepresentable (a jsval union arm, a jsval array element) — the
    // generic type message tells that story better.
    if (!this.dynamic) {
      const pkg = this.npmPackageOf(widened);
      if (pkg) {
        this.pushDiag(requiresDynamicPackageDiag(pkg, locOf(node)));
        throw new PoisonError();
      }
    }
    // A type that keeps a GENERIC call signature (`<T>(x: T) => T` slots,
    // stored generic functions, higher-order-generic call results): the
    // pointed monomorphization message instead of the recitation. Union
    // arms count — a `(<T>(x: T) => T) | undefined` slot is the same
    // story through its callable arm. After the package check: a
    // package-declared generic signature stays the package's story.
    {
      const parts = widened.isUnionType() ? ts.constituentTypes(widened) : [widened];
      if (
        parts.some((p) =>
          this.checker.getCallSignatures(p).some((s) => (s.typeParameters?.length ?? 0) > 0),
        )
      ) {
        this.pushDiag(genericSignatureTypeDiag(this.checker.typeToString(type), locOf(node)));
        throw new PoisonError();
      }
    }
    // A type the DYNAMIC mapping accepts (`any[]`, records/functions with
    // `any`-typed members, .d.ts-declared shapes whose values are island
    // handles): the honest per-site story is the dynamic-family choice, not
    // the supported-types recitation — proved by re-running mapType with
    // `dynamic: true`, never guessed from the type text. Probing is safe
    // here: a diagnostic means this build already failed, so anything the
    // probe interns or registers on the way is never emitted. Return-only
    // island carriers such as ArrayBuffer are excluded: their constructors
    // keep SC2020. Checked LAST so the more-specific stories above keep
    // their own fence class. Bare `any` is excepted: unsupportedTypeDiag's own
    // SC2011 arm tells that story with the stronger stay-static remedy
    // ('unknown' + a checked cast).
    if (
      !this.dynamic &&
      !(widened.flags & ts.TypeFlags.Any) &&
      !(typeSym?.name === "ArrayBuffer" && this.isStdlibSymbol(typeSym)) &&
      mapType(widened, { ...this.typeCtx, dynamic: true }) !== null
    ) {
      const detail = describeRecordMemberBlocker(widened, this.typeCtx) ?? describeSignatureBlocker(widened, this.typeCtx); this.pushDiag(detail !== null ? componentTypeDiag(this.checker.typeToString(type), detail, locOf(node)) : requiresDynamicTypeDiag(this.checker.typeToString(type), locOf(node)));
      throw new PoisonError();
    }
    // STANDARD-LIBRARY nominal provenance, decided once: interface/class
    // declarations in the lib's own files (Date, ArrayBuffer, WeakMap, the
    // iterator/constructor interfaces). Such types report the SC2020 story
    // below — the same one the index-signature-carrying lib types above
    // tell — rather than an overload/record claim no user can act on.
    const stdlibOwnSym = widened.getSymbol();
    const stdlibNominal =
      stdlibOwnSym !== undefined &&
      this.checker.declarationsOf(stdlibOwnSym).some(
        (d) =>
          (ts.isInterfaceDeclaration(d) || ts.isClassDeclaration(d)) &&
          this.isStdlibFile(d.getSourceFile()),
      );
    // OVERLOADED call signatures (SC2007) — after the generic branch, so a
    // generic overload set keeps the monomorphization story: a value of a
    // multi-signature type has no single compiled signature to hold.
    if (!stdlibNominal && this.checker.getCallSignatures(widened).length > 1) {
      this.pushDiag(overloadedSignatureTypeDiag(this.checker.typeToString(type), locOf(node)));
      throw new PoisonError();
    }
    // INTERSECTIONS that resolved to no lowering (SC2008). The ones that
    // compile never get here: member intersections intern through the
    // record path, callable hybrids map to '%call' records, and pinned
    // mixin instantiations resolve by chain structure.
    if (widened.isIntersectionType()) {
      this.pushDiag(intersectionTypeDiag(this.checker.typeToString(type), locOf(node)));
      throw new PoisonError();
    }
    // SUPPORTED shapes over a component outside its slot (SC2009): the
    // Map/Set domains, array/tuple elements, union arms, function
    // parameters/returns. The container is not the blocker — name the
    // component instead of reciting the supported set. Checked BEFORE the
    // lib claim so Map/Set/Promise instantiation failures keep their
    // component story (describeComponentBlocker always answers for those
    // heads).
    {
      const detail = describeComponentBlocker(widened, this.typeCtx);
      if (detail !== null) {
        this.pushDiag(componentTypeDiag(this.checker.typeToString(type), detail, locOf(node)));
        throw new PoisonError();
      }
    }
    // STANDARD-LIBRARY nominal types with no lowering at all: the SC2020
    // story, naming the type — and for the families with a WHY, the same
    // pointed reason the identifier/constructor chokepoints teach.
    if (stdlibNominal) {
      const intlHint =
        "Intl formatter values have no representation — the COMPOSED en-US forms lower: " +
        'new Intl.NumberFormat("en-US").format(x) and x.toLocaleString("en-US") with default options; ' +
        "the rest is ICU locale data the binary does not carry";
      const typeHints: Record<string, string | undefined> = {
        ArrayBuffer:
          "no free-standing ArrayBuffer value exists — typed arrays own their storage " +
          "(new Uint8Array(n) allocates; new Uint8Array(new ArrayBuffer(n)) erases the buffer into the view)",
        SharedArrayBuffer:
          "no shared-memory threads exist in a compiled program — Uint8Array is the byte storage",
        NumberFormat: intlHint,
        DateTimeFormat: intlHint,
        DurationFormat: intlHint,
        PluralRules: intlHint,
        Collator: intlHint,
        ListFormat: intlHint,
        RelativeTimeFormat: intlHint,
        Segmenter: intlHint,
        DisplayNames: intlHint,
        TextEncoder:
          "TextEncoder values have no representation — call through a const initialized with new TextEncoder(), or use the composed new TextEncoder().encode(s) form",
        TextDecoder:
          "TextDecoder values have no representation — call through a const initialized with a recognized literal label, or use the composed new TextDecoder(<literal label>).decode(bytes) form",
      };
      this.pushDiag(
        noLoweringDiag(this.checker.typeToString(type), locOf(node), typeHints[stdlibOwnSym?.name ?? ""]),
      );
      throw new PoisonError();
    }
    // USER record shapes blocked by ONE member (SC2009's record arm):
    // name the member and its type.
    {
      const detail = describeRecordMemberBlocker(widened, this.typeCtx) ?? describeSignatureBlocker(widened, this.typeCtx);
      if (detail !== null) {
        this.pushDiag(componentTypeDiag(this.checker.typeToString(type), detail, locOf(node)));
        throw new PoisonError();
      }
    }
    this.pushDiag(unsupportedTypeDiag(this.checker.typeToString(type), locOf(node)));
    throw new PoisonError();
  }
  /** The lib fence (SC2020): a reached use of standard-library surface
   * nothing lowers. Poisons the statement like every other rejection.
   * `sym`, when given, picks the wording: surface declared only by the
   * adopted @types/node is blamed at @types/node. */
  noLowering(surface: string, node: ts.Node, hint?: string, sym?: ts.Symbol | null): never {
    this.pushDiag(noLoweringDiag(surface, locOf(node), hint, this.nodeTypesOnlySymbol(sym)));
    throw new PoisonError();
  }

  stdlibMemberFence(access: ts.PropertyAccessExpression): void {
    return stdlibMemberFence(this, access);
  }

  fenceStaticResponseMember(
    access: ts.PropertyAccessExpression | ts.ElementAccessExpression,
    use: "read" | "call",
  ): IrExpr | null {
    return fenceStaticResponseMember(this, access, use);
  }

  fenceUnsupportedFetchConstructorMember(
    access: ts.PropertyAccessExpression | ts.ElementAccessExpression,
  ): IrExpr | null {
    return fenceUnsupportedFetchConstructorMember(this, access);
  }

  fenceStaticHeadersMember(
    access: ts.PropertyAccessExpression | ts.ElementAccessExpression,
    use: "read" | "call",
  ): IrExpr | null {
    return fenceStaticHeadersMember(this, access, use);
  }

  fenceStaticAbortControllerMemberRead(
    access: ts.PropertyAccessExpression | ts.ElementAccessExpression,
  ): IrExpr | null {
    return fenceStaticAbortControllerMemberRead(this, access);
  }

  fenceStaticHeadersIteration(node: ts.Node): void {
    return fenceStaticHeadersIteration(this, node);
  }

  fenceFetchObjectAssignment(
    target: ts.ObjectLiteralExpression,
    source: ts.Expression,
  ): void {
    return fenceFetchObjectAssignment(this, target, source);
  }

  lowerDynamicHeadersIteratorCall(
    call: ts.CallExpression,
    access: ts.ElementAccessExpression,
  ): IrExpr | null {
    return lowerDynamicHeadersIteratorCall(this, call, access);
  }

  lowerDynamicHeadersSpread(
    node: ts.Expression,
    type: IrType & { kind: "array" },
  ): IrExpr | null {
    return lowerDynamicHeadersSpread(this, node, type);
  }

  fenceStaticReadableStreamMember(
    access: ts.PropertyAccessExpression | ts.ElementAccessExpression,
    use: "read" | "call",
  ): IrExpr | null {
    return fenceStaticReadableStreamMember(this, access, use);
  }

  typeOf(node: ts.Node): ts.Type {
    // Inside an optional-chain body the guarded receiver is typed by its
    // NON-NULLISH type (the chain's tag test proved it), so every
    // receiver-kind check downstream sees the narrowed arm.
    const narrowed = this.chainNarrowedType.get(node);
    if (narrowed) return narrowed;
    const t = this.checker.getTypeAtLocation(node);
    // ALIASED-TYPEOF narrowing: inside a branch a `type === 'string'`
    // test proves (type = typeof val, both never reassigned), references
    // to the tested operand answer the proven arm — the var/let alias
    // form the checker only narrows for consts. Checked before the
    // implicit-param hook: a branch narrow is strictly more specific
    // than a call-site binding.
    if (this.aliasNarrowTypes.size > 0 && ts.isIdentifier(node)) {
      const sym = this.checker.getSymbolAtLocation(node);
      const arm = sym !== undefined ? this.aliasNarrowTypes.get(sym) : undefined;
      if (arm !== undefined) return arm;
    }
    // IMPLICIT-ANY instance bodies: an identifier reference to a BOUND
    // param answers the call site's concrete type wherever the checker
    // still says `any` (there is no `T` for mapType to substitute — the
    // binding rides here instead). Where tsc's own flow analysis DID
    // narrow the `any` (typeof/instanceof guards), a narrow CONSISTENT
    // with the binding wins — it IS the binding, an arm of it, or a
    // subclass; a CONTRADICTING narrow is the statically-dead branch of a
    // typeof dispatch this instantiation cannot take, and answering the
    // bound type there keeps dead branches on honest fences instead of
    // lowering the live value under a lying type.
    if (this.implicitParamTypes !== null && ts.isIdentifier(node)) {
      const sym = this.checker.getSymbolAtLocation(node);
      const bound = sym !== undefined ? this.implicitParamTypes.get(sym) : undefined;
      if (bound !== undefined && bound !== t) {
        if (t.flags & ts.TypeFlags.Any) return bound;
        const narrowedIr = this.mapTypeOf(t);
        const boundIr = this.mapTypeOf(bound);
        if (narrowedIr === null || boundIr === null) return bound;
        if (typeEquals(narrowedIr, boundIr)) return t;
        // A union binding narrowed to one of its arms (typeof/equality
        // guards over string|number bindings) — the narrow is truth.
        if (boundIr.kind === "union") {
          const arms = this.unions.get(boundIr.unionId)?.arms ?? [];
          const nArms =
            narrowedIr.kind === "union" ? (this.unions.get(narrowedIr.unionId)?.arms ?? [narrowedIr]) : [narrowedIr];
          if (nArms.every((n) => arms.some((a) => typeEquals(a, n)))) return t;
          return bound;
        }
        // An instanceof narrow to a SUBCLASS of the bound class — truth.
        if (
          boundIr.kind === "object" && narrowedIr.kind === "object" &&
          this.isSubclassOf(narrowedIr.className, boundIr.className)
        ) {
          return t;
        }
        return bound;
      }
    }
    return t;
  }

  /** mapType with this Lowerer's registries and (while a generic instance
   * body lowers) type-parameter bindings threaded through. */
  mapTypeOf(t: ts.Type): IrType | null {
    return mapType(t, this.typeCtx);
  }

  /** The one position where a contextual UNION must not be adopted over the
   * expression's own: the LEFT operand of `&&`, `||`, or `??`. Adopting a
   * contextual union is normally safe because tsc proved the value
   * assignable to the slot; that proof does not exist here, because tsc
   * builds a logical operator's result by DROPPING the left's falsy (or
   * nullish) arms. `const s: string | null = (c ? env : undefined) || null`
   * contextually types the ternary `string | null` while its value is
   * `string | undefined` — adopting that strands the very arm the operator
   * exists to answer, throwing where Node yields the default. Such operands
   * represent by their own union; the operator's own lowering re-tags on
   * the branch where the dropped arms are gone. Narrow by design: only the
   * union choice is unsound here. A contextual ARRAY still types the
   * element, and an unmappable own type still falls back to the context. */
  inLogicalLeftPosition(node: ts.Expression): boolean {
    let n: ts.Node = node;
    while (n.parent && ts.isParenthesizedExpression(n.parent)) n = n.parent;
    const p = n.parent;
    if (!p || !ts.isBinaryExpression(p) || p.left !== n) return false;
    const k = p.operatorToken.kind;
    return (
      k === ts.SyntaxKind.AmpersandAmpersandToken ||
      k === ts.SyntaxKind.BarBarToken ||
      k === ts.SyntaxKind.QuestionQuestionToken
    );
  }

  /** True when a ?. token blocks this lowering — i.e. it is NOT the one an
   * active optional-chain lowering is currently handling. Every receiver-
   * typed lowering that supports chained receivers guards with this
   * instead of a raw questionDotToken check. */
  chainBlocked(
    ...nodes: (ts.CallExpression | ts.PropertyAccessExpression | ts.ElementAccessExpression)[]
  ): boolean {
    return nodes.some((n) => n.questionDotToken !== undefined && !this.chainHandled.has(n));
  }

  /** formatIrType with this Lowerer's registries (records and unions expand
   * to their structure in diagnostics). */
  fmt(t: IrType): string {
    return formatIrType(t, this.shapes, this.unions);
  }

  /** Whether an IR value has JavaScript Array identity. Homogeneous arrays
   * use the native array representation; non-empty fixed tuples use a
   * positional record shape so their slots can keep distinct types, but
   * Array.isArray must still answer true for both representations. */
  isArrayValueType(t: IrType): boolean {
    return t.kind === "array" || (t.kind === "record" && this.shapes.get(t.shapeId)?.tuple === true);
  }

  /** Runtime tags of every JavaScript-array arm in one union. Kept beside
   * isArrayValueType so Array.isArray's predicate and its narrowing bridge
   * cannot disagree about fixed tuple arms. */
  arrayValueTags(unionId: string): number[] {
    const def = this.unions.get(unionId);
    return def ? def.arms.flatMap((arm, tag) => (this.isArrayValueType(arm) ? [tag] : [])) : [];
  }

  /** Checked JSON conversion excludes undefined array slots because JSON
   * text cannot preserve that distinction. */
  jsonSafe(t: IrType): boolean {
    return isJsonSafeType(
      t,
      (id) => this.shapes.get(id),
      (id) => this.unions.get(id),
    );
  }

  jsonStringifySafe(t: IrType): boolean {
    return isJsonStringifySafeType(
      t,
      (id) => this.shapes.get(id),
      (id) => this.unions.get(id),
    );
  }

  /** True when a type is a BARE undefined-armed union — the one JSON-unsafe
   * shape whose rejections deserve their own wording: Node's stringify of
   * bare undefined is not a string at all and JSON text never matches the
   * arm, so exactness is unreachable and the fixes (narrow first / null arm
   * / make it an optional record FIELD, where drop-and-absent semantics ARE
   * Node's) are specific. Record fields don't count: an undefined-armed
   * union in field position is JSON-safe (isJsonSafeType), so a record that
   * still fails the fence does so for some other reason. */
  bareUndefinedArmedUnion(t: IrType): boolean {
    return isUndefinedArmedUnion(t, (id) => this.unions.get(id));
  }

  /** canCrossIslandBoundary with this Lowerer's registries — THE test
   * behind every marshal/exit decision (the implicit coercions, jsvalIn,
   * the checked island-exit cast). Rejections that follow a false answer
   * speak through boundaryIntoIslandMsg / boundaryOutOfIslandMsg. */
  boundarySafe(t: IrType): boolean {
    return canCrossIslandBoundary(
      t,
      (id) => this.shapes.get(id),
      (id) => this.unions.get(id),
    );
  }

  /** canExitIslandToType with this Lowerer's registries — the EXIT
   * direction's slightly wider test (bare undefined-armed unions of
   * JSON-safe data arms exit; the engine's undefined takes the undefined
   * arm before the JSON round trip). */
  boundaryExitSafe(t: IrType): boolean {
    return canExitIslandToType(
      t,
      (id) => this.shapes.get(id),
      (id) => this.unions.get(id),
    );
  }

  isIslandExpr(node: ts.Expression): boolean {
    return isIslandExpr(this, node);
  }

  /** True when this node's CHECKER type is proven `any[]`/`unknown[]`,
   * directly or through the intersection tsc builds for a readonly tuple
   * union (`(Model | readonly [Model, Command]) & any[]`; TS7 distributes
   * this over the union arms). These are forms of the `arg is any[]`
   * Array.isArray predicate; the VALUE behind them can still be a real
   * static array/tuple (maybeNarrow's bridge extracts the union's one
   * array-valued arm), so receiver-typed dispatch falls back to the LOWERED
   * type under this test. */
  checkerAnyArray(node: ts.Expression): boolean {
    return this.checkerAnyArrayType(this.typeOf(node));
  }

  /** Type-level half of checkerAnyArray, for narrowing sites that already
   * queried the checker type from a general AST node. */
  checkerAnyArrayType(t: ts.Type): boolean {
    const isAnyArray = (part: ts.Type): boolean =>
      this.checker.isArrayType(part) &&
      ((this.checker.getTypeArguments(part as ts.TypeReference)[0]?.flags ?? 0) &
        (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0;
    const visit = (part: ts.Type): boolean => {
      if (isAnyArray(part)) return true;
      // 5.9 leaves `(U) & any[]` as one intersection; 7 distributes it
      // into `(A & any[]) | (B & any[])`. An intersection is array-proven
      // when one constituent is; a union is array-proven only when EVERY
      // arm is, so an ordinary `any[] | string` never qualifies.
      if ((part.flags & ts.TypeFlags.Intersection) !== 0) {
        return ts.constituentTypes(part).some(visit);
      }
      if (part.isUnionType()) return ts.constituentTypes(part).every(visit);
      return false;
    };
    return visit(t);
  }

  /** The lowered static array/tuple value behind checkerAnyArray's
   * synthetic `any[]` spelling. Array.isArray can leave readonly tuple
   * unions as intersections that do not map directly, while maybeNarrow
   * still extracts the runtime-proven array arm from the original union.
   * Receiver dispatchers use this bridge instead of the synthetic type. */
  checkerArrayValue(node: ts.Expression): IrExpr | null {
    if (!this.checkerAnyArray(node)) return null;
    const value = this.lowerExpr(node);
    return this.isArrayValueType(value.type) ? value : null;
  }

  /** Substitutes a bound type parameter anywhere inside mapType's recursion
   * (`T`, `T[]`, `{ v: T }`, `(x: T) => T` all resolve). Inert outside
   * generic instantiation. */
  readonly typeParamResolver = (t: ts.Type): IrType | null => {
    if (!this.typeParamBindings || !(t.flags & ts.TypeFlags.TypeParameter)) return null;
    const sym: ts.Symbol | undefined = t.getSymbol();
    return (sym && this.typeParamBindings.get(sym)) ?? null;
  };

  /** The ts-level twin of typeParamResolver: the bound CHECKER type of a
   * type parameter in the current instantiation (typeParamTsBindings), for
   * the resolutions where mapType's widening already dropped what the body
   * needs (indexed accesses over literal-bound keys). Inert outside
   * call-keyed generic instantiation. */
  readonly typeParamTsResolver = (t: ts.Type): ts.Type | null => {
    if (!this.typeParamTsBindings || !(t.flags & ts.TypeFlags.TypeParameter)) return null;
    const sym: ts.Symbol | undefined = t.getSymbol();
    return (sym && this.typeParamTsBindings.get(sym)) ?? null;
  };

  irTypeOf(node: ts.Node): IrType {
    const t = this.typeOf(node);
    // Inferred JS array residues must not invent a numeric or unit-only ABI.
    if (jsArrayInferenceBinding(node, this.checker)) return DYN;
    const mapped = neverTaintedJsType(this, node, t) ? null : this.mapTypeOf(t);
    if (!mapped) {
      // The checked-dynamic declaration fallback (dynFallbackType): a
      // JAVASCRIPT binding of any inference residue, or a TypeScript
      // binding of genuine checker-`any`, becomes the checked-dynamic
      // kind instead of a compile fence — 'unknown' with the boundary
      // checks coerceToExpected already applies (dynFrom into the slot,
      // validated dynCheck out) and per-site fences for operations dyn
      // cannot carry. JS arrays keep their array-ness (any[]/never[]
      // evolving arrays become unknown[]), so length/push/index still
      // lower.
      const dyn = dynFallbackType(this, node, t);
      if (dyn) return dyn;
      this.badType(node, t);
    }
    return mapped;
  }

  /** Exact-shape enforcement (SC2002). Records are monomorphic structs, so
   * everywhere a value flows into a typed slot (call arg, initializer,
   * assignment, field, return) the shapes must MATCH — or width-coerce:
   * coerceToExpected already ran widthCoerce (the copy-reshape family),
   * so what reaches here is the RESIDUE its rules decline, and the
   * diagnostic names the first blocking rule (describeRecordWidthBlocker).
   * Non-record mismatches are not reachable through tsc-clean programs; the
   * validator ICEs on them as the usual backstop. */
  requireExactShape(node: ts.Node, actual: IrType, expected: IrType): void {
    if (typeEquals(actual, expected)) return;
    // dyn mismatches first. A dyn ('unknown') value flowing into a typed
    // slot needs a CHECKED cast — the hint points at `as <type>`; tsc
    // usually rejects this before we do, so the fence is mostly defensive.
    // The reverse — a TYPED value flowing into an 'unknown' slot
    // (`const u: unknown = 5`, an unknown-typed param/return) — IS tsc-clean
    // and rejected here: a typed value has no dynamic representation
    // (constructing a dyn from static values is deliberately out this
    // round; only JSON.parse results are dyn).
    if (actual.kind === "dyn") {
      this.unsupported(
        "SC1100",
        node,
        `passing 'unknown' values where '${this.fmt(expected)}' is expected`,
      );
    }
    if (expected.kind === "dyn") {
      // Function values BOX into dyn when their signature crosses
      // (canBoxFuncIntoDyn — coerceToExpected already converted those), so
      // reaching here with a func means a param/result type outside the
      // conversion domains, a generic signature's residue, or an overload
      // set — name the shape instead of the generic typed-to-unknown
      // wording.
      if (actual.kind === "func") {
        this.unsupported(
          "SC1101",
          node,
          `passing '${this.fmt(actual)}' function values into 'unknown' slots (a parameter or result type has no dynamic representation — only JSON-safe data, Uint8Array, undefined-armed unions of those, 'unknown', and functions over the same set cross)`,
        );
      }
      this.unsupported("SC1101", node);
    }
    // jsval mismatches surviving coerceToExpected involve a type with no
    // island representation (in) or no validated exit (out).
    if (actual.kind === "jsval") {
      this.unsupported("SC1090", node, boundaryOutOfIslandMsg(this.fmt(expected)));
    }
    if (expected.kind === "jsval") {
      this.unsupported("SC1090", node, boundaryIntoIslandMsg(this.fmt(actual)));
    }
    // Class-value mismatches: the pointed stories — a widening whose
    // constructor ABIs differ (construction through the slot would
    // dispatch a mismatched signature), or a structural flow between
    // unrelated classes (nominal identity is the IR's only class
    // subtyping, instances and values alike).
    if (actual.kind === "classval" && expected.kind === "classval") {
      const sub = this.classes.get(actual.className);
      const sup = this.classes.get(expected.className);
      if (sub && sup && this.isSubclassOf(actual.className, expected.className)) {
        this.unsupported(
          "SC1090",
          node,
          `class values whose constructor signatures differ ('${this.fmt(actual)}' into a '${this.fmt(expected)}' slot: construction through the slot completes against the base signature, which '${sub.def.jsName ?? actual.className}' does not share — declare matching constructor parameters)`,
        );
      }
      this.unsupported(
        "SC1090",
        node,
        `structurally-typed class-value flows ('${this.fmt(actual)}' into a '${this.fmt(expected)}' slot: only a class and its subclasses share a slot — extend the base class)`,
      );
    }
    // Union-involving mismatches first: a union flowing into a different
    // union's slot (even a superset) would need a runtime re-tag — its own
    // diagnostic, not the record one. Arm-into-union coercions were already
    // wrapped by coerceToExpected before this check runs.
    if (containsUnion(actual) || containsUnion(expected)) {
      this.pushDiag(unionMismatchDiag(this.fmt(expected), this.fmt(actual), locOf(node)));
      throw new PoisonError();
    }
    if (containsRecord(actual) || containsRecord(expected)) {
      // A record→record pair gets the pointed story: WHICH width rule
      // declined (a field that doesn't lift, a required field with no
      // source, an index signature that could hold the completed key).
      const detail =
        actual.kind === "record" && expected.kind === "record"
          ? (this.describeRecordWidthBlocker(actual.shapeId, expected.shapeId) ?? undefined)
          : undefined;
      this.pushDiag(recordShapeMismatchDiag(this.fmt(expected), this.fmt(actual), locOf(node), detail));
      throw new PoisonError();
    }
    // Everything else — a plain-kind mismatch like a string flowing into a
    // class-instance slot — is tsc-rejected in the lowering world and only
    // reaches here through preflight's project-world second chance (e.g. a
    // Promise reject called with a non-Error reason, clean under the lib's
    // `reason?: any`). The honest fence; silence would hand the emitter a
    // reinterpret and the validator an ICE.
    this.unsupported(
      "SC1090",
      node,
      `'${this.fmt(actual)}' values where '${this.fmt(expected)}' is expected`,
    );
  }

  /** Unwraps a HYBRID (function-with-properties) record to its callable:
   * a record whose shape carries the reserved `%call` func field reads
   * that field; anything else returns unchanged. The consumer half of
   * type-mapper.ts's chalk-shape mapping — call paths and func-slot coercions
   * share it. */
  hybridCallUnwrap(expr: IrExpr): IrExpr {
    if (expr.type.kind !== "record") return expr;
    const shape = this.shapes.get(expr.type.shapeId);
    const call = shape?.fields.find((f) => f.name === "%call");
    if (!call || call.type.kind !== "func") return expr;
    return { kind: "recordGet", obj: expr, shapeId: expr.type.shapeId, field: "%call", type: call.type, loc: expr.loc };
  }

  /** The tag of the union arm equal to `arm`, or -1 (unknown union / no
   * such arm). Arm lists are canonical (typeKey-sorted) and interned, so
   * this is THE tag for that (union, arm) pair program-wide — every wrap,
   * narrow, and tag test agrees by construction. */
  armTag(unionId: string, arm: IrType): number {
    const def = this.unions.get(unionId);
    return def ? def.arms.findIndex((a) => typeEquals(a, arm)) : -1;
  }

  coerceToExpected(expr: IrExpr, expected: IrType): IrExpr {
    return coerceToExpected(this, expr, expected);
  }

  widthCoerce(expr: IrExpr, expected: IrType): IrExpr | null {
    return widthCoerce(this, expr, expected);
  }

  widthLiftPlan(src: IrType, dst: IrType): WidthLift | null {
    return widthLiftPlan(this, src, dst);
  }

  unitOnlyElem(t: IrType): boolean {
    return unitOnlyElem(this, t);
  }

  applyWidthLift(lift: WidthLift, value: IrExpr, dst: IrType, loc: SrcLoc): IrExpr {
    return applyWidthLift(this, lift, value, dst, loc);
  }

  recordWidthPlan(fromId: string, toId: string): Map<string, { src: IrType; lift: WidthLift } | { absent: true; utag: number } | { absentDyn: true } | { indexDyn: true }> | null {
    return recordWidthPlan(this, fromId, toId);
  }

  describeRecordWidthBlocker(fromId: string, toId: string): string | null {
    return describeRecordWidthBlocker(this, fromId, toId);
  }

  recordWidthHelper(fromId: string, toId: string, loc: SrcLoc): string | null {
    return recordWidthHelper(this, fromId, toId, loc);
  }

  tupleArrayWidthHelper(fromId: string, toT: IrType & { kind: "array" }, loc: SrcLoc): string | null {
    return tupleArrayWidthHelper(this, fromId, toT, loc);
  }

  emptyArrayLiftHelper(fromT: IrType & { kind: "array" }, toT: IrType & { kind: "array" }, loc: SrcLoc): string {
    return emptyArrayLiftHelper(this, fromT, toT, loc);
  }

  arrayWidthHelper(fromT: IrType & { kind: "array" }, toT: IrType & { kind: "array" }, loc: SrcLoc): string | null {
    return arrayWidthHelper(this, fromT, toT, loc);
  }

  objToRecordPlan(className: string, toId: string): Map<string, { src: IrType; lift: WidthLift } | { absent: true; utag: number }> | null {
    return objToRecordPlan(this, className, toId);
  }

  objRecordWidthHelper(className: string, toId: string, loc: SrcLoc): string | null {
    return objRecordWidthHelper(this, className, toId, loc);
  }

  recordToClassPlan(fromId: string, className: string): ({ field: string; src: IrType; lift: WidthLift } | { absent: true })[] | null {
    return recordToClassPlan(this, fromId, className);
  }

  recordClassWidthHelper(fromId: string, className: string, loc: SrcLoc): string | null {
    return recordClassWidthHelper(this, fromId, className, loc);
  }

  classStaticsProjection(className: string, toId: string, loc: SrcLoc): IrExpr | null {
    return classStaticsProjection(this, className, toId, loc);
  }

  funcReturnWidthAdapter(fromT: IrType & { kind: "func" }, toT: IrType & { kind: "func" }, loc: SrcLoc): string | null {
    return funcReturnWidthAdapter(this, fromT, toT, loc);
  }

  coercibleValue(src: IrType, dst: IrType): boolean {
    return coercibleValue(this, src, dst);
  }

  cleanFuncAdaptable(src: IrType & { kind: "func" }, dst: IrType & { kind: "func" }): boolean {
    return cleanFuncAdaptable(this, src, dst);
  }

  funcCoerceAdapter(fromT: IrType & { kind: "func" }, toT: IrType & { kind: "func" }, loc: SrcLoc): string | null {
    return funcCoerceAdapter(this, fromT, toT, loc);
  }

  dynRestIslandAdapter(value: IrExpr, loc: SrcLoc): IrExpr | null {
    return dynRestIslandAdapter(this, value, loc);
  }

  spawnResFnAdapterPlan(fromT: IrType & { kind: "func" }, toT: IrType & { kind: "func" }): { field: string; build: (r: IrExpr, loc: SrcLoc) => IrExpr }[] | null {
    return spawnResFnAdapterPlan(this, fromT, toT);
  }

  spawnResFnAdapter(fromT: IrType & { kind: "func" }, toT: IrType & { kind: "func" }, loc: SrcLoc): string | null {
    return spawnResFnAdapter(this, fromT, toT, loc);
  }

  unionRetagMappable(fromId: string, toId: string): boolean {
    return unionRetagMappable(this, fromId, toId);
  }

  narrowedRetagHelper(node: ts.Node, fromId: string, toId: string, loc: SrcLoc): string | null {
    return narrowedRetagHelper(this, node, fromId, toId, loc);
  }

  strandedUnitTrap(expr: IrExpr, expected: IrType, loc: SrcLoc): IrExpr | null {
    return strandedUnitTrap(this, expr, expected, loc);
  }

  strandedCoercionTrap(expr: IrExpr, expected: IrType & { kind: "union" }, loc: SrcLoc): IrExpr | null {
    return strandedCoercionTrap(this, expr, expected, loc);
  }

  unionRetagHelper(fromId: string, toId: string, loc: SrcLoc, trappable?: ReadonlySet<number>): string | null {
    return unionRetagHelper(this, fromId, toId, loc, trappable);
  }

  narrowedArmHelper(fromId: string, target: IrType, loc: SrcLoc): string | null {
    return narrowedArmHelper(this, fromId, target, loc);
  }

  deferredReadHelper(fromId: string, target: IrType, loc: SrcLoc): string | null {
    return deferredReadHelper(this, fromId, target, loc);
  }

  jsvalLiftable(t: IrType, visiting: Set<string> = new Set()): boolean {
    return jsvalLiftable(this, t, visiting);
  }

  jsvalLiftExpr(e: IrExpr, loc: SrcLoc): IrExpr {
    return jsvalLiftExpr(this, e, loc);
  }

  unionToJsvalHelper(unionId: string, loc: SrcLoc): string {
    return unionToJsvalHelper(this, unionId, loc);
  }

  recordToJsvalHelper(shapeId: string, loc: SrcLoc): string {
    return recordToJsvalHelper(this, shapeId, loc);
  }

  arrayToJsvalHelper(elem: IrType, loc: SrcLoc): string {
    return arrayToJsvalHelper(this, elem, loc);
  }

  arrayToJsvalArrayHelper(fromElem: IrType, loc: SrcLoc): string | null {
    return arrayToJsvalArrayHelper(this, fromElem, loc);
  }

  jsvalIn(e: IrExpr, node: ts.Node): IrExpr {
    return jsvalIn(this, e, node);
  }

  coerceInto(node: ts.Node, expr: IrExpr, expected: IrType): IrExpr {
    return coerceInto(this, node, expr, expected);
  }

  provenUnitAnyOf(node: ts.Node, value: IrExpr): string | null {
    return provenUnitAnyOf(this, node, value);
  }

  lowerExprExpecting(node: ts.Expression, expected: IrType | undefined): IrExpr {
    return lowerExprExpecting(this, node, expected);
  }

  intoIndexValueSlot(value: IrExpr, indexValue: IrType, node: ts.Node): IrExpr {
    return intoIndexValueSlot(this, value, indexValue, node);
  }

  withUndefinedArmOf(t: IrType): IrType | null {
    return withUndefinedArmOf(this, t);
  }

  dynConvertible(t: IrType): boolean {
    return dynConvertible(this, t);
  }

  lowerReturnValue(node: ts.Expression): IrExpr | null {
    return lowerReturnValue(this, node);
  }

  lowerReturnStmt(node: ts.Expression, loc: SrcLoc): IrStmt {
    return lowerReturnStmt(this, node, loc);
  }

  maybeNarrow(expr: IrExpr, node: ts.Node): IrExpr {
    return maybeNarrow(this, expr, node);
  }

  lowerUnitComparison(left: IrExpr,
    right: IrExpr,
    negated: boolean,
    loc: SrcLoc,): IrExpr | null {
    return lowerUnitComparison(this, left, right, negated, loc);
  }

  lowerNullishCoalesce(expr: ts.BinaryExpression, loc: SrcLoc): IrExpr {
    return lowerNullishCoalesce(this, expr, loc);
  }

  lowerOptionalChain(expr: ts.CallExpression | ts.PropertyAccessExpression | ts.ElementAccessExpression,): IrExpr {
    return lowerOptionalChain(this, expr);
  }

  finishOptionalChain(expr: ts.Expression,
    id: string,
    receiver: IrExpr,
    body: IrExpr,
    loc: SrcLoc,): IrExpr {
    return finishOptionalChain(this, expr, id, receiver, body, loc);
  }

  /* ── functions ────────────────────────────────────────────────────── */

  /** The union without `t`'s undefined arm (unchanged when there is none, or
   * when `t` isn't a union). The body-facing type of a defaulted parameter:
   * tsc types uses of `x: string | undefined = "hi"` as plain `string` inside
   * the body — the default removes exactly the undefined possibility. */
  stripUndefinedArm(t: IrType): IrType {
    if (t.kind !== "union") return t;
    const def = this.unions.get(t.unionId);
    if (!def || !def.arms.some((a) => a.kind === "undefinedT")) return t;
    const rest = def.arms.filter((a) => a.kind !== "undefinedT");
    if (rest.length === 1) return rest[0]!;

    return { kind: "union", unionId: this.unions.intern(rest, def.discriminant) };
  }

  /** The interned `T | undefined` union over a non-union arm type — the ABI
   * type of a defaulted parameter, and the result type of lookups that may
   * miss (process.env reads). "undefined" sorts last among all arm typeKeys,
   * so the sorted pair is always [t, undefined]. */
  withUndefinedArm(t: IrType): IrType {
    const arms = [t, UNDEFINED_T].sort((a, b) => (typeKey(a) < typeKey(b) ? -1 : 1));
    return { kind: "union", unionId: this.unions.intern(arms) };
  }

  paramShape(param: ts.ParameterDeclaration): ParamShape {
    return paramShape(this, param);
  }

  checkDefaultParamBodyType(param: ts.ParameterDeclaration, bodyType: IrType): void {
    return checkDefaultParamBodyType(this, param, bodyType);
  }

  paramShapes(params: readonly ts.ParameterDeclaration[]): ParamShape[] {
    return paramShapes(this, params);
  }

  completeArgs(argNodes: readonly ts.Expression[],
    shapes: readonly ParamShape[],
    loc: SrcLoc,
    blame: ts.Node,): IrExpr[] {
    return completeArgs(this, argNodes, shapes, loc, blame);
  }

  wrappedUndefined(type: IrType, loc: SrcLoc): IrExpr | null {
    return wrappedUndefined(this, type, loc);
  }

  /** The entry value of a binding JS initializes to `undefined` (an
   * initializer-less declaration, a hoisted `var` before its statement):
   * undefined-armed unions hold the interned undefined arm, and 'any'
   * slots hold the ENGINE's undefined — tsc's definite-assignment
   * analysis never guards `any` reads, so a jsval slot IS readable before
   * any assignment and must never stay a C-level NULL (a validated exit
   * or engine op on NULL is memory-unsafe, not a TypeError). Null for
   * every other type: tsc rejects their pre-assignment reads. */
  unassignedSlotInit(type: IrType, loc: SrcLoc): IrExpr | null {
    if (type.kind === "jsval") {
      return { kind: "jsOp", op: "undefLit", args: [], type: JSVAL, loc };
    }
    return this.wrappedUndefined(type, loc);
  }

  undefinedArgFor(type: IrType, loc: SrcLoc, blame: ts.Node): IrExpr {
    return undefinedArgFor(this, type, loc, blame);
  }

  requireExactArityValue(blame: ts.Node,
    contextual: ts.Expression | null,
    shapes: readonly ParamShape[],
    funcType: IrType,): void {
    return requireExactArityValue(this, blame, contextual, shapes, funcType);
  }

  bodyReturnType(isAsync: boolean, declared: IrType): IrType {
    return bodyReturnType(this, isAsync, declared);
  }
  genBodyReturnType(declared: IrType): IrType {
    return declared.kind === "generator" ? declared.retT : declared;
  }

  declaredReturnType(decl: ts.SignatureDeclaration, blame: ts.Node): IrType {
    return declaredReturnType(this, decl, blame);
  }

  /** Runs one declaration's collection with diagnostics captured: on
   * poison, they DEFER under the declaration's symbol instead of failing
   * the build — an unreached broken declaration costs nothing; the first
   * reference flushes them (flushDeferred). A declaration with no name
   * symbol reports eagerly (nothing could ever reference it). */
  collectDeferring(symbolOf: () => ts.Symbol | undefined, collect: () => void): ts.Symbol | null {
    const sink: ScrDiagnostic[] = [];
    this.diagSink = sink;
    try {
      collect();
      return null;
    } catch (e) {
      this.diagSink = null;
      const symbol = (() => {
        // symbolOf queries the checker too — a second panic must not
        // escape the fence that is handling the first.
        try {
          return symbolOf() ?? null;
        } catch {
          return null;
        }
      })();
      // An upstream tsgo panic reached through this declaration's queries
      // (the 1e999 JSON-marshal signature crossed collectSignature): the
      // declaration poisons under a source-anchored diagnostic, deferred
      // like any collection fence — never a crashed CLI.
      if (isCheckerPanic(e)) {
        const decl = symbol ? this.checker.declarationsOf(symbol)[0] : undefined;
        sink.push(checkerPanicDiag(
          e.message.split("\n", 1)[0]!,
          decl ? locOf(decl) : { file: this.entry.fileName, start: 0, end: 0 },
        ));
      } else if (!(e instanceof PoisonError)) {
        throw e;
      }
      if (!symbol) {
        for (const d of sink) this.pushDiag(d);
        return null;
      }
      const list = this.deferredDiags.get(symbol) ?? [];
      list.push(...sink);
      this.deferredDiags.set(symbol, list);
      return symbol;
    } finally {
      this.diagSink = null;
    }
  }

  /** Pushes a symbol's deferred collection diagnostics: lowering resolved
   * a reference to it, so the declaration is part of what the entry runs.
   * The reference site then proceeds exactly as before (its own rejection
   * may follow) — reached-but-broken declarations report the same set of
   * diagnostics the eager collector historically produced. */
  flushDeferred(symbol: ts.Symbol): void {
    if (this.collecting) return;
    const diags = this.deferredDiags.get(symbol);
    if (!diags) return;
    this.deferredDiags.delete(symbol);
    if (this.alreadyFlushed.has(symbol)) return; // the emit pass reported these
    this.flushedSymbols.add(symbol);
    for (const d of diags) this.pushDiag(d);
  }

  flushDeferredClass(className: string): void {
    const symbol = this.deferredClassByName.get(className);
    if (symbol) this.flushDeferred(symbol);
  }

  collectSignature(decl: ts.FunctionDeclaration): void {
    return collectSignature(this, decl);
  }

  collectSignatureInner(decl: ts.FunctionDeclaration): void {
    return collectSignatureInner(this, decl);
  }

  /* ── generic functions (monomorphization) ─────────────────────────── */

  collectGenericSignature(decl: ts.FunctionDeclaration): void {
    return collectGenericSignature(this, decl);
  }

  genericFnOf(ident: ts.Identifier): GenericFnInfo | null {
    return genericFnOf(this, ident);
  }

  lowerGenericCall(expr: ts.CallExpression, info: GenericFnInfo): IrExpr {
    return lowerGenericCall(this, expr, info);
  }

  lowerGenericFnValue(ref: ts.Expression, info: GenericFnInfo): IrExpr {
    return lowerGenericFnValue(this, ref, info);
  }

  inferTypeParamBindings(expr: ts.CallExpression,
    info: GenericFnInfo,
    rsig: ts.Signature,
    tsBindings?: Map<ts.Symbol, ts.Type>,): Map<ts.Symbol, IrType> {
    return inferTypeParamBindings(this, expr, info, rsig, tsBindings);
  }

  lowerGenericInstance(info: GenericFnInfo, inst: GenericInstance): IrFunction {
    return lowerGenericInstance(this, info, inst);
  }

  /* ── classes ──────────────────────────────────────────────────────── */

  /** Checker work class SHAPE collection performs inside otherwise
   * deferred JavaScript bodies. Constructor assignments declare fields,
   * so collection asks for each `this.x` symbol and RHS type even when the
   * constructor is unreachable. Keep that mandatory work batched without
   * sweeping unrelated dead method bodies. */
  private prefetchClassCollection(decls: readonly ts.ClassLikeDeclaration[]): void {
    const defaultTypeNodes: ts.Node[] = [];
    const typeNodes: ts.Node[] = [];
    const symbolRoots: ts.Node[] = [];
    for (const decl of decls) {
      for (const member of decl.members) {
        if (
          (ts.isConstructorDeclaration(member) ||
            ts.isMethodDeclaration(member) ||
            ts.isGetAccessor(member) ||
            ts.isSetAccessor(member)) &&
          (!ts.isMethodDeclaration(member) || member.typeParameters === undefined)
        ) {
          for (const param of member.parameters) {
            if (param.initializer) defaultTypeNodes.push(param.initializer);
          }
        }
      }
      if (!isJsSourceFile(decl.getSourceFile())) continue;
      for (const member of decl.members) {
        if (ts.isConstructorDeclaration(member)) {
          for (const param of member.parameters) {
            if (param.initializer) typeNodes.push(param.initializer);
          }
          for (const stmt of member.body?.statements ?? []) {
            if (!ts.isExpressionStatement(stmt) || !ts.isBinaryExpression(stmt.expression)) continue;
            if (stmt.expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken) continue;
            const lhs = stmt.expression.left;
            if (
              (ts.isPropertyAccessExpression(lhs) || ts.isElementAccessExpression(lhs)) &&
              lhs.expression.kind === ts.SyntaxKind.ThisKeyword
            ) {
              symbolRoots.push(lhs);
              // Field inference normally uses the symbol's type, but its
              // panic/undefined fallback asks for the assignment node too.
              typeNodes.push(lhs, stmt.expression.right);
            }
          }
          continue;
        }
        if (
          ts.isMethodDeclaration(member) ||
          ts.isGetAccessor(member) ||
          ts.isSetAccessor(member)
        ) {
          for (const param of member.parameters) {
            if (param.initializer) typeNodes.push(param.initializer);
          }
          // npm-static implicit-any classification resolves body parameter
          // references while collecting the method's shape.
          if (implicitMonoFile(decl.getSourceFile()) && member.body) {
            symbolRoots.push(member.body);
          }
        }
      }
    }
    if (defaultTypeNodes.length > 0) {
      this.checker.prefetchCollectionTypes(defaultTypeNodes);
    }
    if (typeNodes.length > 0 || symbolRoots.length > 0) {
      this.checker.prefetchClassCollection(typeNodes, symbolRoots);
    }
  }

  collectClassShape(decl: ts.ClassDeclaration): void {
    return collectClassShape(this, decl);
  }

  collectClassShapeInner(decl: ts.ClassLikeDeclaration, jsNameOverride?: string,
    inst?: { family: ClassInfo; name: string; bindings: Map<ts.Symbol, IrType>; typeArgsText: string; ordinal: number },
    mixin?: { base: ClassInfo; name: string; call: ts.CallExpression; bindings: Map<ts.Symbol, IrType>; context: string; ordinal: number },): void {
    // Late class expressions and mixin/generic instances do not participate
    // in emitReachable's initial declaration wave. Prime their mandatory
    // shape queries at the collection boundary; initial declarations are
    // already warm and this is memo-free.
    this.prefetchClassCollection([decl]);
    return collectClassShapeInner(this, decl, jsNameOverride, inst, mixin);
  }

  lowerClassExpressionInfo(expr: ts.ClassExpression): ClassInfo {
    return lowerClassExpressionInfo(this, expr);
  }

  lowerClassExpression(expr: ts.ClassExpression): IrExpr {
    return lowerClassExpression(this, expr);
  }

  /* ── the class graph (single inheritance) ─────────────────────────── */

  findMethodOn(info: ClassInfo | null,
    name: string,): { declarer: ClassInfo; sig: { params: ParamShape[]; ret: IrType; abstract?: true; async?: true } } | null {
    return findMethodOn(this, info, name);
  }

  isSubclassOf(sub: string, sup: string): boolean {
    return isSubclassOf(this, sub, sup);
  }

  inHierarchy(info: ClassInfo): boolean {
    return inHierarchy(this, info);
  }

  overrideBelow(info: ClassInfo, name: string): boolean {
    return overrideBelow(this, info, name);
  }

  upcastTo(expr: IrExpr, className: string): IrExpr {
    return upcastTo(this, expr, className);
  }

  /** True when `className` is the %Error root or any class inside its
   * hierarchy (builtin kinds and user `extends Error` subclasses). */
  errorHierarchyClassOf(className: string): boolean {
    if (className === "%Error" || RUNTIME_ERROR_CLASSES.has(className)) return true;
    for (let c = this.classes.get(className)?.base ?? null; c; c = c.base) {
      if (c.def.name === "%Error") return true;
    }
    return false;
  }

  classValueRef(info: ClassInfo, blame: ts.Node): IrExpr {
    return classValueRef(this, info, blame);
  }

  /** Class EXPRESSIONS collected this run, in first-encounter order: the
   * emit pass lowers their members after the init bodies (declaration
   * members ride fp.classDecls; expressions register only when their
   * containing statement lowers). */
  readonly exprClasses: ClassInfo[] = [];
  readonly exprClassInfoByNode = new Map<ts.ClassExpression, ClassInfo>();
  /** Class expressions whose collection is IN FLIGHT — the reentrancy
   * guard for heritage-demanded collection (lowerClassExpressionInfo). */
  readonly collectingExprClasses = new Set<ts.ClassExpression>();
  /** Static-init statements of class expressions inside the statement
   * currently lowering — lowerFileInit drains the buffer immediately
   * BEFORE that statement (JS's order for the supported whole-initializer
   * positions). */
  readonly pendingClassExprInits: IrStmt[] = [];
  /** Discovery hook: registers a just-collected expression class's member
   * bodies as worklist units (the units map is otherwise built before
   * lowering starts). Null in the emit pass. */
  onExprClassCollected: ((info: ClassInfo) => void) | null = null;

  /** Mixin functions (`(Base: T) => class extends Base {…}`) by their
   * function-like node: recognized shape, or null for checked
   * non-qualifiers (lower-mixins.ts). */
  readonly mixinFnShapes = new Map<ts.Node, MixinFnShape | null>();
  /** Mixin instantiations by CALL SITE (one class per once-evaluated call
   * — the class-expression identity rule); null marks a poisoned
   * instantiation so re-demands fence instead of half-collecting. */
  readonly mixinInstanceByCall = new Map<ts.CallExpression, ClassInfo | null>();
  /** Mixin calls whose instantiation is IN FLIGHT — the cyclic-extends
   * backstop (the collectingExprClasses rule). */
  readonly mixinCollectingCalls = new Set<ts.CallExpression>();
  /** Per mixin-class-node demand count: only the FIRST instantiation
   * counts statements toward coverage (the generic-instance rule). */
  readonly mixinOrdinals = new Map<ts.ClassLikeDeclaration, number>();
  /** The mixin instantiation whose source is CURRENTLY collecting or
   * lowering: mapType resolves the inner class node's own instance type
   * (`this` inside members, self-referential fields) to THIS
   * instantiation — the shared AST means the checker keeps answering the
   * one class node for every instantiation, like generic bindings. */
  mixinTypeContext: { classNode: ts.ClassLikeDeclaration; className: string } | null = null;
  /** PINNED mixin instantiations (const-binding / heritage call sites) by
   * their class node — the intersection resolver's candidate sets
   * (mixinIntersectionInstanceType). */
  readonly mixinInstancesByClassNode = new Map<ts.ClassLikeDeclaration, ClassInfo[]>();

  mixinCallClassInfoOf(call: ts.CallExpression): ClassInfo | null {
    return mixinCallClassInfoOf(this, call);
  }

  /** Generic classes (monomorphization by flow): declaration → the family's
   * instance table. Filled by collectClassShapeInner's family mode;
   * consulted by mapType's genericClassInstance hook. */
  readonly genericClassByDecl = new Map<ts.ClassLikeDeclaration, GenericClassInfo>();
  /** Instantiations in demand order — the member-lowering worklist run()'s
   * monomorphization fixpoint drains (an instantiation's methods can
   * demand further instances of either kind). */
  readonly genericClassInstances: ClassInfo[] = [];
  /** Discovery hook: a generic-class instantiation collected mid-lowering
   * (instantiations are demand-driven, not units — their members lower in
   * the instance drain). Null everywhere today; reserved for symmetry with
   * onExprClassCollected should instantiations ever need eager
   * registration. */
  onLateClassCollected: ((info: ClassInfo) => void) | null = null;

  genericClassInstanceType(decl: ts.ClassLikeDeclaration, ref: ts.Type): IrType | null {
    return genericClassInstanceType(this, decl, ref);
  }

  findStaticOn(info: ClassInfo | null, name: string): ReturnType<typeof findStaticOn> {
    return findStaticOn(this, info, name);
  }

  staticShadowBelow(info: ClassInfo, name: string): boolean {
    return staticShadowBelow(this, info, name);
  }

  ctorAbiEquals(sub: ClassInfo, sup: ClassInfo): boolean {
    return ctorAbiEquals(this, sub, sup);
  }

  exactClassOfReceiver(expr: ts.Expression): ClassInfo | null {
    return exactClassOfReceiver(this, expr);
  }

  lowerClassMembers(info: ClassInfo): IrFunction[] {
    return lowerClassMembers(this, info);
  }

  lowerStaticFieldInits(info: ClassInfo): IrStmt[] {
    return lowerStaticFieldInits(this, info);
  }

  /** The method-like members (methods and accessors) of a class that have
   * lowerable bodies, with their collected method-map names. */
  *classMethodMembers(
    info: ClassInfo,
  ): Generator<{ mName: string; member: ts.MethodDeclaration | ts.AccessorDeclaration }> {
    if (!info.decl) return; // builtin error classes: runtime-provided bodies
    for (const member of info.decl.members) {
      const fnLike =
        ts.isMethodDeclaration(member) || ts.isGetAccessor(member) || ts.isSetAccessor(member)
          ? member
          : null;
      if (!fnLike) continue;
      // STATIC methods lower separately (`%C.static:m` via staticMethods;
      // accessors stay fenced per site) — and a static member SHARING an
      // instance member's name would match the instance entry in
      // info.methods below and lower a second body under the same %C.name
      // (the duplicate-function ICE, signature 10).
      const mods = ts.canHaveModifiers(fnLike) ? ts.getModifiers(fnLike) : undefined;
      if (mods?.some((m) => m.kind === ts.SyntaxKind.StaticKeyword)) continue;
      // Computed method names resolve exactly like collection did
      // (classMemberNameOf — folded keys and the sym:iterator slot);
      // unresolvable ones never collected, so they skip here too.
      const baseName = ts.isMethodDeclaration(fnLike)
        ? classMemberNameOf(this, fnLike.name)
        : ts.isIdentifier(fnLike.name) || ts.isPrivateIdentifier(fnLike.name)
          ? fnLike.name.text
          : null;
      if (baseName === null) continue;
      const mName = ts.isMethodDeclaration(fnLike) ? baseName : `${ts.isGetAccessor(fnLike) ? "get" : "set"}:${baseName}`;
      if (!info.methods.get(mName) || !fnLike.body) continue;
      yield { mName, member: fnLike };
    }
  }

  lowerClassCtor(info: ClassInfo): IrFunction {
    return lowerClassCtor(this, info);
  }

  lowerClassMethodMember(info: ClassInfo,
    fnLike: ts.MethodDeclaration | ts.AccessorDeclaration,): IrFunction | null {
    return lowerClassMethodMember(this, info, fnLike);
  }

  throwingSetterFn(info: ClassInfo, prop: string): IrFunction {
    return throwingSetterFn(this, info, prop);
  }

  fieldInitStmts(info: ClassInfo, thisLocal: IrLocal): IrStmt[] {
    return fieldInitStmts(this, info, thisLocal);
  }

  lowerDerivedCtorBody(info: ClassInfo, thisLocal: IrLocal, forward?: IrExpr[]): IrStmt[] {
    return lowerDerivedCtorBody(this, info, thisLocal, forward);
  }

  superCallStmt(info: ClassInfo,
    thisLocal: IrLocal,
    args: IrExpr[],
    loc: SrcLoc,): IrStmt {
    return superCallStmt(this, info, thisLocal, args, loc);
  }

  /** Declares the current method's `this` parameter local (arrows capture it through the ordinary machinery). */
  declareThis(type: IrType): IrLocal {
    return this.env.declareThis(type);
  }

  lowerFunction(decl: ts.FunctionDeclaration): IrFunction | null {
    return lowerFunction(this, decl);
  }

  collectGlobals(sf: ts.SourceFile, topStmts: ts.Statement[]): void {
    return collectGlobals(this, sf, topStmts);
  }

  lowerFileInit(sf: ts.SourceFile, stmts: ts.Statement[], name: string): IrFunction {
    return lowerFileInit(this, sf, stmts, name);
  }

  lowerDefaultExport(stmt: ts.ExportAssignment): IrStmt | null {
    return lowerDefaultExport(this, stmt);
  }

  buildMain(): IrFunction {
    return buildMain(this);
  }

  /* ── scoping and captures ─────────────────────────────────────────── */

  /** A local of the current function, bound to the symbol `nameNode` declares. */
  declareLocal(nameNode: ts.Node, name: string, type: IrType, mutable: boolean): IrLocal {
    return this.env.declare(this.checker.getSymbolAtLocation(nameNode), name, type, mutable);
  }

  /** A function-scope local bound to NO ts.Symbol — the hidden ABI slot of a
   * defaulted parameter (the parameter's symbol binds to the separately-
   * declared body local; nothing in the source can name this one). */
  declareHiddenLocal(name: string, type: IrType): IrLocal {
    return this.env.declareHidden(name, type);
  }

  /** Declares a callee's parameter locals from its ParamShapes and builds
   * the DEFAULT-PARAM PROLOGUE. Required/optional/rest params bind their
   * symbol directly (one local of the ABI type). A defaulted param `x: T = e`
   * gets TWO locals: the hidden ABI slot (the incoming `T | undefined`
   * union) and the body local `x` of plain T, initialized by
   *
   *   const x = <in> is undefined-arm ? e : narrow(<in>)
   *
   * — a lazily-branched ternary, so the default expression evaluates exactly
   * when the argument was omitted or undefined (JS's call-time rule), in the
   * callee scope, left-to-right across params (prologue order), and may
   * reference earlier params (their body locals are already bound) and
   * `this` in methods (param 0, declared before any of these). tsc rejects
   * self- and forward-references inside initializers. Must be called before
   * lowering the body; the returned prologue statements go first. */
  declareParams(
    rawDecls: readonly ts.ParameterDeclaration[],
    shapes: readonly ParamShape[],
  ): { params: IrParam[]; prologue: IrStmt[] } {
    // `this` parameters are type-world (paramShapes skipped them; callers
    // never pass them) — skip here too so decls stay shape-aligned.
    const decls = rawDecls.filter((p) => !isThisParameter(p));
    const params: IrParam[] = [];
    const prologue: IrStmt[] = [];
    decls.forEach((decl, i) => {
      const shape = shapes[i]!;
      if (ts.isArrayBindingPattern(decl.name) || ts.isObjectBindingPattern(decl.name)) {
        // Pattern parameter: one hidden ABI slot carries the source value;
        // the prologue binds each name exactly like a destructuring
        // declaration reading from it (the same lowerBindingPattern —
        // pattern fences included). Bound names are mutable, like any
        // parameter in JS.
        const loc = locOf(decl);
        const slot = this.declareHiddenLocal("%param", shape.type);
        params.push({ localId: slot.id, name: "%param", type: shape.type });
        let srcType = shape.type;
        let srcRef = (): IrExpr => ({ kind: "varRef", localId: slot.id, type: shape.type, loc });
        if (shape.mode === "omittable" && shape.bodyType && decl.initializer) {
          // A WHOLE-PATTERN default (`({ x } = { x: 1 })`): pick the
          // default exactly when the argument was omitted or undefined
          // (the ABI union's undefined arm — JS's call-time rule, the
          // identifier-param prologue's ternary), then destructure the
          // picked value.
          const abi = shape.type;
          if (abi.kind === "dyn" || abi.kind === "jsval") {
            // A DYNAMIC-TIER pattern source (`function f({} = a)` with
            // `a: any` — jsval for island values, dyn for the checked-
            // dynamic dyn): the slot holds its tier's undefined directly,
            // so the default test is the runtime undefined test — then
            // the pattern destructures the picked value.
            const dflt = this.lowerExprExpecting(decl.initializer, abi);
            const src = this.declareHiddenLocal("%psrc", abi);
            const inRef = (): IrExpr => ({ kind: "varRef", localId: slot.id, type: abi, loc });
            const isUndef: IrExpr =
              abi.kind === "jsval"
                ? { kind: "jsOp", op: "eq", args: [inRef(), { kind: "jsOp", op: "undefLit", args: [], type: JSVAL, loc }], type: BOOL, loc }
                : { kind: "dynTest", test: "undefined", value: inRef(), type: BOOL, loc };
            prologue.push({
              kind: "varDecl",
              localId: src.id,
              init: { kind: "ternary", cond: isUndef, then: dflt, else_: inRef(), type: abi, loc },
              loc,
            });
            const pickedT = abi;
            srcType = pickedT;
            srcRef = () => ({ kind: "varRef", localId: src.id, type: pickedT, loc });
            this.lowerBindingPattern(decl.name, srcRef, srcType, true, prologue);
            return;
          }
          if (abi.kind !== "union") this.unsupported("SC1090", decl, "this parameter form"); // defensive
          const undefTag = this.armTag(abi.unionId, UNDEFINED_T);
          if (undefTag < 0) this.unsupported("SC1090", decl, "this parameter form"); // defensive
          const isUndef: IrExpr = {
            kind: "unionIsTag", unionId: abi.unionId, tag: undefTag, negated: false,
            value: { kind: "varRef", localId: slot.id, type: abi, loc }, type: BOOL, loc,
          };
          let present: IrExpr | null = null;
          if (typeEquals(shape.bodyType, abi)) {
            present = { kind: "varRef", localId: slot.id, type: abi, loc };
          } else if (shape.bodyType.kind === "union") {
            const retag = this.unionRetagHelper(abi.unionId, shape.bodyType.unionId, loc);
            if (retag) present = { kind: "call", callee: retag, args: [{ kind: "varRef", localId: slot.id, type: abi, loc }], type: shape.bodyType, loc };
          } else {
            const tag = this.armTag(abi.unionId, shape.bodyType);
            if (tag >= 0) {
              present = { kind: "unionNarrow", unionId: abi.unionId, tag, value: { kind: "varRef", localId: slot.id, type: abi, loc }, type: shape.bodyType, loc };
            }
          }
          if (!present) this.unsupported("SC1090", decl, "this parameter form"); // defensive: abi = bodyType + undefined by construction
          const dflt = this.lowerExprExpecting(decl.initializer, shape.bodyType);
          const src = this.declareHiddenLocal("%psrc", shape.bodyType);
          prologue.push({
            kind: "varDecl",
            localId: src.id,
            init: { kind: "ternary", cond: isUndef, then: dflt, else_: present, type: shape.bodyType, loc },
            loc,
          });
          const pickedT = shape.bodyType;
          srcType = pickedT;
          srcRef = () => ({ kind: "varRef", localId: src.id, type: pickedT, loc });
        }
        this.lowerBindingPattern(decl.name, srcRef, srcType, true, prologue);
        return;
      }
      const name = (decl.name as ts.Identifier).text;
      if (shape.mode === "omittable" && shape.bodyType && decl.initializer) {
        const abi = shape.type;
        if (abi.kind === "dyn" || abi.kind === "jsval") {
          // A DYNAMIC-TIER defaulted param (`function f(x = a)` with
          // `a: any` — jsval for island values, dyn for the checked-
          // dynamic dyn): the slot holds its tier's undefined directly —
          // the body local picks the default on the runtime test.
          const loc = locOf(decl);
          const slot = this.declareHiddenLocal(name, abi);
          params.push({ localId: slot.id, name, type: abi });
          const inRef = (): IrExpr => ({ kind: "varRef", localId: slot.id, type: abi, loc });
          const isUndef: IrExpr =
            abi.kind === "jsval"
              ? { kind: "jsOp", op: "eq", args: [inRef(), { kind: "jsOp", op: "undefLit", args: [], type: JSVAL, loc }], type: BOOL, loc }
              : { kind: "dynTest", test: "undefined", value: inRef(), type: BOOL, loc };
          const dflt = this.lowerExprExpecting(decl.initializer, abi);
          const body = this.declareLocal(decl.name, name, abi, true);
          prologue.push({
            kind: "varDecl",
            localId: body.id,
            init: { kind: "ternary", cond: isUndef, then: dflt, else_: inRef(), type: abi, loc },
            loc,
          });
          return;
        }
        if (abi.kind !== "union") this.unsupported("SC1090", decl, "this parameter form"); // defensive
        const undefTag = this.armTag(abi.unionId, UNDEFINED_T);
        if (undefTag < 0) this.unsupported("SC1090", decl, "this parameter form"); // defensive
        const loc = locOf(decl);
        const slot = this.declareHiddenLocal(name, abi);
        params.push({ localId: slot.id, name, type: abi });
        const inRef = (): IrExpr => ({ kind: "varRef", localId: slot.id, type: abi, loc });
        if (typeEquals(shape.bodyType, abi)) {
          // The default may ITSELF be undefined (`x = process.env.FOO`):
          // the body keeps the full `T | undefined` union (tsc's type),
          // so a present argument passes through unchanged and an omitted
          // one takes the default AS IS — no narrow on either branch.
          const dflt = this.lowerExprExpecting(decl.initializer, abi);
          const body = this.declareLocal(decl.name, name, abi, true);
          prologue.push({
            kind: "varDecl",
            localId: body.id,
            init: {
              kind: "ternary",
              cond: { kind: "unionIsTag", unionId: abi.unionId, tag: undefTag, negated: false, value: inRef(), type: BOOL, loc },
              then: dflt,
              else_: inRef(),
              type: abi,
              loc,
            },
            loc,
          });
          return;
        }
        if (shape.bodyType.kind === "union") {
          // UNION body type: a present argument re-tags from the ABI union
          // (body arms + undefined) back into the body union through the
          // interned retag helper — the stranded undefined arm's trap case
          // is unreachable from this else-branch (the ternary just tested
          // it), and every other arm maps by identity.
          const retag = this.unionRetagHelper(abi.unionId, shape.bodyType.unionId, loc);
          if (!retag) this.unsupported("SC1090", decl, "this parameter form"); // defensive
          const dflt = this.lowerExprExpecting(decl.initializer, shape.bodyType);
          const body = this.declareLocal(decl.name, name, shape.bodyType, true);
          prologue.push({
            kind: "varDecl",
            localId: body.id,
            init: {
              kind: "ternary",
              cond: { kind: "unionIsTag", unionId: abi.unionId, tag: undefTag, negated: false, value: inRef(), type: BOOL, loc },
              then: dflt,
              else_: { kind: "call", callee: retag, args: [inRef()], type: shape.bodyType, loc },
              type: shape.bodyType,
              loc,
            },
            loc,
          });
          return;
        }
        const valueTag = this.armTag(abi.unionId, shape.bodyType);
        if (valueTag < 0) this.unsupported("SC1090", decl, "this parameter form"); // defensive
        // The default lowers BEFORE the body local binds, so a same-named
        // outer binding referenced in it can never resolve to the fresh
        // local (tsc separately rejects `x = x`).
        const dflt = this.lowerExprExpecting(decl.initializer, shape.bodyType);
        const body = this.declareLocal(decl.name, name, shape.bodyType, true);
        prologue.push({
          kind: "varDecl",
          localId: body.id,
          init: {
            kind: "ternary",
            cond: { kind: "unionIsTag", unionId: abi.unionId, tag: undefTag, negated: false, value: inRef(), type: BOOL, loc },
            then: dflt,
            else_: { kind: "unionNarrow", unionId: abi.unionId, tag: valueTag, value: inRef(), type: shape.bodyType, loc },
            type: shape.bodyType,
            loc,
          },
          loc,
        });
        return;
      }
      const local = this.declareLocal(decl.name, name, shape.type, true);
      params.push({ localId: local.id, name, type: local.type });
      if (
        shape.mode === "required" &&
        shape.type.kind === "union" &&
        this.armTag(shape.type.unionId, UNDEFINED_T) >= 0 &&
        typeEquals(this.stripUndefinedArm(shape.type), this.mapTypeOf(this.typeOf(decl.name)) ?? VOID)
      ) {
        const root = this.runtimeOptionalRootOf(local);
        this.runtimeOptionalLocals.add(root);
        this.runtimeOptionalStorageLocals.add(root);
      }
    });
    return { params, prologue };
  }

  /** The binding for `symbol` inside context `ctx` — a scoped local or an
   * already-threaded capture entry. */
  bindingIn(ctx: FnCtx, symbol: ts.Symbol): IrLocal | null {
    return this.env.bindingIn(ctx, symbol);
  }

  /** Resolves an identifier to a local of the CURRENT function, creating
   * capture entries (and boxing the origin binding) when the name lives in
   * an enclosing function. Self-references of a named lambda are NOT
   * resolved here — callers check `isSelfReference` first. */
  resolveLocal(ident: ts.Identifier): IrLocal | null {
    let symbol = this.checker.getSymbolAtLocation(ident);
    // Shorthand names read their VALUE binding (see resolveValueSymbol).
    if (ident.parent && ts.isShorthandPropertyAssignment(ident.parent) && ident.parent.name === ident) {
      symbol = this.checker.getShorthandAssignmentValueSymbol(ident.parent) ?? symbol;
    }
    if (!symbol) return null;
    const direct = this.resolveKey(symbol, ident);
    if (direct) return direct;
    // A PARAMETER PROPERTY declares two symbols: references resolve to the
    // PARAMETER symbol, while the declaration's name binds the PROPERTY
    // symbol — which is what declareParams registered the local under.
    // On a miss, normalize to the declaration's key and retry (ordinary
    // bindings never reach this — their two sides intern to one symbol).
    const vd = this.checker.valueDeclarationOf(symbol);
    if (
      vd && ts.isParameter(vd) && ts.isIdentifier(vd.name) &&
      vd.modifiers?.some(
        (m) =>
          m.kind === ts.SyntaxKind.PublicKeyword ||
          m.kind === ts.SyntaxKind.PrivateKeyword ||
          m.kind === ts.SyntaxKind.ProtectedKeyword ||
          m.kind === ts.SyntaxKind.ReadonlyKeyword ||
          m.kind === ts.SyntaxKind.OverrideKeyword,
      )
    ) {
      const propSym = this.checker.getSymbolAtLocation(vd.name);
      if (propSym && propSym !== symbol) return this.resolveKey(propSym, ident);
    }
    return null;
  }

  /** Lexical `this` — the enclosing method's this-param, possibly captured
   * through arrows (function expressions/declarations reset `this` in JS;
   * their bodies never see an enclosing method's binding). */
  resolveThis(): IrLocal | null {
    return this.env.resolveThis();
  }

  /** READ-ONLY twin of resolveLocal for PROBES (isIslandExpr): answers
   * the nearest binding entry without boxing, threading, or predeclaring.
   * resolveKey mutates capture state as a side effect, and a speculative
   * island-ness query through a context that takes no captures (a plain
   * declared function between the origin and the reference) was an ICE —
   * the REAL lowering path still resolves (and diagnoses) the reference
   * itself. */
  peekLocal(ident: ts.Identifier): IrLocal | null {
    let symbol = this.checker.getSymbolAtLocation(ident);
    if (ident.parent && ts.isShorthandPropertyAssignment(ident.parent) && ident.parent.name === ident) {
      symbol = this.checker.getShorthandAssignmentValueSymbol(ident.parent) ?? symbol;
    }
    if (!symbol) return null;
    return this.env.peek(symbol);
  }

  /** Resolves `symbol` to a local of the current function, threading captures through enclosing functions. */
  resolveKey(symbol: ts.Symbol, blame?: ts.Node): IrLocal | null {
    return this.env.resolve(symbol, blame);
  }

  isSelfReference(ident: ts.Identifier): boolean {
    const ctx = this.ctx;
    if (!ctx.selfSymbol) return false;
    // The self binding can be shadowed by a scoped local of the same symbol?
    // No — a shadow is a different symbol; symbol identity is exact.
    return this.checker.getSymbolAtLocation(ident) === ctx.selfSymbol;
  }

  /* ── statements ───────────────────────────────────────────────────── */

  lowerStmts(stmts: readonly ts.Statement[]): IrStmt[] {
    return lowerStmts(this, stmts);
  }

  noteBlockedBindings(stmt: ts.Statement): void {
    return noteBlockedBindings(this, stmt);
  }

  isBlockedBinding(symbol: ts.Symbol | null): boolean {
    return isBlockedBinding(this, symbol);
  }

  /** The cascade rejection: an honest "inherits its declaration's blocker"
   * diagnostic (SC2004) when the symbol is a known-blocked binding, the
   * caller's own fallback otherwise. */
  rejectUnresolved(ident: ts.Identifier, fallback: string): never {
    this.rejectUnresolvedSymbol(this.resolveValueSymbol(ident), ident.text, ident, fallback);
  }

  rejectUnresolvedSymbol(
    symbol: ts.Symbol | null,
    name: string,
    node: ts.Node,
    fallback: string,
  ): never {
    if (this.isBlockedBinding(symbol)) {
      this.pushDiag(blockedBindingUseDiag(name, locOf(node)));
      throw new PoisonError();
    }
    // A binding whose TYPE keeps a generic call signature and whose
    // declaration carries no initializer (`declare const o4: undefined |
    // (<T>(f: (a: T) => T) => T)` — the optional-chained ambient shape):
    // there is no function body to monomorphize, so no use can ever pin a
    // concrete signature — name the shape instead of the generic
    // binding-form text.
    if (symbol) {
      const d = this.checker.valueDeclarationOf(symbol);
      if (
        d && ts.isVariableDeclaration(d) && ts.isVariableDeclarationList(d.parent) &&
        (d.parent.flags & ts.NodeFlags.Const) !== 0
      ) {
        const codec = textCodecBindingClassOf(this, d.name, d.initializer);
        if (codec !== null) {
          const call = codec === "TextEncoder" ? `${name}.encode(s)` : `${name}.decode(bytes)`;
          const composed =
            codec === "TextEncoder"
              ? "new TextEncoder().encode(s)"
              : "new TextDecoder().decode(bytes)";
          this.noLowering(
            `${codec} instance stored in ${name}`,
            node,
            `${call} compiles through this const; the codec object itself has no representation (the composed ${composed} form also compiles)`,
          );
        }
      }
      if (d && ts.isVariableDeclaration(d) && d.initializer === undefined) {
        const t = this.checker.getTypeOfSymbol(symbol);
        const parts = t.isUnionType() ? ts.constituentTypes(t) : [t];
        if (parts.some((p) => this.checker.getCallSignatures(p).some((s) => (s.typeParameters?.length ?? 0) > 0))) {
          this.unsupported(
            "SC1030",
            node,
            `the generic-signature binding '${name}' (its type keeps type parameters and the declaration has no initializer — no function body exists to monomorphize, so nothing can pin a concrete signature)`,
          );
        }
      }
    }
    // An unresolved reference to a LATER `var` whose predeclare was
    // refused: the reads Node would serve before the declaration's
    // assignment are `undefined`, and this binding's type has no slot for
    // that value — name the shape instead of the generic no-lowering text.
    if (symbol) {
      const d = this.checker.valueDeclarationOf(symbol);
      if (d && ts.isVariableDeclaration(d) && (ts.getCombinedNodeFlags(d) & ts.NodeFlags.BlockScoped) === 0) {
        this.unsupported(
          "SC1030",
          node,
          `the reference to '${name}' above its 'var' declaration (a read there would be 'undefined', which the binding's type cannot hold — annotate it '| undefined' or move the declaration up)`,
        );
      }
    }
    this.unsupported("SC1090", node, fallback);
  }

  lowerScopedBlock(stmt: ts.Statement): IrStmt[] {
    return lowerScopedBlock(this, stmt);
  }

  /** Lowers inside a jump-target marker. `labels` carries the construct's
   * source label names so labeled jumps resolve against them. */
  inCtl<T>(kind: "loop" | "switch" | "block", fn: () => T, labels?: string[]): T {
    this.ctx.ctl.push(labels !== undefined && labels.length > 0 ? { kind, labels } : { kind });
    try {
      return fn();
    } finally {
      this.ctx.ctl.pop();
    }
  }

  /** The label names a `lbl:` chain put on the statement currently being
   * lowered — set by lowerLabeled around lowering the labeled construct,
   * consumed exactly once by the construct's own lowering (takeLabels).
   * A lowering that never consumes them signals lowerLabeled to fence:
   * silently dropping a label would compile `break lbl` wrong. */
  pendingLabels: string[] | null = null;

  takeLabels(): string[] | undefined {
    const labels = this.pendingLabels;
    this.pendingLabels = null;
    return labels ?? undefined;
  }

  lowerStmt(stmt: ts.Statement): IrStmt | IrStmt[] | null {
    return lowerStmt(this, stmt);
  }

  lowerVarStatement(stmt: ts.VariableStatement): IrStmt[] {
    return lowerVarStatement(this, stmt);
  }

  lowerDestructuringDecl(decl: ts.VariableDeclaration, isLet: boolean): IrStmt[] {
    return lowerDestructuringDecl(this, decl, isLet);
  }

  lowerDestructuringAssignParts(target: ts.ObjectLiteralExpression | ts.ArrayLiteralExpression, rhs: ts.Expression, loc: SrcLoc): { stmts: IrStmt[]; value: IrExpr } {
    return lowerDestructuringAssignParts(this, target, rhs, loc);
  }

  lowerBindingPattern(pattern: ts.ArrayBindingPattern | ts.ObjectBindingPattern,
    srcRef: () => IrExpr,
    srcType: IrType,
    isLet: boolean,
    out: IrStmt[],
    dynSpell?: string,
    allowDynObject = false,): void {
    if (ts.isObjectBindingPattern(pattern)) {
      fenceFetchObjectBinding(this, pattern);
      // parseArgs's declaration family deliberately maps to dyn. Infer the
      // scoped bridge at the binding site as well as at initializer-backed
      // declarations, covering parameter and for-of element patterns.
      allowDynObject ||= srcType.kind === "dyn" &&
        isParseArgsDynCheckerType(this, this.typeOf(pattern));
    }
    // An ISLAND source (`const { readFileSync } = await import("fs")` —
    // a namespace handle, or any 'any'-typed object): each bound name is
    // an engine property read, mirroring the island property-read rule —
    // a member the .d.ts declares as a primitive exits eagerly to the
    // static type; everything else (including members whose declared
    // types have no static mapping, like @types/node's function types)
    // stays a HANDLE, and its use sites dispatch to engine ops. Patterns
    // the element-wise walk cannot spell — ARRAY patterns (the iterator
    // protocol), empty patterns (the coercion checks), holes, rest,
    // defaults — run the REAL pattern in a synthesized engine function
    // instead (lowerJsvalBindingPattern).
    const elementWise =
      srcType.kind === "jsval" &&
      ts.isObjectBindingPattern(pattern) &&
      pattern.elements.length > 0 &&
      pattern.elements.every(
        (el) =>
          !el.dotDotDotToken &&
          !el.initializer &&
          el.name !== undefined &&
          ts.isIdentifier(el.propertyName ?? el.name),
      );
    if (srcType.kind === "jsval" && !elementWise) {
      if (lowerJsvalBindingPattern(this, pattern, srcRef, isLet, out)) return;
      // No engine form (computed keys, untransportable defaults): fall
      // through to the static fences below.
    }
    if (srcType.kind === "jsval" && ts.isObjectBindingPattern(pattern)) {
      for (const el of pattern.elements) {
        this.checkBindingElement(el);
        // 7's BindingElement declares name optional (array elisions are
        // nameless there); object-pattern elements always carry one.
        if (el.name === undefined) continue;
        const prop = el.propertyName ?? el.name;
        if (!ts.isIdentifier(prop)) {
          this.unsupported("SC1031", el, "destructuring with computed or non-identifier keys");
        }
        const loc = locOf(el);
        const read: IrExpr = {
          kind: "jsOp", op: "getProp", name: prop.text, args: [srcRef()], type: JSVAL, loc,
        };
        if (!ts.isIdentifier(el.name)) {
          // A nested pattern reads through its own handle temp.
          const tmp = this.declareHiddenLocal("%destr", JSVAL);
          out.push({ kind: "varDecl", localId: tmp.id, init: read, loc });
          this.lowerBindingPattern(
            el.name,
            () => ({ kind: "varRef", localId: tmp.id, type: JSVAL, loc }),
            JSVAL, isLet, out,
          );
          continue;
        }
        const declared = this.mapTypeOf(this.typeOf(el.name));
        const primitive =
          declared &&
          (declared.kind === "f64" || declared.kind === "bool" || declared.kind === "string");
        const value: IrExpr = primitive
          ? { kind: "jsExit", value: read, type: declared, loc }
          : read;
        const symbol = this.checker.getSymbolAtLocation(el.name);
        const g = symbol ? this.globalsBySymbol.get(symbol) : undefined;
        if (g) {
          out.push({ kind: "assign", localId: g.id, value: this.coerceInto(el.name, value, g.type), loc });
          continue;
        }
        const local = this.declareLocal(el.name, el.name.text, value.type, isLet);
        out.push({ kind: "varDecl", localId: local.id, init: value, loc });
      }
      return;
    }
    return lowerBindingPattern(this, pattern, srcRef, srcType, isLet, out, dynSpell, allowDynObject);
  }

  checkBindingElement(el: ts.BindingElement, allowDefault = false): void {
    return checkBindingElement(this, el, allowDefault);
  }

  bindPatternTarget(name: ts.BindingName,
    value: IrExpr,
    isLet: boolean,
    out: IrStmt[],
    allowDynObject = false,): void {
    return bindPatternTarget(this, name, value, isLet, out, allowDynObject);
  }

  lowerVarDeclList(list: ts.VariableDeclarationList): IrStmt | null {
    return lowerVarDeclList(this, list);
  }

  lowerVarDecl(decl: ts.VariableDeclaration, isLet: boolean): IrStmt | null {
    // ISLAND-HANDLE rescue (--dynamic): `const factory = (await
    // import("./x.mjs")).default` / `const buf = islandReadFileSync(p)` —
    // a binding whose DECLARED type either has no static mapping or has
    // one no island value can EXIT to (bytes, functions, promises), but
    // whose initializer is an island value. The declared type is a .d.ts
    // surface over an engine value; the binding stays a HANDLE (jsval
    // local) and typed use sites go through engine ops and validated
    // exits like any island value. Exit-CAPABLE declared types (numbers,
    // strings, JSON-safe composites, their undefined-armed unions) keep
    // the standard path and its validated-exit machinery; so does
    // everything non-island — including badType here when the
    // initializer turns out not to be island-typed, which is exactly
    // what the standard path would have reported.
    // Only reference-shaped initializers are candidates (awaits, calls,
    // member reads, identifiers, casts/parens over those): they are the
    // island producers, and re-lowering one on the fall-through emits
    // nothing twice — a lambda or literal initializer would (each
    // lowering mints a fresh %fn), and is never an island value anyway.
    const islandCandidate = (e: ts.Expression): boolean => {
      let cur = e;
      while (
        ts.isParenthesizedExpression(cur) ||
        ts.isAsExpression(cur) ||
        ts.isTypeAssertion(cur) ||
        ts.isNonNullExpression(cur)
      ) {
        cur = cur.expression;
      }
      if (
        !ts.isAwaitExpression(cur) &&
        !ts.isCallExpression(cur) &&
        !ts.isPropertyAccessExpression(cur) &&
        !ts.isElementAccessExpression(cur) &&
        !ts.isIdentifier(cur)
      ) {
        return false;
      }
      // A lambda ANYWHERE inside (a call argument) would emit its %fn
      // twice across the fall-through's re-lowering — skip those.
      let lambda = false;
      const scan = (n: ts.Node): void => {
        if (lambda) return;
        if (ts.isArrowFunction(n) || ts.isFunctionExpression(n)) {
          lambda = true;
          return;
        }
        ts.forEachChild(n, scan);
      };
      scan(cur);
      return !lambda;
    };
    if (
      this.dynamic &&
      ts.isIdentifier(decl.name) &&
      decl.initializer !== undefined &&
      // `var` stays out: the rescue's block-positioned jsval local can't
      // model the function-scoped hoisted binding (a redeclaration or an
      // out-of-block read would split the variable in two) — vars take the
      // standard path and its own fences.
      (ts.getCombinedNodeFlags(decl) & ts.NodeFlags.BlockScoped) !== 0 &&
      islandCandidate(decl.initializer) &&
      // createRequire's plumbing decls are COMPILE-TIME erasures (the
      // require binding and its builtin-namespace bindings) — never
      // island values; the standard path's skips own them.
      !createRequireBindingDecl(this, decl.name, decl.initializer) &&
      !createRequireNamespaceDecl(this, decl.name, decl.initializer)
    ) {
      const mapped = this.mapTypeOf(this.typeOf(decl.name));
      const handleOnly =
        mapped === null ||
        (mapped.kind !== "jsval" &&
          mapped.kind !== "void" &&
          !canExitIslandToType(
            mapped,
            (id) => this.shapes.get(id),
            (id) => this.unions.get(id),
          ));
      const symbol = this.checker.getSymbolAtLocation(decl.name);
      if (handleOnly && (!symbol || !this.globalsBySymbol.has(symbol))) {
        const init = this.lowerExpr(decl.initializer);
        if (init.type.kind === "jsval") {
          const local = this.declareLocal(decl.name, decl.name.text, JSVAL, isLet);
          return { kind: "varDecl", localId: local.id, init, loc: locOf(decl) };
        }
        // The CHECKED-DYNAMIC twin of the handle rescue (the runtime-world
        // local rule): an unmappable declared type over a dyn initializer
        // (`const first = plugins[0]` — the checker spells 'string |
        // object' while the read is a dyn keyed read) keeps the binding
        // dyn; typed use sites ride validated extractions and the routed
        // engine ops, exactly the JSON.parse-binding story.
        if (mapped === null && init.type.kind === "dyn") {
          const local = this.declareLocal(decl.name, decl.name.text, DYN, isLet);
          return { kind: "varDecl", localId: local.id, init, loc: locOf(decl) };
        }
        if (mapped === null) this.badType(decl.name, this.typeOf(decl.name));
        // A mappable declared type with a non-island initializer: the
        // standard path owns it (the initializer lowered clean; re-running
        // it re-produces the same IR with no duplicate diagnostics).
      }
    }
    return lowerVarDecl(this, decl, isLet);
  }

  lowerSwitch(stmt: ts.SwitchStatement): IrStmt {
    return lowerSwitch(this, stmt);
  }

  lowerTry(stmt: ts.TryStatement): IrStmt {
    return lowerTry(this, stmt);
  }

  lowerExprStatement(expr: ts.Expression): IrStmt {
    return lowerExprStatement(this, expr);
  }

  lowerForOf(stmt: ts.ForOfStatement): IrStmt {
    const optional = this.runtimeOptionalIdentifierValue(stmt.expression);
    if (optional?.present.kind !== "string") return lowerForOf(this, stmt);
    const helper = this.narrowedArmHelper(optional.unionId, optional.present, locOf(stmt.expression));
    if (!helper) return lowerForOf(this, stmt);
    return this.withExpressionOverride(
      stmt.expression,
      { kind: "call", callee: helper, args: [optional.value], type: optional.present, loc: locOf(stmt.expression) },
      () => lowerForOf(this, stmt),
    );
  }

  lowerForStatement(stmt: ts.ForStatement): IrStmt {
    return lowerForStatement(this, stmt);
  }

  lowerCondition(expr: ts.Expression): IrExpr {
    return lowerCondition(this, expr);
  }

  ensureBool(e: IrExpr, node: ts.Expression): IrExpr {
    return ensureBool(this, e, node);
  }

  requireTruthyUnion(unionId: string, node: ts.Expression): void {
    return requireTruthyUnion(this, unionId, node);
  }

  eqComparableUnion(unionId: string): boolean {
    return eqComparableUnion(this, unionId);
  }

  /* ── expressions ──────────────────────────────────────────────────── */

  lowerExpr(expr: ts.Expression): IrExpr {
    return noteNativeImportSource(this, expr, lowerExpr(this, expr));
  }

  lowerIntrinsicProperty(expr: ts.PropertyAccessExpression): IrExpr | null {
    // The builtin-spoke property extensions (Stats.mtimeMs,
    // SpawnSyncReturns.signal) claim their reads before the intrinsic
    // fallback's member fences fire for them.
    return lowerBuiltinExtraProperty(this, expr) ?? lowerIntrinsicProperty(this, expr);
  }

  /** True for the STANDARD LIBRARY's source files: the shipped ambient
   * .d.ts files (core + overrides + fallback), a lib.*.d.ts bundled with the typescript
   * package (asked via program.isSourceFileDefaultLibrary, never by path
   * matching), or the ADOPTED @types/node surface standing in for the
   * fallback (see loadProgram — the lowering tables recognize the same
   * members by name + this provenance, and everything else those files
   * declare hits the SC2020-family fence). The file half of every
   * supported-surface provenance check. */
  readonly isStdlibFile = (sf: ts.SourceFile): boolean =>
    sf.fileName === this.ambient ||
    sf.fileName === this.overridesAmbient ||
    sf.fileName === this.fallbackAmbient ||
    this.program.isSourceFileDefaultLibrary(sf) ||
    (sf.isDeclarationFile && isNodeTypesPath(sf.fileName));

  nodeTypesOnlySymbol(sym: ts.Symbol | null | undefined): boolean {
    return nodeTypesOnlySymbol(this, sym);
  }

  /** True for an npm package's shipped declaration files — under
   * node_modules but NOT the standard library (typescript's own lib files
   * live under node_modules too), or inside a registered workspace-linked
   * package (a node_modules symlink whose realpath'd files carry no
   * node_modules segment — workspace-registry.ts). The provenance half of the npm
   * typing rule (package types are island handles) and of the per-package
   * requires-dynamic attribution. */
  readonly isNpmFile = (sf: ts.SourceFile): boolean => sf.isDeclarationFile && !isNpmStaticTypeFile(sf.fileName) &&
    (sf.fileName.includes("/node_modules/") || workspacePackageOfPath(sf.fileName) !== null) &&
    !this.isStdlibFile(sf);

  npmPackageOf(type: ts.Type): string | null {
    return npmPackageOf(this, type);
  }

  npmMemberFence(access: ts.PropertyAccessExpression): void {
    return npmMemberFence(this, access);
  }

  npmPackageOfSymbol(sym: ts.Symbol | undefined): string | null {
    return npmPackageOfSymbol(this, sym);
  }

  isStdlibMember(access: ts.PropertyAccessExpression): boolean {
    return isStdlibMember(this, access);
  }

  isStdlibSymbol(symbol: ts.Symbol | undefined): boolean {
    return isStdlibSymbol(this, symbol);
  }

  isStdlibGlobal(expr: ts.Expression, name: string): boolean {
    return isStdlibGlobal(this, expr, name);
  }

  stdlibGlobalMember(access: ts.PropertyAccessExpression, name: string): string | null {
    return stdlibGlobalMember(this, access, name);
  }

  lowerArrayLiteral(expr: ts.ArrayLiteralExpression, expected?: (IrType & { kind: "array" }) | (IrType & { kind: "record" })): IrExpr {
    return lowerArrayLiteral(this, expr, expected);
  }

  lowerObjectLiteral(expr: ts.ObjectLiteralExpression): IrExpr {
    return lowerObjectLiteral(this, expr);
  }

  lowerShorthandValue(prop: ts.ShorthandPropertyAssignment): IrExpr {
    return lowerShorthandValue(this, prop);
  }

  rejectThisInObjectMethod(node: ts.Node): void {
    return rejectThisInObjectMethod(this, node);
  }

  lowerElementAccess(expr: ts.ElementAccessExpression): IrExpr {
    // `value?.[k]` short-circuits on a nullish receiver: never pre-extract it.
    const receiver = expr.questionDotToken ? null : this.runtimeOptionalIdentifierValue(expr.expression);
    const receiverValue = receiver && (receiver.present.kind === "array" || receiver.present.kind === "record")
      ? (() => {
          const helper = this.narrowedArmHelper(receiver.unionId, receiver.present, locOf(expr.expression));
          return helper ? { kind: "call" as const, callee: helper, args: [receiver.value], type: receiver.present, loc: locOf(expr.expression) } : null;
        })()
      : null;
    if (receiverValue && receiver?.present.kind === "record" && ts.isNumericLiteral(expr.argumentExpression)) {
      const shape = this.shapes.get(receiver.present.shapeId);
      const index = expr.argumentExpression.text;
      const field = shape?.tuple ? shape.fields.find((candidate) => candidate.name === String(Number(index))) : undefined;
      if (field) {
        const read: IrExpr = {
          kind: "recordGet",
          obj: receiverValue,
          shapeId: receiver.present.shapeId,
          field: field.name,
          type: field.type,
          loc: locOf(expr),
        };
        if (
          expr.parent && ts.isTypeOfExpression(expr.parent) &&
          (field.type.kind === "f64" || field.type.kind === "bool" || field.type.kind === "string")
        ) {
          return { kind: "dynFrom", value: read, type: DYN, loc: locOf(expr) };
        }
        return read;
      }
    }
    const key = this.runtimeOptionalIdentifierValue(expr.argumentExpression);
    const keyValue = key?.present.kind === "string" ? this.ensureString(key.value, expr.argumentExpression) : null;
    const lower = (): IrExpr => lowerElementAccess(this, expr);
    const withKey = (): IrExpr => keyValue ? this.withExpressionOverride(expr.argumentExpression, keyValue, lower) : lower();
    return receiverValue ? this.withExpressionOverride(expr.expression, receiverValue, withKey) : withKey();
  }

  lowerRecordKeyRead(
    expr: ts.ElementAccessExpression,
    shapeId: string,
    shape: IrRecordShape,
    includeUndefined = false,
  ): IrExpr {
    return lowerRecordKeyRead(this, expr, shapeId, shape, includeUndefined);
  }

  lowerElementWrite(expr: ts.BinaryExpression): IrStmt {
    return lowerElementWrite(this, expr);
  }

  ensureString(e: IrExpr, node: ts.Node): IrExpr {
    return ensureString(this, e, node);
  }

  lowerTemplate(expr: ts.TemplateExpression): IrExpr {
    return lowerTemplate(this, expr);
  }

  lowerAsExpression(expr: ts.AsExpression | ts.TypeAssertion): IrExpr {
    const native = lowerNativeImportAssertion(this, expr);
    if (native) return native;
    // ISLAND value cast to a PROMISE type (`factory(opts) as Promise<Mod>`
    // — the Node-typed async-API shape): promises never have a validated
    // exit, so instead of refusing the build the cast DEFERS the failure
    // to runtime — island.castFail evaluates the value (its side effects
    // are real) and throws a catchable TypeError naming the target, so
    // typed-but-never-executed code (a wasm decode path behind a
    // rejecting import) still compiles and a reached cast fails loudly at
    // the exact site. Claimed only when the source is island-typed by the
    // checker (jsval, or a promise whose inner is a handle); a source
    // that lowers to a real static promise keeps erasure — the standard
    // path's rule for non-island inners. Static builds keep their
    // per-site diagnostics.
    if (this.dynamic) {
      const srcMapped = this.mapTypeOf(this.typeOf(expr.expression));
      const island =
        srcMapped?.kind === "jsval" ||
        (srcMapped?.kind === "promise" && srcMapped.inner.kind === "jsval");
      if (island) {
        const targetTs = this.checker.getTypeFromTypeNode(expr.type);
        const target = this.mapTypeOf(targetTs);
        if (target?.kind === "promise") {
          const inner = this.lowerExpr(expr.expression);
          if (inner.type.kind !== "jsval") return inner; // static promise: erasure
          const loc = locOf(expr);
          const name: IrExpr = {
            kind: "strLit", value: this.fmt(target), type: STRING, loc,
          };
          return { kind: "libCall", fn: "island.castFail", args: [inner, name], type: target, loc };
        }
      }
    }
    return lowerAsExpression(this, expr);
  }

  lowerPrefixUnary(expr: ts.PrefixUnaryExpression): IrExpr {
    return lowerPrefixUnary(this, expr);
  }

  lowerBinary(expr: ts.BinaryExpression): IrExpr {
    return lowerBinary(this, expr);
  }

  lowerCaughtTypeofTest(expr: ts.BinaryExpression, loc: SrcLoc): IrExpr | null {
    return lowerCaughtTypeofTest(this, expr, loc);
  }

  caughtRead(node: ts.Identifier, local: IrLocal, loc: SrcLoc): IrExpr {
    return caughtRead(this, node, local, loc);
  }

  caughtLocalOf(node: ts.Expression): IrLocal | null {
    return caughtLocalOf(this, node);
  }

  caughtToString(node: ts.Expression): IrExpr | null {
    return caughtToString(this, node);
  }

  lowerInstanceOf(expr: ts.BinaryExpression, loc: SrcLoc): IrExpr {
    const lower = (): IrExpr => this.withRuntimeOptionalClassValue(expr.right, () => lowerInstanceOf(this, expr, loc));
    if (!ts.isIdentifier(expr.right) || this.mapTypeOf(this.typeOf(expr.right))?.kind !== "classval") {
      return lower();
    }
    const optionalLeft = this.runtimeOptionalIdentifierValue(expr.left);
    const left = optionalLeft?.value ?? (ts.isElementAccessExpression(expr.left) ? this.lowerExpr(expr.left) : null);
    if (!left) return lower();
    if (left.type.kind !== "union" || this.armTag(left.type.unionId, UNDEFINED_T) < 0) return lower();
    const present = this.stripUndefinedArm(left.type);
    if (present.kind !== "object") return lower();
    const undefinedTag = this.armTag(left.type.unionId, UNDEFINED_T);
    const valueTag = this.armTag(left.type.unionId, present);
    if (undefinedTag < 0 || valueTag < 0) return lower();
    const stable = this.declareHiddenLocal("%instanceofLeft", left.type);
    const value = varRef(stable.id, left.type, locOf(expr.left));
    const optionalRight = this.runtimeOptionalIdentifierValue(expr.right);
    let right: IrExpr;
    if (optionalRight?.present.kind === "classval") {
      const helper = this.narrowedArmHelper(optionalRight.unionId, optionalRight.present, locOf(expr.right));
      if (!helper) return lower();
      right = { kind: "call", callee: helper, args: [optionalRight.value], type: optionalRight.present, loc: locOf(expr.right) };
    } else {
      right = this.lowerExpr(expr.right);
    }
    if (right.type.kind !== "classval") return lower();
    const stableRight = this.declareHiddenLocal("%instanceofRight", right.type);
    const rightValue = varRef(stableRight.id, right.type, locOf(expr.right));
    const body = this.withExpressionOverride(expr.left, {
      kind: "unionNarrow", unionId: left.type.unionId, tag: valueTag, value, type: present, loc: locOf(expr.left),
    }, () => this.withExpressionOverride(expr.right, rightValue, () => lowerInstanceOf(this, expr, loc)));
    return {
      kind: "seqExpr",
      stmts: [
        { kind: "varDecl", localId: stable.id, init: left, loc: locOf(expr.left) },
        { kind: "varDecl", localId: stableRight.id, init: right, loc: locOf(expr.right) },
      ],
      result: {
        kind: "ternary",
        cond: { kind: "unionIsTag", unionId: left.type.unionId, tag: undefinedTag, negated: false, value, type: BOOL, loc },
        then: { kind: "boolLit", value: false, type: BOOL, loc },
        else_: body,
        type: BOOL,
        loc,
      },
      type: BOOL,
      loc,
    };
  }

  private withRuntimeOptionalClassValue<T>(node: ts.Expression, lower: () => T): T {
    if (this.mapTypeOf(this.typeOf(node))?.kind !== "classval") return lower();
    const optional = this.runtimeOptionalIdentifierValue(node);
    if (optional?.present.kind !== "classval") return lower();
    const helper = this.narrowedArmHelper(optional.unionId, optional.present, locOf(node));
    if (!helper) return lower();
    return this.withExpressionOverride(
      node,
      { kind: "call", callee: helper, args: [optional.value], type: optional.present, loc: locOf(node) },
      lower,
    );
  }

  private withExpressionOverride<T>(node: ts.Expression, value: IrExpr, lower: () => T): T {
    const previous = this.chainRecvByNode.get(node);
    this.chainRecvByNode.set(node, value);
    try {
      return lower();
    } finally {
      if (previous) this.chainRecvByNode.set(node, previous);
      else this.chainRecvByNode.delete(node);
    }
  }

  lowerCall(expr: ts.CallExpression): IrExpr {
    // Fetch and dynamic import claim calls before general dispatch:
    // identifier-call paths do not lower promise-returning ambient globals
    // or the `import` keyword. Static fetch stays native; --dynamic fetch
    // uses the island.
    return checkNativeCallResult(this, expr,
      lowerFfiCall(this, expr) ??
      lowerFetchCall(this, expr) ??
      lowerStaticFetchCompanionCall(this, expr) ??
      lowerStaticAbortControllerCall(this, expr) ??
      lowerStaticAbortSignalListenerCall(this, expr) ??
      lowerStaticReadableStreamCancelCall(this, expr) ??
      lowerStaticReadableStreamControllerCall(this, expr) ??
      lowerStaticReadableStreamReaderCall(this, expr) ??
      lowerStaticResponseCall(this, expr) ??
      lowerFetchElementMethodCall(this, expr) ??
      lowerDynamicImportCall(this, expr) ??
      lowerCall(this, expr)
    );
  }

  isTopLevelFnSymbol(ident: ts.Identifier): boolean {
    return isTopLevelFnSymbol(this, ident);
  }

  lowerNestedFunctionDecl(stmt: ts.FunctionDeclaration): IrStmt {
    return lowerNestedFunctionDecl(this, stmt);
  }

  lambdaSignature(node: ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration | ts.MethodDeclaration | ts.GetAccessorDeclaration | ts.SetAccessorDeclaration,): { shapes: ParamShape[]; funcType: IrType & { kind: "func" } } {
    return lambdaSignature(this, node);
  }

  lowerLambda(node: ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration | ts.MethodDeclaration | ts.GetAccessorDeclaration | ts.SetAccessorDeclaration,): IrExpr {
    return lowerLambda(this, node);
  }

  lowerArrayMethodCall(call: ts.CallExpression,
    access: ts.PropertyAccessExpression,): IrExpr | null {
    return lowerArrayMethodCall(this, call, access);
  }

  lowerMapMethodCall(call: ts.CallExpression,
    access: ts.PropertyAccessExpression,): IrExpr | null {
    return lowerMapMethodCall(this, call, access);
  }

  lowerMapForEachCall(call: ts.CallExpression,
    receiver: IrExpr,
    mapT: IrType & { kind: "map" },): IrExpr {
    return lowerMapForEachCall(this, call, receiver, mapT);
  }

  buildMapForEachFn(name: string,
    mapT: IrType & { kind: "map" },
    arity: number,
    fnRet: IrType,
    loc: SrcLoc,): IrFunction {
    return buildMapForEachFn(this, name, mapT, arity, fnRet, loc);
  }

  lowerSetMethodCall(call: ts.CallExpression,
    access: ts.PropertyAccessExpression,): IrExpr | null {
    return lowerSetMethodCall(this, call, access);
  }

  lowerSetForEachCall(call: ts.CallExpression,
    receiver: IrExpr,
    setT: IrType & { kind: "set" },): IrExpr {
    return lowerSetForEachCall(this, call, receiver, setT);
  }

  buildSetForEachFn(name: string,
    setT: IrType & { kind: "set" },
    arity: number,
    fnRet: IrType,
    loc: SrcLoc,): IrFunction {
    return buildSetForEachFn(this, name, setT, arity, fnRet, loc);
  }

  lowerRegexLiteral(expr: ts.RegularExpressionLiteral): IrExpr {
    return lowerRegexLiteral(this, expr);
  }

  lowerRegexMethodCall(call: ts.CallExpression,
    access: ts.PropertyAccessExpression,): IrExpr | null {
    return lowerRegexMethodCall(this, call, access);
  }

  lowerStringMethodCall(call: ts.CallExpression,
    access: ts.PropertyAccessExpression,): IrExpr | null {
    return lowerStringMethodCall(this, call, access);
  }

  lowerBytesNew(expr: ts.NewExpression, symbol: ts.Symbol | null | undefined): IrExpr | null {
    return lowerBytesNew(this, expr, symbol);
  }

  lowerBytesMethodCall(call: ts.CallExpression,
    access: ts.PropertyAccessExpression,): IrExpr | null {
    return lowerBytesMethodCall(this, call, access);
  }

  lowerBufferStaticCall(call: ts.CallExpression,
    access: ts.PropertyAccessExpression,): IrExpr | null {
    return lowerBufferStaticCall(this, call, access);
  }

  fieldTarget(access: ts.PropertyAccessExpression): FieldTarget | null {
    return fieldTarget(this, access);
  }

  uniqueSymbolKeyOf(key: ts.Expression): { sym: ts.Symbol; fieldName: string } | null {
    return uniqueSymbolKeyOf(this, key);
  }

  foldedStringKeyOf(expr: ts.Expression): string | null {
    return foldedStringKeyOf(this, expr);
  }

  accessorCall(className: string,
    member: string,
    obj: IrExpr,
    extraArgs: IrExpr[],
    ret: IrType,
    loc: SrcLoc,): IrExpr {
    return accessorCall(this, className, member, obj, extraArgs, ret, loc);
  }

  classIteratorOf(t: IrType): ClassIteratorInfo | null {
    return classIteratorOf(this, t);
  }

  classIteratorOpenCall(cit: ClassIteratorInfo, recv: IrExpr, loc: SrcLoc): IrExpr {
    return classIteratorOpenCall(this, cit, recv, loc);
  }

  classIteratorNextCall(cit: ClassIteratorInfo, itRef: IrExpr, loc: SrcLoc): IrExpr {
    return classIteratorNextCall(this, cit, itRef, loc);
  }

  classIteratorDrainCall(src: IrExpr, loc: SrcLoc, elemT?: IrType): IrExpr | null {
    return classIteratorDrainCall(this, src, loc, elemT);
  }

  classIteratorRestDrainCall(cit: ClassIteratorInfo, itVal: IrExpr, loc: SrcLoc): IrExpr {
    return classIteratorRestDrainCall(this, cit, itVal, loc);
  }

  fieldGetExpr(target: FieldTarget, loc: SrcLoc, blame: ts.Node): IrExpr {
    return fieldGetExpr(this, target, loc, blame);
  }

  fieldSetStmt(target: FieldTarget, value: IrExpr, loc: SrcLoc, blame: ts.Node): IrStmt {
    return fieldSetStmt(this, target, value, loc, blame);
  }

  lowerFieldCompound(access: ts.PropertyAccessExpression | ts.ElementAccessExpression,
    op: CompoundOp,
    rhsNode: ts.Expression | null,
    loc: SrcLoc,): IrStmt {
    return lowerFieldCompound(this, access, op, rhsNode, loc);
  }

  errorMessageArg(args: readonly ts.Expression[], loc: SrcLoc, blame: ts.Node): IrExpr {
    return errorMessageArg(this, args, loc, blame);
  }

  inheritsBuiltinErrorCtor(info: ClassInfo): boolean {
    return inheritsBuiltinErrorCtor(this, info);
  }

  inheritsBuiltinEmitterCtor(info: ClassInfo): boolean {
    return inheritsBuiltinEmitterCtor(this, info);
  }

  lowerNew(expr: ts.NewExpression): IrExpr {
    // `new Uint8Array(handle)` (and the other typed-array ctors) over an
    // ISLAND argument: the construction is an ENGINE operation — the
    // engine's own constructor over the engine's own value (an Emscripten
    // factory's `wasmBinary: new Uint8Array(buf)` where buf came off an
    // island readFileSync) — and the instance stays a handle. The static
    // bytes ctor cannot claim it (bytes never cross the boundary), so
    // this preempts only when the single argument is island-typed;
    // every static form keeps the standard path.
    if (
      this.dynamic &&
      ts.isIdentifier(expr.expression) &&
      expr.arguments?.length === 1 &&
      !ts.isSpreadElement(expr.arguments[0]!) &&
      /^(Uint8|Uint8Clamped|Int8|Uint16|Int16|Uint32|Int32|Float32|Float64|BigInt64|BigUint64)Array$/.test(
        expr.expression.text,
      ) &&
      this.isStdlibSymbol(this.resolveValueSymbol(expr.expression) ?? undefined) &&
      this.isIslandExpr(expr.arguments[0]!)
    ) {
      const loc = locOf(expr);
      const ctor: IrExpr = {
        kind: "jsOp", op: "globalGet", name: expr.expression.text, args: [], type: JSVAL, loc,
      };
      const arg = this.lowerExpr(expr.arguments[0]!);
      return { kind: "jsOp", op: "construct", args: [ctor, arg], type: JSVAL, loc };
    }
    const builtin = lowerAbortControllerNew(this, expr) ?? lowerRequestNew(this, expr) ?? lowerResponseNew(this, expr) ?? lowerStaticReadableStreamNew(this, expr);
    return builtin ?? this.withRuntimeOptionalClassValue(expr.expression, () => lowerNew(this, expr));
  }

  lowerFieldRead(expr: ts.PropertyAccessExpression): IrExpr | null {
    // `C.x` static reads first (the receiver is a CLASS, not an instance
    // — the instance field path below could never claim it), then static
    // access through class VALUES (classval-typed bindings).
    return lowerStaticFieldRead(this, expr) ?? lowerClassValueProperty(this, expr) ?? lowerFieldRead(this, expr);
  }

  lowerUnionProperty(expr: ts.PropertyAccessExpression): IrExpr | null {
    return lowerUnionProperty(this, expr);
  }

  lowerRecordFieldCall(call: ts.CallExpression,
    access: ts.PropertyAccessExpression,): IrExpr | null {
    return lowerRecordFieldCall(this, call, access);
  }

  lowerObjectMethodCall(call: ts.CallExpression,
    access: ts.PropertyAccessExpression,): IrExpr | null {
    return lowerObjectMethodCall(this, call, access);
  }

  lowerSuperMethodCall(call: ts.CallExpression,
    access: ts.PropertyAccessExpression,): IrExpr {
    return lowerSuperMethodCall(this, call, access);
  }

  superThisRef(access: ts.PropertyAccessExpression): { thisRef: IrExpr; base: ClassInfo } {
    return superThisRef(this, access);
  }

  lowerSuperAccessorRead(access: ts.PropertyAccessExpression): IrExpr {
    return lowerSuperAccessorRead(this, access);
  }

  lowerSuperAccessorWrite(access: ts.PropertyAccessExpression,
    rhs: ts.Expression,
    loc: SrcLoc,): IrStmt {
    return lowerSuperAccessorWrite(this, access, rhs, loc);
  }

  /* ── comptime (compile-time evaluation) ───────────────────────────── */

  lowerComptime(expr: ts.CallExpression): IrExpr {
    return lowerComptime(this, expr);
  }

  comptimeBakeable(t: IrType): boolean {
    return comptimeBakeable(this, t);
  }

  rejectComptimeCaptures(cb: ts.ArrowFunction | ts.FunctionExpression): void {
    return rejectComptimeCaptures(this, cb);
  }

  comptimeValueToIr(value: unknown,
    expected: IrType,
    path: string,
    blame: ts.Node,): IrExpr {
    return comptimeValueToIr(this, value, expected, path, blame);
  }

  isConsoleLog(call: ts.CallExpression): boolean {
    return isConsoleLog(this, call);
  }

  consoleCallMember(call: ts.CallExpression): "log" | "info" | "debug" | "error" | "warn" | null {
    return consoleCallMember(this, call);
  }

  /* ── standard library (process + node:fs) ─────────────────────────── */

  builtinImportOf(ident: ts.Identifier): { module: string; member: string } | null {
    return builtinImportOf(this, ident);
  }

  /** The namespace-import twin of builtinImportOf's provenance rule:
   * resolves an expression to the supported builtin MODULE whose members
   * it exposes — an identifier declared by `import * as ns from "node:fs"`
   * (through the symbol, so shadowing locals never match), or a nested
   * member access that IS a module in its own right (`fs.promises` — the
   * same object as node:fs/promises, Node's rule). Null otherwise. */
  builtinNamespaceModuleOf(expr: ts.Expression): string | null {
    if (ts.isIdentifier(expr)) {
      const symbol = this.checker.getSymbolAtLocation(expr);
      const decl = symbol ? this.checker.declarationsOf(symbol)[0] : undefined;
      if (!decl) return null;
      // The CommonJS twin: `const fs = require("fs")` binds the same
      // namespace surface as `import * as fs from "node:fs"` — and the
      // createRequire spelling (`const fs = require("node:fs")` through a
      // createRequire binding, the fallback-typed cast idiom stripped)
      // binds it too.
      if (ts.isVariableDeclaration(decl) && ts.isIdentifier(decl.name) && decl.initializer) {
        const spec = requireSpecOf(decl.initializer);
        if (spec !== null) return canonicalBuiltinModule(spec);
        const init = stripTypeCasts(decl.initializer);
        if (ts.isCallExpression(init)) {
          const cr = createRequireSpecOf(this, init);
          if (cr !== null && cr.spec !== null) return canonicalBuiltinModule(cr.spec);
        }
        return null;
      }
      // A DESTRUCTURED sub-namespace binding — `const { promises } =
      // fs` / `= require('fs')`: the member is itself a supported module
      // ("fs/promises"), so the binding carries that module's namespace
      // surface. canonicalBuiltinModule gates the composition (an
      // ordinary destructured FUNCTION binding composes to an unknown
      // name and answers null — builtinImportOf owns those).
      if (ts.isBindingElement(decl) && ts.isObjectBindingPattern(decl.parent) &&
          ts.isVariableDeclaration(decl.parent.parent) && decl.parent.parent.initializer !== undefined &&
          decl.propertyName === undefined && decl.initializer === undefined) {
        const name = decl.name;
        if (name === undefined || !ts.isIdentifier(name)) return null;
        const init = decl.parent.parent.initializer;
        const spec = requireSpecOf(init);
        const outer = spec !== null
          ? canonicalBuiltinModule(spec)
          : ts.isIdentifier(init) ? this.builtinNamespaceModuleOf(init) : null;
        if (outer !== null) return canonicalBuiltinModule(`${outer}/${name.text}`);
        return null;
      }
    }
    // The INLINE CommonJS spelling: `require("cluster").isPrimary` — the
    // call expression IS the module namespace (Node evaluates the member
    // off the module object; a supported module's members key the same
    // tables as any namespace binding).
    {
      const spec = requireSpecOf(expr);
      if (spec !== null) return canonicalBuiltinModule(spec);
    }
    // The createRequire spelling of the same inline form:
    // `require("node:path").join(...)` through a createRequire binding
    // (the fallback-typed cast idiom strips: `(require("x") as T).m`).
    {
      const inner = stripTypeCasts(expr);
      if (ts.isCallExpression(inner)) {
        const cr = createRequireSpecOf(this, inner);
        if (cr !== null && cr.spec !== null) return canonicalBuiltinModule(cr.spec);
      }
    }
    if (ts.isIdentifier(expr)) {
      const symbol = this.checker.getSymbolAtLocation(expr);
      const decl = symbol ? this.checker.declarationsOf(symbol)[0] : undefined;
      if (!decl) return null;
      // The DEFAULT-import twin: Node's default export of a CJS builtin
      // IS the module object, so `import path from "node:path"` exposes
      // exactly the namespace form's member surface for EVERY supported
      // builtin (preflight admits the spelling in JS sources, plus the
      // callable module objects — assert, events, test — everywhere).
      if (ts.isImportClause(decl) && decl.name) {
        const importDecl = decl.parent;
        if (ts.isImportDeclaration(importDecl) && ts.isStringLiteral(importDecl.moduleSpecifier)) {
          return canonicalBuiltinModule(importDecl.moduleSpecifier.text);
        }
      }
      if (!ts.isNamespaceImport(decl)) return null;
      const importDecl = decl.parent.parent;
      if (!ts.isImportDeclaration(importDecl) || !ts.isStringLiteral(importDecl.moduleSpecifier)) return null;
      return canonicalBuiltinModule(importDecl.moduleSpecifier.text);
    }
    if (ts.isPropertyAccessExpression(expr) && !expr.questionDotToken && ts.isIdentifier(expr.expression)) {
      const outer = this.builtinNamespaceModuleOf(expr.expression);
      if (outer === null) return null;
      return canonicalBuiltinModule(`${outer}/${expr.name.text}`);
    }
    return null;
  }

  /** A member access on a supported builtin namespace import —
   * `fs.readFileSync`, `path.sep`, `fs.promises.readFile` — as the same
   * { module, member } shape builtinImportOf gives named imports, so both
   * import forms key the same lowering tables. Null for everything else. */
  builtinMemberOf(access: ts.PropertyAccessExpression): { module: string; member: string } | null {
    if (access.questionDotToken) return null;
    const module = this.builtinNamespaceModuleOf(access.expression);
    if (module !== null) return { module, member: access.name.text };
    // The RE-EXPORT FACADE's namespace spelling: `import * as assert from
    // "./facade.js"` over `export { ok } from "node:assert"` (the formatter idiom's
    // universal/assert). The member's symbol is the facade's
    // ExportSpecifier, and builtinImportOf's alias chase answers the
    // builtin's own module/member — the same tables as a direct import;
    // ordinary property symbols are not aliases and never match.
    return ts.isIdentifier(access.name) ? builtinImportOf(this, access.name) : null;
  }

  /** `ns.member(...)` on a builtin namespace import: exactly the named-
   * import dispatch — the module tables for lowered members, the module-
   * qualified per-member fence for the rest. Null for non-namespace
   * callees (the call chain keeps trying). */
  lowerNamespaceBuiltinCall(call: ts.CallExpression, access: ts.PropertyAccessExpression): IrExpr | null {
    const bi = this.builtinMemberOf(access);
    if (!bi) return null;
    // The timers spoke: `timers.setTimeout(...)` through a namespace or
    // require binding IS the global (Node's timers module re-exports
    // them) — the shared member lowering serves both spellings.
    if (bi.module === "timers") {
      const timersServed = lowerTimersMemberCall(this, call, bi.member, locOf(access));
      if (timersServed) return timersServed;
    }
    // The assert spoke owns node:assert wholesale (every call shape is
    // special-cased — optional messages, per-type comparisons, synthesized
    // deep-equality helpers).
    const assertServed = this.lowerAssertModuleCall(call, bi, locOf(access));
    if (assertServed) return assertServed;
    // The node:test spoke owns its module the same way (`test.skip(...)`
    // through the default import is a namespace-member call here).
    const testServed = this.lowerNodeTestModuleCall(call, bi, locOf(access));
    if (testServed) return testServed;
    // The util spoke owns inspect/format the same way (per-type
    // synthesized traversal helpers, compile-time format strings).
    const utilServed = this.lowerUtilModuleCall(call, bi, locOf(access));
    if (utilServed) return utilServed;
    // The dgram/dns spoke owns those modules for namespace imports too
    // (`import * as dns from "node:dns"` — portless's form): every call
    // shape is special-cased there, so it never rides the param tables.
    const dgramServed = this.lowerDgramDnsModuleCall(call, bi, locOf(access));
    if (dgramServed) return dgramServed;
    // The server-surface spoke owns net and http wholesale — the same
    // dispatch the named-import path takes (`net.createServer(...)` via
    // `import * as net` is portless's own spelling).
    const served = this.lowerNetModuleCall(call, bi, locOf(access));
    if (served) return served;
    // The stream spoke owns finished/pipeline the same way.
    const streamServed = lowerStreamModuleCall(this, call, bi, locOf(access));
    if (streamServed) return streamServed;
    // fs._toUnixTimestamp — off the param tables (an underscore-stable
    // internal), served by its own spoke before the table fence.
    const fsTs = this.lowerFsToUnixTimestampCall(call, bi, locOf(access));
    if (fsTs) return fsTs;
    // The fs validation-ladder spoke (checked-dynamic lane): misuse of
    // implemented-namespace members throws Node's typed errors instead
    // of meeting the table fence.
    const fsLadder = this.lowerFsLadderCall(call, bi, locOf(access));
    if (fsLadder) return fsLadder;
    // The crypto introspection statics (getFips and the name lists) bake
    // at the call site — no runtime entry exists to table.
    const cryptoServed = this.lowerCryptoModuleCall(call, bi, locOf(access));
    if (cryptoServed) return cryptoServed;
    const builtinFn = builtinModuleFnOf(this, bi.module, bi.member);
    if (!builtinFn) {
      this.noLowering(
        `${bi.module}.${bi.member}`,
        call,
        builtinFenceHintOf(bi.module, bi.member),
        this.checker.getSymbolAtLocation(access.name),
      );
    }
    return this.lowerBuiltinModuleCall(call, bi, builtinFn, locOf(access));
  }

  /** `ns.member` on a builtin namespace import as a VALUE: constants
   * (path.sep, os.EOL) read as interned string literals; fs.constants
   * access-mode bits bake as numbers exactly like the named-import form;
   * functions have no closure representation (call sites only); members
   * with no lowering fence with the module-qualified name. Null for
   * non-namespace receivers (the property chain keeps trying). */
  lowerNamespaceBuiltinProperty(expr: ts.PropertyAccessExpression): IrExpr | null {
    const loc = locOf(expr);
    // Named and namespace imports share the destination platform table.
    if (!expr.questionDotToken && ts.isPropertyAccessExpression(expr.expression)) {
      const inner = this.builtinMemberOf(expr.expression);
      if (inner && inner.module === "fs" && inner.member === "constants") {
        const value = fsConstantValue(expr.name.text, this.targetPlatform);
        if (value === undefined) {
          this.noLowering(
            `fs.constants.${expr.name.text}`,
            expr,
            "access modes and O_RDONLY/O_WRONLY/O_RDWR/O_CREAT/O_EXCL/O_TRUNC/O_APPEND are supported",
          );
        }
        return { kind: "numLit", value, type: F64, loc };
      }
    }
    const bi = this.builtinMemberOf(expr);
    if (!bi) return null;
    // events.defaultMaxListeners READS the process-wide default (its
    // write twin routes through emitter.setDefaultMaxChk).
    if (bi.module === "events" && bi.member === "defaultMaxListeners") {
      return { kind: "libCall", fn: "emitter.getDefaultMax", args: [], type: F64, loc };
    }
    const c = builtinModuleConstOf(this, bi.module, bi.member);
    if (c !== undefined) return builtinConstLit(c, loc);
    // module.builtinModules through a namespace binding — the baked
    // Node v24 list, a fresh string[] per read.
    if (bi.module === "module" && bi.member === "builtinModules") {
      return builtinModulesArrayLit(loc);
    }
    // tls.rootCertificates through the namespace: the same runtime-valued
    // constant the named-import read lowers to.
    {
      const roots = lowerTlsRootCertificates(this, bi, loc);
      if (roots) return roots;
    }
    if (bi.member === "constants" && bi.module === "fs") {
      // A bare `fs.constants` read (not one of the baked bits above).
      this.noLowering(`fs.constants`, expr, "access modes and O_RDONLY/O_WRONLY/O_RDWR/O_CREAT/O_EXCL/O_TRUNC/O_APPEND are supported");
    }
    if (builtinModuleFnOf(this, bi.module, bi.member)) {
      this.unsupported(
        "SC1090",
        expr,
        `library functions as values (call '${expr.getText()}' directly)`,
      );
    }
    this.noLowering(
      `${bi.module}.${bi.member}`,
      expr,
      builtinFenceHintOf(bi.module, bi.member),
      this.checker.getSymbolAtLocation(expr.name),
    );
  }

  lowerBuiltinModuleCall(expr: ts.CallExpression,
    bi: { module: string; member: string },
    fn: BuiltinModuleFn,
    loc: SrcLoc,): IrExpr {
    return lowerBuiltinModuleCall(this, expr, bi, fn, loc);
  }

  lowerTimersPromisesSetInterval(
    expr: ts.CallExpression,
    bi: { module: string; member: string },
    loc: SrcLoc,
  ): IrExpr | null {
    return lowerTimersPromisesSetInterval(this, expr, bi, loc);
  }

  lowerFsToUnixTimestampCall(expr: ts.CallExpression,
    bi: { module: string; member: string },
    loc: SrcLoc,): IrExpr | null {
    return lowerFsToUnixTimestampCall(this, expr, bi, loc);
  }

  lowerFsLadderCall(expr: ts.CallExpression,
    bi: { module: string; member: string },
    loc: SrcLoc,): IrExpr | null {
    return lowerFsLadderCall(this, expr, bi, loc);
  }

  lowerChildArgsArg(node: ts.Expression | undefined, loc: SrcLoc): IrExpr {
    return lowerChildArgsArg(this, node, loc);
  }

  lowerSpawnSyncCall(expr: ts.CallExpression, loc: SrcLoc): IrExpr {
    return lowerSpawnSyncCall(this, expr, loc);
  }

  lowerSpawnCall(expr: ts.CallExpression, loc: SrcLoc): IrExpr {
    return lowerSpawnCall(this, expr, loc);
  }

  lowerExecSyncCall(expr: ts.CallExpression, shell: boolean, loc: SrcLoc): IrExpr {
    return lowerExecSyncCall(this, expr, shell, loc);
  }

  recordToEnvPairs(node: ts.Expression): IrExpr {
    return recordToEnvPairs(this, node);
  }

  envToPairsHelper(shapeId: string, loc: SrcLoc): string | null {
    return lowerEnvToPairsHelper(this, shapeId, loc);
  }

  lowerJsonMethodCall(call: ts.CallExpression,
    access: ts.PropertyAccessExpression,): IrExpr | null {
    return lowerJsonMethodCall(this, call, access);
  }

  fencedBuiltinImportOf(ident: ts.Identifier): string | null {
    return fencedBuiltinImportOf(this, ident);
  }

  lowerCryptoComposedCall(call: ts.CallExpression,
    access: ts.PropertyAccessExpression,): IrExpr | null {
    return lowerCryptoComposedCall(this, call, access);
  }

  lowerUrlMethodCall(call: ts.CallExpression,
    access: ts.PropertyAccessExpression,): IrExpr | null {
    return lowerUrlMethodCall(this, call, access);
  }

  lowerSearchParamsMethodCall(call: ts.CallExpression,
    access: ts.PropertyAccessExpression,): IrExpr | null {
    return lowerSearchParamsMethodCall(this, call, access);
  }

  lowerStatsMethodCall(call: ts.CallExpression,
    access: ts.PropertyAccessExpression,): IrExpr | null {
    return lowerStatsMethodCall(this, call, access);
  }

  lowerChildMethodCall(call: ts.CallExpression,
    access: ts.PropertyAccessExpression,): IrExpr | null {
    return lowerChildMethodCall(this, call, access);
  }

  lowerAtomicsCall(call: ts.CallExpression,
    access: ts.PropertyAccessExpression,): IrExpr | null {
    return lowerAtomicsCall(this, call, access);
  }

  // The server-surface spoke (lower-server.ts): net module calls, the
  // netServer/netSocket method surface, and the composed address().port.
  lowerNetModuleCall(expr: ts.CallExpression,
    bi: { module: string; member: string },
    loc: SrcLoc,): IrExpr | null {
    return lowerNetModuleCall(this, expr, bi, loc);
  }

  lowerServerMethodCall(call: ts.CallExpression,
    access: ts.PropertyAccessExpression,): IrExpr | null {
    return lowerServerMethodCall(this, call, access);
  }

  lowerServerProperty(expr: ts.PropertyAccessExpression): IrExpr | null {
    return lowerServerProperty(this, expr);
  }

  // The dgram/dns spoke (lower-dgram.ts): dgram/dns module calls and the
  // dgramSocket method surface.
  lowerAssertModuleCall(expr: ts.CallExpression,
    bi: { module: string; member: string },
    loc: SrcLoc,): IrExpr | null {
    return lowerAssertModuleCall(this, expr, bi, loc);
  }

  lowerAssertDirectCall(expr: ts.CallExpression, loc: SrcLoc): IrExpr | null {
    return lowerAssertDirectCall(this, expr, loc);
  }

  // The util spoke (lower-inspect.ts): inspect/format/formatWithOptions.
  lowerUtilModuleCall(expr: ts.CallExpression,
    bi: { module: string; member: string },
    loc: SrcLoc,): IrExpr | null {
    return lowerUtilModuleCall(this, expr, bi, loc);
  }

  lowerDgramDnsModuleCall(expr: ts.CallExpression,
    bi: { module: string; member: string },
    loc: SrcLoc,): IrExpr | null {
    return lowerDgramDnsModuleCall(this, expr, bi, loc);
  }

  lowerDgramMethodCall(call: ts.CallExpression,
    access: ts.PropertyAccessExpression,): IrExpr | null {
    return lowerDgramMethodCall(this, call, access);
  }

  // The node:test spoke (lower-test.ts): registrations, suites, hooks,
  // and the TestContext surface.
  lowerNodeTestModuleCall(expr: ts.CallExpression,
    bi: { module: string; member: string },
    loc: SrcLoc,): IrExpr | null {
    return lowerNodeTestModuleCall(this, expr, bi, loc);
  }

  lowerTestDirectCall(expr: ts.CallExpression, loc: SrcLoc): IrExpr | null {
    return lowerTestDirectCall(this, expr, loc);
  }

  lowerTestMethodCall(call: ts.CallExpression,
    access: ts.PropertyAccessExpression,): IrExpr | null {
    return lowerTestMethodCall(this, call, access);
  }

  lowerTestCtxProperty(expr: ts.PropertyAccessExpression): IrExpr | null {
    return lowerTestCtxProperty(this, expr);
  }

  lowerHttpHeadersElement(expr: ts.ElementAccessExpression): IrExpr | null {
    return lowerHttpHeadersElement(this, expr);
  }

  lowerJsonProperty(expr: ts.PropertyAccessExpression): IrExpr | null {
    return lowerJsonProperty(this, expr);
  }

  lowerErrorCodeProperty(expr: ts.PropertyAccessExpression): IrExpr | null {
    return lowerErrorCodeProperty(this, expr);
  }

  lowerStringDecoderMethodCall(call: ts.CallExpression, access: ts.PropertyAccessExpression): IrExpr | null {
    return lowerStringDecoderMethodCall(this, call, access);
  }

  lowerReadlineMethodCall(call: ts.CallExpression, access: ts.PropertyAccessExpression): IrExpr | null {
    return lowerReadlineMethodCall(this, call, access);
  }

  lowerDcChannelMethodCall(call: ts.CallExpression, access: ts.PropertyAccessExpression): IrExpr | null {
    return lowerDcChannelMethodCall(this, call, access);
  }

  lowerAlsMethodCall(call: ts.CallExpression, access: ts.PropertyAccessExpression): IrExpr | null {
    return lowerAlsMethodCall(this, call, access);
  }

  lowerDcChannelProperty(access: ts.PropertyAccessExpression): IrExpr | null {
    return lowerDcChannelProperty(this, access);
  }

  lowerDcTracingChannelMethodCall(call: ts.CallExpression, access: ts.PropertyAccessExpression): IrExpr | null {
    return lowerDcTracingChannelMethodCall(this, call, access);
  }

  lowerDcTracingChannelProperty(access: ts.PropertyAccessExpression): IrExpr | null {
    return lowerDcTracingChannelProperty(this, access);
  }

  strdecHelper(op: "write" | "end", shapeId: string, loc: SrcLoc): string {
    return strdecHelper(this, op, shapeId, loc);
  }

  lowerProcessProperty(expr: ts.PropertyAccessExpression): IrExpr | null {
    return lowerProcessProperty(this, expr);
  }

  lowerNavigatorProperty(expr: ts.PropertyAccessExpression): IrExpr | null {
    return lowerNavigatorProperty(this, expr);
  }

  lowerFsConstantsProperty(expr: ts.PropertyAccessExpression): IrExpr | null {
    return lowerFsConstantsProperty(this, expr);
  }

  lowerBuiltinConstantsProperty(expr: ts.PropertyAccessExpression): IrExpr | null {
    return lowerBuiltinConstantsProperty(this, expr);
  }

  builtinConstantBindingOf(ident: ts.Identifier): IrExpr | null {
    return builtinConstantBindingOf(this, ident);
  }

  builtinConstantsDestructureDecl(nameNode: ts.Node, init: ts.Expression | undefined): boolean {
    return builtinConstantsDestructureDecl(this, nameNode, init);
  }

  lowerCryptoModuleCall(expr: ts.CallExpression, bi: { module: string; member: string }, loc: SrcLoc): IrExpr | null {
    return lowerCryptoModuleCall(this, expr, bi, loc);
  }

  lowerProcessStreamProperty(expr: ts.PropertyAccessExpression): IrExpr | null {
    return lowerProcessStreamProperty(this, expr);
  }

  isProcessEnv(node: ts.Expression): boolean {
    return isProcessEnv(this, node);
  }

  envValueType(): IrType {
    return envValueType(this);
  }

  lowerProcessEnvGet(expr: ts.PropertyAccessExpression): IrExpr | null {
    return lowerProcessEnvGet(this, expr);
  }

  lowerProcessMethodCall(call: ts.CallExpression,
    access: ts.PropertyAccessExpression,): IrExpr | null {
    return lowerProcessMethodCall(this, call, access);
  }

  lowerProcessOptionalMethodCall(call: ts.CallExpression): IrExpr | null {
    return lowerProcessOptionalMethodCall(this, call);
  }

  lowerTimeoutMethodCall(call: ts.CallExpression, access: ts.PropertyAccessExpression): IrExpr | null {
    return lowerTimeoutMethodCall(this, call, access);
  }

  promisifiedExecFileDecl(nameNode: ts.Node, init: ts.Expression | undefined): boolean {
    return promisifiedExecFileDecl(this, nameNode, init);
  }

  lowerExecFileAsyncCall(expr: ts.CallExpression, loc: SrcLoc): IrExpr {
    return lowerExecFileAsyncCall(this, expr, loc);
  }

  execFileAsyncHelper(loc: SrcLoc): { name: string; shapeId: string } {
    return execFileAsyncHelper(this, loc);
  }

  envSnapshotHelper(shapeId: string, loc: SrcLoc): string | null {
    return envSnapshotHelper(this, shapeId, loc);
  }

  lowerNumberStaticCall(call: ts.CallExpression,
    access: ts.PropertyAccessExpression,): IrExpr | null {
    return lowerNumberStaticCall(this, call, access);
  }

  lowerDateCall(call: ts.CallExpression,
    access: ts.PropertyAccessExpression,): IrExpr | null {
    return lowerDateCall(this, call, access);
  }

  lowerTextCodecCall(call: ts.CallExpression,
    access: ts.PropertyAccessExpression,): IrExpr | null {
    return lowerTextCodecCall(this, call, access);
  }

  lowerStringStaticCall(call: ts.CallExpression,
    access: ts.PropertyAccessExpression,): IrExpr | null {
    return lowerStringStaticCall(this, call, access);
  }

  lowerStringLastIndexOfCall(call: ts.CallExpression,
    access: ts.PropertyAccessExpression,): IrExpr | null {
    return lowerStringLastIndexOfCall(this, call, access);
  }

  lowerFilterNarrowCall(call: ts.CallExpression,
    access: ts.PropertyAccessExpression,): IrExpr | null {
    // Native array filters use the state-aware HOF helper: its callback
    // receives present undefined values and skips holes before a narrowed
    // survivor is extracted. The older narrowing helper reads the payload
    // directly and therefore cannot represent that three-state contract.
    if (this.mapTypeOf(this.typeOf(access.expression))?.kind === "array" && this.isStdlibMember(access)) {
      return null;
    }
    return lowerFilterNarrowCall(this, call, access);
  }

  lowerPromiseMethodCall(call: ts.CallExpression,
    access: ts.PropertyAccessExpression,): IrExpr | null {
    return lowerPromiseMethodCall(this, call, access);
  }

  lowerPromiseStaticCall(call: ts.CallExpression,
    access: ts.PropertyAccessExpression,): IrExpr | null {
    return lowerPromiseStaticCall(this, call, access);
  }

  lowerNumberStaticProperty(expr: ts.PropertyAccessExpression): IrExpr | null {
    return lowerNumberStaticProperty(this, expr);
  }

  /* ── the island-backed ambient surface (ISLAND_SURFACE) ───────────── */

  requireDynamicApi(feature: string, node: ts.Node): void {
    return requireDynamicApi(this, feature, node);
  }

  lowerMathProperty(expr: ts.PropertyAccessExpression): IrExpr | null {
    return lowerMathProperty(this, expr);
  }

  islandGlobalFnOf(ident: ts.Identifier): IslandFnEntry | null {
    return islandGlobalFnOf(this, ident);
  }

  lowerIslandMethodCall(call: ts.CallExpression,
    access: ts.PropertyAccessExpression,): IrExpr | null {
    return lowerIslandMethodCall(this, call, access);
  }
}
