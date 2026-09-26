import { ffiNativeTypeC, ffiCallbackNativeParamsC, ffiCallbackPointerTypeC, ffiCallbackDummyC } from "./ffi-types.js";
import type { CEmitOptions } from "./options.js";
export type { CEmitOptions } from "./options.js";
import { assertNativeModuleBackend } from "../native-module-support.js";
import { InternalCompilerError } from "../../errors.js";
/* IR → C. Three-address style: every IR expression lands in a fresh C temp.
 * Verbose (clang -O2 erases it) but buys three things: short-circuit
 * emission is trivially correct, reference counting has one mechanical
 * hook point, and the output shape is already close to a CFG lowering.
 *
 * RC ownership discipline (must match docs/ir.md):
 * - every refcounted temp (isRefCounted kinds) holds an owned (+1) reference;
 * - varDecl/assign/return/call-argument MOVE that ownership (the temp is
 *   struck from its release list); everything else borrows;
 * - each statement releases its remaining refcounted temps when it ends;
 * - each scope releases the refcounted locals declared in it when it exits;
 * - callees own their params and release them on exit (callers pass +1);
 * - `return` first releases pending temps and every in-scope refcounted
 *   local.
 *
 * RC dispatch is type-directed: frames and scopes carry {name, type} so a
 * release always knows which scr_*_release to call. `isRefCounted` in
 * ir.ts is the membership test — no `kind === "string"` checks here.
 *
 * The generated C is a debugging surface: locals keep their TS names inside
 * the mangled form and every statement carries a `source line` comment.
 */
/* IR → C. Three-address style: every IR expression lands in a fresh C temp.
 * Verbose (clang -O2 erases it) but buys three things: short-circuit
 * emission is trivially correct, reference counting has one mechanical
 * hook point, and the output shape is already close to a CFG lowering.
 *
 * RC ownership discipline (must match docs/ir.md):
 * - every refcounted temp (isRefCounted kinds) holds an owned (+1) reference;
 * - varDecl/assign/return/call-argument MOVE that ownership (the temp is
 *   struck from its release list); everything else borrows;
 * - each statement releases its remaining refcounted temps when it ends;
 * - each scope releases the refcounted locals declared in it when it exits;
 * - callees own their params and release them on exit (callers pass +1);
 * - `return` first releases pending temps and every in-scope refcounted
 *   local.
 *
 * RC dispatch is type-directed: frames and scopes carry {name, type} so a
 * release always knows which scr_*_release to call. `isRefCounted` in
 * ir.ts is the membership test — no `kind === "string"` checks here.
 *
 * The generated C is a debugging surface: locals keep their TS names inside
 * the mangled form and every statement carries a `source line` comment.
 */
import type { IrBytesElem, IrGlobal, IrRecordShape, IrExpr, IrFfiImport, IrFunction, IrLocal, IrModule, IrStmt, IrType, IrUnionDef, SrcLoc } from "../../ir/ir.js";
import { ffiCallbackType, funcOf, isFfiCallbackParam, isFfiContextParam, isFfiReleaseParam, isRefCounted, isUnitType, mapOf, moduleEmbedsCompressedNpm, moduleUsesDgram, moduleUsesDynInvoke, moduleEmbedsBuiltin, moduleUsesFetch, moduleUsesFsWatch, moduleUsesHttp2, moduleUsesHttpServer, moduleUsesNet, moduleUsesNodeTest, moduleUsesProcessEvents, moduleUsesStream, moduleUsesTls, moduleUsesTlsCa, POINTER_KINDS, type PointerKind, RUNTIME_EMITTER_CLASS, STRING, VOID } from "../../ir/ir.js";
import { undefinedArmTag } from "../../ir/analysis.js";
import { scalarizeNumericRecords } from "../../ir/scalar-records.js";
import type { IntegerRanges } from "../../ir/integer-ranges.js";
import { findConstantNumericTables, type ConstantNumericTable } from "../../ir/constant-tables.js";
import { allocateFfiCallbackAdapters, hasForeignFfiCallback, hasRetainedFfiCallback, type FfiCallbackAdapter } from "../ffi-callbacks.js";
              `  memcpy(b->data + idx * ${size}, &stored, ${size});`,
