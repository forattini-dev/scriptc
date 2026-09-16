/* Union retagging and narrowing: moving a union value between union types with different arm sets (interned retag
 * helpers, traps for stranded arms), checked single-arm narrowing, and deferred reads. */
import * as ts from "../ts7/adapter.js";
import type {
  IrExpr,
  IrStmt,
  IrType,
  SrcLoc,
} from "../../ir/ir.js";
import { BOOL, F64, isUnitType, STRING } from "../../ir/ir.js";
import {
  typeKey,
} from "../type-mapper.js";
import type { Lowerer } from "./lowerer.js";
import { type WidthLift } from "./lowerer.js";

  /** Interned `%union.retag.<n>(u)` — the runtime re-tag for a value of
   * union `fromId` flowing into a slot of union `toId`: a switch on the
   * source tag re-wraps the payload under its tag in the destination
   * (unionNarrow + unionWrap — the payload pointer moves, no copy, so
   * ref-arm identity is preserved across the re-tag). Arms map by
   * canonical type (typeEquals): every non-unit source arm must exist in
   * the destination, or the pair isn't mappable (null — the caller keeps
   * the SC2003 fence). A stranded UNIT arm (undefined/null with no
   * destination arm) is different: it means tsc's picture at the site was
   * NARROWER than the IR type — control-flow narrowing to a sub-union, or
   * a non-null assertion, both of which erase at lowering — so the arm is
   * exactly the possibility the checker proved (or the source asserted)
   * away. It compiles to a runtime trap case throwing a catchable
   * TypeError-shaped string, the lying-cast stance (SEMANTICS.md): sound
   * narrowing never reaches it, a lying `!` throws instead of smuggling
   * an unrepresentable unit into the destination. */
  /** True when unionRetagHelper can bridge the pair — every non-unit
   * source arm exists (typeEquals) in the destination, or width-lifts
   * into exactly one destination arm (widthLiftPlan — record and array
   * arms compose the re-tag with the per-arm reshape). Pure: callers that
   * must validate a WHOLE plan before interning anything (recordWidthHelper)
   * probe with this so a failed later field never orphans a helper. */
  export function unionRetagMappable(lowerer: Lowerer, fromId: string, toId: string): boolean {
    const from = lowerer.unions.get(fromId);
    if (!from || !lowerer.unions.get(toId)) return false;
    // The union-pair face of the widthPlanning cycle guard: recursive
    // aliases can close their cycle through a union without repeating a
    // record pair (`type Json = Json[] | undefined`) — an in-progress
    // pair re-entered answers "assume mappable", same greatest-fixed-point
    // reading as recordWidthPlan's.
    const key = `u:${fromId}:${toId}`;
    if (lowerer.widthPlanning.has(key)) return true;
    lowerer.widthPlanning.add(key);
    try {
      const toT: IrType = { kind: "union", unionId: toId };
      return from.arms.every((arm) => isUnitType(arm) || lowerer.widthLiftPlan(arm, toT) !== null);
    } finally {
      lowerer.widthPlanning.delete(key);
    }
  }

  /** A checker-NARROWED union flowing into a different union: `typeof r
   * === "string" || Buffer.isBuffer(r)` proves the record arm of r away,
   * then `{ data: r }` needs `Buffer | string | Rec` in a `Buffer | string`
   * slot. Control-flow narrowing to a sub-union erases at lowering, so the
   * IR value still carries the wide union — but the SITE's checker type
   * names exactly the arms still possible, and every one of those must
   * exist in both unions. The stranded arms compile to trap cases exactly
   * like stranded units (divergence 38's trust-the-checker stance): sound
   * narrowing never reaches them, a lying cast throws a catchable
   * TypeError instead of smuggling an unrepresentable arm. Null when the
   * site type isn't a genuine sub-union of the source (the SC2003 fence
   * stays). */
  export function narrowedRetagHelper(lowerer: Lowerer, node: ts.Node, fromId: string, toId: string, loc: SrcLoc): string | null {
    const from = lowerer.unions.get(fromId);
    if (!from || !lowerer.unions.get(toId)) return null;
    const siteT = lowerer.mapTypeOf(lowerer.typeOf(node));
    if (!siteT) return null;
    const siteArms = siteT.kind === "union" ? lowerer.unions.get(siteT.unionId)?.arms : [siteT];
    if (!siteArms || siteArms.length === 0) return null;
    const allowed = new Set<number>();
    for (const a of siteArms) {
      const fi = lowerer.armTag(fromId, a);
      if (fi < 0) return null; // not a narrowing of the source union
      allowed.add(fi);
    }
    const trappable = new Set<number>();
    from.arms.forEach((_, i) => {
      if (!allowed.has(i)) trappable.add(i);
    });
    if (trappable.size === 0) return null; // nothing stranded: the plain re-tag already declined
    return lowerer.unionRetagHelper(fromId, toId, loc, trappable);
  }

  /** The stranded-UNIT trap for PLAIN (non-union) slots: a null/undefined
   * value flowing into a non-nullable typed slot the checker approved —
   * `null!` and `null as any as T` casts, and the non-strict world's
   * legal `let s: string = null`. The compiled representation has no null
   * to carry, so the FLOW throws the catchable stranded TypeError
   * (divergence 38's stance: Node lets the impossible value ride until it
   * is used; the trap surfaces at the assignment instead). Unit sources
   * only — they are pure, so the nullary helper evaluates nothing. */
  export function strandedUnitTrap(lowerer: Lowerer, expr: IrExpr, expected: IrType, loc: SrcLoc): IrExpr | null {
    if (!isUnitType(expr.type)) return null;
    if (
      expected.kind === "union" || expected.kind === "void" || expected.kind === "dyn" ||
      expected.kind === "jsval" || isUnitType(expected)
    ) {
      return null;
    }
    const what = expr.type.kind === "undefinedT" ? "undefined" : "null";
    const key = `strandunit:${typeKey(expected)}:${expr.type.kind}`;
    let name = lowerer.retagHelpers.get(key);
    if (!name) {
      name = `%unit.strand.${lowerer.retagHelpers.size}`;
      lowerer.retagHelpers.set(key, name);
      lowerer.liftedFns.push({
        name,
        params: [],
        returnType: expected,
        locals: [],
        body: [
          {
            kind: "throw",
            value: {
              kind: "libCall",
              fn: "error.new",
              args: [
                {
                  kind: "strLit",
                  value: `${what} is not representable in a '${lowerer.fmt(expected)}' slot (a value narrowed or asserted past the type still held it)`,
                  type: STRING,
                  loc,
                },
              ],
              type: { kind: "object", className: "%TypeError" },
              loc,
            },
            loc,
          },
        ],
        loc,
      });
    }
    return { kind: "call", callee: name, args: [], type: expected, loc };
  }

  /** The STRANDED-SOURCE trap: a checker-approved value flowing into a
   * union that cannot represent it (armTag < 0, no class widening, no
   * width lift). Only shapes that PROVE a lying assertion trap: unit
   * sources (null/undefined literals smuggled through `null!` / `as any`
   * casts), and record/array sources with ZERO same-family width-lift
   * candidates among the arms — an AMBIGUOUS lift (several candidates)
   * stays a compile fence, because honest code lands there. The interned
   * helper evaluates the operand (JS evaluates it too) and throws the
   * stranded-arm TypeError verbatim. Null when the shape doesn't prove
   * the lie. */
  export function strandedCoercionTrap(lowerer: Lowerer, expr: IrExpr, expected: IrType & { kind: "union" }, loc: SrcLoc): IrExpr | null {
    const def = lowerer.unions.get(expected.unionId);
    if (!def) return null;
    const src = expr.type;
    let what: string;
    if (isUnitType(src)) {
      what = src.kind === "undefinedT" ? "undefined" : "null";
    } else if (src.kind === "f64" || src.kind === "bool" || src.kind === "string") {
      // A SCALAR the union has no arm for (`4 as any as X`, a generic
      // dummy for an unmappable instantiation): no widening exists at
      // all, so the mismatch proves the lie the same way a unit does.
      what = `a '${lowerer.fmt(src)}' value`;
    } else if (src.kind === "record" || src.kind === "array") {
      // Zero width-lift candidates proves no honest mapping was missed.
      const candidates = def.arms.filter(
        (arm) =>
          ((src.kind === "record" && arm.kind === "record") || (src.kind === "array" && arm.kind === "array")) &&
          lowerer.widthLiftPlan(src, arm) !== null,
      );
      if (candidates.length !== 0) return null;
      what = `a '${lowerer.fmt(src)}' value`;
    } else {
      return null;
    }
    // Unit sources have no runtime payload and are pure — the helper is
    // nullary (unit-typed ABI params have no representation); ref sources
    // pass through so the operand still evaluates, exactly JS.
    const takesOperand = !isUnitType(src);
    const key = `strand:${expected.unionId}:${typeKey(src)}`;
    let name = lowerer.retagHelpers.get(key);
    if (!name) {
      name = `%union.strand.${lowerer.retagHelpers.size}`;
      lowerer.retagHelpers.set(key, name);
      const toT: IrType = { kind: "union", unionId: expected.unionId };
      lowerer.liftedFns.push({
        name,
        params: takesOperand ? [{ localId: "v.0", name: "v", type: src }] : [],
        returnType: toT,
        locals: takesOperand ? [{ id: "v.0", name: "v", type: src, mutable: false }] : [],
        body: [
          {
            kind: "throw",
            value: {
              kind: "libCall",
              fn: "error.new",
              args: [
                {
                  kind: "strLit",
                  value: `${what} is not representable in the target union (a value narrowed or asserted past it still held it)`,
                  type: STRING,
                  loc,
                },
              ],
              type: { kind: "object", className: "%TypeError" },
              loc,
            },
            loc,
          },
        ],
        loc,
      });
    }
    return { kind: "call", callee: name, args: isUnitType(src) ? [] : [expr], type: expected, loc };
  }

  export function unionRetagHelper(lowerer: Lowerer, fromId: string, toId: string, loc: SrcLoc, trappable?: ReadonlySet<number>): string | null {
    const from = lowerer.unions.get(fromId);
    const to = lowerer.unions.get(toId);
    if (!from || !to) return null;
    // Per-arm WIDTH LIFTS: a RECORD or ARRAY arm with no identical
    // destination arm may width-lift into exactly ONE destination arm
    // (widthLiftPlan's liftWrap — the findRoute pattern: `{hostname, port,
    // tailscaleUrl?} | undefined` returning as `{hostname, port} |
    // undefined`; nested width and per-element array reshapes compose).
    // Planned PURELY first so a failing arm never orphans an interned
    // width helper; ambiguity (several liftable destination arms) declines
    // — no honest single mapping exists. A lifted arm is a COPY
    // (divergence 35's stance), unlike the identity-preserving plain
    // re-wrap.
    const toT: IrType = { kind: "union", unionId: toId };
    const lifts = new Map<number, WidthLift & { how: "liftWrap" }>();
    from.arms.forEach((arm, i) => {
      if (lowerer.armTag(toId, arm) >= 0 || isUnitType(arm) || (trappable?.has(i) ?? false)) return;
      const lp = lowerer.widthLiftPlan(arm, toT);
      if (lp && lp.how === "liftWrap") lifts.set(i, lp);
    });
    // `trappable` extends the unit-arm rule to arms the CHECKER proved
    // away at the coercion site (narrowedRetagHelper): those may trap too.
    const ok = from.arms.every(
      (arm, i) => lowerer.armTag(toId, arm) >= 0 || isUnitType(arm) || (trappable?.has(i) ?? false) || lifts.has(i),
    );
    if (!ok) return null;
    const mapping = from.arms.map((arm, i) => {
      const identity = lowerer.armTag(toId, arm);
      return identity >= 0 ? identity : (lifts.get(i)?.tag ?? -1);
    });
    const stranded = mapping.flatMap((t, i) => (t < 0 ? [i] : []));
    // Lifts are a pure function of the (from, to) pair, so the historic
    // key stays sound for them; stranded arms depend on the SITE.
    const key = `${fromId}:${toId}:${stranded.join(".")}`;
    const existing = lowerer.retagHelpers.get(key);
    if (existing) return existing;
    const name = `%union.retag.${lowerer.retagHelpers.size}`;
    lowerer.retagHelpers.set(key, name);
    const fromT: IrType = { kind: "union", unionId: fromId };
    const u: IrExpr = { kind: "varRef", localId: "u.0", type: fromT, loc };
    const body: IrStmt[] = [];
    from.arms.forEach((arm, i) => {
      const tag = mapping[i]!;
      const cond: IrExpr = { kind: "unionIsTag", unionId: fromId, tag: i, negated: false, value: u, type: BOOL, loc };
      let then: IrStmt[];
      if (tag < 0) {
        const what = isUnitType(arm)
          ? (arm.kind === "undefinedT" ? "undefined" : "null")
          : `a '${lowerer.fmt(arm)}' value`;
        then = [
          {
            kind: "throw",
            value: {
              kind: "libCall",
              fn: "error.new",
              args: [
                {
                  kind: "strLit",
                  value: `${what} is not representable in the target union (a value narrowed or asserted past it still held it)`,
                  type: STRING,
                  loc,
                },
              ],
              type: { kind: "object", className: "%TypeError" },
              loc,
            },
            loc,
          },
        ];
      } else {
        const value: IrExpr = isUnitType(arm)
          ? { kind: "unitLit", unit: arm.kind === "undefinedT" ? "undefined" : "null", type: arm, loc }
          : { kind: "unionNarrow", unionId: fromId, tag: i, value: u, type: arm, loc };
        const lift = lifts.get(i);
        // Width-lifted arm: the narrowed payload reshapes into the
        // destination arm and wraps (applyWidthLift — planned above, so
        // the interns cannot fail here); identity arms re-wrap the same
        // payload pointer.
        const wrapped: IrExpr = lift
          ? lowerer.applyWidthLift(lift, value, toT, loc)
          : { kind: "unionWrap", unionId: toId, tag, value, type: toT, loc };
        then = [{ kind: "return", value: wrapped, loc }];
      }
      body.push({ kind: "if", cond, then, else_: null, loc });
    });
    // Unreachable when tags are exhaustive (they are, by construction);
    // satisfies the all-paths-return rule and keeps a corrupted tag loud.
    body.push({
      kind: "throw",
      value: { kind: "strLit", value: "scriptc: internal error: invalid union tag", type: STRING, loc },
      loc,
    });
    lowerer.liftedFns.push({
      name,
      params: [{ localId: "u.0", name: "u", type: fromT }],
      returnType: toT,
      locals: [{ id: "u.0", name: "u", type: fromT, mutable: true }],
      body,
      loc,
    });
    return name;
  }

  /** Interned `%union.narrow.<n>(u)` — the CHECKED single-arm extraction
   * behind `x!` on union values: the asserted arm's payload comes out
   * (+1 for ref arms, like any unionNarrow), and every OTHER arm throws
   * the catchable TypeError — divergence 38's lying-assertion stance (an
   * unchecked unionNarrow would misread the payload where JS lets the
   * impossible value flow on). Null when the target isn't a non-unit arm
   * of the union — those uses keep their erasure/fences. */
  export function narrowedArmHelper(lowerer: Lowerer, fromId: string, target: IrType, loc: SrcLoc): string | null {
    const from = lowerer.unions.get(fromId);
    if (!from || isUnitType(target)) return null;
    const tag = lowerer.armTag(fromId, target);
    if (tag < 0) return null;
    const key = `${fromId}:${tag}`;
    const existing = lowerer.narrowHelpers.get(key);
    if (existing) {
      lowerer.checkedNarrowHelpers.add(existing);
      return existing;
    }
    const name = `%union.narrow.${lowerer.narrowHelpers.size}`;
    lowerer.narrowHelpers.set(key, name);
    lowerer.checkedNarrowHelpers.add(name);
    const fromT: IrType = { kind: "union", unionId: fromId };
    const u: IrExpr = { kind: "varRef", localId: "u.0", type: fromT, loc };
    const body: IrStmt[] = [];
    from.arms.forEach((arm, i) => {
      if (i === tag) return; // the fall-through extraction below
      const what = isUnitType(arm)
        ? (arm.kind === "undefinedT" ? "undefined" : "null")
        : `a '${lowerer.fmt(arm)}' value`;
      body.push({
        kind: "if",
        cond: { kind: "unionIsTag", unionId: fromId, tag: i, negated: false, value: u, type: BOOL, loc },
        then: [
          {
            kind: "throw",
            value: {
              kind: "libCall",
              fn: "error.new",
              args: [
                {
                  kind: "strLit",
                  value: `${what} is not representable in the target union (a value narrowed or asserted past it still held it)`,
                  type: STRING,
                  loc,
                },
              ],
              type: { kind: "object", className: "%TypeError" },
              loc,
            },
            loc,
          },
        ],
        else_: null,
        loc,
      });
    });
    body.push({
      kind: "return",
      value: { kind: "unionNarrow", unionId: fromId, tag, value: u, type: target, loc },
      loc,
    });
    lowerer.liftedFns.push({
      name,
      params: [{ localId: "u.0", name: "u", type: fromT }],
      returnType: target,
      locals: [{ id: "u.0", name: "u", type: fromT, mutable: true }],
      body,
      loc,
    });
    return name;
  }

  /** The DEFERRED-INIT field read (`stream!: T` assigned past the
   * constructor's top level — the slot is `T | undefined`): interned
   * `%deferred.read.<n>(u)` extracting the declared type. SCALAR arms
   * whose JS-undefined behavior a unit default reproduces read that
   * default — bool false (conditions are exact: undefined and false are
   * both falsy; only printing/strict-equality could tell) and f64 NaN
   * (arithmetic and conditions exact) — while string and REF arms keep
   * the checked-extraction TRAP: JS itself TypeErrors the first member
   * use of such an undefined, so the catchable TypeError at the read is
   * the same failure, named earlier (SEMANTICS.md). */
  export function deferredReadHelper(lowerer: Lowerer, fromId: string, target: IrType, loc: SrcLoc): string | null {
    if (target.kind !== "bool" && target.kind !== "f64") {
      return lowerer.narrowedArmHelper(fromId, target, loc);
    }
    const from = lowerer.unions.get(fromId);
    const tag = lowerer.armTag(fromId, target);
    const utag = from ? from.arms.findIndex((a) => a.kind === "undefinedT") : -1;
    if (!from || tag < 0 || utag < 0) return null;
    const key = `deferred:${fromId}:${tag}`;
    const existing = lowerer.narrowHelpers.get(key);
    if (existing) return existing;
    const name = `%deferred.read.${lowerer.narrowHelpers.size}`;
    lowerer.narrowHelpers.set(key, name);
    const fromT: IrType = { kind: "union", unionId: fromId };
    const u: IrExpr = { kind: "varRef", localId: "u.0", type: fromT, loc };
    const dflt: IrExpr =
      target.kind === "bool"
        ? { kind: "boolLit", value: false, type: BOOL, loc }
        : { kind: "numLit", value: NaN, type: F64, loc };
    lowerer.liftedFns.push({
      name,
      params: [{ localId: "u.0", name: "u", type: fromT }],
      returnType: target,
      locals: [{ id: "u.0", name: "u", type: fromT, mutable: true }],
      body: [
        {
          kind: "if",
          cond: { kind: "unionIsTag", unionId: fromId, tag: utag, negated: false, value: u, type: BOOL, loc },
          then: [{ kind: "return", value: dflt, loc }],
          else_: null,
          loc,
        },
        {
          kind: "return",
          value: { kind: "unionNarrow", unionId: fromId, tag, value: u, type: target, loc },
          loc,
        },
      ],
      loc,
    });
    return name;
  }
