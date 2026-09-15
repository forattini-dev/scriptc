/* Width coercion: a record, tuple, array or object value narrowed or lifted into a related shape — field copies
 * through interned %rec.width / %arr.width helpers (named in interning order), object ↔ record ↔ class plans, and
 * class statics projections. */
import { discriminatedViewSupported } from "./lower-discriminated-view.js";
import { InternalCompilerError } from "../../errors.js";
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
import { BOOL, canDynCheckTo, DYN, F64, isUnitType, STRING, typeEquals, UNDEFINED_T } from "../../ir/ir.js";
import {
  typeKey,
} from "../type-mapper.js";
import { ClassInfo, findMethodOn, findStaticOn, findGenericMethodOn, findGenericStaticOn } from "./lower-classes.js";
import { lowerRecordOvfCaptureHelper } from "./lower-containers.js";
import type { ExpandoMember } from "./lower-expando.js";
import { numLit, varRef } from "../../ir/build.js";
import type { Lowerer } from "./lowerer.js";
import { dynUndefinedExpr, type WidthLift } from "./lowerer.js";

  /** Copy-based structural WIDTH coercion — a `Full` record flowing into a
   * narrower `{ id }` slot, or `Full[]` into `{ id }[]` (the Pick-typed
   * display-table pattern): TS's width subtyping is free on erased types,
   * but monomorphic structs must RESHAPE, so the value is rebuilt with the
   * subset of fields copied — per element, via an interned helper, for
   * arrays. A deliberate divergence from JS's aliasing (SEMANTICS.md 35,
   * next to the marshal-copy stance): mutations through the narrowed value
   * don't reach the original and vice versa. Exactly two flows coerce —
   * record→record and record-array→record-array, each target field copied
   * from a same-named source field whose type matches exactly or LIFTS
   * into the target field's union (see recordWidthHelper); anything
   * deeper keeps the exactness fences. Null when the pair isn't
   * width-coercible. */
  export function widthCoerce(lowerer: Lowerer, expr: IrExpr, expected: IrType): IrExpr | null {
    if (expected.kind === "record" && expr.type.kind === "record") {
      // Index-signature pairs reshape through the overflow CAPTURE helper
      // (the `Object.fromEntries(e) as ModelPricing` pattern — declared
      // collisions validate at runtime); plain shapes keep the field-copy
      // width helper. Each declines the other's shapes.
      const helper =
        lowerer.recordWidthHelper(expr.type.shapeId, expected.shapeId, expr.loc) ??
        lowerRecordOvfCaptureHelper(lowerer, expr.type.shapeId, expected.shapeId, expr.loc);
      if (!helper) return null;
      return { kind: "call", callee: helper, args: [expr], type: expected, loc: expr.loc };
    }
    // A CLASS INSTANCE flowing into a record slot (`new Point(0, 0)` into
    // `{ x: number; y: number }` — tsc's structural view of classes): the
    // same field-projecting copy, each target field read off the instance.
    if (expected.kind === "record" && expr.type.kind === "object") {
      const helper = lowerer.objRecordWidthHelper(expr.type.className, expected.shapeId, expr.loc);
      if (!helper) return null;
      return { kind: "call", callee: helper, args: [expr], type: expected, loc: expr.loc };
    }
    // A RECORD flowing into a class-instance slot (`{x: 0, y: 0}` into
    // `A.Point` — the parameter-property data-class pattern): construction
    // IS the projection when the constructor is nothing but parameter
    // properties (recordToClassPlan's gates).
    if (expected.kind === "object" && expr.type.kind === "record") {
      const helper = lowerer.recordClassWidthHelper(expr.type.shapeId, expected.className, expr.loc);
      if (!helper) return null;
      return { kind: "call", callee: helper, args: [expr], type: expected, loc: expr.loc };
    }
    // A CLASS VALUE flowing into a record slot (`var f: ShapeFactory =
    // Shape` — an interface matched by the class's STATIC side): the
    // record captures the statics — fields as copies, methods as the
    // zero-capture closures `const f = C.m` builds. Direct classRef
    // sources only: the projection reads no runtime value, so an effectful
    // source expression would lose its evaluation.
    if (expected.kind === "record" && expr.type.kind === "classval" && expr.kind === "classRef") {
      return lowerer.classStaticsProjection(expr.type.className, expected.shapeId, expr.loc);
    }
    if (expected.kind === "array" && expr.type.kind === "array" && expected.elem.kind !== "jsval") {
      const helper = lowerer.arrayWidthHelper(expr.type, expected, expr.loc);
      if (helper) return { kind: "call", callee: helper, args: [expr], type: expected, loc: expr.loc };
      // The EMPTY-array lift (widthLiftPlan's emptyArr rule), top-level:
      // `cmd.aliases` typed `(null | undefined)[]` (an `aliases: []`
      // table) flowing into a `string[]` slot.
      const lift = lowerer.widthLiftPlan(expr.type, expected);
      if (lift?.how !== "emptyArr") return null;
      return lowerer.applyWidthLift(lift, expr, expected, expr.loc);
    }
    // A TUPLE flowing into an array slot (`const NAMES = [...] as const`
    // assigned to a `readonly T[]` — the const-table pattern): TS erases
    // the arity for free; the monomorphic tuple REBUILDS as a fresh array,
    // each position's value lifted into the element type (the same copy
    // stance as every width coercion — later mutations don't alias).
    if (expected.kind === "array" && expr.type.kind === "record" && expected.elem.kind !== "jsval") {
      const helper = lowerer.tupleArrayWidthHelper(expr.type.shapeId, expected, expr.loc);
      if (!helper) return null;
      return { kind: "call", callee: helper, args: [expr], type: expected, loc: expr.loc };
    }
    // An `any[]` slot: any liftable element becomes one island handle per
    // element (the messages-array pattern — records holding `any` content).
    if (
      expected.kind === "array" &&
      expected.elem.kind === "jsval" &&
      expr.type.kind === "array" &&
      expr.type.elem.kind !== "jsval"
    ) {
      const helper = lowerer.arrayToJsvalArrayHelper(expr.type.elem, expr.loc);
      if (!helper) return null;
      return { kind: "call", callee: helper, args: [expr], type: expected, loc: expr.loc };
    }
    return null;
  }

  /** One step of the recursive width-lift relation: how a `src`-typed
   * value enters a `dst`-typed slot under the copy-reshape family. The
   * pure planning side — nothing interns here, so whole plans validate
   * before any helper exists. The cases, in order:
   *   copy      — exact same type (typeEquals), the field/element moves as is
   *   retag     — union into union, every arm mapped (unionRetagMappable —
   *               identity arms, trap-less; record/array arms may width-lift
   *               into exactly one destination arm)
   *   wrap      — a non-unit arm value into a union that contains it
   *   liftWrap  — a record/array value into a union with NO identical arm
   *               but exactly ONE arm it width-lifts into (the findRoute
   *               rule applied at every level; several candidates are
   *               ambiguous and decline)
   *   width     — record into a strict-subset record (recordWidthPlan,
   *               recursively — NESTED width)
   *   arr       — array into array whose element pair lifts (per-element
   *               copy loop, arrayWidthHelper)
   *   dynIn     — a typed value into an 'unknown' (dyn) slot — the same
   *               static→dyn deep copy coerceToExpected applies top-level
   *   upcast    — a derived class instance into a base-typed slot (the
   *               prefix-layout pointer reinterpret, no copy)
   *   funcAdapt — a function into a slot whose signature differs only by
   *               CLEAN mechanical conversions (cleanFuncAdaptable); the
   *               stranded (trap-only) dispositions stay out of the plan
   * Null when the pair isn't in the relation — callers keep their fences. */
  export function widthLiftPlan(lowerer: Lowerer, src: IrType, dst: IrType): WidthLift | null {
    if (typeEquals(src, dst)) return { how: "copy" };
    if (discriminatedViewSupported(lowerer, src, dst)) return { how: "dynView" };
    if (dst.kind === "dyn" && src.kind !== "dyn" && lowerer.dynConvertible(src)) {
      return { how: "dynIn" };
    }
    if (dst.kind === "union") {
      if (src.kind === "union") {
        return lowerer.unionRetagMappable(src.unionId, dst.unionId) ? { how: "retag" } : null;
      }
      // A unit-typed source can't wrap here (unionWrap requires the
      // LITERAL unit — and no lowered shape carries a bare unit field).
      if (isUnitType(src)) return null;
      const tag = lowerer.armTag(dst.unionId, src);
      if (tag >= 0) return { how: "wrap", tag };
      const def = lowerer.unions.get(dst.unionId);
      if (!def) return null;
      const candidates: { tag: number; arm: IrType }[] = [];
      def.arms.forEach((arm, i) => {
        if (isUnitType(arm)) return;
        const sameFamily =
          (src.kind === "record" && arm.kind === "record") ||
          // Tuple values use the record IR shape but may lift into an
          // array arm (for example `aliases: ["h"]` entering the optional
          // `string[] | undefined` field of a generic schema). The
          // recursive probe below still enforces tupleArrayWidthHelper's
          // tuple and per-position rules, so ordinary records do not gain
          // an array conversion here.
          (src.kind === "record" && arm.kind === "array") ||
          (src.kind === "array" && arm.kind === "array") ||
          (src.kind === "object" && arm.kind === "record") ||
          (src.kind === "record" && arm.kind === "object") ||
          (src.kind === "func" && arm.kind === "func");
        if (sameFamily && lowerer.widthLiftPlan(src, arm) !== null) candidates.push({ tag: i, arm });
      });
      if (candidates.length !== 1) return null;
      return { how: "liftWrap", tag: candidates[0]!.tag, arm: candidates[0]!.arm };
    }
    // A UNION source into a slot that is ONE of its arms (a width copy
    // whose target field narrowed — the option-table choices shape:
    // `value: boolean | string` copying into a `value: string` slot the
    // checker approved): the CHECKED extraction — narrowedArmHelper,
    // exactly `x!`'s machinery — the proven arm's payload comes out, any
    // other arm throws the catchable TypeError (divergence 38's stance).
    if (src.kind === "union" && !isUnitType(dst) && dst.kind !== "void" && lowerer.armTag(src.unionId, dst) >= 0) {
      return { how: "narrow" };
    }
    // A DERIVED instance into a BASE-typed slot (`{ p: Q }` copying into
    // `{ p: P }`): the same implicit upcast coerceToExpected performs at
    // top level — prefix layout, a pointer reinterpret, no copy.
    if (
      dst.kind === "object" &&
      src.kind === "object" &&
      lowerer.isSubclassOf(src.className, dst.className)
    ) {
      return { how: "upcast" };
    }
    // A FUNCTION into a slot whose signature differs only by CLEAN
    // mechanical conversions (fewer params — JS ignores extras — and
    // coercibleValue pieces): the general function-value adapter, plan-
    // gated to the clean subset. The stranded (trap-only) dispositions
    // funcCoerceAdapter also builds stay TOP-LEVEL only: a width plan
    // never promises a bridge that can only throw.
    if (dst.kind === "func" && src.kind === "func" && lowerer.cleanFuncAdaptable(src, dst)) {
      return { how: "funcAdapt" };
    }
    if (dst.kind === "record" && src.kind === "record") {
      return lowerer.recordWidthPlan(src.shapeId, dst.shapeId) !== null ? { how: "width" } : null;
    }
    if (dst.kind === "record" && src.kind === "object") {
      return lowerer.objToRecordPlan(src.className, dst.shapeId) !== null ? { how: "objWidth" } : null;
    }
    if (dst.kind === "object" && src.kind === "record") {
      return lowerer.recordToClassPlan(src.shapeId, dst.className) !== null ? { how: "clsWidth" } : null;
    }
    if (dst.kind === "array" && src.kind === "array") {
      if (lowerer.widthLiftPlan(src.elem, dst.elem) !== null) return { how: "arr" };
      // The EMPTY-array lift: a unit-only element type (`readonly []`
      // mapped as the unit-element array, `(null | undefined)[]`) has no
      // per-element conversion into a data element — but the only value
      // such a slot honestly holds in the width family is EMPTY, so the
      // lift is a fresh empty array of the target type, guarded by a
      // runtime non-empty trap (the checked-extraction stance).
      if (lowerer.unitOnlyElem(src.elem) && dst.elem.kind !== "jsval" && !lowerer.unitOnlyElem(dst.elem)) {
        return { how: "emptyArr" };
      }
      return null;
    }
    // A TUPLE flowing into an array FIELD/ELEMENT (`aliases: ["ls"]` into
    // an `aliases: string[]` slot): per-position lifts, the top-level
    // tuple-into-array coercion applied recursively.
    if (dst.kind === "array" && src.kind === "record" && dst.elem.kind !== "jsval") {
      const from = lowerer.shapes.get(src.shapeId);
      if (from?.tuple && from.fields.every((f) => lowerer.widthLiftPlan(f.type, dst.elem) !== null)) {
        return { how: "tupleArr" };
      }
      return null;
    }
    return null;
  }

  /** True for the unit-only element types (`(null | undefined)[]`, the
   * `readonly []` mapping): a union whose every arm is a unit. */
  export function unitOnlyElem(lowerer: Lowerer, t: IrType): boolean {
    if (t.kind !== "union") return false;
    const def = lowerer.unions.get(t.unionId);
    return def !== undefined && def.arms.every((a) => isUnitType(a));
  }

  /** The build side of widthLiftPlan: the IrExpr converting `value` into
   * `dst` under a plan the caller validated. Interns whatever helpers the
   * lift needs (planned first, so the interns cannot fail — a failure here
   * is a lowerer bug, not a user diagnostic). */
  export function applyWidthLift(lowerer: Lowerer, lift: WidthLift, value: IrExpr, dst: IrType, loc: SrcLoc): IrExpr {
    switch (lift.how) {
      case "copy":
        return value;
      case "wrap": {
        if (dst.kind !== "union") throw new InternalCompilerError("lowerer bug: wrap lift against a non-union");
        return { kind: "unionWrap", unionId: dst.unionId, tag: lift.tag, value, type: dst, loc };
      }
      case "retag": {
        if (dst.kind !== "union" || value.type.kind !== "union") throw new InternalCompilerError("lowerer bug: retag lift shape");
        const retag = lowerer.unionRetagHelper(value.type.unionId, dst.unionId, loc);
        if (!retag) throw new InternalCompilerError("lowerer bug: planned retag lift failed to intern");
        return { kind: "call", callee: retag, args: [value], type: dst, loc };
      }
      case "liftWrap": {
        if (dst.kind !== "union") throw new InternalCompilerError("lowerer bug: liftWrap lift against a non-union");
        const inner = lowerer.widthLiftPlan(value.type, lift.arm);
        if (!inner) throw new InternalCompilerError("lowerer bug: planned liftWrap arm stopped lifting");
        const lifted = lowerer.applyWidthLift(inner, value, lift.arm, loc);
        return { kind: "unionWrap", unionId: dst.unionId, tag: lift.tag, value: lifted, type: dst, loc };
      }
      case "width": {
        if (dst.kind !== "record" || value.type.kind !== "record") throw new InternalCompilerError("lowerer bug: width lift shape");
        const helper = lowerer.recordWidthHelper(value.type.shapeId, dst.shapeId, loc);
        if (!helper) throw new InternalCompilerError("lowerer bug: planned width lift failed to intern");
        return { kind: "call", callee: helper, args: [value], type: dst, loc };
      }
      case "arr": {
        if (dst.kind !== "array" || value.type.kind !== "array") throw new InternalCompilerError("lowerer bug: arr lift shape");
        const helper = lowerer.arrayWidthHelper(value.type, dst, loc);
        if (!helper) throw new InternalCompilerError("lowerer bug: planned arr lift failed to intern");
        return { kind: "call", callee: helper, args: [value], type: dst, loc };
      }
      case "tupleArr": {
        if (dst.kind !== "array" || value.type.kind !== "record") throw new InternalCompilerError("lowerer bug: tupleArr lift shape");
        const helper = lowerer.tupleArrayWidthHelper(value.type.shapeId, dst, loc);
        if (!helper) throw new InternalCompilerError("lowerer bug: planned tupleArr lift failed to intern");
        return { kind: "call", callee: helper, args: [value], type: dst, loc };
      }
      case "emptyArr": {
        if (dst.kind !== "array" || value.type.kind !== "array") throw new InternalCompilerError("lowerer bug: emptyArr lift shape");
        const helper = lowerer.emptyArrayLiftHelper(value.type, dst, loc);
        return { kind: "call", callee: helper, args: [value], type: dst, loc };
      }
      case "objWidth": {
        if (dst.kind !== "record" || value.type.kind !== "object") throw new InternalCompilerError("lowerer bug: objWidth lift shape");
        const helper = lowerer.objRecordWidthHelper(value.type.className, dst.shapeId, loc);
        if (!helper) throw new InternalCompilerError("lowerer bug: planned objWidth lift failed to intern");
        return { kind: "call", callee: helper, args: [value], type: dst, loc };
      }
      case "clsWidth": {
        if (dst.kind !== "object" || value.type.kind !== "record") throw new InternalCompilerError("lowerer bug: clsWidth lift shape");
        const helper = lowerer.recordClassWidthHelper(value.type.shapeId, dst.className, loc);
        if (!helper) throw new InternalCompilerError("lowerer bug: planned clsWidth lift failed to intern");
        return { kind: "call", callee: helper, args: [value], type: dst, loc };
      }
      case "narrow": {
        if (value.type.kind !== "union") throw new InternalCompilerError("lowerer bug: narrow lift on a non-union");
        const helper = lowerer.narrowedArmHelper(value.type.unionId, dst, loc);
        if (!helper) throw new InternalCompilerError("lowerer bug: planned narrow lift failed to intern");
        return { kind: "call", callee: helper, args: [value], type: dst, loc };
      }
      case "dynView": return { kind: "dynCheck", value: { kind: "dynFrom", value, type: DYN, loc }, type: dst, loc };
      case "dynIn": {
        if (dst.kind !== "dyn") throw new InternalCompilerError("lowerer bug: dynIn lift against a non-dyn slot");
        return { kind: "dynFrom", value, type: DYN, loc };
      }
      case "upcast": {
        if (dst.kind !== "object" || value.type.kind !== "object") throw new InternalCompilerError("lowerer bug: upcast lift shape");
        return lowerer.upcastTo(value, dst.className);
      }
      case "funcAdapt": {
        if (dst.kind !== "func" || value.type.kind !== "func") throw new InternalCompilerError("lowerer bug: funcAdapt lift shape");
        const adapter = lowerer.funcCoerceAdapter(value.type, dst, loc);
        if (!adapter) throw new InternalCompilerError("lowerer bug: planned funcAdapt lift failed to intern");
        return { kind: "call", callee: adapter, args: [value], type: dst, loc };
      }
      default: {
        const _exhaustive: never = lift;
        void _exhaustive;
        throw new InternalCompilerError("unreachable");
      }
    }
  }

  /** Interned `%rec.width.<n>(r)` — builds the target shape from a source
   * record by copying fields: every target field must exist on the source
   * with the EXACT same type, or with a type that LIFTS under
   * widthLiftPlan — an arm value wraps (`text: string` into
   * `text?: string`), a whole union re-tags (unionRetagMappable), a field
   * whose own record/array type needs narrowing reshapes RECURSIVELY
   * (nested width — the copy stance applies per level), and a MISSING
   * optional-flavored field completes to its undefined arm (the
   * literal-completion rule). TUPLES width-coerce too, arity-exact (TS
   * permits no other tuple width): per-position lifts, never completion.
   * Index-signature SOURCES narrow here like any wider record — declared
   * fields copy, the overflow drops with the width (missing target
   * fields decline: the overflow could hold them). Index-signature
   * TARGETS keep the overflow CAPTURE helper (widthCoerce's other arm).
   * Null when the shapes don't relate that way. */
  /** The pure planning half of recordWidthHelper — every target field's
   * lift, or null when the pair isn't width-coercible. Callers that must
   * validate a WHOLE plan before interning anything (the retag helper's
   * per-arm width lifts) probe with this. */
  export function recordWidthPlan(lowerer: Lowerer, fromId: string, toId: string): Map<string, { src: IrType; lift: WidthLift } | { absent: true; utag: number } | { absentDyn: true } | { indexDyn: true }> | null {
    const from = lowerer.shapes.get(fromId);
    const to = lowerer.shapes.get(toId);
    // INDEX-SIGNATURE sources narrow like any wider record — the target
    // fields copy off the declared struct slots and the overflow drops
    // with the rest of the width (divergence 36's stance; the absent-
    // completion rule below is the one extra fence). Index-signature
    // TARGETS keep the overflow CAPTURE helper (widthCoerce's other arm):
    // a fresh hybrid needs keyed writes, not a field-list literal.
    if (!from || !to || to.indexValue) return null;
    // Tuple↔record pairs never relate; tuple↔tuple only arity-exact.
    if (!!from.tuple !== !!to.tuple) return null;
    if (from.tuple && from.fields.length !== to.fields.length) return null;
    const key = `${fromId}:${toId}`;
    // Recursive shapes: an in-progress pair re-entered through its own
    // fields answers "assume coercible" — see widthPlanning.
    if (lowerer.widthPlanning.has(key)) return new Map();
    lowerer.widthPlanning.add(key);
    try {
      type FieldLift = { src: IrType; lift: WidthLift } | { absent: true; utag: number } | { absentDyn: true } | { indexDyn: true };
      const plan = new Map<string, FieldLift>();
      for (const tf of to.fields) {
        const ff = from.fields.find((f) => f.name === tf.name);
        if (!ff) {
          // A checked assertion may project a concrete mapped-result field
          // out of a `Record<string, unknown>` slot. Read the runtime key
          // from the overflow map and validate its dyn value against the
          // destination field; a missing key surfaces as dyn undefined, so
          // optional targets accept it and required targets throw. This is
          // deliberately a checked copy, never an erased `as` cast.
          if (
            !from.tuple &&
            from.indexValue?.kind === "dyn" &&
            canDynCheckTo(tf.type, (id) => lowerer.shapes.get(id), (id) => lowerer.unions.get(id))
          ) {
            plan.set(tf.name, { indexDyn: true });
            continue;
          }
          // A target field MISSING on the source: legal exactly when it is
          // optional-flavored (an undefined-armed union) — the unset field
          // IS the undefined arm, the same rule literal completion applies
          // — or 'unknown' (a dyn slot holds the dyn undefined, exactly
          // the absent-property read: the options-record call shape
          // against `{ plugins: unknown, ... }`). Never for tuples: a
          // completed position would change .length and JSON where Node
          // keeps the source arity. Never for INDEX-SIGNATURE sources:
          // the overflow may hold this very key at runtime (tsc lets the
          // signature satisfy optional target members), so completing to
          // undefined would drop a value Node keeps — the pair stays
          // fenced.
          if (from.tuple || from.indexValue) return null;
          if (tf.type.kind === "dyn") {
            plan.set(tf.name, { absentDyn: true });
            continue;
          }
          if (tf.type.kind !== "union") return null;
          const def = lowerer.unions.get(tf.type.unionId);
          const utag = def ? def.arms.findIndex((a) => a.kind === "undefinedT") : -1;
          if (utag < 0) return null;
          plan.set(tf.name, { absent: true, utag });
          continue;
        }
        const lift = lowerer.widthLiftPlan(ff.type, tf.type);
        if (!lift) return null;
        plan.set(tf.name, { src: ff.type, lift });
      }
      return plan;
    } finally {
      lowerer.widthPlanning.delete(key);
    }
  }

  /** Post-hoc classifier for SC2002's record→record residue: WHY the
   * width family (recordWidthPlan and the overflow capture — widthCoerce's
   * two record arms) declined this pair — the FIRST blocking rule, named.
   * Pure description on the failure path (the site already carries the
   * rejection): mirrors the planners' gates, never changes what coerces,
   * and answers null when no pointed story applies (the generic message
   * stands). */
  export function describeRecordWidthBlocker(lowerer: Lowerer, fromId: string, toId: string): string | null {
    const from = lowerer.shapes.get(fromId);
    const to = lowerer.shapes.get(toId);
    if (!from || !to) return null;
    if (to.indexValue) {
      // The overflow CAPTURE's gates (lowerRecordOvfCaptureHelper).
      if (from.tuple || to.tuple) return "a tuple cannot reshape into an index-signature record";
      const tIv = to.indexValue;
      const slotOk = (t: IrType): boolean =>
        typeEquals(t, tIv) ||
        (tIv.kind === "dyn" && (t.kind === "dyn" || lowerer.dynConvertible(t))) ||
        lowerer.widthLiftPlan(t, tIv) !== null;
      const consumed = new Set<string>();
      for (const tf of to.fields) {
        const sf = from.fields.find((f) => f.name === tf.name);
        if (sf) {
          if (lowerer.widthLiftPlan(sf.type, tf.type) !== null) {
            consumed.add(tf.name);
            continue;
          }
          return `field '${tf.name}': '${lowerer.fmt(sf.type)}' does not lift into '${lowerer.fmt(tf.type)}'`;
        }
        if (tf.type.kind !== "union" || lowerer.armTag(tf.type.unionId, UNDEFINED_T) < 0) {
          return `the expected field '${tf.name}' is required and the source has no field to copy into it`;
        }
        if (tIv.kind === "dyn" ? !lowerer.dynConvertible(tf.type) : !typeEquals(tf.type, tIv)) {
          return `the expected field '${tf.name}' ('${lowerer.fmt(tf.type)}') cannot take a runtime key collision from the '${lowerer.fmt(tIv)}' signature slot`;
        }
      }
      for (const ff of from.fields) {
        if (consumed.has(ff.name)) continue;
        if (!slotOk(ff.type)) {
          return `the source field '${ff.name}' ('${lowerer.fmt(ff.type)}') cannot enter the expected '[key: string]: ${lowerer.fmt(tIv)}' slot`;
        }
      }
      if (from.indexValue && !slotOk(from.indexValue)) {
        return `the source's '[key: string]: ${lowerer.fmt(from.indexValue)}' slot cannot enter the expected '[key: string]: ${lowerer.fmt(tIv)}' slot`;
      }
      // The dispatch-writes gate: runtime-keyed writes can collide with a
      // declared field whose type is not the slot's.
      const dispatchWrites =
        from.indexValue !== undefined ||
        from.fields.some((ff) => !consumed.has(ff.name) && to.fields.some((f) => f.name === ff.name));
      if (dispatchWrites) {
        const bad = to.fields.find((f) =>
          tIv.kind === "dyn" ? !lowerer.dynConvertible(f.type) : !typeEquals(f.type, tIv),
        );
        if (bad) {
          return `runtime-keyed writes can collide with the expected field '${bad.name}' ('${lowerer.fmt(bad.type)}'), which cannot take a '${lowerer.fmt(tIv)}' slot value`;
        }
      }
      return null;
    }
    // The field-copy plan's gates (recordWidthPlan).
    if (!!from.tuple !== !!to.tuple) return null;
    if (from.tuple && from.fields.length !== to.fields.length) {
      return `tuple arities differ (${from.fields.length} vs ${to.fields.length}; TS permits no tuple width)`;
    }
    for (const tf of to.fields) {
      const ff = from.fields.find((f) => f.name === tf.name);
      if (!ff) {
        if (from.tuple) return null;
        if (from.indexValue) {
          if (
            from.indexValue.kind === "dyn" &&
            canDynCheckTo(tf.type, (id) => lowerer.shapes.get(id), (id) => lowerer.unions.get(id))
          ) {
            continue;
          }
          return `'${tf.name}' is not a declared field of the source, and the source's index signature could hold it at runtime (a completed undefined would drop that value)`;
        }
        if (tf.type.kind === "dyn") continue;
        if (tf.type.kind !== "union" || lowerer.armTag(tf.type.unionId, UNDEFINED_T) < 0) {
          return `the expected field '${tf.name}' is missing on the source and is not optional`;
        }
        continue;
      }
      if (lowerer.widthLiftPlan(ff.type, tf.type) === null) {
        return `field '${tf.name}': '${lowerer.fmt(ff.type)}' does not lift into '${lowerer.fmt(tf.type)}'`;
      }
    }
    return null;
  }

  export function recordWidthHelper(lowerer: Lowerer, fromId: string, toId: string, loc: SrcLoc): string | null {
    const from = lowerer.shapes.get(fromId);
    const to = lowerer.shapes.get(toId);
    if (!from || !to) return null;
    // Plan every target field BEFORE interning anything (interned helpers
    // are part of the emitted program; a later field's failure must not
    // orphan one).
    const plan = lowerer.recordWidthPlan(fromId, toId);
    if (!plan) return null;
    const key = `rec:${fromId}:${toId}`;
    const existing = lowerer.widthHelpers.get(key);
    if (existing) return existing;
    const name = `%rec.width.${lowerer.widthHelpers.size}`;
    // Interned BEFORE the body builds: a recursive nested-width field
    // (self-referential shapes) resolves to this helper itself.
    lowerer.widthHelpers.set(key, name);
    const fromT: IrType = { kind: "record", shapeId: fromId };
    const toT: IrType = { kind: "record", shapeId: toId };
    const r: IrExpr = { kind: "varRef", localId: "r.0", type: fromT, loc };
    lowerer.liftedFns.push({
      name,
      params: [{ localId: "r.0", name: "r", type: fromT }],
      returnType: toT,
      locals: [{ id: "r.0", name: "r", type: fromT, mutable: true }],
      body: [
        {
          kind: "return",
          value: {
            kind: "recordLit",
            fields: to.fields.map((f) => {
              const lift = plan.get(f.name)!;
              if ("indexDyn" in lift) {
                const value: IrExpr = {
                  kind: "recordKeyGet",
                  obj: r,
                  shapeId: fromId,
                  key: { kind: "strLit", value: f.name, type: STRING, loc },
                  overflowOnly: true,
                  type: DYN,
                  loc,
                };
                return { name: f.name, value: { kind: "dynCheck", value, type: f.type, loc } satisfies IrExpr };
              }
              if ("absentDyn" in lift) {
                // The unset 'unknown' field: the dyn undefined — exactly
                // the absent-property read's answer.
                return { name: f.name, value: dynUndefinedExpr(loc) };
              }
              if ("absent" in lift) {
                if (f.type.kind !== "union") throw new InternalCompilerError("lowerer bug: absent lift against a non-union field");
                // The unset optional field: build the undefined arm.
                return {
                  name: f.name,
                  value: {
                    kind: "unionWrap",
                    unionId: f.type.unionId,
                    tag: lift.utag,
                    value: { kind: "unitLit", unit: "undefined", type: UNDEFINED_T, loc },
                    type: f.type,
                    loc,
                  } satisfies IrExpr,
                };
              }
              const get: IrExpr = { kind: "recordGet", obj: r, shapeId: fromId, field: f.name, type: lift.src, loc };
              return { name: f.name, value: lowerer.applyWidthLift(lift.lift, get, f.type, loc) };
            }),
            type: toT,
            loc,
          },
          loc,
        },
      ],
      loc,
    });
    return name;
  }

  /** Interned `%arr.width.<n>(a)` — the per-element copy loop over
   * widthLiftPlan's element lift: out = []; n = a.length; for (...)
   * out.push(lift(a[i])); return out. Record elements reshape
   * (recordWidthHelper), union elements wrap or re-tag (`number[]` into
   * `(number | undefined)[]`), nested arrays recurse. Null when the
   * element pair isn't width-liftable. */
  /** Interned `%tup.arr.<n>(t)` — rebuilds a TUPLE as an ARRAY: positions
   * read in order, each lifted into the element type under widthLiftPlan.
   * Null unless the source shape really is a tuple whose every position
   * lifts (records with named fields never relate to arrays). */
  export function tupleArrayWidthHelper(lowerer: Lowerer, fromId: string, toT: IrType & { kind: "array" }, loc: SrcLoc): string | null {
    const from = lowerer.shapes.get(fromId);
    if (!from || !from.tuple) return null;
    const lifts: WidthLift[] = [];
    for (const f of from.fields) {
      const lift = lowerer.widthLiftPlan(f.type, toT.elem);
      if (!lift) return null;
      lifts.push(lift);
    }
    const key = `tuparr:${fromId}:${typeKey(toT.elem)}`;
    const existing = lowerer.widthHelpers.get(key);
    if (existing) return existing;
    const name = `%tup.arr.${lowerer.widthHelpers.size}`;
    lowerer.widthHelpers.set(key, name);
    const fromT: IrType = { kind: "record", shapeId: fromId };
    const t: IrExpr = { kind: "varRef", localId: "t.0", type: fromT, loc };
    lowerer.liftedFns.push({
      name,
      params: [{ localId: "t.0", name: "t", type: fromT }],
      returnType: toT,
      locals: [{ id: "t.0", name: "t", type: fromT, mutable: true }],
      body: [
        {
          kind: "return",
          value: {
            kind: "arrayLit",
            elems: from.fields.map((f, i) =>
              lowerer.applyWidthLift(
                lifts[i]!,
                { kind: "recordGet", obj: t, shapeId: fromId, field: f.name, type: f.type, loc },
                toT.elem,
                loc,
              ),
            ),
            type: toT,
            loc,
          },
          loc,
        },
      ],
      loc,
    });
    return name;
  }

  /** Interned `%arr.empty.<n>(a)` — the EMPTY-array lift's build side: a
   * unit-only-element array reshapes into any data-element array by
   * answering a FRESH empty array, after a runtime non-empty trap (a
   * genuinely inhabited `(null | undefined)[]` cannot reshape — the
   * catchable-TypeError stance every checked extraction takes). */
  export function emptyArrayLiftHelper(lowerer: Lowerer, fromT: IrType & { kind: "array" }, toT: IrType & { kind: "array" }, loc: SrcLoc): string {
    const key = `emptyarr:${typeKey(fromT.elem)}:${typeKey(toT.elem)}`;
    const existing = lowerer.widthHelpers.get(key);
    if (existing) return existing;
    const name = `%arr.empty.${lowerer.widthHelpers.size}`;
    lowerer.widthHelpers.set(key, name);
    const a: IrExpr = { kind: "varRef", localId: "a.0", type: fromT, loc };
    lowerer.liftedFns.push({
      name,
      params: [{ localId: "a.0", name: "a", type: fromT }],
      returnType: toT,
      locals: [{ id: "a.0", name: "a", type: fromT, mutable: true }],
      body: [
        {
          kind: "if",
          cond: {
            kind: "bin",
            op: "!==",
            left: { kind: "arrIntrinsic", method: "length", receiver: a, args: [], type: F64, loc },
            right: { kind: "numLit", value: 0, type: F64, loc },
            type: BOOL,
            loc,
          },
          then: [
            {
              kind: "throw",
              value: {
                kind: "libCall",
                fn: "error.new",
                args: [{ kind: "strLit", value: `expected ${lowerer.fmt(toT)} (a non-empty ${lowerer.fmt(fromT)} has no elements the target can hold)`, type: STRING, loc }],
                type: { kind: "object", className: "%TypeError" },
                loc,
              },
              loc,
            },
          ],
          else_: [],
          loc,
        },
        { kind: "return", value: { kind: "arrayLit", elems: [], type: toT, loc }, loc },
      ],
      loc,
    });
    return name;
  }

  export function arrayWidthHelper(lowerer: Lowerer, fromT: IrType & { kind: "array" }, toT: IrType & { kind: "array" }, loc: SrcLoc): string | null {
    const fromElem = fromT.elem;
    const toElem = toT.elem;
    const elemLift = lowerer.widthLiftPlan(fromElem, toElem);
    if (!elemLift || elemLift.how === "copy") return null;
    const key = `arr:${typeKey(fromElem)}:${typeKey(toElem)}`;
    const existing = lowerer.widthHelpers.get(key);
    if (existing) return existing;
    const name = `%arr.width.${lowerer.widthHelpers.size}`;
    lowerer.widthHelpers.set(key, name);
    const arrT: IrType = { kind: "array", elem: fromElem };
    const outT: IrType = { kind: "array", elem: toElem };

    const f64: IrType = { kind: "f64" };
    lowerer.liftedFns.push({
      name,
      params: [{ localId: "a.0", name: "a", type: arrT }],
      returnType: outT,
      locals: [
        { id: "a.0", name: "a", type: arrT, mutable: true },
        { id: "out.0", name: "out", type: outT, mutable: false },
        { id: "n.0", name: "n", type: f64, mutable: false },
        { id: "i.0", name: "i", type: f64, mutable: true },
      ],
      body: [
        { kind: "varDecl", localId: "out.0", init: { kind: "arrayLit", elems: [], type: outT, loc }, loc },
        {
          kind: "varDecl",
          localId: "n.0",
          init: { kind: "arrIntrinsic", method: "length", receiver: varRef("a.0", arrT, loc), args: [], type: f64, loc },
          loc,
        },
        {
          kind: "for",
          init: { kind: "varDecl", localId: "i.0", init: numLit(0, loc), loc },
          cond: { kind: "bin", op: "<", left: varRef("i.0", f64, loc), right: varRef("n.0", f64, loc), type: BOOL, loc },
          update: {
            kind: "assign",
            localId: "i.0",
            value: { kind: "bin", op: "+", left: varRef("i.0", f64, loc), right: numLit(1, loc), type: f64, loc },
            loc,
          },
          body: [
            {
              kind: "exprStmt",
              expr: {
                kind: "arrIntrinsic",
                method: "push",
                receiver: varRef("out.0", outT, loc),
                args: [
                  lowerer.applyWidthLift(
                    elemLift,
                    { kind: "arrayGet", arr: varRef("a.0", arrT, loc), index: varRef("i.0", f64, loc), type: fromElem, loc },
                    toElem,
                    loc,
                  ),
                ],
                type: f64,
                loc,
              },
              loc,
            },
          ],
          loc,
        },
        { kind: "return", value: varRef("out.0", outT, loc), loc },
      ],
      loc,
    });
    return name;
  }

  /** The planning half of objRecordWidthHelper — how a CLASS INSTANCE
   * projects into a record shape (tsc's structural view of classes makes
   * `new Point(0,0)` flow into `{x: number; y: number}` slots). Every
   * target field must be a plain instance FIELD on the class (inherited
   * included) whose type lifts, or a missing optional-flavored field
   * completing to its undefined arm — but never a field the class
   * satisfies through a METHOD or accessor (bound method references have
   * no lowering; the plan declines instead of projecting a lie). Builtin
   * runtime layouts (the Error/EventEmitter/stream chains) decline: their
   * fields aren't plain emitted storage. */
  export function objToRecordPlan(lowerer: Lowerer, className: string, toId: string): Map<string, { src: IrType; lift: WidthLift } | { absent: true; utag: number }> | null {
    const info = lowerer.classes.get(className);
    const to = lowerer.shapes.get(toId);
    if (!info || !to || to.indexValue || to.tuple) return null;
    // Reserved slots (%call hybrids, %get:/%set: accessor closures) are
    // not projectable storage.
    if (to.fields.some((f) => f.name.startsWith("%"))) return null;
    for (let c: ClassInfo | null = info; c; c = c.base) {
      if (c.builtinError || c.builtinEmitter || c.builtinStream !== undefined || c.def.runtime) return null;
    }
    const key = `obj:${className}:${toId}`;
    if (lowerer.widthPlanning.has(key)) return new Map();
    lowerer.widthPlanning.add(key);
    try {
      const plan = new Map<string, { src: IrType; lift: WidthLift } | { absent: true; utag: number }>();
      for (const tf of to.fields) {
        // A method/accessor satisfying the checker has no projectable
        // value — decline the whole plan, field or not.
        if (
          findMethodOn(lowerer, info, tf.name) ||
          findMethodOn(lowerer, info, `get:${tf.name}`) ||
          findGenericMethodOn(lowerer, info, tf.name)
        ) {
          return null;
        }
        const ft = info.fields.get(tf.name);
        if (ft === undefined) {
          if (tf.type.kind !== "union") return null;
          const def = lowerer.unions.get(tf.type.unionId);
          const utag = def ? def.arms.findIndex((a) => a.kind === "undefinedT") : -1;
          if (utag < 0) return null;
          plan.set(tf.name, { absent: true, utag });
          continue;
        }
        const lift = lowerer.widthLiftPlan(ft, tf.type);
        if (!lift) return null;
        plan.set(tf.name, { src: ft, lift });
      }
      return plan;
    } finally {
      lowerer.widthPlanning.delete(key);
    }
  }

  /** Interned `%obj.width.<n>(o)` — builds a record from a class
   * instance's fields under objToRecordPlan: the width-copy stance
   * (divergence 305 — a fresh record, mutations don't alias, extra class
   * members drop). */
  export function objRecordWidthHelper(lowerer: Lowerer, className: string, toId: string, loc: SrcLoc): string | null {
    const to = lowerer.shapes.get(toId);
    if (!to) return null;
    const plan = lowerer.objToRecordPlan(className, toId);
    if (!plan) return null;
    const key = `obj:${className}:${toId}`;
    const existing = lowerer.widthHelpers.get(key);
    if (existing) return existing;
    const name = `%obj.width.${lowerer.widthHelpers.size}`;
    lowerer.widthHelpers.set(key, name);
    const fromT: IrType = { kind: "object", className };
    const toT: IrType = { kind: "record", shapeId: toId };
    const o: IrExpr = { kind: "varRef", localId: "o.0", type: fromT, loc };
    lowerer.liftedFns.push({
      name,
      params: [{ localId: "o.0", name: "o", type: fromT }],
      returnType: toT,
      locals: [{ id: "o.0", name: "o", type: fromT, mutable: true }],
      body: [
        {
          kind: "return",
          value: {
            kind: "recordLit",
            fields: to.fields.map((f) => {
              const lift = plan.get(f.name)!;
              if ("absent" in lift) {
                if (f.type.kind !== "union") throw new InternalCompilerError("lowerer bug: absent lift against a non-union field");
                return {
                  name: f.name,
                  value: {
                    kind: "unionWrap",
                    unionId: f.type.unionId,
                    tag: lift.utag,
                    value: { kind: "unitLit", unit: "undefined", type: UNDEFINED_T, loc },
                    type: f.type,
                    loc,
                  } satisfies IrExpr,
                };
              }
              const get: IrExpr = { kind: "fieldGet", obj: o, className, field: f.name, type: lift.src, loc };
              return { name: f.name, value: lowerer.applyWidthLift(lift.lift, get, f.type, loc) };
            }),
            type: toT,
            loc,
          },
          loc,
        },
      ],
      loc,
    });
    return name;
  }

  /** The planning half of recordClassWidthHelper — how a RECORD enters a
   * class-instance slot. Construction IS the projection, so the class
   * must be a pure parameter-property data class: its own trivial
   * constructor (every parameter a parameter property, empty body), no
   * other fields, no methods/accessors anywhere in the chain (a
   * fabricated instance must carry no behavior the record lacks), no
   * decoration, no base beyond a generic FAMILY ancestor (fieldless and
   * methodless by construction). Each constructor parameter takes the
   * same-named source field under widthLiftPlan, or — omittable params —
   * the absent undefined arm. One entry per constructor parameter, in
   * parameter order. */
  export function recordToClassPlan(lowerer: Lowerer, fromId: string, className: string): ({ field: string; src: IrType; lift: WidthLift } | { absent: true })[] | null {
    const from = lowerer.shapes.get(fromId);
    const info = lowerer.classes.get(className);
    if (!from || !info || from.indexValue || from.tuple) return null;
    if (from.fields.some((f) => f.name.startsWith("%"))) return null;
    if (!info.decl || info.def.abstract || info.def.runtime || info.generic) return null;
    if (info.builtinError || info.builtinEmitter || info.builtinStream !== undefined) return null;
    if (info.classDecorators) return null;
    if (info.base && !(info.base.generic && !info.base.base)) return null;
    for (let c: ClassInfo | null = info; c; c = c.base) {
      if (
        c.methods.size > 0 ||
        (c.genericMethods?.size ?? 0) > 0 ||
        (c.symbolFields?.size ?? 0) > 0 ||
        c.throwingSetters.length > 0 ||
        (c.def.abstractMethods?.length ?? 0) > 0
      ) {
        return null;
      }
    }
    if (!info.ctor || info.ctor.body === undefined || info.ctor.body.statements.length > 0) return null;
    const props = info.paramProps ?? [];
    if (props.length !== info.ctorParams.length) return null;
    // Every layout field must come from a parameter property (no declared
    // fields with initializers the projection would silently prefer).
    if (info.def.fields.length !== props.length) return null;
    const key = `cls:${fromId}:${className}`;
    if (lowerer.widthPlanning.has(key)) return [];
    lowerer.widthPlanning.add(key);
    try {
      const plan: ({ field: string; src: IrType; lift: WidthLift } | { absent: true })[] = [];
      for (let i = 0; i < props.length; i++) {
        const shape = info.ctorParams[i];
        if (!shape || (shape.mode !== "required" && shape.mode !== "omittable")) return null;
        const name = props[i]!.name;
        const ff = from.fields.find((f) => f.name === name);
        if (!ff) {
          if (shape.mode !== "omittable" || shape.type.kind !== "union") return null;
          const def = lowerer.unions.get(shape.type.unionId);
          if (!def || !def.arms.some((a) => a.kind === "undefinedT")) return null;
          plan.push({ absent: true });
          continue;
        }
        const lift = lowerer.widthLiftPlan(ff.type, shape.type);
        if (!lift) return null;
        plan.push({ field: name, src: ff.type, lift });
      }
      return plan;
    } finally {
      lowerer.widthPlanning.delete(key);
    }
  }

  /** Interned `%cls.width.<n>(r)` — `new C(r.p1, ..., r.pn)` under
   * recordToClassPlan: the record's fields become the trivial
   * constructor's arguments (divergence 305's copy stance — a fresh
   * instance, mutations don't alias, and `instanceof C` answers true
   * where Node's plain object answers false). */
  export function recordClassWidthHelper(lowerer: Lowerer, fromId: string, className: string, loc: SrcLoc): string | null {
    const info = lowerer.classes.get(className);
    if (!info) return null;
    const plan = lowerer.recordToClassPlan(fromId, className);
    if (!plan) return null;
    const key = `cls:${fromId}:${className}`;
    const existing = lowerer.widthHelpers.get(key);
    if (existing) return existing;
    const name = `%cls.width.${lowerer.widthHelpers.size}`;
    lowerer.widthHelpers.set(key, name);
    lowerer.noteEdge(`%${className}.constructor`);
    const fromT: IrType = { kind: "record", shapeId: fromId };
    const toT: IrType = { kind: "object", className };
    const r: IrExpr = { kind: "varRef", localId: "r.0", type: fromT, loc };
    const args = plan.map((entry, i): IrExpr => {
      const shape = info.ctorParams[i]!;
      if ("absent" in entry) {
        const u = lowerer.wrappedUndefined(shape.type, loc);
        if (!u) throw new InternalCompilerError("lowerer bug: planned absent ctor arg has no undefined arm");
        return u;
      }
      const get: IrExpr = { kind: "recordGet", obj: r, shapeId: fromId, field: entry.field, type: entry.src, loc };
      return lowerer.applyWidthLift(entry.lift, get, shape.type, loc);
    });
    lowerer.liftedFns.push({
      name,
      params: [{ localId: "r.0", name: "r", type: fromT }],
      returnType: toT,
      locals: [{ id: "r.0", name: "r", type: fromT, mutable: true }],
      body: [
        { kind: "return", value: { kind: "new", className, args, type: toT, loc }, loc },
      ],
      loc,
    });
    return name;
  }

  /** A CLASS VALUE's statics projected into a record shape (`var f:
   * ShapeFactory = Shape`): the record literal capturing static FIELDS as
   * copies of their globals and static METHODS as the zero-capture
   * closures `const f = C.m` builds (params all required — value-form
   * completion rules stay out of coercions). Inherited statics resolve
   * like JS's class-object prototype walk. Divergence 305's copy stance:
   * later writes to a writable static field don't flow into the record
   * (Node aliases the one class object). Null when any target field has
   * no projectable static. */
  export function classStaticsProjection(lowerer: Lowerer, className: string, toId: string, loc: SrcLoc): IrExpr | null {
    const info = lowerer.classes.get(className);
    const to = lowerer.shapes.get(toId);
    if (!info || !to || to.indexValue || to.tuple) return null;
    if (to.fields.some((f) => f.name.startsWith("%"))) return null;
    if (info.generic || !info.decl) return null;
    const fields: { name: string; value: IrExpr }[] = [];
    for (const tf of to.fields) {
      if (findGenericStaticOn(lowerer, info, tf.name)) return null;
      const found = findStaticOn(lowerer, info, tf.name);
      if (!found) {
        if (tf.type.kind !== "union") return null;
        const u = lowerer.wrappedUndefined(tf.type, loc);
        if (!u) return null;
        fields.push({ name: tf.name, value: u });
        continue;
      }
      if (found.field !== undefined) {
        const read: IrExpr = { kind: "varRef", localId: found.field.globalId, type: found.field.type, loc };
        const lift = lowerer.widthLiftPlan(found.field.type, tf.type);
        if (!lift) return null;
        fields.push({ name: tf.name, value: lowerer.applyWidthLift(lift, read, tf.type, loc) });
        continue;
      }
      if (found.method.params.some((p) => p.mode !== "required")) return null;
      const funcType: IrType = {
        kind: "func",
        params: found.method.params.map((p) => p.type),
        ret: found.method.ret,
      };
      const lift = lowerer.widthLiftPlan(funcType, tf.type);
      if (!lift) return null;
      const fnName = `%${found.declarer.def.name}.static:${tf.name}`;
      lowerer.noteEdge(fnName);
      const closure: IrExpr = { kind: "closure", fnName, captures: [], type: funcType, loc };
      fields.push({ name: tf.name, value: lowerer.applyWidthLift(lift, closure, tf.type, loc) });
    }
    return { kind: "recordLit", fields, type: { kind: "record", shapeId: toId }, loc };
  }
