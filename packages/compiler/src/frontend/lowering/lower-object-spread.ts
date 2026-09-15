/* Object spreads that do not go through the field-by-field desugar: the `{ ...model, x }` clone update, merges into
 * index-signature targets, declared shapes built from index-signature spreads, union-of-records spreads, and the
 * source guards (nullish optional records, accessor-carrying shapes) the desugar in lower-object-literal.ts shares. */
import { lowerComputedStringKey } from "./lower-computed-string-key.js";
import { InternalCompilerError } from "../../errors.js";
import * as ts from "../ts7/adapter.js";
import type { Lowerer } from "./lowerer.js";
import {
  BOOL,
  F64,
  IrExpr,
  IrLocal,
  IrRecordShape,
  IrStmt,
  IrType,
  STRING,
  SrcLoc,
  UNDEFINED_T,
  arrayOf,
  isUnitType,
  shapeHasAccessorSlots,
  typeEquals,
} from "../../ir/ir.js";
import { isJsSourceFile, locOf } from "../program.js";
import { NARROW_FIRST } from "./surfaces.js";
import { IndexMergeContributor, lowerIndexMergeHelper } from "./lower-containers.js";
import { numLit, varRef } from "../../ir/build.js";
import { conditionalSpreadOf, literalComputedKey, propNameText, pureReemittable } from "./lower-exprs.js";

/** Spreading a source whose shape carries accessor slots: Node's copy
 * invokes each getter exactly once in insertion order — even for keys a
 * later contributor overrides — while the field-copy desugar assumes pure
 * reads it may drop or reorder. Getter-call counts would silently diverge,
 * so accessor-carrying sources fence by name. */
export function fenceAccessorSpreadSource(lowerer: Lowerer, prop: ts.Node, srcShape: IrRecordShape | undefined): void {
  if (srcShape && shapeHasAccessorSlots(srcShape)) {
    lowerer.unsupported(
      "SC1090",
      prop,
      "object spread of sources carrying get/set accessor properties (Node invokes each getter once during the copy — the field-copy desugar cannot model the calls; bind the reads to consts first)",
    );
  }
}

/** `{ ...request, id }` where both `request` and the asserted/contextual
 * result are unions of records, and the one appended shorthand field is
 * the only structural difference between each source/target arm. The
 * source and appended value evaluate once, in JS order; a tag dispatch
 * clones the active record into its uniquely matching target arm. */
export function lowerUnionRecordSpreadAppend(
  lowerer: Lowerer,
  expr: ts.ObjectLiteralExpression,
  target: IrType & { kind: "union" },
  loc: SrcLoc,
): IrExpr | null {
  if (expr.properties.length !== 2) return null;
  const spread = expr.properties[0];
  const append = expr.properties[1];
  if (
    !spread || !ts.isSpreadAssignment(spread) ||
    !append || !ts.isShorthandPropertyAssignment(append) || !ts.isIdentifier(append.name)
  ) return null;

  const source = lowerer.mapTypeOf(lowerer.typeOf(spread.expression));
  if (source?.kind !== "union") return null;
  const sourceDef = lowerer.unions.get(source.unionId);
  const targetDef = lowerer.unions.get(target.unionId);
  if (
    !sourceDef || !targetDef ||
    sourceDef.arms.length < 2 || sourceDef.arms.length !== targetDef.arms.length ||
    !sourceDef.arms.every((arm) => arm.kind === "record") ||
    !targetDef.arms.every((arm) => arm.kind === "record")
  ) {
    return null;
  }

  const field = append.name.text;
  const pairs: {
    source: IrType & { kind: "record" };
    sourceShape: IrRecordShape;
    sourceTag: number;
    target: IrType & { kind: "record" };
    targetShape: IrRecordShape;
    targetTag: number;
  }[] = [];
  for (const [sourceTag, sourceArm] of (sourceDef.arms as (IrType & { kind: "record" })[]).entries()) {
    const sourceShape = lowerer.shapes.get(sourceArm.shapeId);
    if (!sourceShape || sourceShape.tuple || sourceShape.indexValue || sourceShape.fields.some((item) => item.name === field)) {
      return null;
    }
    const candidates = (targetDef.arms as (IrType & { kind: "record" })[]).flatMap((targetArm, targetTag) => {
      const targetShape = lowerer.shapes.get(targetArm.shapeId);
      if (!targetShape || targetShape.tuple || targetShape.indexValue) return [];
      if (targetShape.fields.length !== sourceShape.fields.length + 1) return [];
      if (!targetShape.fields.some((item) => item.name === field)) return [];
      const preservesSource = sourceShape.fields.every((sourceField) => {
        const targetField = targetShape.fields.find((item) => item.name === sourceField.name);
        return targetField !== undefined && typeEquals(targetField.type, sourceField.type);
      });
      return preservesSource ? [{ target: targetArm, targetShape, targetTag }] : [];
    });
    const candidate = candidates[0];
    if (!candidate || candidates.length !== 1) return null;
    pairs.push({ source: sourceArm, sourceShape, sourceTag, ...candidate });
  }
  if (new Set(pairs.map((pair) => pair.targetTag)).size !== targetDef.arms.length) return null;

  const fieldTypes = pairs.map((pair) => pair.targetShape.fields.find((item) => item.name === field)?.type);
  const fieldType = fieldTypes[0];
  if (!fieldType || !fieldTypes.every((candidate) => candidate !== undefined && typeEquals(candidate, fieldType))) return null;

  const sourceValue = lowerer.lowerExpr(spread.expression);
  if (!typeEquals(sourceValue.type, source)) return null;
  const sourceLocal = lowerer.declareHiddenLocal("%unionSpread", source);
  const appendedValue = lowerer.coerceInto(append, lowerer.lowerShorthandValue(append), fieldType);
  const appendedLocal = lowerer.declareHiddenLocal("%unionSpreadField", fieldType);
  const sourceRef = (): IrExpr => varRef(sourceLocal.id, source, loc);
  const appendedRef = (): IrExpr => varRef(appendedLocal.id, fieldType, loc);

  const wrap = (pair: typeof pairs[number]): IrExpr => {
    const narrowed = (): IrExpr => ({
      kind: "unionNarrow",
      unionId: source.unionId,
      tag: pair.sourceTag,
      value: sourceRef(),
      type: pair.source,
      loc,
    });
    const value: IrExpr = {
      kind: "recordLit",
      fields: pair.targetShape.fields.map((targetField) => {
        if (targetField.name === field) return { name: targetField.name, value: appendedRef() };
        const sourceField = pair.sourceShape.fields.find((candidate) => candidate.name === targetField.name);
        if (!sourceField) throw new InternalCompilerError("lowerer bug: union spread target field missing from source arm");
        return {
          name: targetField.name,
          value: {
            kind: "recordGet",
            obj: narrowed(),
            shapeId: pair.source.shapeId,
            field: targetField.name,
            type: sourceField.type,
            loc,
          },
        };
      }),
      type: pair.target,
      loc,
    };
    return { kind: "unionWrap", unionId: target.unionId, tag: pair.targetTag, value, type: target, loc };
  };

  const lastPair = pairs[pairs.length - 1];
  if (!lastPair) return null;
  let result = wrap(lastPair);
  for (let index = pairs.length - 2; index >= 0; index--) {
    const pair = pairs[index];
    if (!pair) throw new InternalCompilerError("lowerer bug: missing union spread arm");
    result = {
      kind: "ternary",
      cond: { kind: "unionIsTag", unionId: source.unionId, tag: pair.sourceTag, negated: false, value: sourceRef(), type: BOOL, loc },
      then: wrap(pair),
      else_: result,
      type: target,
      loc,
    };
  }
  return {
    kind: "seqExpr",
    stmts: [
      { kind: "varDecl", localId: sourceLocal.id, init: sourceValue, loc },
      { kind: "varDecl", localId: appendedLocal.id, init: appendedValue, loc },
    ],
    result,
    type: target,
    loc,
  };
}

/** Object spread treats nullish sources as empty. Preserve evaluation once,
 * then turn `Record<K, V> | undefined` into either that record or a fresh
 * empty record of the same represented shape. */
export function lowerOptionalIndexSpreadSource(lowerer: Lowerer, source: IrExpr, loc: SrcLoc): IrExpr | null {
  if (source.type.kind !== "union") return null;
  const def = lowerer.unions.get(source.type.unionId);
  if (!def || def.arms.length !== 2) return null;
  const undefinedTag = def.arms.findIndex((arm) => arm.kind === "undefinedT");
  const recordTag = def.arms.findIndex((arm) => arm.kind === "record");
  if (undefinedTag < 0 || recordTag < 0) return null;
  const recordType = def.arms[recordTag]!;
  if (recordType.kind !== "record") return null;

  const prefix: IrStmt[] = [];
  let stable = source;
  if (!pureReemittable(source)) {
    const local = lowerer.declareHiddenLocal("%spread", source.type);
    prefix.push({ kind: "varDecl", localId: local.id, init: source, loc });
    stable = varRef(local.id, source.type, loc);
  }
  const selected: IrExpr = {
    kind: "ternary",
    cond: { kind: "unionIsTag", unionId: source.type.unionId, tag: undefinedTag, negated: false, value: stable, type: BOOL, loc },
    then: { kind: "recordLit", fields: [], type: recordType, loc },
    else_: { kind: "unionNarrow", unionId: source.type.unionId, tag: recordTag, value: stable, type: recordType, loc },
    type: recordType,
    loc,
  };
  return prefix.length === 0 ? selected : { kind: "seqExpr", stmts: prefix, result: selected, type: recordType, loc };
}

/** A property whose computed key does not fold to a compile-time name: only index-signature targets can hold it. */
export function isRuntimeComputedKey(lowerer: Lowerer, p: ts.ObjectLiteralElementLike): boolean {
  return (
    !ts.isSpreadAssignment(p) &&
    p.name !== undefined &&
    ts.isComputedPropertyName(p.name) &&
    literalComputedKey(lowerer, p.name) === null
  );
}

/** `{ ...model, changed, other: value }` over a record of the SAME shape: one recordClone (source first, overrides in
 * source order). Answers the clone, or the leading spread when it lowered it before declining (the ordinary spread
 * path reuses that value so lowering still happens once). */
export function lowerRecordUpdateSpread(
  lowerer: Lowerer,
  expr: ts.ObjectLiteralExpression,
  type: IrType & { kind: "record" },
  shape: IrRecordShape,
  fieldTypes: ReadonlyMap<string, IrType>,
  loc: SrcLoc,
): { clone: IrExpr } | { leadingSpread: IrExpr | null } {
    // The overwhelmingly common immutable-update form over a record:
    // `{ ...model, changed, other: value }`. The historic lowering expanded
    // the spread into one recordGet per untouched field at EVERY site, then
    // the backends inlined all of those retains and stores into the caller.
    // A 178-field model updated hundreds of times consequently produced a
    // half-million-line LLVM function. Keep the same evaluation/ownership
    // semantics in one compact IR node: source first, explicit overrides in
    // source order, and one backend clone helper per shape.
    //
    // Stay deliberately narrow. Tuple/index/accessor shapes, conditional or
    // multiple spreads, spread-after-explicit order, and shape-changing width
    // copies retain their existing lowering and diagnostics.
    if (
      !isJsSourceFile(expr.getSourceFile()) &&
      !shape.indexValue &&
      !shape.tuple &&
      !shapeHasAccessorSlots(shape) &&
      expr.properties.length >= 2 &&
      ts.isSpreadAssignment(expr.properties[0]!) &&
      !conditionalSpreadOf(expr.properties[0]!.expression) &&
      expr.properties.slice(1).every(
        (p) =>
          (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) &&
          p.name !== undefined &&
          (ts.isIdentifier(p.name) ||
            ts.isStringLiteral(p.name) ||
            ts.isNumericLiteral(p.name) ||
            (ts.isComputedPropertyName(p.name) && literalComputedKey(lowerer, p.name) !== null)),
      )
    ) {
      const spread = expr.properties[0]! as ts.SpreadAssignment;
      const props = expr.properties.slice(1) as (
        | ts.PropertyAssignment
        | ts.ShorthandPropertyAssignment
      )[];
      const names = props.map((p) => propNameText(lowerer, p.name!));
      const unique = new Set(names);
      const sourceType = lowerer.mapTypeOf(lowerer.typeOf(spread.expression));
      if (
        sourceType?.kind === "record" &&
        sourceType.shapeId === type.shapeId &&
        unique.size === names.length &&
        names.every((name) => fieldTypes.has(name))
      ) {
        const source = lowerer.lowerExpr(spread.expression);
        if (source.type.kind === "record" && source.type.shapeId === type.shapeId) {
          const overrides: { name: string; value: IrExpr }[] = [];
          for (let i = 0; i < props.length; i++) {
            const p = props[i]!;
            const name = names[i]!;
            const fieldType = fieldTypes.get(name)!;
            const valueNode = ts.isPropertyAssignment(p) ? p.initializer : p;
            let value = ts.isPropertyAssignment(p)
              ? lowerer.lowerExpr(p.initializer)
              : lowerer.lowerShorthandValue(p);
            value = lowerer.coerceInto(valueNode, value, fieldType);
            if (!typeEquals(value.type, fieldType)) lowerer.badType(valueNode, lowerer.typeOf(valueNode));
            overrides.push({ name, value });
          }
          return { clone: { kind: "recordClone", source, overrides, type, loc } };
        }
        return { leadingSpread: source };
      }
    }
    return { leadingSpread: null };
}

/** Spreads and runtime-keyed properties into a PURE index-signature target, as one merge-helper call; null when the
 * target or the members do not fit. */
export function lowerIndexSignatureSpreadMerge(
  lowerer: Lowerer,
  expr: ts.ObjectLiteralExpression,
  type: IrType & { kind: "record" },
  shape: IrRecordShape,
  loc: SrcLoc,
): IrExpr | null {
    // A PURE index-signature target with spreads — `{ ...process.env }`,
    // `{ ...process.env, ...extraEnv }`, `{ ...env, PATH: p }` (the
    // spawn-env pattern): the field-by-field desugar below cannot
    // enumerate runtime overflow keys, so the literal lowers as ONE
    // interned merge-helper call — contributors apply in literal order
    // with keyed writes (JS last-write-wins), sources and values evaluate
    // once each in source order (the call's argument order). A CONDITIONAL
    // spread `...(c ? { k: v } : {})` contributes its one key as a ternary
    // — cond once, v lazily, the empty arm holding the value slot's
    // undefined arm (the explicit-undefined-is-absent stance: JSON and
    // child-env builders drop it, exactly Node's absent key); targets
    // with declared fields keep the historic desugar below.
    if (
      shape.indexValue &&
      shape.fields.length === 0 &&
      !shape.tuple &&
      (expr.properties.some((p) => ts.isSpreadAssignment(p)) || expr.properties.some((p) => isRuntimeComputedKey(lowerer, p)))
    ) {
      const contributors: IndexMergeContributor[] = [];
      let mergeable = true;
      for (const prop of expr.properties) {
        if (ts.isSpreadAssignment(prop)) {
          const cs = conditionalSpreadOf(prop.expression);
          if (cs === "unsupported" || (cs && cs.props.length !== 1)) {
            lowerer.unsupported(
              "SC1090",
              prop,
              "conditional spreads beyond `...(c ? { field: v } : {})` (exactly one property against an empty arm)",
            );
          }
          if (cs) {
            const absent = lowerer.wrappedUndefined(shape.indexValue, locOf(prop));
            if (!absent) {
              lowerer.unsupported(
                "SC1090",
                prop,
                `conditional spreads into '${lowerer.fmt(shape.indexValue)}'-valued index-signature keys (the empty arm needs an undefined arm to hold — write the key in an if statement instead)`,
              );
            }
            const csProp = cs.props[0]!;
            const cond = lowerer.lowerCondition(cs.cond);
            const vNode: ts.Node = ts.isPropertyAssignment(csProp) ? csProp.initializer : csProp;
            const v = lowerer.intoIndexValueSlot(
              ts.isPropertyAssignment(csProp) ? lowerer.lowerExpr(csProp.initializer) : lowerer.lowerShorthandValue(csProp),
              shape.indexValue,
              vNode,
            );
            contributors.push({
              kind: "field",
              name: csProp.name.text,
              value: {
                kind: "ternary",
                cond,
                then: cs.whenTrue ? v : absent,
                else_: cs.whenTrue ? absent : v,
                type: shape.indexValue,
                loc: locOf(prop),
              },
            });
            continue;
          }
          let src = lowerer.lowerExpr(prop.expression);
          src = lowerOptionalIndexSpreadSource(lowerer, src, locOf(prop)) ?? src;
          if (src.type.kind !== "record") {
            lowerer.unsupported(
              "SC1090",
              prop,
              `object spread of '${lowerer.fmt(src.type)}' sources into an index-signature shape (only index-signature records merge — ${NARROW_FIRST})`,
            );
          }
          fenceAccessorSpreadSource(lowerer, prop, lowerer.shapes.get(src.type.shapeId));
          contributors.push({ kind: "spread", shapeId: src.type.shapeId, value: src });
          continue;
        }
        if (
          (ts.isPropertyAssignment(prop) || ts.isShorthandPropertyAssignment(prop)) &&
          prop.name &&
          (ts.isIdentifier(prop.name) ||
            ts.isStringLiteral(prop.name) ||
            ts.isNumericLiteral(prop.name) ||
            (ts.isComputedPropertyName(prop.name) && literalComputedKey(lowerer, prop.name) !== null))
        ) {
          const value = ts.isPropertyAssignment(prop)
            ? lowerer.intoIndexValueSlot(lowerer.lowerExpr(prop.initializer), shape.indexValue, prop.initializer)
            : lowerer.intoIndexValueSlot(lowerer.lowerShorthandValue(prop), shape.indexValue, prop);
          contributors.push({ kind: "field", name: propNameText(lowerer, prop.name), value });
          continue;
        }
        // A RUNTIME-keyed property (`{ ...m, ["a" + "b"]: "" }`, `{ [K]:
        // v }` where K is a runtime string): the key evaluates before its
        // value (JS's per-property order — both are helper arguments) and
        // writes through the signature exactly like a spread's keys.
        // Number/boolean/unknown keys stringify (ToPropertyKey).
        if (ts.isPropertyAssignment(prop) && ts.isComputedPropertyName(prop.name)) {
          const k = lowerComputedStringKey(lowerer, prop.name);
          const value = lowerer.intoIndexValueSlot(lowerer.lowerExpr(prop.initializer), shape.indexValue, prop.initializer);
          contributors.push({ kind: "keyedField", key: k, value });
          continue;
        }
        mergeable = false;
        break;
      }
      if (mergeable) {
        const helper = lowerIndexMergeHelper(lowerer, type.shapeId, contributors, loc);
        if (helper === null) {
          lowerer.unsupported(
            "SC1090",
            expr,
            `object spread into '${lowerer.fmt(type)}' from these source shapes (spread sources must be index-signature records whose value type is, or lifts into, the target's)`,
          );
        }
        return {
          kind: "call",
          callee: helper,
          args: contributors.flatMap((c) => (c.kind === "keyedField" ? [c.key, c.value] : [c.value])),
          type,
          loc,
        };
      }
    }
    return null;
}

/** A declared-fields target built entirely from index-signature spreads, as one merge-helper call; null otherwise. */
export function lowerDeclaredShapeSpreadMerge(
  lowerer: Lowerer,
  expr: ts.ObjectLiteralExpression,
  type: IrType & { kind: "record" },
  shape: IrRecordShape,
  loc: SrcLoc,
): IrExpr | null {
    // A DECLARED-fields target built ENTIRELY from index-signature spreads —
    // `{ ...Object.fromEntries(...), ...Object.fromEntries(...) }` typed
    // AppConfig (the defaults-merge idiom over runtime-keyed sources): the
    // field-by-field desugar cannot enumerate runtime keys, so the literal
    // lowers as ONE interned merge-helper call — sources evaluate once each
    // in source order (the call's argument order — computed sources
    // included, no re-read), contributors apply in order with per-key
    // dispatch onto the declared fields (JS last-write-wins). Divergence 68
    // has the runtime rules (validated collisions, extra keys dropped).
    if (
      !shape.indexValue &&
      !shape.tuple &&
      shape.fields.length > 0 &&
      expr.properties.length > 0 &&
      expr.properties.every((p) => ts.isSpreadAssignment(p) && !conditionalSpreadOf(p.expression)) &&
      expr.properties.some((p) => {
        const t = lowerer.mapTypeOf(lowerer.typeOf((p as ts.SpreadAssignment).expression));
        return t?.kind === "record" && !!lowerer.shapes.get(t.shapeId)?.indexValue;
      })
    ) {
      return lowerDeclaredSpreadMerge(lowerer, expr, type, shape, loc);
    }
    return null;
}

/** `{ ...idx, ...idx2 }` typed a DECLARED shape (no index signature) — the
   * defaults-merge idiom over runtime-keyed sources (`{ ...fromEntries(a),
   * ...fromEntries(b) }` typed AppConfig). Lowers to ONE interned helper
   * call: sources evaluate once each as arguments (source order — computed
   * sources included, JS's evaluate-once), the result starts all-undefined
   * (every target field must be optional — the runtime keys decide
   * presence), and each source's keys apply in JS own-key order with a
   * per-key dispatch onto the declared fields: a matching key writes the
   * field — identity when the source's value slot IS the field type, a
   * validated extraction otherwise (a dyn slot dynChecks; a union slot
   * re-tags arm-by-arm, and a value outside the field's arms throws the
   * catchable TypeError — divergence 34's keyed-write stance, where Node's
   * untyped copy would store the lie) — and a key naming NO declared field
   * is DROPPED (the shape cannot represent it; Node keeps it invisibly —
   * divergence 68). Later contributors overwrite earlier ones
   * (last-write-wins). Sources must be PURE index-signature records. */
  function lowerDeclaredSpreadMerge(lowerer: Lowerer, expr: ts.ObjectLiteralExpression,
    type: IrType & { kind: "record" },
    shape: IrRecordShape,
    loc: SrcLoc,): IrExpr {
    interface Src { value: IrExpr; shapeId: string; iv: IrType }
    const srcs: Src[] = [];
    for (const prop of expr.properties) {
      const spread = prop as ts.SpreadAssignment; // caller-checked: all spreads
      const value = lowerer.lowerExpr(spread.expression);
      const srcShape = value.type.kind === "record" ? lowerer.shapes.get(value.type.shapeId) : undefined;
      if (value.type.kind !== "record" || !srcShape?.indexValue || srcShape.tuple || srcShape.fields.length > 0) {
        lowerer.unsupported(
          "SC1090",
          prop,
          `object spread of '${lowerer.fmt(value.type)}' into '${lowerer.fmt(type)}' (only PURE index-signature records — Object.fromEntries results, Record<string, T> values — spread into a declared shape)`,
        );
      }
      srcs.push({ value, shapeId: value.type.shapeId, iv: srcShape.indexValue });
    }
    // Every target field must be optional: absent keys leave the undefined
    // arm, exactly the unset-optional representation.
    for (const f of shape.fields) {
      if (f.type.kind !== "union" || lowerer.armTag(f.type.unionId, UNDEFINED_T) < 0) {
        lowerer.unsupported(
          "SC1090",
          expr,
          `object spread of runtime-keyed sources onto the required field '${f.name}' (the keys decide presence at runtime — declare the field optional or spell it explicitly)`,
        );
      }
    }
    // Per (source value slot → field) conversion, checked up front so the
    // fence fires at the literal, not inside the interned helper.
    const conv = (iv: IrType, f: { name: string; type: IrType }, v: IrExpr): { value: IrExpr } | { stmts: (write: (value: IrExpr) => IrStmt) => IrStmt[] } => {
      if (typeEquals(iv, f.type)) return { value: v };
      if (iv.kind === "dyn") {
        return { value: { kind: "dynCheck", value: v, type: f.type, loc } };
      }
      if (iv.kind === "union" && f.type.kind === "union") {
        const fUnion = f.type;
        const def = lowerer.unions.get(iv.unionId);
        const fDef = lowerer.unions.get(fUnion.unionId);
        if (def && fDef && def.arms.some((a) => lowerer.armTag(fUnion.unionId, a) >= 0)) {
          // Arm-by-arm validated re-tag, inline in the helper: matching
          // arms map by identity (unit arms re-wrap, value arms narrow and
          // wrap); anything else throws the catchable TypeError.
          return {
            stmts: (write) => {
              const chain = (i: number): IrStmt[] => {
                if (i >= def.arms.length) {
                  return [{
                    kind: "throw",
                    value: {
                      kind: "libCall",
                      fn: "error.new",
                      args: [{ kind: "strLit", value: `expected ${lowerer.fmt(fUnion)} at $.${f.name}`, type: STRING, loc }],
                      type: { kind: "object", className: "%TypeError" },
                      loc,
                    },
                    loc,
                  }];
                }
                const arm = def.arms[i]!;
                const toTag = lowerer.armTag(fUnion.unionId, arm);
                if (toTag < 0) return chain(i + 1);
                const extracted: IrExpr = isUnitType(arm)
                  ? { kind: "unionWrap", unionId: fUnion.unionId, tag: toTag, value: { kind: "unitLit", unit: arm.kind === "undefinedT" ? "undefined" : "null", type: arm, loc }, type: fUnion, loc }
                  : { kind: "unionWrap", unionId: fUnion.unionId, tag: toTag, value: { kind: "unionNarrow", unionId: iv.unionId, tag: i, value: v, type: arm, loc }, type: fUnion, loc };
                return [{
                  kind: "if",
                  cond: { kind: "unionIsTag", unionId: iv.unionId, tag: i, negated: false, value: v, type: BOOL, loc },
                  then: [write(extracted)],
                  else_: chain(i + 1),
                  loc,
                }];
              };
              return chain(0);
            },
          };
        }
      }
      lowerer.unsupported(
        "SC1090",
        expr,
        `object spread into '${lowerer.fmt(type)}' where the source's '${lowerer.fmt(iv)}' values cannot reach the '${lowerer.fmt(f.type)}' field '${f.name}' (the value slot must be the field type, 'unknown', or a union covering the field's arms)`,
      );
    };
    const key = `declmerge:${type.shapeId}:${srcs.map((s) => s.shapeId).join(",")}`;
    let helper = lowerer.widthHelpers.get(key);
    if (!helper) {
      helper = `%rec.declmerge.${lowerer.widthHelpers.size}`;

      const outRef = varRef("out.0", type, loc);
      const ksT = arrayOf(STRING);
      const locals: IrLocal[] = [{ id: "out.0", name: "out", type, mutable: false }];
      const params = srcs.map((s, j) => {
        locals.push({ id: `s${j}.0`, name: `s${j}`, type: s.value.type, mutable: true });
        return { localId: `s${j}.0`, name: `s${j}`, type: s.value.type };
      });
      const body: IrStmt[] = [
        {
          kind: "varDecl",
          localId: "out.0",
          init: {
            kind: "recordLit",
            fields: shape.fields.map((f) => ({ name: f.name, value: lowerer.wrappedUndefined(f.type, loc)! })),
            type,
            loc,
          },
          loc,
        },
      ];
      srcs.forEach((s, j) => {
        const sRef = varRef(`s${j}.0`, s.value.type, loc);
        const kRef = varRef(`k${j}.0`, STRING, loc);
        const vRef = varRef(`v${j}.0`, s.iv, loc);
        locals.push(
          { id: `ks${j}.0`, name: `ks${j}`, type: ksT, mutable: false },
          { id: `i${j}.0`, name: `i${j}`, type: F64, mutable: true },
          { id: `k${j}.0`, name: `k${j}`, type: STRING, mutable: false },
          { id: `v${j}.0`, name: `v${j}`, type: s.iv, mutable: false },
        );
        // Per-key dispatch: if (k === "a") { write a } else if ... else drop.
        const dispatch = shape.fields.reduceRight<IrStmt[]>((rest, f) => {
          const write = (value: IrExpr): IrStmt => ({ kind: "recordSet", obj: outRef, shapeId: type.shapeId, field: f.name, value, loc });
          const c = conv(s.iv, f, vRef);
          const thenBody = "value" in c ? [write(c.value)] : c.stmts(write);
          return [{
            kind: "if",
            cond: { kind: "strEq", negated: false, left: kRef, right: { kind: "strLit", value: f.name, type: STRING, loc }, type: BOOL, loc },
            then: thenBody,
            else_: rest.length > 0 ? rest : null,
            loc,
          }];
        }, []);
        body.push(
          { kind: "varDecl", localId: `ks${j}.0`, init: { kind: "recordOvfKeys", obj: sRef, shapeId: s.shapeId, type: ksT, loc }, loc },
          {
            kind: "for",
            init: { kind: "varDecl", localId: `i${j}.0`, init: numLit(0, loc), loc },
            cond: { kind: "bin", op: "<", left: varRef(`i${j}.0`, F64, loc), right: { kind: "arrIntrinsic", method: "length", receiver: varRef(`ks${j}.0`, ksT, loc), args: [], type: F64, loc }, type: BOOL, loc },
            update: { kind: "assign", localId: `i${j}.0`, value: { kind: "bin", op: "+", left: varRef(`i${j}.0`, F64, loc), right: numLit(1, loc), type: F64, loc }, loc },
            body: [
              { kind: "varDecl", localId: `k${j}.0`, init: { kind: "arrayGet", arr: varRef(`ks${j}.0`, ksT, loc), index: varRef(`i${j}.0`, F64, loc), type: STRING, loc }, loc },
              { kind: "varDecl", localId: `v${j}.0`, init: { kind: "recordKeyGet", obj: sRef, shapeId: s.shapeId, key: kRef, overflowOnly: true, type: s.iv, loc }, loc },
              ...dispatch,
            ],
            loc,
          },
        );
      });
      body.push({ kind: "return", value: outRef, loc });
      lowerer.liftedFns.push({
        name: helper,
        params,
        returnType: type,
        locals,
        body,
        loc,
      });
      // Registered only after a fence-free build: a conv() fence mid-build
      // must not leave a phantom helper behind for the next literal.
      lowerer.widthHelpers.set(key, helper);
    }
    return { kind: "call", callee: helper, args: srcs.map((s) => s.value), type, loc };
  }
