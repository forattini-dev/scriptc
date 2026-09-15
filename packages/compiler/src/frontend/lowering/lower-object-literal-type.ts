/* The record type an object literal builds: the contextual type when it can hold the literal, otherwise the literal
 * own type, with the union-arm and satisfies/PromiseLike refinements. A union of records spread with one appended field
 * lowers here directly (lower-object-spread.ts). */
import * as ts from "../ts7/adapter.js";
import type { Lowerer } from "./lowerer.js";
import { IrExpr, IrType, SrcLoc, typeEquals } from "../../ir/ir.js";
import { isConstAssertionTypeNode } from "../type-mapper.js";
import { propNameText } from "./lower-exprs.js";
import { lowerUnionRecordSpreadAppend } from "./lower-object-spread.js";

/** The union arm an object LITERAL inhabits when its fields must widen
 * PER FIELD into exactly one record arm — the reducer-action pattern
 * (`{ kind: "a", parsed: 1 }` into `{ kind: "a"; parsed: number | null }
 * | { kind: "b" }`). The IR shapes erased the literal types tsc
 * discriminated on, so the probe runs against the contextual union's
 * CHECKER members: every literal field must exist on the member
 * (excess-property freshness — tsc already enforced it), every arm field
 * missing from the literal must be optional-flavored (an undefined-armed
 * union, or a dyn slot — the absent-completion rule), and each present
 * field's LITERAL type must fit the member's field type — literal against
 * literal decides by VALUE (the discriminant), everything else by the
 * widened IR pair under the width-lift relation. Exactly ONE fitting arm
 * answers it; zero or several answer null and the caller keeps its
 * fences. Plain property-assignment/shorthand literals only — spreads,
 * accessors, methods, and unfoldable computed keys keep their own paths. */
function literalUnionArmOf(
  lowerer: Lowerer,
  expr: ts.ObjectLiteralExpression,
  tsType: ts.Type,
  recordArms: (IrType & { kind: "record" })[],
): (IrType & { kind: "record" }) | null {
  if (!tsType.isUnionType()) return null;
  const props: { name: string; node: ts.Expression }[] = [];
  for (const p of expr.properties) {
    if (ts.isPropertyAssignment(p) && !ts.isComputedPropertyName(p.name)) {
      props.push({ name: propNameText(lowerer, p.name), node: p.initializer });
    } else if (ts.isShorthandPropertyAssignment(p) && ts.isIdentifier(p.name)) {
      props.push({ name: p.name.text, node: p.name });
    } else {
      return null;
    }
  }
  /** litT fits ftT: unions per arm; literal-vs-literal by value; unit
   * types only into their own unit; otherwise the widened IR pair must be
   * equal or width-liftable. */
  const fits = (litT: ts.Type, ftT: ts.Type): boolean => {
    if (ftT.isUnionType()) return ts.constituentTypes(ftT).some((a) => fits(litT, a));
    if (ftT.isStringLiteralType()) return litT.isStringLiteralType() && litT.value === ftT.value;
    if (ftT.isNumberLiteralType()) return litT.isNumberLiteralType() && litT.value === ftT.value;
    if (ftT.flags & ts.TypeFlags.BooleanLiteral) {
      return (litT.flags & ts.TypeFlags.BooleanLiteral) !== 0 && lowerer.checker.typeToString(litT) === lowerer.checker.typeToString(ftT);
    }
    if (ftT.flags & ts.TypeFlags.Null) return (litT.flags & ts.TypeFlags.Null) !== 0;
    if (ftT.flags & ts.TypeFlags.Undefined) return (litT.flags & ts.TypeFlags.Undefined) !== 0;
    if (litT.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined)) return false;
    const li = lowerer.mapTypeOf(lowerer.checker.getBaseTypeOfLiteralType(litT));
    const fi = lowerer.mapTypeOf(ftT);
    if (!li || !fi) return false;
    return typeEquals(li, fi) || lowerer.widthLiftPlan(li, fi) !== null;
  };
  const armShapeIds = new Set(recordArms.map((a) => a.shapeId));
  const candidates = new Set<string>();
  for (const member of ts.constituentTypes(tsType)) {
    const mMapped = lowerer.mapTypeOf(member);
    if (mMapped?.kind !== "record" || !armShapeIds.has(mMapped.shapeId) || candidates.has(mMapped.shapeId)) continue;
    const shape = lowerer.shapes.get(mMapped.shapeId);
    if (!shape || shape.tuple || shape.indexValue) continue;
    // Excess-property freshness: every literal field must exist on the
    // member (tsc rejected the others for a fresh literal).
    if (!props.every((p) => lowerer.checker.getPropertyOfType(member, p.name) !== undefined)) continue;
    // Arm fields the literal leaves unset must be optional-flavored (the
    // absent-completion rule: an undefined-armed union or a dyn slot).
    const names = new Set(props.map((p) => p.name));
    const absentOk = shape.fields.every((f) => {
      if (names.has(f.name)) return true;
      if (f.type.kind === "dyn") return true;
      if (f.type.kind !== "union") return false;
      return lowerer.unions.get(f.type.unionId)?.arms.some((a) => a.kind === "undefinedT") ?? false;
    });
    if (!absentOk) continue;
    const fieldsFit = props.every((p) => {
      const sym = lowerer.checker.getPropertyOfType(member, p.name);
      if (!sym) return false;
      return fits(lowerer.typeOf(p.node), lowerer.checker.getTypeOfSymbol(sym));
    });
    if (fieldsFit) candidates.add(mMapped.shapeId);
  }
  if (candidates.size !== 1) return null;
  const [only] = candidates;
  return recordArms.find((a) => a.shapeId === only) ?? null;
}

/** The record type `expr` builds (`mapped`, null when nothing maps) and the checker type it came from, or the literal
 * already lowered when a union-of-records spread appends its one field. */
export function objectLiteralRecordType(
  lowerer: Lowerer,
  expr: ts.ObjectLiteralExpression,
  loc: SrcLoc,
): { lowered: IrExpr } | { tsType: ts.Type; mapped: IrType | null } {
    let tsType = lowerer.checker.getContextualType(expr) ?? lowerer.typeOf(expr);
    // `lit satisfies T` is TYPE-LEVEL only: the expression's checker type —
    // and therefore the shape every downstream consumer sees — is the
    // literal's OWN type (T still contextually types members, so inferred
    // parameter types flow). Building at T would reshape the value tsc
    // says has the literal's type: `{...} satisfies Movable &
    // Record<string, unknown>` must NOT become an index-signature record.
    // Own type wins whenever it maps to a record; an unmappable own type
    // keeps the contextual fallback (a bare-null field whose satisfies
    // target names the wider slot type).
    {
      let p: ts.Node = expr.parent;
      while (
        ts.isParenthesizedExpression(p) ||
        (ts.isAsExpression(p) && isConstAssertionTypeNode(p.type)) ||
        ts.isPropertyAssignment(p) ||
        ts.isObjectLiteralExpression(p)
      ) {
        p = p.parent;
      }
      if (ts.isSatisfiesExpression(p)) {
        const own = lowerer.typeOf(expr);
        if (lowerer.mapTypeOf(own)?.kind === "record") tsType = own;
      }
    }
    // An async function's return position types the literal
    // `T | PromiseLike<T>` (the lib's await-unwrapping contract). The
    // PromiseLike arm never maps, and the record the return slot actually
    // holds is exactly the checker's awaited type — strip to it BEFORE the
    // own-type fallback below: the awaited contextual type carries the
    // slot's field types (`lanIp: string | null`), which the literal's own
    // type narrows away (a field written as `lanIp: null` types as bare
    // `null`, which maps to nothing on its own).
    if (tsType.isUnionType() && ts.constituentTypes(tsType).some((t) => t.getSymbol()?.name === "PromiseLike")) {
      tsType = lowerer.checker.getAwaitedType(tsType) ?? tsType;
    }
    let mapped = lowerer.mapTypeOf(tsType);
    if (mapped?.kind === "union") {
      const unionSpread = lowerUnionRecordSpreadAppend(lowerer, expr, mapped, loc);
      if (unionSpread) return { lowered: unionSpread };
    }
    // An EMPTY-record context under a NON-empty literal (`Object.keys({
    // ...process.env })` — the lib's `{}`-typed parameters admit every
    // object): `{}` carries no shape information, so the literal builds as
    // its OWN type, exactly the unmappable-context fallback below. An
    // empty LITERAL keeps the context (the shapes agree).
    if (mapped?.kind === "record" && expr.properties.length > 0) {
      const ctxShape = lowerer.shapes.get(mapped.shapeId);
      if (ctxShape && ctxShape.fields.length === 0 && !ctxShape.indexValue && !ctxShape.tuple) {
        mapped = lowerer.mapTypeOf(lowerer.typeOf(expr)) ?? mapped;
      }
    }
    // A literal with a property the contextual TYPE ITSELF lacks — only
    // reachable through type assertions and satisfies (fresh-literal
    // excess-property checks reject the direct spelling): the context
    // cannot hold the value, so the literal builds at its OWN type and the
    // slot's width coercion narrows it (divergence 36's copy stance — the
    // extra fields drop in the copy). The probe is against the CHECKER's
    // contextual type, not the mapped shape: a property the contextual
    // type carries but the shape dropped (settled value/reason,
    // generic-callable members) belongs to the drop paths below, and
    // index-signature contexts keep every key (overflow capture).
    if (mapped?.kind === "record" && expr.properties.length > 0) {
      const ctxShape = lowerer.shapes.get(mapped.shapeId);
      if (ctxShape && !ctxShape.indexValue && !ctxShape.tuple) {
        const names = new Set(ctxShape.fields.map((f) => f.name));
        const ctxHasProp = (name: string): boolean => {
          const members = tsType.isUnionType() ? ts.constituentTypes(tsType) : [tsType];
          return members.some((m) => lowerer.checker.getPropertyOfType(m, name) !== undefined);
        };
        const extraOf = (text: string): boolean => !names.has(text) && !ctxHasProp(text);
        const extra = expr.properties.some((p) => {
          if (ts.isSpreadAssignment(p) || !p.name) return false;
          if (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) return extraOf(p.name.text);
          if (ts.isNumericLiteral(p.name)) return extraOf(String(Number(p.name.text)));
          return false; // computed keys keep their existing paths
        });
        if (extra) mapped = lowerer.mapTypeOf(lowerer.typeOf(expr)) ?? mapped;
      }
    }
    // A union-typed slot (`const r: Res = { kind: "ok", ... }`) contextually
    // types the literal as the WHOLE union; build the literal as its own
    // (arm) shape and let the slot's coercion wrap it into the union. An
    // unknown-typed slot (`JSON.stringify({ a: 1 })`) likewise. An
    // UNMAPPABLE context falls back the same way — the literal's own type
    // is the plain record the slot coerces. A CLASS-INSTANCE context
    // (`const p: Point = { x, y }` — tsc's structural view of data
    // classes) falls back too: the literal builds as its own record and
    // the slot's width coercion constructs through the trivial
    // parameter-property constructor (recordToClassPlan), or fences with
    // the record-shape story.
    // A jsval-mapped context reaches here only when lowerExpr's island
    // gate DECLINED it (a project-declared typedef that absorbed to the
    // island through checker-`any` field residue): the literal builds at
    // its own type like every unmappable context.
    if (mapped === null || mapped.kind === "union" || mapped.kind === "dyn" || mapped.kind === "object" || mapped.kind === "jsval") {
      const ctxUnion = mapped?.kind === "union" ? mapped : null;
      mapped = lowerer.mapTypeOf(lowerer.typeOf(expr)) ?? mapped;
      // A literal whose own shape re-tags into NO arm of the contextual
      // union, where the union has exactly ONE record arm: build AS that
      // arm — there is no ambiguity (tsc already checked the literal
      // against the union, and the record arm is the only shape it can
      // inhabit), and the arm's field types drive every property's
      // coercion (`{ env: {...spread...}, onCleanup }` against an
      // optional options param — the env value builds by ITS contextual
      // index-signature type and wraps into the arm's `| undefined`
      // field, where the literal's own inferred width would mismatch).
      // Empty literals (`_env = {}` — the fieldless own shape) and
      // literals against PURE index-signature arms (`{ OPENSSL_CONF:
      // candidate }` — keys become overflow entries) are the same rule's
      // simplest cases. The empty-array-in-union rule, record form.
      if (ctxUnion) {
        const def = lowerer.unions.get(ctxUnion.unionId);
        const recordArms = def?.arms.filter((a) => a.kind === "record") ?? [];
        if (recordArms.length === 1) {
          const armShape = lowerer.shapes.get(recordArms[0]!.shapeId);
          if (
            (mapped?.kind !== "record" || mapped.shapeId !== recordArms[0]!.shapeId) &&
            !armShape?.tuple
          ) {
            mapped = recordArms[0]!;
          }
        } else if (recordArms.length > 1) {
          const ownShapeId = mapped?.kind === "record" ? mapped.shapeId : null;
          // SEVERAL record arms (the reducer-action / discriminated-message
          // pattern): the literal's own inferred shape re-tags into no arm
          // — its field types widened per field (`parsed: 1` against
          // `parsed: number | null`), so the IR-level candidate probe is
          // ambiguous (a narrower arm also admits the literal by dropping
          // fields). The LITERAL types tsc checked carry the discriminant
          // the shapes erased: match the literal's fields against each
          // union member's CHECKER types (literal-vs-literal field pairs
          // decide by value — the `kind: "a"` discriminant), and when
          // exactly ONE member fits, build AS that arm — its field types
          // drive every property's coercion, exactly the single-record-arm
          // rule above. Ambiguous literals keep the SC2003 fence.
          if (ownShapeId === null || !recordArms.some((a) => a.shapeId === ownShapeId)) {
            const arm = literalUnionArmOf(lowerer, expr, tsType, recordArms);
            if (arm) mapped = arm;
          }
        }
      }
    }
    return { tsType, mapped };
}
