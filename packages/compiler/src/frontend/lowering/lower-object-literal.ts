/* Object-literal lowering (static builds): `{ a: 1, ...spread, [KEY]: v, m() {} }` → recordLit. The record type comes
 * from the contextual type or the literal own type; spreads merge by declared shape, by union arm, or through the
 * index-signature helpers; accessors fill the shape %get:/%set: slots; methods and properties lower in source order.
 * The dynamic (JS) and island object literals stay in lower-exprs.ts and lower-island.ts. */
import { InternalCompilerError } from "../../errors.js";
import * as ts from "../ts7/adapter.js";
import type { Lowerer } from "./lowerer.js";
import {
  BOOL,
  DYN,
  IrExpr,
  IrLocal,
  IrStmt,
  IrType,
  STRING,
  UNDEFINED_T,
  canDynCheckTo,
  isUnitType,
  typeEquals,
} from "../../ir/ir.js";
import { isCjsExportTableLiteral, isJsSourceFile, locOf } from "../program.js";
import { NARROW_FIRST } from "./surfaces.js";
import { recordShapeMismatchDiag } from "../../diagnostics/diagnostic.js";
import { PoisonError, dynUndefinedExpr } from "./lowerer.js";
import { familyFnOfValue, lowerFamilyImpl } from "./lower-families.js";
import { isGenericCallableMemberType } from "../type-mapper.js";
import { varRef } from "../../ir/build.js";
import { probeLower } from "./lower-probe.js";
import {
  conditionalSpreadOf,
  droppableStatic,
  fenceClosureProbe,
  literalComputedKey,
  lowerDynObjectLiteral,
  methodUsesThis,
  pureCondExpr,
  pureReemittable,
} from "./lower-exprs.js";
import { objectLiteralRecordType } from "./lower-object-literal-type.js";
import {
  fenceAccessorSpreadSource,
  isRuntimeComputedKey,
  lowerDeclaredShapeSpreadMerge,
  lowerIndexSignatureSpreadMerge,
  lowerRecordUpdateSpread,
} from "./lower-object-spread.js";
import { propNameText } from "./lower-exprs.js";

  /** The dropped-field names of the PromiseSettledResult honest subset
   * (SEMANTICS.md 46): when the literal's target type is (a union
   * containing) the lib's PromiseFulfilledResult / PromiseRejectedResult,
   * the record mapping kept only `status` — `value` and `reason` evaluate
   * for effect and are not stored. Null for every other target. */
  function settledDropNames(lowerer: Lowerer, tsType: ts.Type): Set<string> | null {
    let names: Set<string> | null = null;
    const parts: readonly ts.Type[] = tsType.isUnionType() ? ts.constituentTypes(tsType) : [tsType];
    for (const part of parts) {
      const sym = part.getSymbol();
      if (
        !sym ||
        !lowerer.checker.declarationsOf(sym).some(
          (d) => ts.isInterfaceDeclaration(d) && lowerer.isStdlibFile(d.getSourceFile()),
        )
      ) {
        continue;
      }
      if (sym.name === "PromiseFulfilledResult") (names ??= new Set()).add("value");
      if (sym.name === "PromiseRejectedResult") (names ??= new Set()).add("reason");
    }
    return names;
  }

/** `{ a: 1, b: "x" }` → recordLit. The record type comes from the
   * contextual type when tsc has one (annotated declarations, arguments,
   * nested literals) and from the literal's own type otherwise — both intern
   * to the same shapeId unless width subtyping is in play (an `as` cast can
   * smuggle a wider/narrower literal past tsc's freshness check), which the
   * exact-shape checks below reject with SC2002. Fields lower IN SOURCE
   * ORDER: JS evaluates property values in source order. */
/** A slot whose value can only be a closure family: the family type itself, or a union carrying one family arm
 * (`transformRows: (<A>(rows) => …) | undefined`). lowerExprExpecting joins the family and wraps at the arm's tag. */
function familyArmedUnion(lowerer: Lowerer, type: IrType | undefined): boolean {
  return type?.kind === "union" && (lowerer.unions.get(type.unionId)?.arms.some((arm) => arm.kind === "genericFunc") ?? false);
}

export function lowerObjectLiteral(lowerer: Lowerer, expr: ts.ObjectLiteralExpression): IrExpr {
    const loc = locOf(expr);
    // The RUNTIME-KEYED literal (JS): a computed key that doesn't fold to a
    // compile-time string means the literal's shape is not a compile-time
    // fact — no record shape can hold it. The whole literal builds as a dyn
    // object instead (`{ [field]: criteria, actual: 0, ... }` —
    // test/common's _mustCallInner context), where keys are runtime string
    // values. TypeScript keeps the record world and its fence: this shape
    // only arises in checked-dynamic JS.
    if (
      isJsSourceFile(expr.getSourceFile()) &&
      expr.properties.some(
        (p) => {
          const n = ts.isSpreadAssignment(p) ? undefined : p.name;
          return n !== undefined && ts.isComputedPropertyName(n) && literalComputedKey(lowerer, n) === null;
        },
      )
    ) {
      return lowerDynObjectLiteral(lowerer, expr);
    }
    // Fence unsupported syntax before reporting a less specific type failure.
    for (const prop of expr.properties) {
      if (ts.isSpreadAssignment(prop)) {
        // Supported shapes: FULL spreads of known record shapes read as
        // identifiers or other side-effect-free reads, all BEFORE any
        // explicit property (the field-copy desugar reads spread fields
        // first, exactly JS's eager copy order); and CONDITIONAL spreads
        // `...(c ? {k: v} : {})` — the optional-field idiom tsc types as
        // `k?: ...` — which desugar to one conditional field at the
        // spread's own position (any position: they introduce one fresh
        // name, collision-fenced below). Everything else stays fenced.
        const cs = conditionalSpreadOf(prop.expression);
        if (cs === "unsupported" || (cs && cs.props.length !== 1)) {
          lowerer.unsupported(
            "SC1090",
            prop,
            "conditional spreads beyond `...(c ? { field: v } : {})` (exactly one property against an empty arm — spell other shapes as optional fields)",
          );
        }
        // Spread ORDER is fenced in the field-by-field desugar below, not
        // here: the index-signature merge path supports any order (keyed
        // last-write-wins writes), so `{ K: v, ...extra }` into a pure
        // Record shape compiles — the buildServiceEnv pattern.
        continue;
      }
      if (ts.isGetAccessorDeclaration(prop) || ts.isSetAccessorDeclaration(prop)) {
        // JavaScript CJS-export tables reach reads through the lifted-
        // accessor path (cjsExportAccessorRead) — the literal VALUE
        // narrows to its plain fields below (accessor names are not
        // record storage; SEMANTICS.md documents the enumeration
        // divergence). TypeScript accessors lower into the shape's
        // reserved closure slots (%get:/%set: — see accessorSlotProp);
        // `this` in the body is fenced up front: the closure slot has no
        // receiver (capturing the record under construction would be an
        // RC cycle), and the generic lexical-this walk would silently
        // capture an ENCLOSING method's `this` — the object-method rule.
        if (!isJsSourceFile(expr.getSourceFile())) {
          rejectThisInObjectAccessor(lowerer, prop.body ?? prop);
        }
      }
      // Unfoldable computed keys are NOT fenced here: an index-signature
      // target lowers them as runtime keyed writes (the merge path below);
      // every other target re-fences them after the merge path declined
      // (fenceUnfoldableComputedKeys).
      // Identifier keys, STRING-LITERAL keys (`"content-type": v` —
      // record field names are data, never C identifiers; the mangler
      // encodes what C can't spell), NUMERIC-LITERAL keys in their
      // canonical string spelling (`{ 0: v }` stores "0", `{ 0x10: v }`
      // stores "16" — JS's ToPropertyKey; the checker names the property
      // symbol the same way), and FOLDABLE computed keys (above).
      if (
        !prop.name ||
        !(
          ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name) ||
          ts.isNumericLiteral(prop.name) || ts.isComputedPropertyName(prop.name)
        )
      ) {
        lowerer.unsupported("SC1090", prop, "non-identifier property names");
      }
      // Shorthand methods are closure-valued fields. Their `this` is the
      // literal itself, bound below through a hidden %self local the methods
      // capture (JS binds it at the CALL, so fieldGetExpr refuses reading
      // such a method as a value). A JS literal keeps the old refusal: there
      // `this` already lowers to the ambient receiver (libCall dyn.this).
      if (ts.isMethodDeclaration(prop) && isJsSourceFile(expr.getSourceFile())) {
        lowerer.rejectThisInObjectMethod(prop.body ?? prop);
      }
    }
    // The methods whose bodies name `this`: only these need the receiver.
    const thisMethods = new Set(
      expr.properties.filter((prop): prop is ts.MethodDeclaration =>
        ts.isMethodDeclaration(prop) && prop.body !== undefined && methodUsesThis(prop.body)),
    );

    const selected = objectLiteralRecordType(lowerer, expr, loc);
    if ("lowered" in selected) return selected.lowered;
    const { tsType, mapped } = selected;
    // The CJS EXPORT-TABLE literal in VALUE position (JS): importers reach
    // every member through alias plumbing and accessor lifts — the record
    // VALUE exists for the module's own reads (Object.keys, internal
    // member reads), so it keeps exactly the plain fields whose values
    // lower; accessor entries and members with no value representation
    // (rest-param function types) narrow away. SEMANTICS.md documents the
    // enumeration divergence.
    if (
      isJsSourceFile(expr.getSourceFile()) &&
      (!mapped || expr.properties.some((p) => ts.isGetAccessorDeclaration(p) || ts.isSetAccessorDeclaration(p))) &&
      isCjsExportTableLiteral(expr)
    ) {
      const fields: { name: string; value: IrExpr }[] = [];
      for (const prop of expr.properties) {
        if (ts.isGetAccessorDeclaration(prop) || ts.isSetAccessorDeclaration(prop)) continue;
        const propName = ts.isSpreadAssignment(prop) ? undefined : prop.name;
        if (!propName || !(ts.isIdentifier(propName) || ts.isStringLiteral(propName))) continue;
        const name = propName.text;
        let v: IrExpr | null = null;
        if (ts.isShorthandPropertyAssignment(prop)) {
          v = probeLower(lowerer, propName as ts.Identifier);
        } else if (ts.isPropertyAssignment(prop)) {
          v = probeLower(lowerer, prop.initializer);
        }
        if (!v || v.type.kind === "void" || v.type.kind === "caught" || v.type.kind === "jsval") continue;
        if (isUnitType(v.type)) continue;
        fields.push({ name, value: v });
      }
      // Canonical (sorted) field order — the shape registry's invariant;
      // the dropped reads are all pure, so reordering loses nothing.
      fields.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      const shapeId = lowerer.shapes.intern(fields.map((f) => ({ name: f.name, type: f.value.type })));
      return { kind: "recordLit", fields, type: { kind: "record", shapeId }, loc };
    }
    // The JS declaration fallback, literal-side (the checked-dynamic tree-array rule's
    // object form): a literal whose shape has no static home — an
    // unmappable contextual type over unmappable own fields (the
    // PropertyDescriptorMap argument of Object.defineProperties, nested
    // descriptor records with `any` values) — builds as a dyn OBJECT:
    // each field converts through the usual dyn boundary, and dynamic
    // consumers ride the keyed-dyn paths. TypeScript keeps the fence.
    if ((!mapped || mapped.kind === "dyn") && isJsSourceFile(expr.getSourceFile())) {
      return lowerDynObjectLiteral(lowerer, expr);
    }
    if (!mapped || mapped.kind !== "record") lowerer.badType(expr, tsType);
    let type: IrType = mapped;
    let shape = lowerer.shapes.get(type.shapeId)!;
    // The receiver for `this` methods, declared on first use: a mutable local the methods capture BEFORE the record
    // exists (varDecl with no init, assigned once the fields are lowered — the forward-capture shape corpus 605 pins).
    const selfSlot: { local: IrLocal | null } = { local: null };
    const selfLocal = (): IrLocal => (selfSlot.local ??= lowerer.env.declare(undefined, "%self", type, true));
    // ACCESSOR properties, JS literals only (TS accessors fill the shape's
    // %get:/%set: closure slots below): no record storage exists for them,
    // so the literal's shape NARROWS to its plain fields (reads resolve
    // through the lifted accessors; Object.keys over the value omits
    // accessor names — the documented divergence).
    if (isJsSourceFile(expr.getSourceFile())) {
      const accessorNames = new Set(
        expr.properties
          .filter((p) => ts.isGetAccessorDeclaration(p) || ts.isSetAccessorDeclaration(p))
          .map((p) => (p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? p.name.text : ""))
          .filter((n) => n !== ""),
      );
      if (accessorNames.size > 0) {
        const narrowed = shape.fields.filter((f) => !accessorNames.has(f.name));
        const narrowedId = lowerer.shapes.intern(
          narrowed.map((f) => ({ name: f.name, type: f.type })),
          false,
          shape.indexValue,
        );
        type = { kind: "record", shapeId: narrowedId };
        shape = lowerer.shapes.get(narrowedId)!;
      }
    }
    const fieldTypes = new Map(shape.fields.map((f) => [f.name, f.type]));
    // File-scope JavaScript object bindings live in the checked-dynamic tree
    // to preserve open writes and identity. Build an optional-field literal
    // from its actually written keys so Object.hasOwn can distinguish an
    // omitted property from a present property whose value is undefined.
    const topLevelJsDecl = ts.isVariableDeclaration(expr.parent) &&
      expr.parent.initializer === expr &&
      ts.isVariableStatement(expr.parent.parent.parent) &&
      ts.isSourceFile(expr.parent.parent.parent.parent);
    const assignedProperties = expr.properties.filter(
      (prop): prop is ts.PropertyAssignment | ts.ShorthandPropertyAssignment =>
        ts.isPropertyAssignment(prop) || ts.isShorthandPropertyAssignment(prop),
    );
    if (
      topLevelJsDecl && isJsSourceFile(expr.getSourceFile()) &&
      assignedProperties.length === expr.properties.length
    ) {
      const provided = new Set(assignedProperties.map((prop) => propNameText(lowerer, prop.name)));
      const omittedOptional = shape.fields.some((field) =>
        !provided.has(field.name) && field.type.kind === "union" &&
        lowerer.armTag(field.type.unionId, UNDEFINED_T) >= 0);
      if (omittedOptional) return lowerDynObjectLiteral(lowerer, expr);
    }
    // The clone probe may lower the leading spread before declining (a
    // static `as` cast can make the checker-visible shape match while its
    // erased IR value keeps a wider shape). Reuse that exact value in the
    // ordinary spread path so lowering still happens once.
    let leadingSpreadLowered: IrExpr | null = null;
    // A computed spread (`...(clientOptions() ?? {})`) must evaluate once
    // while the field-by-field desugar needs several reads. A FIRST spread
    // can bind around the whole literal. A later optional-record spread may
    // use the same outer binding when everything before it is static: moving
    // the source over an unobservable prefix preserves source-order effects.
    let computedLeadingSpread: { local: IrLocal; init: IrExpr } | null = null;
    let computedInlineSpread: { prop: ts.SpreadAssignment; local: IrLocal; init: IrExpr } | null = null;
    const stableSpreadSource = (
      prop: ts.SpreadAssignment,
      value: IrExpr,
      allowInline = false,
    ): IrExpr => {
      if (pureReemittable(value)) return value;
      const local = lowerer.declareHiddenLocal("%spread", value.type);
      if (prop === expr.properties[0] && computedLeadingSpread === null) {
        computedLeadingSpread = { local, init: value };
        return varRef(local.id, local.type, locOf(prop));
      }
      if (
        !allowInline ||
        computedLeadingSpread !== null ||
        computedInlineSpread !== null ||
        !fields.every(
          (field) =>
            field.drop ||
            droppableStatic(field.value) ||
            (field.value.kind === "ternary" &&
              pureCondExpr(field.value.cond) &&
              droppableStatic(field.value.then) &&
              droppableStatic(field.value.else_)),
        )
      ) {
        lowerer.unsupported(
          "SC1090",
          prop,
          "object spread of computed sources after effectful members (bind the source to a const before the object literal)",
        );
      }
      computedInlineSpread = { prop, local, init: value };
      return varRef(local.id, local.type, locOf(prop));
    };

    const update = lowerRecordUpdateSpread(lowerer, expr, type, shape, fieldTypes, loc);
    if ("clone" in update) return update.clone;
    leadingSpreadLowered = update.leadingSpread;

    const merged = lowerIndexSignatureSpreadMerge(lowerer, expr, type, shape, loc);
    if (merged) return merged;
    // Unfoldable computed keys outside the index-signature merge path:
    // no record shape can hold a runtime-decided name.
    for (const prop of expr.properties) {
      if (isRuntimeComputedKey(lowerer, prop)) {
        lowerer.unsupported("SC1090", (prop as ts.PropertyAssignment).name, "computed property keys (compile-time-known keys fold — a pure expression whose checker type is one string or number literal: consts, enum members, quoted keys, templates of those — `{ [MARKER]: v }`; runtime string keys write through an index-signature target; symbol keys stay out)");
      }
    }

    const declaredMerge = lowerDeclaredShapeSpreadMerge(lowerer, expr, type, shape, loc);
    if (declaredMerge) return declaredMerge;

    const shapeMismatch = (node: ts.Node): never => {
      const own = lowerer.mapTypeOf(lowerer.typeOf(expr));
      lowerer.pushDiag(
        recordShapeMismatchDiag(
          lowerer.fmt(type),
          own ? lowerer.fmt(own) : lowerer.checker.typeToString(lowerer.typeOf(expr)),
          locOf(node),
          own?.kind === "record" && type.kind === "record"
            ? (lowerer.describeRecordWidthBlocker(own.shapeId, type.shapeId) ?? undefined)
            : undefined,
        ),
      );
      throw new PoisonError();
    };

    const fields: { name: string; value: IrExpr; overflow?: true; drop?: true; absent?: true }[] = [];
    const hasInlineSpread = (prop: ts.SpreadAssignment): boolean =>
      computedInlineSpread !== null && computedInlineSpread.prop === prop;
    const selectedComputedSpread = (): { local: IrLocal; init: IrExpr } | null =>
      computedLeadingSpread ?? computedInlineSpread;
    // Field names introduced by conditional spreads: their ternary carries
    // the spread's whole evaluation (cond once, value lazily), so a LATER
    // contributor overriding one would silently drop that evaluation —
    // collisions fence in both directions.
    const conditionalNames = new Set<string>();
    // Member names DROPPED from the shape (JS deferral — unlowerable pure
    // member reads narrow away; see the catch in the property loop).
    const droppedNames = new Set<string>();
    for (const prop of expr.properties) {
      if (ts.isSpreadAssignment(prop)) {
        const cs = conditionalSpreadOf(prop.expression);
        if (cs && cs !== "unsupported") {
          // `...(c ? { k: v } : {})` — ONE conditional field at the
          // spread's own position: cond evaluates exactly once, `v` only
          // when the non-empty arm is taken (ternary arms are lazy), and
          // the empty arm holds the interned undefined arm — exactly the
          // omitted-optional-field representation, which is also why the
          // target field must be optional (tsc types the idiom that way).
          const csProp = cs.props[0]!; // single-prop-checked in the fence pass
          const name = csProp.name.text;
          const fieldType = fieldTypes.get(name);
          if (!fieldType) {
            if (shape.indexValue) {
              lowerer.unsupported(
                "SC1090",
                prop,
                "conditional spreads into index-signature keys (overflow entries model presence — write the key in an if statement instead)",
              );
            }
            throw shapeMismatch(prop);
          }
          const absent = lowerer.wrappedUndefined(fieldType, locOf(prop));
          if (!absent) {
            lowerer.unsupported(
              "SC1090",
              prop,
              `conditional spreads onto the required field '${name}' (the empty arm leaves it undefined — declare the field optional)`,
            );
          }
          // A conditional contributor overrides the earlier value only in
          // its non-empty arm. Move the merged entry to this spread's
          // position so the condition/value retain source order; the empty
          // arm preserves the earlier spread-copied value.
          const earlier = fields.findIndex((f) => f.name === name && !f.drop);
          const emptyValue = earlier >= 0 ? fields[earlier]!.value : absent;
          if (earlier >= 0) fields.splice(earlier, 1);
          const cond = lowerer.lowerCondition(cs.cond);
          const valueNode = ts.isPropertyAssignment(csProp) ? csProp.initializer : csProp;
          let v = ts.isPropertyAssignment(csProp)
            ? lowerer.lowerExpr(csProp.initializer)
            : lowerer.lowerShorthandValue(csProp);
          v = lowerer.coerceInto(valueNode, v, fieldType);
          if (!typeEquals(v.type, fieldType)) lowerer.badType(valueNode, lowerer.typeOf(valueNode));
          conditionalNames.add(name);
          fields.push({
            name,
            value: {
              kind: "ternary",
              cond,
              then: cs.whenTrue ? v : emptyValue,
              else_: cs.whenTrue ? emptyValue : v,
              type: fieldType,
              loc: locOf(prop),
            },
          });
          continue;
        }
        // `{ ...base, ... }` — field-by-field copy of a known record
        // shape. Every source field must land on the target shape with an
        // equal type (a wider source would silently DROP fields JS keeps —
        // the width fence, same as literals). Later contributors override
        // earlier ones (JS last-write-wins; the reads are side-effect-free,
        // so dropping the earlier read is exact). Identifier sources
        // re-read per field (historic path); any OTHER source must be a
        // re-emittable pure read, sharing one lowered node per field.
        // The desugar's one-entry-per-name list reads spread fields
        // EAGERLY at the spread's position, so an explicit property
        // BEFORE a spread would need JS's overwrite — order-fenced (the
        // index-signature merge path above takes any order).
        if (
          expr.properties
            .slice(0, expr.properties.indexOf(prop))
            .some((p) => !ts.isSpreadAssignment(p))
        ) {
          lowerer.unsupported(
            "SC1090",
            prop,
            "object spread after explicit properties (spreads must come first — a later spread would overwrite them with JS semantics the desugar does not model)",
          );
        }
        let srcNode: ts.Expression = prop.expression;
        while (ts.isParenthesizedExpression(srcNode)) srcNode = srcNode.expression;
        let srcLowered =
          prop === expr.properties[0] && leadingSpreadLowered !== null
            ? leadingSpreadLowered
            : ts.isIdentifier(srcNode)
              ? null
              : lowerer.lowerExpr(srcNode);
        let srcType = srcLowered ? srcLowered.type : lowerer.mapTypeOf(lowerer.typeOf(srcNode));
        // A package-exported defaults record lowers as an island handle
        // even though its declaration still gives tsc a precise object
        // type. When that declared type is assignable to the target record,
        // validate the handle into the target once and reuse the ordinary
        // field-copy spread path. Exclude genuine `any`: it carries no
        // proof that required target fields exist before later overrides.
        const srcTsType = lowerer.typeOf(srcNode);
        const srcProps = new Map(
          lowerer.checker.getPropertiesOfType(srcTsType).map((field) => [field.name, field]),
        );
        const declaredCoversTarget = shape.fields.every((targetField) => {
          const sourceField = srcProps.get(targetField.name);
          if (!sourceField) {
            return targetField.type.kind === "union" &&
              lowerer.armTag(targetField.type.unionId, UNDEFINED_T) >= 0;
          }
          const sourceTs = lowerer.checker.getTypeOfSymbolAtLocation(sourceField, srcNode);
          const sourceType = lowerer.mapTypeOf(sourceTs);
          return sourceType !== null &&
            (typeEquals(sourceType, targetField.type) || lowerer.coercibleValue(sourceType, targetField.type));
        });
        if (
          srcType?.kind === "jsval" &&
          (srcTsType.flags & ts.TypeFlags.Any) === 0 &&
          declaredCoversTarget &&
          lowerer.boundaryExitSafe(type)
        ) {
          const island = srcLowered ?? lowerer.lowerExpr(srcNode);
          const checked = lowerer.coerceToExpected(island, type);
          if (checked.type.kind === "record") {
            srcLowered = checked;
            srcType = checked.type;
          }
        }
        // `...options.installConfig` — a spread of `Partial<X> | undefined`
        // (the optional-options merge idiom `{ ...DEFAULTS, ...overrides }`):
        // JS spreads nothing for the unit arm and copies present keys
        // otherwise. Per target field the desugar builds
        // `present ? extracted : earlier` — present tests the source's
        // record tag AND (optional source fields) the field's own value
        // arm; absent keeps the earlier contributor's value (both reads
        // are pure, so the reorder into the ternary is unobservable).
        if (srcType?.kind === "union") {
          const def = lowerer.unions.get(srcType.unionId);
          const recArms = def?.arms.filter((a) => a.kind === "record") ?? [];
          if (
            !def ||
            recArms.length !== 1 ||
            !def.arms.every((a) => a.kind === "record" || isUnitType(a))
          ) {
            lowerer.unsupported(
              "SC1090",
              prop,
              `object spread of '${lowerer.fmt(srcType)}' sources (only known record shapes spread — ${NARROW_FIRST})`,
            );
          }
          const stableSrc = srcLowered ? stableSpreadSource(prop, srcLowered, true) : null;
          const inlineComputed = hasInlineSpread(prop);
          const recArm = recArms[0]! as IrType & { kind: "record" };
          const recTag = def.arms.indexOf(recArm);
          // A checked-dynamic VALUE under the union-mapped checker type
          // (a JS dyn-holding binding): the present/absent desugar tests
          // union tags a dyn box does not carry — fence honestly instead
          // of the validator's ICE.
          const probedSrc = stableSrc ?? probeLower(lowerer, srcNode);
          if (probedSrc?.type.kind === "dyn") {
            lowerer.unsupported(
              "SC1090",
              prop,
              `object spread of a checked-dynamic '${lowerer.fmt(srcType)}' source (${NARROW_FIRST})`,
            );
          }
          const srcShape = lowerer.shapes.get(recArm.shapeId);
          if (!srcShape) throw new InternalCompilerError(`lowerer bug: spread of unknown shape ${recArm.shapeId}`);
          fenceAccessorSpreadSource(lowerer, prop, srcShape);
          if (srcShape.indexValue || shape.indexValue) {
            lowerer.unsupported(
              "SC1090",
              prop,
              "object spread involving index-signature shapes (overflow keys are runtime state — copy the fields you need explicitly)",
            );
          }
          const laterNames = new Set<string>();
          for (const later of expr.properties.slice(expr.properties.indexOf(prop) + 1)) {
            if (ts.isSpreadAssignment(later)) {
              if (conditionalSpreadOf(later.expression)) continue;
              const lt = lowerer.mapTypeOf(lowerer.typeOf(later.expression));
              if (lt?.kind === "record") {
                for (const lf of lowerer.shapes.get(lt.shapeId)?.fields ?? []) laterNames.add(lf.name);
              }
              continue;
            }
            if (
              later.name &&
              (ts.isIdentifier(later.name) ||
                ts.isStringLiteral(later.name) ||
                ts.isNumericLiteral(later.name) ||
                (ts.isComputedPropertyName(later.name) && literalComputedKey(lowerer, later.name) !== null))
            ) {
              laterNames.add(propNameText(lowerer, later.name));
            }
          }
          const srcRef = (): IrExpr => stableSrc ?? lowerer.lowerExpr(srcNode);
          for (const f of srcShape.fields) {
            if (laterNames.has(f.name)) continue;
            const targetType = fieldTypes.get(f.name);
            // No slot on the target shape: the copy DROPS the field
            // (divergence 36's stance, same as the plain-record spread).
            if (!targetType) continue;
            const at = fields.findIndex((x) => x.name === f.name && !x.drop);
            if (
              conditionalNames.has(f.name) &&
              (!inlineComputed || at < 0 || !droppableStatic(fields[at]!.value))
            ) {
              lowerer.unsupported(
                "SC1090",
                prop,
                `spread of '${f.name}' over an earlier conditional spread (the desugar keeps one entry per name — restructure so each name has one contributor)`,
              );
            }
            const fRead = (): IrExpr => ({
              kind: "recordGet",
              obj: { kind: "unionNarrow", unionId: srcType.unionId, tag: recTag, value: srcRef(), type: recArm, loc: locOf(prop) },
              shapeId: recArm.shapeId,
              field: f.name,
              type: f.type,
              loc: locOf(prop),
            });
            let cond: IrExpr = { kind: "unionIsTag", unionId: srcType.unionId, tag: recTag, negated: false, value: srcRef(), type: BOOL, loc: locOf(prop) };
            let thenVal: IrExpr;
            if (typeEquals(f.type, targetType)) {
              thenVal = fRead();
            } else if (
              f.type.kind === "union" &&
              lowerer.armTag(f.type.unionId, UNDEFINED_T) >= 0 &&
              typeEquals(lowerer.stripUndefinedArm(f.type), targetType)
            ) {
              // Optional source field into a required target slot: present
              // means the source holds the record AND the field its value
              // arm — the spread-override completion, union-source form.
              const ftUndef = lowerer.armTag(f.type.unionId, UNDEFINED_T);
              cond = {
                kind: "logical",
                op: "&&",
                left: cond,
                right: { kind: "unionIsTag", unionId: f.type.unionId, tag: ftUndef, negated: true, value: fRead(), type: BOOL, loc: locOf(prop) },
                type: BOOL,
                loc: locOf(prop),
              };
              const ftDef = lowerer.unions.get(f.type.unionId);
              if (targetType.kind === "union") {
                const retag = lowerer.unionRetagHelper(f.type.unionId, targetType.unionId, locOf(prop));
                if (!retag) {
                  lowerer.pushDiag(recordShapeMismatchDiag(lowerer.fmt(type), lowerer.fmt(recArm), locOf(prop), `spread field '${f.name}': '${lowerer.fmt(f.type)}' cannot re-tag into '${lowerer.fmt(targetType)}' behind the present-test`));
                  throw new PoisonError();
                }
                thenVal = { kind: "call", callee: retag, args: [fRead()], type: targetType, loc: locOf(prop) };
              } else if (ftDef && ftDef.arms.length === 2 && lowerer.armTag(f.type.unionId, targetType) >= 0) {
                thenVal = { kind: "unionNarrow", unionId: f.type.unionId, tag: lowerer.armTag(f.type.unionId, targetType), value: fRead(), type: targetType, loc: locOf(prop) };
              } else {
                lowerer.pushDiag(recordShapeMismatchDiag(lowerer.fmt(type), lowerer.fmt(recArm), locOf(prop), `spread field '${f.name}': '${lowerer.fmt(f.type)}' cannot narrow into '${lowerer.fmt(targetType)}' behind the present-test`));
                throw new PoisonError();
              }
            } else {
              // The width-lift fallback (arm wrap, re-tag, nested
              // reshape) — the same per-field rule the slot coercion
              // applies. Runs AFTER the optional-completion branch: a
              // present-test has its own semantics a re-tag's stranded
              // undefined trap must not shadow.
              const lift = lowerer.widthLiftPlan(f.type, targetType);
              if (!lift) {
                lowerer.pushDiag(recordShapeMismatchDiag(lowerer.fmt(type), lowerer.fmt(recArm), locOf(prop), `spread field '${f.name}': '${lowerer.fmt(f.type)}' does not lift into '${lowerer.fmt(targetType)}'`));
                throw new PoisonError();
              }
              thenVal = lowerer.applyWidthLift(lift, fRead(), targetType, locOf(prop));
            }
            const elseVal = at >= 0 ? fields[at]!.value : lowerer.wrappedUndefined(targetType, locOf(prop));
            if (!elseVal) {
              lowerer.unsupported(
                "SC1090",
                prop,
                `object spread of '${lowerer.fmt(srcType)}' sources where '${f.name}' has no earlier contributor (the absent arm leaves the required field unset — spread defaults first: { ...defaults, ...overrides })`,
              );
            }
            const merged: IrExpr = {
              kind: "ternary",
              cond,
              then: thenVal,
              else_: elseVal,
              type: targetType,
              loc: locOf(prop),
            };
            if (at >= 0 && inlineComputed) {
              fields.splice(at, 1);
              fields.push({ name: f.name, value: merged });
            } else if (at >= 0) {
              fields[at] = { name: f.name, value: merged };
            } else {
              fields.push({ name: f.name, value: merged });
            }
          }
          continue;
        }
        if (srcType?.kind !== "record") {
          lowerer.unsupported(
            "SC1090",
            prop,
            `object spread of '${srcType ? lowerer.fmt(srcType) : lowerer.checker.typeToString(lowerer.typeOf(srcNode))}' sources (only known record shapes spread — ${NARROW_FIRST})`,
          );
        }
        const stableSrc = srcLowered ? stableSpreadSource(prop, srcLowered, true) : null;
        const inlineComputed = hasInlineSpread(prop);
        const srcShape = lowerer.shapes.get(srcType.shapeId);
        if (!srcShape) throw new InternalCompilerError(`lowerer bug: spread of unknown shape ${srcType.shapeId}`);
        fenceAccessorSpreadSource(lowerer, prop, srcShape);
        // Index-signature shapes carry runtime-keyed overflow entries the
        // field-by-field desugar cannot enumerate — fenced on either side.
        if (srcShape.indexValue || shape.indexValue) {
          lowerer.unsupported(
            "SC1090",
            prop,
            "object spread involving index-signature shapes (overflow keys are runtime state — copy the fields you need explicitly)",
          );
        }
        // Names a LATER contributor unconditionally defines: copying such a
        // source field is dead under JS last-write-wins (and spread reads
        // are side-effect-free), so it neither lowers nor width-checks —
        // the spread-then-override completion `{ ...config, stateDir }`
        // narrows an optional source field into a required target slot
        // exactly like Node does. Conditional spreads don't count (their
        // empty arm defines nothing) — their own collision fences hold.
        const laterNames = new Set<string>();
        for (const later of expr.properties.slice(expr.properties.indexOf(prop) + 1)) {
          if (ts.isSpreadAssignment(later)) {
            if (conditionalSpreadOf(later.expression)) continue;
            const lt = lowerer.mapTypeOf(lowerer.typeOf(later.expression));
            if (lt?.kind === "record") {
              for (const lf of lowerer.shapes.get(lt.shapeId)?.fields ?? []) laterNames.add(lf.name);
            }
            continue;
          }
          if (
            later.name &&
            (ts.isIdentifier(later.name) ||
              ts.isStringLiteral(later.name) ||
              ts.isNumericLiteral(later.name) ||
              (ts.isComputedPropertyName(later.name) && literalComputedKey(lowerer, later.name) !== null))
          ) {
            laterNames.add(propNameText(lowerer, later.name));
          }
        }
        for (const f of srcShape.fields) {
          if (laterNames.has(f.name)) continue;
          const targetType = fieldTypes.get(f.name);
          // A source field with NO slot on the target shape: the copy
          // DROPS it — a spread of a wider record into a narrower literal
          // is width subtyping in spread clothing, divergence 36's stance
          // (Node's object would keep the key); the read is pure, so
          // skipping evaluates nothing.
          if (!targetType) continue;
          const lift = typeEquals(f.type, targetType)
            ? null
            : lowerer.widthLiftPlan(f.type, targetType);
          if (!typeEquals(f.type, targetType) && !lift) {
            // Print the SOURCE shape, not the literal's own type: the
            // checker's own type already has later overrides applied, so
            // it can render identically to the target while the spread
            // source (the thing that actually mismatches) differs — an
            // invisible difference is a diagnostics bug.
            lowerer.pushDiag(recordShapeMismatchDiag(lowerer.fmt(type), lowerer.fmt(srcType), locOf(prop), `spread field '${f.name}': '${lowerer.fmt(f.type)}' does not lift into '${lowerer.fmt(targetType)}'`));
            throw new PoisonError();
          }
          const obj = stableSrc ?? lowerer.lowerExpr(srcNode);
          // A record-mapped CHECKER type whose VALUE lives in the checked-dynamic tree (a
          // JS file-scope object-literal global): read each field from
          // the checked-dynamic tree (dynKeyGet) and VALIDATE it into the source shape's
          // field type (dynCheck) — the checked-dynamic member-read
          // discipline. A missing key answers the dyn undefined, exactly
          // the undefined-armed optional's absent case; a mismatched
          // runtime value throws the catchable TypeError, never a silent
          // wrong copy. Runtime-ADDED keys drop — width subtyping in
          // spread clothing, divergence 36's stance.
          let value: IrExpr;
          if (obj.type.kind === "dyn") {
            if (!canDynCheckTo(f.type, (id) => lowerer.shapes.get(id), (id) => lowerer.unions.get(id))) {
              lowerer.unsupported(
                "SC1100",
                prop,
                `object spread of a checked-dynamic source whose field '${f.name}' ('${lowerer.fmt(f.type)}') cannot validate out of the checked-dynamic tree (copy the fields explicitly)`,
              );
            }
            value = {
              kind: "dynCheck",
              value: {
                kind: "dynKeyGet",
                key: { kind: "strLit", value: f.name, type: STRING, loc: locOf(prop) },
                value: obj,
                type: DYN,
                loc: locOf(prop),
              },
              type: f.type,
              loc: locOf(prop),
            };
          } else {
            value = {
              kind: "recordGet",
              obj,
              shapeId: srcType.shapeId,
              field: f.name,
              type: f.type,
              loc: locOf(prop),
            };
          }
          // A liftable field widens into the target slot (arm wrap,
          // re-tag, nested reshape) — the same per-field rule the slot
          // coercion applies.
          if (lift) value = lowerer.applyWidthLift(lift, value, targetType, locOf(prop));
          const at = fields.findIndex((x) => x.name === f.name && !x.drop);
          if (
            conditionalNames.has(f.name) &&
            (!inlineComputed || at < 0 || !droppableStatic(fields[at]!.value))
          ) {
            lowerer.unsupported(
              "SC1090",
              prop,
              `spread of '${f.name}' over an earlier conditional spread (the desugar keeps one entry per name — restructure so each name has one contributor)`,
            );
          }
          if (
            inlineComputed &&
            at >= 0 &&
            f.type.kind === "union" &&
            lowerer.armTag(f.type.unionId, UNDEFINED_T) >= 0 &&
            typeEquals(f.type, targetType)
          ) {
            value = {
              kind: "ternary",
              cond: {
                kind: "unionIsTag",
                unionId: f.type.unionId,
                tag: lowerer.armTag(f.type.unionId, UNDEFINED_T),
                negated: true,
                value,
                type: BOOL,
                loc: locOf(prop),
              },
              then: value,
              else_: fields[at]!.value,
              type: targetType,
              loc: locOf(prop),
            };
          }
          if (at >= 0 && inlineComputed) {
            fields.splice(at, 1);
            fields.push({ name: f.name, value });
          } else if (at >= 0) {
            fields[at] = { name: f.name, value };
          } else {
            fields.push({ name: f.name, value });
          }
        }
        continue;
      }
      if (ts.isGetAccessorDeclaration(prop) || ts.isSetAccessorDeclaration(prop)) {
        // JS accessor entries carry no storage (narrowed away above); TS
        // accessors fill the shape's reserved closure slots — the getter
        // body lowers as an ordinary zero-arg closure invoked per property
        // READ, the setter as a one-arg closure invoked per WRITE
        // (fieldGetExpr/fieldSetStmt dispatch on the slots). Creating the
        // closures is side-effect-free, so their position among the data
        // fields' source-order evaluation is unobservable — exactly JS,
        // where accessor definitions evaluate nothing.
        if (isJsSourceFile(expr.getSourceFile())) continue;
        const name = propNameText(lowerer, prop.name); // key-form-checked above
        const slotName = `${ts.isGetAccessorDeclaration(prop) ? "%get" : "%set"}:${name}`;
        const slotT = fieldTypes.get(slotName);
        if (!slotT || slotT.kind !== "func") {
          // The contextual shape stores a DATA value under this name
          // (`const p: { x: number } = { get x() {...} }` — tsc lets a
          // live accessor satisfy a data member): the slot would freeze
          // one getter answer where Node keeps the accessor live.
          if (fieldTypes.has(name)) {
            lowerer.unsupported(
              "SC1090",
              prop,
              `a get/set accessor satisfying the data property '${name}' of '${lowerer.fmt(type)}' (the record slot stores a plain value — Node would keep the accessor live through this type)`,
            );
          }
          throw shapeMismatch(prop);
        }
        const closure = lowerer.coerceInto(prop, lowerer.lowerLambda(prop), slotT);
        if (!typeEquals(closure.type, slotT)) lowerer.badType(prop, lowerer.typeOf(prop));
        fields.push({ name: slotName, value: closure });
        continue;
      }
      const name = propNameText(lowerer, prop.name!); // key-form-checked above
      let fieldType = fieldTypes.get(name);
      // An undeclared name against an index-signature shape is an OVERFLOW
      // entry (tsc typechecked it against the signature's value type);
      // against a plain shape it is the width mismatch it always was —
      // EXCEPT the PromiseSettledResult honest subset's dropped fields
      // (value/reason — SEMANTICS.md 46): those evaluate for effect in
      // their source-order slot and store nothing.
      // A GENERIC-callable member (a generic method `m<T>(x: T) {...}` or a
      // generic arrow/function-expression property): excluded from the
      // record shape (isGenericCallableMemberType — no single closure slot
      // can hold it), so the literal stores nothing for it. Pure
      // function-creating forms skip outright (creating a closure has no
      // side effects; calls resolve statically against this declaration);
      // a computed initializer would need its evaluation kept — fenced.
      if (!fieldType && !ts.isSpreadAssignment(prop)) {
        const memberSym = prop.name && lowerer.checker.getSymbolAtLocation(prop.name);
        const memberT = memberSym ? lowerer.checker.getTypeOfSymbol(memberSym) : undefined;
        if (memberT && isGenericCallableMemberType(memberT, lowerer.checker)) {
          const pureInit = (() => {
            if (ts.isMethodDeclaration(prop)) return true;
            if (ts.isShorthandPropertyAssignment(prop)) return true; // a pure read
            if (!ts.isPropertyAssignment(prop)) return false;
            let init: ts.Expression = prop.initializer;
            while (ts.isParenthesizedExpression(init)) init = init.expression;
            return ts.isArrowFunction(init) || ts.isFunctionExpression(init) || ts.isIdentifier(init);
          })();
          if (!pureInit) {
            lowerer.unsupported(
              "SC1090",
              prop,
              `generic-function-valued properties with computed initializers ('${name}' has no record slot — its evaluation would be dropped; bind the function to a top-level declaration instead)`,
            );
          }
          continue;
        }
      }
      if (!fieldType && !shape.indexValue) {
        if (settledDropNames(lowerer, tsType)?.has(name)) {
          // Identifier and shorthand initializers are effect-free reads —
          // skipped outright. The caught `reason` MUST skip: lowering the
          // read would hit the catch-binding narrowness fence, and the
          // snapshot it names needs no evaluation.
          if (ts.isPropertyAssignment(prop) && !ts.isIdentifier(prop.initializer)) {
            const v = lowerer.lowerExpr(prop.initializer);
            // Effect-free lowerings (literals, plain reads) drop at
            // compile time; anything else — the awaited mapper — runs
            // (and may throw into the enclosing catch) with its result
            // released by the statement frame.
            if (
              v.kind !== "unitLit" && v.kind !== "numLit" && v.kind !== "strLit" &&
              v.kind !== "boolLit" && v.kind !== "varRef" && v.kind !== "closure"
            ) {
              fields.push({ name, value: v, drop: true });
            }
          }
          continue;
        }
        throw shapeMismatch(prop);
      }

      let value: IrExpr;
      let valueNode: ts.Node = prop;
      const propDiagsBefore = lowerer.diags.length;
      try {
      if (ts.isPropertyAssignment(prop)) {
        valueNode = prop.initializer;
        // ARRAY-LITERAL initializers route through the expected-type
        // lowering: a union field with one array-family arm builds the
        // literal AS that arm (lowerExprExpecting's IR-directed rule —
        // the option-table `default: [{ value: [] }]` shape), where the
        // bare lowering would take the JS dyn fallback and fence.
        let init: ts.Expression = prop.initializer;
        while (ts.isParenthesizedExpression(init)) init = init.expression;
        value =
          fenceClosureProbe(lowerer, prop.initializer, fieldType, () => lowerer.lowerExpr(prop.initializer)) ??
          (fieldType !== undefined && (ts.isArrayLiteralExpression(init) || fieldType.kind === "genericFunc" || familyArmedUnion(lowerer, fieldType)) // a family slot — bare or behind a union — takes the value as an implementation
            ? lowerer.lowerExprExpecting(prop.initializer, fieldType)
            : lowerer.lowerExpr(prop.initializer));
      } else if (ts.isShorthandPropertyAssignment(prop)) {
        value = fieldType?.kind === "genericFunc" && familyFnOfValue(lowerer, prop.name as ts.Identifier) !== null ? lowerFamilyImpl(lowerer, familyFnOfValue(lowerer, prop.name as ts.Identifier)!, fieldType.familyId) : lowerer.lowerShorthandValue(prop);
      } else if (ts.isMethodDeclaration(prop)) {
        // A method naming `this` lowers with the literal's own %self local as its receiver: the closure captures that
        // box (the ordinary capture machinery, boxing it at the origin), and the record fills it right after.
        const lowerMethod = (): IrExpr =>
          fieldType?.kind === "genericFunc" ? lowerFamilyImpl(lowerer, prop, fieldType.familyId) // a generic method filling a family slot
            : fenceClosureProbe(lowerer, prop, fieldType, () => lowerer.lowerLambda(prop)) ?? lowerer.lowerLambda(prop);
        if (thisMethods.has(prop)) {
          lowerer.literalThisMethods.add(`${type.kind === "record" ? type.shapeId : ""}:${name}`);
          value = lowerer.env.withThis(selfLocal(), lowerMethod);
        } else {
          value = lowerMethod();
        }
      } else {
        lowerer.unsupported("SC1090", prop, `syntax '${ts.SyntaxKind[(prop as ts.Node).kind]}'`);
      }
      } catch (err) {
        // A member VALUE a JS file cannot lower (a namespace object in an
        // export aggregate — the sharedWithCli `errors` member): the
        // member NARROWS AWAY like a CJS export-table accessor entry —
        // the diagnostics defer to the runtime-fence ledger, the shape
        // drops the field, and each READ of it meets its own per-site
        // fence. Pure member forms only (identifier/shorthand reads);
        // TypeScript, probe mode, and ICEs keep the poison.
        const pureMember =
          ts.isShorthandPropertyAssignment(prop) ||
          (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.initializer));
        if (
          !(err instanceof PoisonError) ||
          !pureMember ||
          !isJsSourceFile(expr.getSourceFile()) ||
          lowerer.diagSink !== null ||
          lowerer.diags.length <= propDiagsBefore ||
          lowerer.diags.slice(propDiagsBefore).some((d) => d.code === "SC9001")
        ) {
          throw err;
        }
        lowerer.runtimeFences.push(...lowerer.diags.splice(propDiagsBefore));
        droppedNames.add(name);
        continue;
      }
      if (!fieldType) {
        // Overflow entry: the value flows into the index signature's value
        // slot — dyn slots take a dyn conversion (dynFrom), typed slots the
        // ordinary coercion path. Later duplicates override (map semantics
        // are last-write-wins already; a duplicate literal key is a tsc
        // error anyway).
        const slotted = lowerer.intoIndexValueSlot(value, shape.indexValue!, valueNode);
        fields.push({ name, value: slotted, overflow: true });
        continue;
      }
      const promotedField = fieldType ? lowerer.runtimeOptionalWidening(value.type, fieldType) : null;
      if (promotedField && fieldType) {
        type = lowerer.runtimeOptionalRecordField(type, name, promotedField);
        if (type.kind === "record") shape = lowerer.shapes.get(type.shapeId)!;
        fieldTypes.set(name, promotedField);
        fieldType = promotedField;
      }
      value = lowerer.coerceInto(valueNode, value, fieldType); // union-typed fields wrap arm values
      if (!typeEquals(value.type, fieldType)) lowerer.badType(valueNode, lowerer.typeOf(valueNode));
      // An explicit property overrides a spread-copied field: JS
      // last-write-wins. The entry moves to the END so explicit property
      // values keep their source-order evaluation among themselves. A
      // conditional-spread entry cannot be overridden (its ternary IS the
      // spread's evaluation; splicing it out would drop that).
      if (conditionalNames.has(name)) {
        lowerer.unsupported(
          "SC1090",
          prop,
          `'${name}' after a conditional spread of the same name (the desugar keeps one entry per name — restructure so each name has one contributor)`,
        );
      }
      const at = fields.findIndex((x) => x.name === name);
      if (at >= 0) fields.splice(at, 1);
      fields.push({ name, value });
    }
    // Optional fields (undefined-armed union slots) may be omitted: the
    // absent field holds the interned undefined arm, exactly like writing
    // `a: undefined` (without exactOptionalPropertyTypes tsc treats the two
    // the same, and only optional fields may be omitted — tsc rejects
    // omission of required fields before lowering, undefined-armed or not).
    // A REQUIRED missing field keeps the shape-mismatch rejection (possible
    // through `as`: the cast smuggles a narrower literal past freshness).
    if (droppedNames.size > 0) {
      const narrowed = shape.fields.filter((f) => !droppedNames.has(f.name));
      const narrowedId = lowerer.shapes.intern(
        narrowed.map((f) => ({ name: f.name, type: f.type })),
        false,
        shape.indexValue,
      );
      type = { kind: "record", shapeId: narrowedId };
      shape = lowerer.shapes.get(narrowedId)!;
    }
    if (fields.filter((f) => !f.overflow).length !== shape.fields.length) {
      const provided = new Set(fields.filter((f) => !f.overflow).map((f) => f.name));
      for (const f of shape.fields) {
        if (provided.has(f.name)) continue;
        // 'unknown' fields complete with the dyn undefined — the absent
        // property reads as undefined in Node, and a dyn slot holds
        // exactly that (the options-record call shape against
        // `{ plugins: unknown, ... }` — a JS caller the checker admits).
        const absent = lowerer.wrappedUndefined(f.type, loc) ?? (f.type.kind === "dyn" ? dynUndefinedExpr(loc) : null);
        if (!absent) throw shapeMismatch(expr); // only optional (undefined-armed) and 'unknown' fields may be omitted
        fields.push({ name: f.name, value: absent, absent: true });
      }
    }
    const result: IrExpr = { kind: "recordLit", fields, type, loc };
    const computedSpread = selectedComputedSpread();
    const self = selfSlot.local;
    if (computedSpread === null && self === null) return result;
    const stmts: IrStmt[] = [];
    if (computedSpread !== null) {
      stmts.push({ kind: "varDecl", localId: computedSpread.local.id, init: computedSpread.init, loc });
    }
    if (self === null) return { kind: "seqExpr", stmts, result, type, loc };
    // `this` methods captured %self before the record existed (the forward-capture shape): declare its box, build the
    // record into it, and the literal's VALUE is that local. The record→closure→box→record cycle is collectable.
    stmts.push({ kind: "varDecl", localId: self.id, init: null, loc });
    stmts.push({ kind: "assign", localId: self.id, value: result, loc });
    return { kind: "seqExpr", stmts, result: { kind: "varRef", localId: self.id, type, loc }, type, loc };
  }

/** The accessor twin of rejectThisInObjectMethod: a get/set accessor body
   * referencing `this` (`get x() { return this._x }`). The accessor lowers
   * as a closure stored IN the record — passing the record as a receiver
   * would capture the value under construction (an RC cycle), and the
   * generic lexical-this walk would silently bind an ENCLOSING method's
   * `this`; the fence names the fix (capture a binding instead). */
  function rejectThisInObjectAccessor(lowerer: Lowerer, node: ts.Node): void {
    if (node.kind === ts.SyntaxKind.ThisKeyword) {
      lowerer.unsupported(
        "SC1090",
        node,
        "references to 'this' in object literal get/set accessors (the accessor lowers as a captured closure with no receiver — read a captured binding instead)",
      );
    }
    ts.forEachChild(node, (child) => rejectThisInObjectAccessor(lowerer, child));
  }
