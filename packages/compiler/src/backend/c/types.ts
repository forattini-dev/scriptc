import { InternalCompilerError } from "../../errors.js";
/* Type-directed dispatch tables of the C emitter: the C spelling of every IR
 * type and the per-type runtime entry points (retain/release, box kinds,
 * array element kinds, map key/value kinds), plus C literal spelling. Pure
 * functions of IrType/values — every emission module leans on these, so they
 * live in ONE place with no emitter state. */
import type { IrBytesElem, IrType } from "../../ir/ir.js";
import { POINTER_KINDS, type PointerKind, runtimeRcStem, RUNTIME_EMITTER_CLASS, RUNTIME_ERROR_CLASSES, RUNTIME_STREAM_CLASSES } from "../../ir/ir.js";
import {
  mangleClassRelease,
  mangleClassRetain,
  mangleClassStruct,
  mangleRecordRelease,
  mangleRecordRetain,
  mangleRecordStruct,
} from "../mangle.js";

type BoxNewPointerType = Extract<IrType, {
  kind: Exclude<PointerKind, "string" | "array" | "func" | "dyn" | "jsval" | "caught" | "promise" | "generator">
}>;
type RejectedArrayPointerType = Extract<IrType, {
  kind: Exclude<PointerKind, "string" | "array" | "bytes" | "record" | "object" | "union" | "jsval" | "child" | "netServer" | "symbol" | "classval" | "func">
}>;

export function cType(t: IrType): string {
  switch (t.kind) {
    case "bigint":
      throw new Error("native BigInt values require --backend rust");
    case "f64":
    case "date":
      return "double";
    case "bool":
      return "bool";
    case "string":
      return "ScrStr *";
    case "array":
      return "ScrArr *";
    case "map":
    case "set":
      // Sets ARE the map runtime with the value slot unused (SCR_MAP_VAL_F64
      // storing a constant 0) — one struct, one RC family, one allocator.
      return "ScrMap *";
    case "regex":
      return "ScrRegex *";
    case "bytes":
      // One struct for every element kind (the runtime dispatches on the
      // stored elem tag) — exactly the ScrArr pattern.
      return "ScrBytes *";
    case "url":
      return "ScrUrl *";
    case "searchParams":
      return "ScrSearchParams *";
    case "symbol":
      return "ScrSym *";
    case "stats":
      return "ScrStats *";
    case "fileHandle":
      return "ScrFileHandle *";
    case "spawnRes":
      return "ScrSpawnRes *";
    case "child":
      return "ScrChild *";
    case "effect":
      throw new Error("the effect kernel needs --backend rust");
    case "sqliteDb": case "sqliteStmt":
      throw new Error("bun:sqlite handles need --backend rust");
    case "genericFunc":
      throw new Error("generic function values need --backend rust");
    case "netServer":
      return "ScrNetServer *";
    case "netSocket":
      return "ScrNetSocket *";
    case "http2Session":
      return "ScrH2Session *";
    case "http2Stream":
      return "ScrH2Stream *";
    case "dgramSocket":
      return "ScrDgramSocket *";
    case "testCtx":
      return "ScrTestCtx *";
    case "httpReq":
      return "ScrHttpReq *";
    case "httpRes":
      return "ScrHttpRes *";
    case "httpClientReq":
      return "ScrHttpClientReq *";
    case "secureCtx":
      return "ScrSecureCtx *";
    case "fsWatcher":
      return "ScrWatcher *";
    case "childStream":
      return "ScrChildStream *";
    case "procStream":
      // A SCALAR kind: the stream value IS its fd (1 = stdout, 2 =
      // stderr) — no heap, no refcount.
      return "double";
    case "func":
      return "ScrClosure *";
    case "classval":
      // ONE struct type for every class (the fields are class-independent).
      return "ScrClassObj *";
    case "object":
      // Runtime-provided error classes share the runtime's ScrError struct
      // (all four builtins have the same layout; user subclasses embed it
      // as their emitted struct's prefix).
      if (RUNTIME_ERROR_CLASSES.has(t.className)) return "ScrError *";
      // The runtime emitter class shares the runtime's ScrEmitter struct
      // (user subclasses embed its prefix in their emitted structs).
      if (t.className === RUNTIME_EMITTER_CLASS) return "ScrEmitter *";
      // The five runtime stream classes share ONE runtime struct (the
      // emitter prefix plus the stream-state pointer) — upcasts among
      // them and to ScrEmitter are pointer reinterprets.
      if (RUNTIME_STREAM_CLASSES.has(t.className)) return "ScrStream *";
      return `${mangleClassStruct(t.className)} *`;
    case "record":
      return `${mangleRecordStruct(t.shapeId)} *`;
    case "union":
      return "ScrUnion *";
    case "dyn":
      return "ScrDyn *";
    case "jsval":
      return "ScrJsval *";
    case "caught":
      return "ScrCaught *";
    case "promise":
      return "ScrPromise *";
    case "generator":
      return "ScrGen *";
    case "void":
      return "void";
    case "undefinedT":
    case "nullT":
      // Unit kinds have no C value form: they exist only as union arms
      // (the box carries the tag and nothing else) — a unit type asked to
      // declare a C value is an emitter bug.
      throw new InternalCompilerError(`emitter bug: ${t.kind} has no C value form`);
    default: {
      const _exhaustive: never = t;
      void _exhaustive;
      throw new InternalCompilerError("unreachable");
    }
  }
}

/** The retain call (+1, returns the value) for one refcounted type. */
export function retainCallC(type: IrType, expr: string): string {
  const stem = runtimeRcStem(type);
  if (stem !== null) return `${stem}_retain(${expr})`;
  switch (type.kind) {
    case "object":
      return `${mangleClassRetain(type.className)}(${expr})`;
    case "record":
      return `${mangleRecordRetain(type.shapeId)}(${expr})`;
    default:
      throw new InternalCompilerError(`emitter bug: retain of non-refcounted type ${type.kind}`);
  }
}

/** The release call for one owned refcounted value (all NULL-tolerant). */
export function releaseCallC(type: IrType, expr: string): string {
  const stem = runtimeRcStem(type);
  if (stem !== null) return `${stem}_release(${expr})`;
  switch (type.kind) {
    case "object":
      return `${mangleClassRelease(type.className)}(${expr})`;
    case "record":
      return `${mangleRecordRelease(type.shapeId)}(${expr})`;
    default:
      throw new InternalCompilerError(`emitter bug: release of non-refcounted type ${type.kind}`);
  }
}

/** The runtime's box-kind tag for a boxed (captured) variable's type. */
export function boxKindC(t: IrType): string {
  if (POINTER_KINDS.has(t.kind) &&
      t.kind !== "string" && t.kind !== "array" && t.kind !== "func" &&
      t.kind !== "dyn" && t.kind !== "jsval" && t.kind !== "caught" &&
      t.kind !== "promise" && t.kind !== "generator") {
    throw new InternalCompilerError(`emitter bug: ${t.kind} boxes go through boxNewC, not boxKindC`);
  }
  switch (t.kind) {
    case "bigint":
      throw new Error("native BigInt values require --backend rust");
    case "f64":
    case "date":
      return "SCR_BOX_F64";
    case "bool":
      return "SCR_BOX_BOOL";
    case "string":
      return "SCR_BOX_STR";
    case "array":
      return "SCR_BOX_ARR";
    case "func":
      return "SCR_BOX_FUNC";
    case "procStream":
      // Scalar (the fd double) — the f64 box carries it.
      return "SCR_BOX_F64";
    case "dyn":
      // dyn never rides capture boxes (frontend rejects dyn captures).
      throw new InternalCompilerError("emitter bug: box of dyn");
    case "jsval":
      throw new InternalCompilerError("emitter bug: jsval boxes go through boxNewC, not boxKindC");
    case "promise":
      // promises ride obj-boxes (boxNewC), never plain kind boxes
      throw new InternalCompilerError("emitter bug: promise boxes go through boxNewC");
    case "generator":
      // generators ride obj-boxes too (boxNewC — vAdapters carries the
      // ScrGen RC entry points; no trace, like child).
      throw new InternalCompilerError("emitter bug: generator boxes go through boxNewC");
    case "undefinedT":
    case "nullT":
    case "caught":
      // unit kinds never stand alone (and catch bindings never box), so
      // nothing to box
      throw new InternalCompilerError(`emitter bug: box of ${t.kind}`);
    case "void":
      throw new InternalCompilerError("emitter bug: box of void");
    default: {
      const _exhaustive: never = t as Exclude<typeof t, BoxNewPointerType>;
      void _exhaustive;
      throw new InternalCompilerError("unreachable");
    }
  }
}

/** The runtime `_v` (void*-signature) RC entry points for one refcounted
 * type — the currency of every generic container that must retain/release
 * payloads whose concrete struct it cannot know: union values, capture
 * boxes, promises, and the exception cell. Classes and records use their
 * emitted per-shape adapters; everything else has runtime-provided ones.
 * Bare symbol names — call sites prefix `&` where a fn ptr is passed. */
export function vAdapters(t: IrType): { retain: string; release: string } {
  const stem = runtimeRcStem(t);
  if (stem !== null && t.kind !== "caught") {
    return { retain: `${stem}_retain_v`, release: `${stem}_release_v` };
  }
  switch (t.kind) {
    case "bigint":
      throw new Error("native BigInt values require --backend rust");
    case "object":
      return { retain: `${mangleClassRetain(t.className)}_v`, release: `${mangleClassRelease(t.className)}_v` };
    case "record":
      return { retain: `${mangleRecordRetain(t.shapeId)}_v`, release: `${mangleRecordRelease(t.shapeId)}_v` };
    default:
      throw new InternalCompilerError(`emitter bug: no RC adapters for ${t.kind}`);
  }
}

/** Box accessor suffix: scalars stored unboxed, ref kinds as pointers. */
export function boxAccess(t: IrType): "f64" | "bool" | "ref" {
  // procStream is a scalar (the stream's fd double — boxKindC agrees with
  // SCR_BOX_F64), so its captures ride the f64 slot like any number.
  return t.kind === "f64" || t.kind === "date" || t.kind === "procStream" ? "f64" : t.kind === "bool" ? "bool" : "ref";
}

/** C function-pointer cast for calling through a closure: the callee
 * receives its own ScrClosure first, then the declared params. */
export function cFnPtrCast(ft: IrType & { kind: "func" }): string {
  const params = ["ScrClosure *", ...ft.params.map((p) => cType(p).trim())].join(", ");
  return `(${cType(ft.ret).trim()} (*)(${params}))`;
}

/** The runtime's element-kind tag for an array's element type. Record/
 * object/union elements are SCR_ELEM_REF (void* slots + per-array RC entry
 * points); array elements answer SCR_ELEM_ARR here, but a CYCLE-CAPABLE
 * inner array rides SCR_ELEM_REF instead so the outer array's trace can
 * reach it — that answer needs emitter state, so construction goes through
 * CEmitter.arrNewC, which overrides this for traced-array elements. */
export function elemKindC(elem: IrType): string {
  if (POINTER_KINDS.has(elem.kind) &&
      elem.kind !== "string" && elem.kind !== "array" && elem.kind !== "bytes" &&
      elem.kind !== "record" && elem.kind !== "object" && elem.kind !== "union" &&
      elem.kind !== "jsval" && elem.kind !== "child" && elem.kind !== "netServer" &&
      elem.kind !== "symbol" && elem.kind !== "classval" && elem.kind !== "func") {
    throw new InternalCompilerError(`emitter bug: array of ${elem.kind} (frontend rejects these)`);
  }
  switch (elem.kind) {
    case "bigint":
      throw new Error("native BigInt values require --backend rust");
    case "f64":
      return "SCR_ELEM_F64";
    case "bool":
      return "SCR_ELEM_BOOL";
    case "string":
      return "SCR_ELEM_STR";
    case "array":
      return "SCR_ELEM_ARR";
    case "bytes":
      return "SCR_ELEM_BYTES";
    case "record":
    case "object":
    case "union":
    // Island handles are ordinary refcounted pointers (scr_jsval_retain/
    // release adapters) — `any[]` under --dynamic is a native array of
    // handles, one element per island value.
    case "jsval":
    // Spawned child handles (ChildProcess[] — the running-apps list):
    // ordinary refcounted pointers, no trace (they drop their closures at
    // reap, so never part of a cycle).
    case "child":
    // Server handles (ProxyServer[] — the [...set] drain of the auxiliary
    // registries): same refcounted-pointer story; listeners drop at close,
    // so a handle-in-array cycle is temporary like child's.
    case "netServer":
    // Symbols (symbol[] — heterogeneous sentinel lists): refcounted
    // identity pointers holding only strings — no trace, no cycles ever.
    case "symbol":
    // Class objects ((typeof Shape)[] — the registry idiom): immortal
    // statics behind no-op RC adapters — no trace, no cycles ever;
    // indexOf/includes/=== are the REF kind's pointer identity, exactly
    // JS class identity.
    case "classval":
      return "SCR_ELEM_REF";
    // Closures: refcounted, cycle-headered (captures can reach back
    // through boxes), scr_closure_* `_v` adapters + scr_closure_trace_v.
    // Identity semantics (indexOf/includes/===) are the REF kind's
    // pointer identity — exactly JS function identity.
    case "func":
      return "SCR_ELEM_REF";
    case "date":
    case "procStream":
    case "undefinedT":
    case "nullT":
      throw new InternalCompilerError(`emitter bug: array of ${elem.kind} (frontend rejects these)`);
    case "void":
      throw new InternalCompilerError("emitter bug: array of void");
    default: {
      const _exhaustive: never = elem as Exclude<typeof elem, RejectedArrayPointerType>;
      void _exhaustive;
      throw new InternalCompilerError("unreachable");
    }
  }
}

/** The runtime's element-kind tag for a bytes (typed array) type. */
const BYTES_ELEM_KIND_C: Record<IrBytesElem, string> = {
  u8: "SCR_BYTES_U8",
  u32: "SCR_BYTES_U32",
  i32: "SCR_BYTES_I32",
  f32: "SCR_BYTES_F32",
  f64: "SCR_BYTES_F64",
};

export function bytesElemKindC(elem: IrBytesElem): string {
  return BYTES_ELEM_KIND_C[elem];
