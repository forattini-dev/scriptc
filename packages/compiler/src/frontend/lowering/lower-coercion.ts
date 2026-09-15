/* Coercion at typed slots: coerceInto and lowerExprExpecting route a lowered value into the type its slot expects —
 * union wraps, island boundary crossings, promise and discriminated views, width lifts, function adapters, index-value
 * slots, return values. The specialized engines live beside it (lower-width-coercion.ts, lower-function-adapters.ts,
 * lower-union-retag.ts, lower-jsval-lift.ts) and reach each other through the Lowerer, so interned helpers keep
 * their call order. */
import { lowerPromiseView } from "./lower-promise-view.js";
import { lowerDiscriminatedView } from "./lower-discriminated-view.js";
import { nativeRecordCheckSupported } from "../../ir/native-record.js";
import * as ts from "../ts7/adapter.js";
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
import { canAdaptDynFuncTo, canConvertToDyn, canMarshalTypedFuncIntoIsland, DYN, isUnitType, JSVAL, typeEquals, UNDEFINED_T } from "../../ir/ir.js";
import {
  isJsSourceFile,
} from "../program.js";
import {
  isUnitOnlyTsType,
  withUndefinedArm as withUndefinedArmCanonical,
} from "../type-mapper.js";
import { rejectNativeImportCopy } from "./lower-native-import-boundary.js";
import { returnOfFailingYield } from "./lower-schema.js";
import { bindingNeverReassigned } from "./lower-calls.js";
import { islandFuncValueFence, islandRegexpOf } from "./lower-island.js";
import { voidTernaryIfStmtOrExprStmt } from "./lower-stmts.js";
import { lowerDynObjectLiteral } from "./lower-exprs.js";
import type { ExpandoMember } from "./lower-expando.js";
import { familyFnOfValue, lowerFamilyImpl } from "./lower-families.js";
import type { Lowerer } from "./lowerer.js";
import { jsFuncNameOf } from "./lowerer.js";

  /** Coerce typed slots with checked shared views, canonical union wraps
   * and structural adapters; incompatible pairs keep their shape fences. */
  export function coerceToExpected(lowerer: Lowerer, expr: IrExpr, expected: IrType): IrExpr {
    rejectNativeImportCopy(lowerer, expr, expected);
    const promiseView = lowerPromiseView(lowerer, expr, expected);
    if (promiseView) return promiseView;
    const sharedUnion = lowerDiscriminatedView(lowerer, expr, expected);
    if (sharedUnion) return sharedUnion;
    // Island boundary, both directions. IN: any static value flowing into
    // an any-typed slot marshals implicitly (tsc allows the assignment;
    // the marshal is where its semantics live). OUT: an 'any' value
    // flowing into a typed slot compiles to a VALIDATED exit — like every
    // dyn→static edge, trust-but-verify: a lying `any` throws a catchable
    // TypeError instead of corrupting memory (SEMANTICS.md). Unmarshalable
    // and unextractable types fall through to requireExactShape's fences.
    if (expected.kind === "jsval" && expr.type.kind !== "jsval") {
      // Bare unit literals: the engine's own undefined/null (units have no
      // other producers, so dropping the operand loses nothing).
      if (isUnitType(expr.type)) {
        return { kind: "jsOp", op: expr.type.kind === "undefinedT" ? "undefLit" : "nullLit", args: [], type: JSVAL, loc: expr.loc };
      }
      // A CHECKED-DYNAMIC (dyn/'unknown') value entering the island (the
      // `isJson ? JSON.parse(text) : islandParser(text)` config ternary):
      // the dyn tree deep-copies into engine values — data kinds only; a
      // dyn carrying a boxed function/handle/promise throws the catchable
      // TypeError at runtime (trust-but-verify, like every boundary).
      if (expr.type.kind === "dyn") {
        return { kind: "jsMarshal", value: expr, type: JSVAL, loc: expr.loc };
      }
      // Native checked-dynamic rest callbacks and island rest callbacks
      // use different ABIs. Adapt before the ordinary marshal predicate so
      // overloaded implementation returns preserve omitted defaults and
      // every surplus argument when their public slot is `any`.
      const dynRestAdapter = lowerer.dynRestIslandAdapter(expr, expr.loc);
      if (dynRestAdapter) {
        return { kind: "jsMarshal", value: dynRestAdapter, type: JSVAL, loc: expr.loc };
      }
      if (lowerer.boundarySafe(expr.type)) {
        return { kind: "jsMarshal", value: expr, type: JSVAL, loc: expr.loc };
      }
      // Closures cross as host functions when their signature marshals —
      // the same shapes jsvalIn admits at call arguments (`const f: any =
      // (x: number) => x * 3` is the declaration-slot spelling of the
      // package-callback pattern).
      if (
        expr.type.kind === "func" &&
        canMarshalTypedFuncIntoIsland(expr.type, (id) => lowerer.shapes.get(id), (id) => lowerer.unions.get(id))
      ) {
        return { kind: "jsMarshal", value: expr, type: JSVAL, loc: expr.loc };
      }
      // jsval-BEARING composites (a record holding `any` fields, an array
      // of such records) have no JSON marshal but an honest per-field
      // island construction — see jsvalLiftExpr.
      if (lowerer.jsvalLiftable(expr.type)) {
        return lowerer.jsvalLiftExpr(expr, expr.loc);
      }
      // A RegExp flowing into an 'any' slot: the fresh-engine-RegExp
      // rebuild (see jsvalIn's regex rule); computed regex values fall
      // through to requireExactShape's fence.
      if (expr.type.kind === "regex") {
        const re = islandRegexpOf(expr);
        if (re) return re;
      }
      return expr;
    }
    if (expr.type.kind === "jsval" && expected.kind !== "jsval") {
      // The jsval→dyn crossing (the world unification's engine-handle
      // kind): an 'any'-typed engine value flowing into an 'unknown'/
      // 'object'/JS-residue slot wraps BY REFERENCE as the checked-dynamic tree's island
      // kind — engine scalars normalize to native dyn kinds at wrap time,
      // typeof/truthiness/String()/=== route to the engine, un-armed dyn
      // walks fence loudly, and the value unwraps back identity-preserved
      // (scr_jsval_from_dyn). Monotone under evolution/widening: a value
      // wraps once at its first dyn edge and stays valid through every
      // subsequent dyn slot; narrowing never changes representation.
      // This wrap RETIRES the silent-wrong-answer fence-closure box for
      // jsval members of dyn object literals (lowerDynObjectLiteral's
      // coercion lands here first).
      if (expected.kind === "dyn") {
        return { kind: "dynFromJsval", value: expr, type: DYN, loc: expr.loc };
      }
      // An island value flowing into a PROMISE-typed slot (the inferred
      // `loadPlugins` return — `Promise.all(...)` lowered engine-side
      // against a Promise<any[]> inference): the island→static promise
      // bridge — the engine promise settles a fresh static promise (void
      // fulfillments drop, `any[]`-declared fulfillments exit
      // Array.isArray-gated by reference at the settle, 'any' parks as an
      // island handle). Only inner shapes the bridge can deliver take the
      // arm; the rest keep the exit fence with the type named.
      if (
        expected.kind === "promise" &&
        (expected.inner.kind === "void" ||
          expected.inner.kind === "jsval" ||
          (expected.inner.kind === "array" && expected.inner.elem.kind === "jsval"))
      ) {
        return { kind: "jsBridgePromise", value: expr, type: expected, loc: expr.loc };
      }
      // The exit set: everything round-trippable, plus bare undefined-armed
      // unions of JSON-safe data arms (the engine's undefined takes the
      // undefined arm before the JSON detour) — canExitIslandToType.
      if (lowerer.boundaryExitSafe(expected)) {
        return { kind: "jsExit", value: expr, type: expected, loc: expr.loc };
      }
      return expr;
    }
    // A TYPED value flowing into an 'unknown' slot (`const u: unknown = 5`,
    // an unknown-typed param/return, a dyn-valued index slot): the
    // static→dyn conversion — dynFrom, a DEEP COPY (the jsMarshal aliasing
    // stance intoIndexValueSlot documents; SEMANTICS.md). Bare
    // undefined/null literals store the dyn unit values. Types outside the
    // dyn's domain (bytes, classes, Maps, ...) fall through to
    // requireExactShape's SC1101 fence.
    // A promise flowing into a VOID-promise slot (an inferred
    // Promise<never> return holding a `return Promise.reject(value)` the
    // dyn arm typed promise<dyn>): awaiting through the slot ignores the
    // fulfillment payload (scr_await_void) and rejections flow untyped,
    // so the value passes through — one C representation, no adapter.
    if (
      expected.kind === "promise" &&
      expected.inner.kind === "void" &&
      expr.type.kind === "promise" &&
      expr.type.inner.kind !== "void"
    ) {
      return { kind: "promiseVoidWiden", value: expr, type: expected, loc: expr.loc };
    }
    if (expected.kind === "dyn" && expr.type.kind !== "dyn") {
      if (expr.kind === "unitLit" || lowerer.dynConvertible(expr.type)) {
        return { kind: "dynFrom", value: expr, type: DYN, loc: expr.loc };
      }
      // An error-HIERARCHY object (builtin subclass or user `extends
      // Error` class) upcasts to the %Error root first — the caughtToDyn
      // encoding (scr_dyn_from_error) carries name/message/code and the
      // runtime CACHES the identity edge, so `instanceof TypeError` on
      // the dyn side still answers exactly (dyn.errInstanceof). Only the
      // root spelling was convertible before; the harness passes typed
      // errors into untyped helpers constantly.
      if (expr.type.kind === "object" && lowerer.errorHierarchyClassOf(expr.type.className)) {
        return {
          kind: "dynFrom",
          value: lowerer.upcastTo(expr, "%Error"),
          type: DYN,
          loc: expr.loc,
        };
      }
      return expr;
    }
    // A dyn ('unknown') ACTUAL flowing into a typed slot the checker
    // approved (an assertion function's narrowing, the error-any world's
    // forgiven chains): the VALIDATED extraction — dynCheck, the
    // checked-cast machinery, applied automatically. Trust-but-verify,
    // exactly the island exit's stance: a value that doesn't match the
    // slot's type throws a catchable TypeError instead of misreading the
    // payload. Only dynCheck's own domain (JSON-representable types,
    // undefined-armed unions of those, bytes<u8>, the %Error root)
    // converts; everything else keeps requireExactShape's SC1100 fence.
    if (expr.type.kind === "dyn" && expected.kind !== "dyn") {
      const undefArmedOk =
        expected.kind === "union" &&
        (lowerer.unions
          .get(expected.unionId)
          ?.arms.every((a) => a.kind === "undefinedT" || lowerer.jsonSafe(a)) ??
          false);
      const bytesOk = expected.kind === "bytes" && expected.elem === "u8";
      const errorOk = expected.kind === "object" && expected.className === "%Error";
      // Callable slots validate the function and adapt its signature.
      // Shared native records validate members while retaining their map.
      // Composite method signatures stay fenced until parameter and result
      // representations can preserve their aliases across the boundary.
      const callableOrRecordOk =
        (expected.kind === "func" && canAdaptDynFuncTo(expected, (id) => lowerer.shapes.get(id), (id) => lowerer.unions.get(id))) ||
        nativeRecordCheckSupported(expected, (id) => lowerer.shapes.get(id), (id) => lowerer.unions.get(id));
      if (lowerer.jsonSafe(expected) || undefArmedOk || bytesOk || errorOk || callableOrRecordOk) {
        return { kind: "dynCheck", value: expr, type: expected, loc: expr.loc };
      }
      return expr;
    }
    // A HYBRID (function-with-properties) record flowing into a plain
    // func slot extracts its reserved %call field — the chalk shape's
    // "the value IS callable" half (type-mapper.ts's hybrid mapping).
    if (expected.kind === "func" && expr.type.kind === "record") {
      const un = lowerer.hybridCallUnwrap(expr);
      if (un !== expr && typeEquals(un.type, expected)) return un;
    }
    // A zero-param function whose RETURN is a wider record array than the
    // slot's (`getRoutes: () => cachedRoutes` against `() => Narrow[]`):
    // the interned width adapter wraps it — each call maps the result
    // through the per-element record width copy.
    if (
      expected.kind === "func" &&
      expr.type.kind === "func" &&
      !typeEquals(expr.type, expected) &&
      expr.type.params.length === 0 &&
      expected.params.length === 0
    ) {
      const adapter = lowerer.funcReturnWidthAdapter(expr.type, expected, expr.loc);
      if (adapter) {
        return { kind: "call", callee: adapter, args: [expr], type: expected, loc: expr.loc };
      }
    }
    // JS func-into-func mismatches ride the checked-dynamic function
    // boundary: box the value (dynFrom), adapt to the slot (dynCheck) —
    // the thunk delivers JS arity exactly (extras ignored, missing args
    // the undefined dyn value), so `return _return` fits _mustCallInner's
    // inferred (unknown) => unknown slot even though the wrapper declares
    // (). JS files only: TypeScript signatures keep the exact-shape
    // fences (a mismatch there is a compile-time story, not a boundary).
    if (expected.kind === "func" && expr.type.kind === "func" && !typeEquals(expr.type, expected)) {
      const sf = lowerer.program.getSourceFile(expr.loc.file);
      if (
        sf !== undefined && isJsSourceFile(sf) &&
        canConvertToDyn(expr.type, (id) => lowerer.shapes.get(id), (id) => lowerer.unions.get(id)) &&
        canAdaptDynFuncTo(expected, (id) => lowerer.shapes.get(id), (id) => lowerer.unions.get(id))
      ) {
        return {
          kind: "dynCheck",
          value: { kind: "dynFrom", value: expr, type: DYN, loc: expr.loc },
          type: expected,
          loc: expr.loc,
        };
      }
    }
    // A spawnSync-runner value (`defaultRunner` — its inferred return is
    // the opaque spawnRes) flowing into a slot whose signature returns
    // the structural result record tsc accepted: the interned adapter
    // forwards the call and converts the result field-wise.
    if (expected.kind === "func" && expr.type.kind === "func" && !typeEquals(expr.type, expected)) {
      const adapter = lowerer.spawnResFnAdapter(expr.type, expected, expr.loc);
      if (adapter) {
        return { kind: "call", callee: adapter, args: [expr], type: expected, loc: expr.loc };
      }
    }
    // The GENERAL function-value adapter (funcCoerceAdapter): a function
    // whose signature differs from the slot's only by coercible pieces —
    // fewer parameters (JS ignores extras: `load(function () {})` into an
    // `(x?: string) => void` slot), parameters/results that wrap into
    // union arms, re-tag union-to-union, take a checked narrow, or cross
    // the dyn boundary — wraps in a fresh closure applying exactly those
    // conversions per call. Runs after the specialized adapters above so
    // their pointed shapes keep winning.
    if (expected.kind === "func" && expr.type.kind === "func" && !typeEquals(expr.type, expected)) {
      const adapter = lowerer.funcCoerceAdapter(expr.type, expected, expr.loc);
      if (adapter) {
        return { kind: "call", callee: adapter, args: [expr], type: expected, loc: expr.loc };
      }
    }
    // Derived-into-base widening: a legal implicit upcast (prefix layout —
    // a pointer reinterpret). Exactness stays required in every other
    // direction; there is never an implicit DOWNcast.
    if (
      expected.kind === "object" &&
      expr.type.kind === "object" &&
      expr.type.className !== expected.className &&
      lowerer.isSubclassOf(expr.type.className, expected.className)
    ) {
      return { kind: "upcast", value: expr, type: expected, loc: expr.loc };
    }
    // CLASS-VALUE widening (classval:D into a classval:C slot): the same
    // pointer with only the static type changing — legal exactly when D
    // strictly descends from C AND the two completed constructor ABIs
    // agree, the invariant `newValue` completion against C's one
    // signature rests on. Mismatches fall through to requireExactShape's
    // pointed class-value fences.
    if (
      expected.kind === "classval" &&
      expr.type.kind === "classval" &&
      expr.type.className !== expected.className &&
      lowerer.isSubclassOf(expr.type.className, expected.className)
    ) {
      const sub = lowerer.classes.get(expr.type.className);
      const sup = lowerer.classes.get(expected.className);
      // A generic FAMILY as the destination (`new () => Box<any>` slots):
      // no `%<family>.constructor` exists for the validator's ABI check
      // and no completion target is meaningful — the exact-shape fence
      // downstream names the class-value flow instead.
      if (sub && sup && !sup.generic && lowerer.ctorAbiEquals(sub, sup)) {
        return { kind: "upcast", value: expr, type: expected, loc: expr.loc };
      }
    }
    if (expected.kind !== "union" || typeEquals(expr.type, expected)) {
      // A UNION value flowing into one of its own ARMS: the checker
      // proved the narrowing (control flow through a destructured
      // binding, `d ?? (d = ...)`, a predicate call — tsc typed the SITE
      // as the arm; the IR value still carries the declaration's union)
      // — the CHECKED extraction, exactly `x!`'s machinery: the proven
      // arm's payload comes out, every other arm throws the catchable
      // TypeError (divergence 38's lying-assertion stance — sound
      // narrowing never reaches them).
      if (
        expr.type.kind === "union" &&
        !isUnitType(expected) &&
        expected.kind !== "void" &&
        lowerer.armTag(expr.type.unionId, expected) >= 0
      ) {
        const helper = lowerer.narrowedArmHelper(expr.type.unionId, expected, expr.loc);
        if (helper) {
          return { kind: "call", callee: helper, args: [expr], type: expected, loc: expr.loc };
        }
      }
      if (!typeEquals(expr.type, expected)) {
        const w = lowerer.widthCoerce(expr, expected);
        if (w) return w;
        // A UNIT (null/undefined) flowing into a plain non-nullable slot
        // the checker approved (`null!` casts, non-strict assignments):
        // the stranded-source stance (divergence 38) without a union in
        // sight — the flow compiles to the catchable TypeError, where
        // Node lets the impossible value ride until (unless) it is used.
        const trap = lowerer.strandedUnitTrap(expr, expected, expr.loc);
        if (trap) return trap;
      }
      return expr;
    }
    if (expr.type.kind === "union") {
      // A DIFFERENT union flowing into this slot: re-tag at runtime when
      // every arm maps (unionRetagHelper); anything unmappable falls
      // through to requireExactShape's SC2003.
      const helper = lowerer.unionRetagHelper(expr.type.unionId, expected.unionId, expr.loc);
      if (helper) {
        return { kind: "call", callee: helper, args: [expr], type: expected, loc: expr.loc };
      }
      return expr;
    }
    if (expr.type.kind === "void") {
      // A void CALL RESULT flowing into a union with an undefined arm
      // (`var r = foo({})` where foo returns void — tsc's void slots map
      // to undefined-armed unions): JS's void value IS undefined, so the
      // wrap takes the undefined arm. The backends evaluate the void
      // operand for its effects and produce the interned unit instance
      // (the unionWrap void-payload rule).
      const undefTag = lowerer.armTag(expected.unionId, UNDEFINED_T);
      if (undefTag >= 0) {
        return { kind: "unionWrap", unionId: expected.unionId, tag: undefTag, value: expr, type: expected, loc: expr.loc };
      }
      return expr;
    }
    const tag = lowerer.armTag(expected.unionId, expr.type);
    if (tag < 0) {
      // A derived class flowing into a union with a base-class arm widens
      // first (nearest ancestor arm wins), then wraps like any arm value.
      if (expr.type.kind === "object") {
        for (let c = lowerer.classes.get(expr.type.className)?.base ?? null; c; c = c.base) {
          const baseTag = lowerer.armTag(expected.unionId, { kind: "object", className: c.def.name });
          if (baseTag >= 0) {
            const widened = lowerer.upcastTo(expr, c.def.name);
            return { kind: "unionWrap", unionId: expected.unionId, tag: baseTag, value: widened, type: expected, loc: expr.loc };
          }
        }
      }
      // A derived CLASS VALUE against a union with a base classval arm
      // (`typeof Base | undefined` slots receiving D): the same nearest-
      // ancestor widening, gated by the constructor-ABI rule; a mismatch
      // falls through to the union fence.
      if (expr.type.kind === "classval") {
        const sub = lowerer.classes.get(expr.type.className);
        for (let c = sub?.base ?? null; c; c = c.base) {
          const baseTag = lowerer.armTag(expected.unionId, { kind: "classval", className: c.def.name });
          if (baseTag >= 0) {
            if (!sub || !lowerer.ctorAbiEquals(sub, c)) break;
            const widened: IrExpr = { kind: "upcast", value: expr, type: { kind: "classval", className: c.def.name }, loc: expr.loc };
            return { kind: "unionWrap", unionId: expected.unionId, tag: baseTag, value: widened, type: expected, loc: expr.loc };
          }
        }
      }
      // A width-coercible value against a union: coerce into the SINGLE
      // width-liftable arm, then wrap like any arm value (widthLiftPlan's
      // liftWrap — several candidate arms are ambiguous and decline).
      const lift = lowerer.widthLiftPlan(expr.type, expected);
      if (lift) return lowerer.applyWidthLift(lift, expr, expected, expr.loc);
      // Arms OUTSIDE widthLiftPlan's domain keep the historic per-arm
      // widthCoerce probe (first match): index-signature record arms (the
      // overflow CAPTURE helper owns their reshapes) and `any[]` arms
      // (the island-boundary per-element lift). Bounded to those arm
      // shapes so the plan's ambiguity rule for record/array lifts is
      // never undone by a first-match fallback.
      {
        const def = lowerer.unions.get(expected.unionId);
        if (def) {
          for (let i = 0; i < def.arms.length; i++) {
            const arm = def.arms[i]!;
            const boundaryArm =
              (arm.kind === "record" && lowerer.shapes.get(arm.shapeId)?.indexValue !== undefined) ||
              (arm.kind === "array" && arm.elem.kind === "jsval");
            if (!boundaryArm) continue;
            const w = lowerer.widthCoerce(expr, arm);
            if (w) {
              return { kind: "unionWrap", unionId: expected.unionId, tag: i, value: w, type: expected, loc: expr.loc };
            }
          }
        }
      }
      // A checker-approved value the union CANNOT represent: a unit
      // (`getV(): Foo | Bar { return null! }`, `null as any as T`), or a
      // record/array with NO width-lift candidate at all (`{} as
      // InstanceOne | InstanceTwo`). Every one is a LYING assertion —
      // tsc accepted the flow only through a cast/assertion our arm list
      // proves impossible — so it compiles to the stranded-arm TRAP
      // (divergence 38's stance: the catchable TypeError at the flow,
      // where Node lets the impossible value ride). AMBIGUOUS width
      // candidates stay compile fences: honest code lands there.
      {
        const trap = lowerer.strandedCoercionTrap(expr, expected, expr.loc);
        if (trap) return trap;
      }
      return expr;
    }
    return { kind: "unionWrap", unionId: expected.unionId, tag, value: expr, type: expected, loc: expr.loc };
  }

  /** True when a `src` function value enters a `dst` slot through
   * funcCoerceAdapter with NO stranded (trap-only) piece: no rest packs,
   * no surplus source params, every slot parameter converts into the
   * wrapped function's own type, and the result converts back (a void
   * slot drops it; a void result answers the exact JS undefined for
   * dyn/jsval slots). The width family's func gate — widthLiftPlan
   * bridges only signatures whose every call succeeds by construction. */
  export function cleanFuncAdaptable(lowerer: Lowerer, src: IrType & { kind: "func" }, dst: IrType & { kind: "func" }): boolean {
    if (src.rest === true || dst.rest === true) return false;
    if (src.params.length > dst.params.length) return false;
    for (let i = 0; i < src.params.length; i++) {
      if (!lowerer.coercibleValue(dst.params[i]!, src.params[i]!)) return false;
    }
    if (dst.ret.kind === "void") return src.ret.kind !== "jsval";
    if (lowerer.coercibleValue(src.ret, dst.ret)) return true;
    return src.ret.kind === "void" && (dst.ret.kind === "dyn" || dst.ret.kind === "jsval");
  }

  /** THE coercion path for values flowing into a typed slot: union arms
   * wrap implicitly (coerceToExpected), then the exact-type fence runs
   * (SC2002 for record shapes, SC2003 for unions). Every slot-directed
   * lowering goes through here (via lowerExprExpecting) or calls this
   * directly when the expression was already lowered. */
  export function coerceInto(lowerer: Lowerer, node: ts.Node, expr: IrExpr, expected: IrType): IrExpr {
    let source = expr;
    if (expr.type.kind === "jsval" && expected.kind === "func") {
      const symbol = ts.isIdentifier(node) ? lowerer.resolveValueSymbol(node) : null;
      const checkerDeclared = symbol ? lowerer.checker.getTypeOfSymbol(symbol) : lowerer.typeOf(node);
      const declared = (() : IrType | null => {
        const signatures = lowerer.checker.getCallSignatures(checkerDeclared);
        const signature = signatures[0];
        if (signature === undefined || signatures.length !== 1 || signature.getTypeParameters().length > 0) return null;
        const params: IrType[] = [];
        for (const param of signature.getParameters()) {
          const mapped = lowerer.mapTypeOf(lowerer.checker.getTypeOfSymbol(param));
          if (mapped === null) return null;
          params.push(mapped);
        }
        const ret = lowerer.mapTypeOf(lowerer.checker.getReturnTypeOfSignature(signature));
        return ret === null ? null : { kind: "func", params, ret };
      })();
      const scalar = (type: IrType): boolean =>
        type.kind === "f64" || type.kind === "bool" || type.kind === "string";
      if (
        declared?.kind === "func" &&
        declared.params.every(scalar) && scalar(declared.ret) &&
        canAdaptDynFuncTo(declared, (id) => lowerer.shapes.get(id), (id) => lowerer.unions.get(id))
      ) {
        source = {
          kind: "dynCheck",
          value: { kind: "dynFromJsval", value: expr, type: DYN, loc: expr.loc },
          type: declared,
          loc: expr.loc,
        };
      }
    }
    let e = lowerer.coerceToExpected(source, expected);
    // An 'any' value PROVABLY null/undefined (the unit literal itself, or
    // a read of a binding nothing ever assigns a non-unit value) flowing
    // implicitly into a primitive slot: the validated exit refuses units
    // unconditionally, so every run would throw the boundary TypeError
    // where Node proceeds silently. A failure certain at compile time is
    // a fence, not a runtime surprise. Explicit casts keep their runtime
    // checked-cast semantics (the cast lowering builds its own jsExit
    // before this runs, so `e !== expr` skips them), and union/composite
    // targets keep the runtime exit (an undefined-armed union ACCEPTS the
    // engine's undefined; composite validation is dynCheck's business).
    if (
      e !== expr && e.kind === "jsExit" &&
      (e.type.kind === "f64" || e.type.kind === "string" || e.type.kind === "bool")
    ) {
      const unit = lowerer.provenUnitAnyOf(node, e.value);
      if (unit !== null) {
        lowerer.unsupported(
          "SC1090",
          node,
          `an 'any' value that is always ${unit} flowing into a '${lowerer.fmt(expected)}' slot (nothing in the program gives this value another shape, and the island boundary's validated exit refuses ${unit} — every run would throw a TypeError where Node proceeds silently)`,
          `give the binding a value other than ${unit} before this use, or keep the slot's type 'any'`,
        );
      }
    }
    // A closure that just BOXED into dyn takes its best-effort JS name
    // from the source node (identifier reads, named function expressions,
    // NamedEvaluation through a variable initializer) — inspect prints
    // [Function: name] and call errors spell it, like Node.
    if (e.kind === "dynFrom" && e.value.type.kind === "func" && e.fnName === undefined) {
      const name = jsFuncNameOf(node);
      if (name !== null) e = { ...e, fnName: name };
    }
    // A union the plain re-tag declined (stranded NON-unit arms): when the
    // node's CHECKER type proves those arms away, they trap instead — the
    // sub-union narrowing bridge (narrowedRetagHelper).
    if (e.type.kind === "union" && expected.kind === "union" && !typeEquals(e.type, expected)) {
      const helper = lowerer.narrowedRetagHelper(node, e.type.unionId, expected.unionId, e.loc);
      if (helper) {
        e = { kind: "call", callee: helper, args: [e], type: expected, loc: e.loc };
      }
    }
    // A JS FUNC value outside the island marshal set flowing into a
    // jsval slot (`withPlugins(getSupportInfoWithoutPlugins, 0)` — a
    // wrapper built at module init around a function the run may never
    // call): the crossing defers to a call-time fence closure instead of
    // stopping the statement — jsvalIn's deferral, the implicit-coercion
    // spelling.
    if (expected.kind === "jsval" && e.type.kind === "func" && !typeEquals(e.type, expected)) {
      const diagsBefore = lowerer.diags.length;
      try {
        lowerer.requireExactShape(node, e.type, expected);
      } catch (err) {
        const fence = islandFuncValueFence(lowerer, err, diagsBefore, node);
        if (fence) return fence;
        throw err;
      }
      return e;
    }
    lowerer.requireExactShape(node, e.type, expected);
    return e;
  }

  /** The unit an 'any' expression PROVABLY holds on every run, or null
   * when no proof exists. Two spellings prove: the lowered value IS the
   * engine unit literal (`null as any`, an any-contextual `undefined`),
   * or the node is an identifier whose every declaration is a plain,
   * non-ambient `var`/`let`/`const` declarator under a variable STATEMENT
   * (catch bindings, for-of/for-in cursors, parameters, and imports all
   * fail this shape test — each receives values from elsewhere), each
   * initializer absent or unit-typed by the checker (a unit TYPE has
   * exactly one value, so syntax doesn't matter), and nothing in the
   * declaring file ever assigns it — bindingNeverReassigned, the same
   * file-scan proof the generic-binding machinery leans on (ESM import
   * bindings are read-only, so cross-file writes don't exist). A hoisted
   * `var` read before its unit-initialized statement holds undefined —
   * also a unit — so the mixed case reports both names. */
  export function provenUnitAnyOf(lowerer: Lowerer, node: ts.Node, value: IrExpr): string | null {
    if (value.kind === "jsOp" && value.args.length === 0) {
      if (value.op === "undefLit") return "undefined";
      if (value.op === "nullLit") return "null";
    }
    let n: ts.Node = node;
    while (ts.isParenthesizedExpression(n)) n = n.expression;
    if (!ts.isIdentifier(n)) return null;
    const sym = lowerer.resolveValueSymbol(n);
    if (!sym) return null;
    const decls = lowerer.checker.declarationsOf(sym);
    if (decls.length === 0) return null;
    const units = new Set<string>();
    let allConst = true;
    let firstDecl: ts.VariableDeclaration | null = null;
    for (const d of decls) {
      if (
        !ts.isVariableDeclaration(d) ||
        !ts.isIdentifier(d.name) ||
        !ts.isVariableDeclarationList(d.parent) ||
        !ts.isVariableStatement(d.parent.parent) ||
        d.getSourceFile().isDeclarationFile ||
        (ts.getCombinedModifierFlags(d) & ts.ModifierFlags.Ambient) !== 0
      ) {
        return null;
      }
      firstDecl ??= d;
      if ((ts.getCombinedNodeFlags(d) & ts.NodeFlags.Const) === 0) allConst = false;
      if (d.initializer === undefined) {
        units.add("undefined");
      } else {
        const t = lowerer.typeOf(d.initializer);
        if (!isUnitOnlyTsType(t)) return null;
        for (const p of t.isUnionType() ? ts.constituentTypes(t) : [t]) {
          units.add((p.flags & ts.TypeFlags.Null) !== 0 ? "null" : "undefined");
        }
      }
      // A hoisted `var` with a unit initializer still reads `undefined`
      // between module/function entry and its statement.
      if ((ts.getCombinedNodeFlags(d) & (ts.NodeFlags.Const | ts.NodeFlags.Let)) === 0) {
        units.add("undefined");
      }
    }
    if (!allConst && !bindingNeverReassigned(lowerer, sym, firstDecl!)) return null;
    return [...units].sort().join(" or ");
  }

  /** Lowers an expression that flows into a slot of a known expected type,
   * then applies the coercion path (coerceInto). An EMPTY array literal
   * takes the slot's array type directly — the caller-supplied `expected`
   * lowerArrayLiteral documents, for the positions where tsc's contextual
   * API answers nothing (binding-element defaults: `{ json = [] }`) and
   * the literal's own never[] would build the f64 representation. */
  export function lowerExprExpecting(lowerer: Lowerer, node: ts.Expression, expected: IrType | undefined): IrExpr { if (expected?.kind === "genericFunc") { const fn = familyFnOfValue(lowerer, node); if (fn !== null) return lowerFamilyImpl(lowerer, fn, expected.familyId, lowerer.checker.getContextualType(node) ?? undefined); } // a function expression flowing into a generic slot joins THAT slot's family, whether or not it declares type parameters of its own
    if (expected?.kind === "array") {
      let x: ts.Expression = node;
      while (ts.isParenthesizedExpression(x)) x = x.expression;
      if (ts.isArrayLiteralExpression(x) && x.elements.length === 0) {
        return lowerer.coerceInto(node, lowerer.lowerArrayLiteral(x, expected), expected);
      }
    }
    // An OBJECT LITERAL against a checked-dynamic slot in a JS file (the
    // getSupportInfo options argument — a dyn-ABI param), or against the
    // standard RequestInit type in TypeScript: the value's world IS the
    // checked-dynamic tree — build the dyn literal directly.
    if (expected?.kind === "dyn") {
      let x: ts.Expression = node;
      while (ts.isParenthesizedExpression(x)) x = x.expression;
      if (ts.isObjectLiteralExpression(x)) {
        const contextual = lowerer.checker.getContextualType(x);
        const widened = contextual
          ? lowerer.checker.getBaseTypeOfLiteralType(contextual)
          : undefined;
        const sym = widened?.getAliasSymbol() ?? widened?.getSymbol();
        const requestInit =
          sym?.name === "RequestInit" && lowerer.isStdlibSymbol(sym);
        if (isJsSourceFile(x.getSourceFile()) || requestInit) {
          return lowerDynObjectLiteral(lowerer, x);
        }
      }
    }
    // An ARRAY LITERAL against a UNION slot whose own type has no static
    // home (the JS dyn fallback — the checker gave no usable context):
    // when the union has exactly ONE array-family arm — an array, or an
    // arity-matching tuple (the option-table `default: [{ value: [] }]`
    // shape) — build AS that arm and wrap; the IR-directed twin of
    // lowerArrayLiteral's contextual-union rule.
    if (expected?.kind === "union") {
      let x: ts.Expression = node;
      while (ts.isParenthesizedExpression(x)) x = x.expression;
      if (ts.isArrayLiteralExpression(x)) {
        const own = lowerer.mapTypeOf(lowerer.checker.getContextualType(x) ?? lowerer.typeOf(x));
        // Elements beyond bare null/undefined literals can never live in
        // a unit-only-element array — a checker type that degraded to one
        // (`[]`-flavored inference over a populated literal) carries no
        // element information.
        const nonUnitElems = x.elements.some(
          (el) =>
            !ts.isOmittedExpression(el) &&
            el.kind !== ts.SyntaxKind.NullKeyword &&
            !(ts.isIdentifier(el) && el.text === "undefined"),
        );
        if (
          own === null || own.kind === "dyn" || own.kind === "jsval" ||
          (own.kind === "array" && nonUnitElems && lowerer.unitOnlyElem(own.elem)) ||
          lowerer.widthLiftPlan(own, expected) === null
        ) {
          const def = lowerer.unions.get(expected.unionId);
          const arms = (def?.arms ?? []).filter(
            (a) =>
              (a.kind === "array" && !(nonUnitElems && lowerer.unitOnlyElem(a.elem))) ||
              (a.kind === "record" &&
                !!lowerer.shapes.get(a.shapeId)?.tuple &&
                lowerer.shapes.get(a.shapeId)!.fields.length === x.elements.length &&
                !x.elements.some(ts.isSpreadElement)),
          );
          if (arms.length === 1) {
            const arm = arms[0]!;
            const built = lowerer.lowerArrayLiteral(x, arm as IrType & { kind: "array" } | (IrType & { kind: "record" }));
            return lowerer.coerceInto(node, built, expected);
          }
        }
      }
    }
    const e = lowerer.lowerExpr(node);
    return expected ? lowerer.coerceInto(node, e, expected) : e;
  }

  /** A value flowing into an index-signature VALUE slot (an overflow
   * literal entry, a dynamic-keyed record write). dyn slots (`unknown`
   * signatures — ModelPricing's) take a dyn conversion: dyn values pass
   * through, JSON-safe static values convert with dynFrom (a deep copy —
   * the jsMarshal aliasing stance), everything else keeps the dyn-boundary
   * fence. Typed slots ride the ordinary coercion path (union slots wrap
   * arm values, exactness enforced). */
  export function intoIndexValueSlot(lowerer: Lowerer, value: IrExpr, indexValue: IrType, node: ts.Node): IrExpr {
    if (indexValue.kind !== "dyn") return lowerer.coerceInto(node, value, indexValue);
    if (value.type.kind === "dyn") return value;
    // Bare `undefined`/`null` literals store the dyn unit values (JS keeps
    // the key; JSON.stringify drops an undefined-valued one, like Node).
    if (value.kind === "unitLit") {
      return { kind: "dynFrom", value, type: DYN, loc: value.loc };
    }
    // An ISLAND ('any') value: the by-reference jsval→dyn wrap — the same
    // edge coerceToExpected converts (dyn slots accept engine values).
    if (value.type.kind === "jsval") {
      return { kind: "dynFromJsval", value, type: DYN, loc: value.loc };
    }
    if (!lowerer.dynConvertible(value.type)) {
      lowerer.unsupported(
        "SC1100",
        node,
        `storing '${lowerer.fmt(value.type)}' values under an 'unknown'-valued index signature (only numbers, strings, booleans, and JSON-safe records/arrays/unions convert)`,
      );
    }
    return { kind: "dynFrom", value, type: DYN, loc: value.loc };
  }

  /** IR-level `t | undefined` through the shared canonicalizer — the
   * declared result type of an index-signature read under
   * noUncheckedIndexedAccess. Null when the type cannot take the arm. */
  export function withUndefinedArmOf(lowerer: Lowerer, t: IrType): IrType | null {
    return withUndefinedArmCanonical(t, lowerer.unions);
  }

  /** True when a static type converts to a dyn value (the dynFrom
   * walker's domain): JSON-safe, bytes<u8> (Uint8Array/Buffer — the checked-dynamic tree's
   * bytes kind, shared in Rust and copied in C/LLVM; unknown-typed helpers),
   * an undefined-armed union whose other arms are JSON-safe — the
   * undefined arm becomes the undefined dyn singleton — or a BOXABLE
   * function type (the checked-dynamic function boundary: the closure
   * crosses as the checked-dynamic tree's callable kind, identity preserved). */
  export function dynConvertible(lowerer: Lowerer, t: IrType): boolean {
    return canConvertToDyn(t, (id) => lowerer.shapes.get(id), (id) => lowerer.unions.get(id));
  }

  /** The value of a `return` statement. In an async function `return p`
   * where p is a promise flattens (JS: the returned promise's settlement
   * becomes the async function's result), so it lowers exactly as
   * `return await p` — the awaitExpr parks the fiber and re-throws
   * rejections, which IS the flattening. Everything else flows into the
   * function's return slot through the usual coercion path. */
  /** The value of `return <expr>` against the context's declared return —
   * or NULL for a bare return: `return undefined`/`return null` in a
   * void-returning function (`{ bar() { return undefined } }`, inferred
   * `() => null` shapes whose return maps to void) hands the caller JS's
   * undefined, which the void slot drops. Units are pure literals, so
   * nothing evaluates; unit-typed non-literals keep the fences. */
  export function lowerReturnValue(lowerer: Lowerer, node: ts.Expression): IrExpr | null {
    const expected = lowerer.ctx.returnType;
    const e = lowerer.lowerExpr(node);
    if (expected.kind === "void" && e.kind === "unitLit") return null;
    if (lowerer.ctx.isAsync && e.type.kind === "promise" && expected.kind !== "promise") {
      const awaited: IrExpr = { kind: "awaitExpr", value: e, type: e.type.inner, loc: e.loc };
      return lowerer.coerceInto(node, awaited, expected);
    }
    return lowerer.coerceInto(node, e, expected);
  }

  /** `return <expr>` lowered as a STATEMENT against the declared return.
   * Void-returning contexts get the JS drop: a contextually void-typed
   * function may return a value (`fv = function() { return 0; }` into a
   * `() => void` slot) — the expression evaluates for its effects, the
   * caller never sees a value, so the return goes out bare. Async
   * void-inner returns still resolve a returned promise first. */
  export function lowerReturnStmt(lowerer: Lowerer, node: ts.Expression, loc: SrcLoc): IrStmt {
    const expected = lowerer.ctx.returnType; const failing = returnOfFailingYield(lowerer, node, loc); if (failing !== null) return failing;
    if (expected.kind === "void") {
      let e = lowerer.lowerExpr(node);
      if (lowerer.ctx.isAsync && e.type.kind === "promise") {
        e = { kind: "awaitExpr", value: e, type: e.type.inner, loc: e.loc };
      }
      if (e.kind === "unitLit") return { kind: "return", value: null, loc };
      // `return flag ? a() : b();` over two void arms: JS runs exactly the
      // taken arm for effect and completes — an if/else over the lowered
      // pieces does precisely that. Each branch carries its own explicit
      // bare return so statements after this one stay unreachable; the
      // arm landing keeps the rewrite recursive for nested void ternaries.
      if (e.kind === "ternary" && e.type.kind === "void") {
        const armStmts = (arm: IrExpr): IrStmt[] => [
          voidTernaryIfStmtOrExprStmt(arm, arm.loc),
          { kind: "return", value: null, loc },
        ];
        return {
          kind: "if",
          cond: e.cond,
          then: armStmts(e.then),
          else_: armStmts(e.else_),
          loc,
        };
      }
      if (e.type.kind === "void") return { kind: "return", value: e, loc };
      return {
        kind: "block",
        body: [
          { kind: "exprStmt", expr: e, loc },
          { kind: "return", value: null, loc },
        ],
        loc,
      };
    }
    return { kind: "return", value: lowerer.lowerReturnValue(node), loc };
  }
