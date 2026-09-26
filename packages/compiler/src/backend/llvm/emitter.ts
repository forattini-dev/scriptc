import { assertNativeModuleBackend } from "../native-module-support.js";
import { InternalCompilerError } from "../../errors.js";
/* IR → LLVM IR text (.ll). The LLVM backend consumes the SAME in-memory
 * IrModule the C backend does (never the JSON dump — see the -0 lesson in
 * the survey). Its textual module is either lowered by scriptc's native
 * helper and linked with a runtime pack or occupies the legacy compiler
 * driver's program-TU seat. Both paths use the same scr_* C ABI.
 *
 * Phase 1 was the TRIVIAL TIER: f64/bool/string locals and params, the
 * scalar operator set, structured control flow, direct calls, interned
 * string literals, and the console protocol. Phase 2 adds the VOLUME
 * TIER: module globals and locals of every in-tier ref kind (arrays,
 * record shapes, unions, function values/closures), the full array and
 * string intrinsic surfaces, per-record-shape RC helpers (cycle headers
 * included — the C emitter's fixpoint, ported in shapes.ts), tagged-union
 * construction/narrowing/equality with interned immortal unit instances,
 * capture boxes and the closure calling convention, switch/for-of
 * lowering, and the non-throwing slice of the libCall table. EVERYTHING
 * ELSE REFUSES loudly at the first unhandled node (LlvmUnsupportedError
 * naming the kind) — this backend never guesses and never emits wrong
 * code for a construct it does not model. compile() surfaces the refusal
 * as diagnostic SC3001.
 *
 * RC ownership discipline: the frame/scope release-point machinery is
 * ported from CEmitter (docs/ir.md) — every refcounted temp holds an owned
 * +1 reference; varDecl/assign/return/call-argument MOVE that ownership;
 * each statement releases its remaining refcounted temps when it ends;
 * each scope releases the refcounted locals declared in it when it exits;
 * callees own their params; return/break/continue release everything the
 * jump bypasses (releaseForJump). Releases are type-directed through
 * shapes.ts (the releaseCallC table's LLVM twin); frame entries can be
 * SLOT-based (the entry names a pointer whose CURRENT value releases —
 * conditional results like optional chains need that indirection).
 *
 * Exceptions (phase 4): the pending-flag unwind protocol, ported from the
 * C emitter. `throw` moves its payload into the runtime's exception cell
 * (scr_throw_*) and unwinds; after every call that can raise (per the
 * SAME computeMayThrow analysis the C backend runs) a pending check tests
 * scr_exc_pending() and unwinds — releasing frames/scopes down to the
 * innermost try handler's depths and branching to its label, or releasing
 * everything and returning a dummy value (never read: callers of a
 * may-throw function test the flag before using the result). No
 * setjmp/longjmp: longjmp would skip the emitted RC releases. try/catch
 * follows stmts.ts's shape exactly — a compile-time tryStack entry
 * per region, the catch block taking the exception (scr_exc_take into the
 * binding's snapshot box, or scr_exc_clear for the bindingless form), the
 * finally body emitted once per path (normal, exception-with-stash,
 * pending-return) with fresh temps each time. Catch bindings ride
 * ScrCaught snapshot boxes (caughtTest/caughtNarrow/caughtCheck read
 * them); TDZ reads test the box's payload slot and throw Node's
 * ReferenceError. main() gains the uncaught epilogue when the entry
 * function may throw.
 *
 * The dyn surface (phase 5): ScrDyn dyn values are in the tier — dyn.ts
 * ports walkers.ts's dyn slice (match/check/toDyn walkers, the
 * String(unknown)/caught→dyn/keyed-read singletons, the checked-dynamic
 * function boundary's thunk/box/adapter triple) and the emitter lowers
 * the dyn expression kinds (dynFrom/dynCall/dynInvoke/dynTest/dynKeyGet/
 * dynCheck/destructuring), the JSON.parse family, dyn record fields and
 * overflow maps, dyn capture boxes, and generator unknown channels.
 * The island surface (jsval/jsExit and embedded npm tables) is in the
 * tier too; the module text and resolution tables use the same compressed,
 * lazy-inflate representation as the C debugging backend.
 */
import { deflateRawSync } from "node:zlib";
import { endsWithJump, matchStringSelfConcat } from "../../ir/analysis.js";
import { emitLibraryIdentityLines } from "../library-identity-markers.js";
import type {
  IrBytesElem,
  IrExpr,
  IrFfiCallbackParam,
  IrFfiImport,
  IrFunction,
  IrGlobal,
  IrLocal,
  IrModule,
  IrRecordShape,
  IrStmt,
  IrType,
  IrUnionDef,
  SrcLoc,
} from "../../ir/ir.js";
import { CAUGHT, ffiCallbackType, isFfiContextParam, isRefCounted, isUnitType, moduleEmbedsBuiltin, moduleEmbedsCompressedNpm, moduleUsesDynInvoke, moduleUsesFetch, moduleUsesFsWatch, moduleUsesHttpServer, moduleUsesNet, moduleUsesNodeTest, moduleUsesProcessEvents, moduleUsesStream, moduleUsesTls, moduleUsesTlsCa, NPM_COMPRESS_MIN, POINTER_KINDS, RUNTIME_EMITTER_CLASS, RUNTIME_ERROR_CLASSES, RUNTIME_STREAM_CLASSES, typeKey, VOID } from "../../ir/ir.js";
import { matchIntegerBytesForLoop } from "../../ir/integer-loops.js";
import { scalarizeNumericRecords } from "../../ir/scalar-records.js";
import { analyzeIntegerRanges, type IntegerRanges } from "../../ir/integer-ranges.js";
import { findConstantNumericTables, type ConstantNumericTable } from "../../ir/constant-tables.js";
import { allocateFfiCallbackAdapters, hasForeignFfiCallback, hasRetainedFfiCallback, type FfiCallbackAdapter } from "../ffi-callbacks.js";
import { RUNTIME_ABI_MARKER } from "../runtime-abi.js";
import { computeMayThrow } from "../c/may-throw.js";
import { mangleArgPack, mangleAsyncSpawn, mangleClassObj, mangleFnClosure, mangleFunction, mangleGenDrop, mangleGenSpawn, mangleGlobal, mangleLocal, mangleRecordStruct, mangleTrampoline, mangleWrapper } from "../mangle.js";
import { BlockBuilder } from "./blocks.js";
import { f64Lit, ffiNativeTypeLl } from "./common.js";
import { emitLiteralExpr, emitOperatorExpr, emitStringExpr, emitContainerExpr, emitRecordExpr } from "./expr-primitives.js";
import { emitControlExpr } from "./expr-control.js";
import { emitCallExpr } from "./expr-calls.js";
import { emitDynamicExpr } from "./expr-dynamic.js";
import { emitIntrinsicExpr, emitSerializationExpr, emitAsyncExpr } from "./expr-async.js";
import { emitJsInteropExpr, emitExpr } from "./expr-dispatch.js";
import { emitJsMarshal, emitJsOp, emitJsExit, islandAdapter, islandTypedAdapter } from "./expr-island.js";
  private emitToUint32(value: string, expr?: IrExpr): string {
    return emitToUint32(this.expressionContext(), value, expr);
