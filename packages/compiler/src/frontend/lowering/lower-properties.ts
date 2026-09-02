import { InternalCompilerError } from "../../errors.js";
import {
  DYN,
  F64,
  STRING,
  UNDEFINED_T,
  VOID,
  type IrExpr,
  type IrStmt,
  type IrType,
  type SrcLoc,
  isUnitType,
  typeEquals,
  typeKey,
  unionFuncSetArmsOk,
} from "../../ir/nodes.js";
import { locOf } from "../program.js";
import * as ts from "../ts7/adapter.js";
import { isGenericCallableMemberType } from "../types.js";
import {
  objLitGenericFnInfoOf,
  objLitGenericFnNodeOf,
  requireObjLitGenericReceiver,
} from "./lower-calls.js";
import { exactInstanceClassOf, findGenericMethodOn } from "./lower-classes.js";
import { probeLower } from "./lower-probe.js";
import { recordKeyResultOk } from "./lower-record-key-types.js";
import type { Lowerer } from "./lowerer.js";
import { NARROW_FIRST } from "./surfaces.js";

/** An assignable class, record, overflow, or accessor property target. */
export type FieldTarget =
  | {
      container: "class";
      obj: IrExpr;
      className: string;
      field: string;
      fieldType: IrType;
    }
  | {
      container: "record";
      obj: IrExpr;
      shapeId: string;
      field: string;
      fieldType: IrType;
    }
  | {
      container: "recordOvf";
      obj: IrExpr;
      shapeId: string;
      field: string;
      fieldType: IrType;
    }
  | {
      container: "accessor";
      obj: IrExpr;
      className: string;
      field: string;
      fieldType: IrType;
    }
  | {
      container: "recordAccessor";
      obj: IrExpr;
      shapeId: string;
      field: string;
      fieldType: IrType;
      getType?: IrType & { kind: "func" };
      setType?: IrType & { kind: "func" };
    };

/** Field read `obj.f` on class-instance and record receivers, through the
   * shared FieldTarget union (fieldGet / recordGet). Bound method references
   * on classes are rejected specifically; func-typed record fields are
   * ordinary closure values, so bare references to them work (unlike class
   * methods, which have no bound-value form). */
  export function lowerFieldRead(L: Lowerer, expr: ts.PropertyAccessExpression): IrExpr | null {
    // A generic instance may lower its receiver to a narrower concrete
    // record than the checker-visible constraint. When that concrete shape
    // omits an OPTIONAL constraint field, JavaScript still performs the
    // receiver evaluation and answers undefined. Handle that value case
    // before fieldTarget (which only describes assignable storage slots).
    const accessType = L.mapTypeOf(L.typeOf(expr));
    const absent = accessType ? L.wrappedUndefined(accessType, locOf(expr)) : null;
    if (absent) {
      const probed = probeLower(L, expr.expression);
      if (probed?.type.kind === "record") {
        const concreteShape = L.shapes.get(probed.type.shapeId);
        const propertyName = expr.name.text;
        if (
          concreteShape &&
          !concreteShape.indexValue &&
          !concreteShape.fields.some((f) =>
            f.name === propertyName ||
            f.name === `%get:${propertyName}` ||
            f.name === `%set:${propertyName}`
          )
        ) {
          const receiver = L.lowerExpr(expr.expression);
          return {
            kind: "seqExpr",
            stmts: [{ kind: "exprStmt", expr: receiver, loc: receiver.loc }],
            result: absent,
            type: absent.type,
            loc: locOf(expr),
          };
        }
      }
    }
    const target = L.fieldTarget(expr);
    if (target) return L.fieldGetExpr(target, locOf(expr), expr);
    if (expr.questionDotToken) return null;
    let receiverIr = L.mapTypeOf(L.typeOf(expr.expression));
    // The readonly-tuple Array.isArray narrow has no directly mappable
    // checker type (`Result & any[]`), but maybeNarrow extracted the tuple
    // record behind it. Route tuple properties such as `.length` from that
    // lowered value, the element-access bridge's twin.
    const checkerArray = L.checkerArrayValue(expr.expression);
    if (checkerArray?.type.kind === "record") receiverIr = checkerArray.type;
    if (
      receiverIr?.kind === "object" &&
      (L.findMethodOn(L.classes.get(receiverIr.className) ?? null, expr.name.text) ||
        findGenericMethodOn(L, L.classes.get(receiverIr.className) ?? null, expr.name.text))
    ) {
      L.unsupported("SC1090", expr, `bound method references (call '${expr.name.text}' directly)`);
    }
    // An object-literal GENERIC method as a VALUE (`o.m` — the member is
    // excluded from the record shape): the pinned-value rule verbatim when
    // the receiver is the defining literal's own const binding (the value
    // is the pinned instance's closure — no `this` exists); anything else
    // fences by name inside the helpers.
    {
      const propSym = L.checker.getPropertyOfType(L.typeOf(expr.expression), expr.name.text);
      if (
        receiverIr?.kind !== "object" && propSym &&
        isGenericCallableMemberType(L.checker.getTypeOfSymbol(propSym), L.checker) &&
        // CLASS members keep the class-path fences (a poisoned class's own
        // diagnostics, the bound-method fence above).
        !L.checker.declarationsOf(propSym).some(
          (d) => d.parent !== undefined && (ts.isClassDeclaration(d.parent) || ts.isClassExpression(d.parent)),
        )
      ) {
        const found = objLitGenericFnNodeOf(L, propSym);
        if (!found) {
          L.unsupported(
            "SC1090",
            expr,
            `the generic method '${expr.name.text}' as a value with no defining object literal (only methods declared with a body in an object literal compile)`,
          );
        }
        requireObjLitGenericReceiver(L, expr, expr.expression, found.literal, expr.name.text);
        return L.lowerGenericFnValue(expr, objLitGenericFnInfoOf(L, expr, expr.name.text, found));
      }
    }
    // Dot access to an UNDECLARED key of an index-signature shape
    // (`bag.count` on `Record<string, number>`): tsc allows it without
    // noPropertyAccessFromIndexSignature, but the bracket spelling is the
    // canonical index-signature form here — point at it.
    if (receiverIr?.kind === "record") {
      const shape = L.shapes.get(receiverIr.shapeId);
      if (shape?.indexValue && !shape.fields.some((f) => f.name === expr.name.text)) {
        L.unsupported(
          "SC1090",
          expr,
          `dot access to index-signature keys (spell it r["${expr.name.text}"] — brackets are the index-signature form)`,
        );
      }
    }
    // `t.length` on a tuple: the arity CONSTANT (tuples are fixed-shape —
    // the checker types it as the literal arity too). Folding discards the
    // receiver's evaluation, so only side-effect-free receivers fold;
    // anything else (a call result) binds to a const first.
    if (receiverIr?.kind === "record" && expr.name.text === "length") {
      const shape = L.shapes.get(receiverIr.shapeId);
      if (shape?.tuple) {
        let root: ts.Expression = expr.expression;
        while (ts.isPropertyAccessExpression(root)) root = root.expression;
        if (!ts.isIdentifier(root) && root.kind !== ts.SyntaxKind.ThisKeyword) {
          L.unsupported(
            "SC1090",
            expr,
            "'.length' of a computed tuple expression (the arity is a constant — bind the tuple to a const first)",
          );
        }
        return { kind: "numLit", value: shape.fields.length, type: F64, loc: locOf(expr) };
      }
    }
    return null;
  }

/** Shared-field read `r.f` on a UNION receiver: supported exactly when
   * every arm is a record/class possessing the field with ONE shared IR
   * type — the discriminant pattern (`r.kind`, primitive) and the
   * shared-payload pattern (`spec.config` where every ServiceSpec arm
   * carries the same record). Lowers to `unionDisc` (the backend switches
   * on the runtime tag and reads the field from the concrete arm), which
   * composes with existing strEq/bin/switch nodes, so `r.kind === "ok"`
   * and `switch (r.kind)` work without dedicated test nodes. Anything else
   * on a union receiver is rejected specifically (narrow first). */
  export function lowerUnionProperty(L: Lowerer, expr: ts.PropertyAccessExpression): IrExpr | null {
    if (expr.questionDotToken) return null;
    const receiverIr = L.mapTypeOf(L.typeOf(expr.expression));
    if (receiverIr?.kind !== "union") return null;
    // Lower the receiver FIRST and read its actual IR union: a partially
    // narrowed receiver (checker type = a SUB-union of the binding's union)
    // stays the full union at runtime, and the tag switch must cover the
    // full union's arms.
    const value = L.lowerExpr(expr.expression);
    // A checker-union receiver whose VALUE lowered to a plain RECORD (the
    // merged-signature fiction — `runner(cmd, args)` where runner joined
    // a structural runner type with spawnSync's, and the local adopted
    // the record arm): read the record field directly, the dyn-receiver
    // fallback's discipline.
    // A checker-union receiver whose VALUE lowered checked-dynamic (a
    // never-tainted JS chain — `cmd[1].length` on `const cmd = ['pwd',
    // []]`, where the element read stayed a dyn node): read through the
    // dyn keyed read like the unmappable-receiver path below the chain.
    if (value.type.kind === "dyn") {
      const key: IrExpr = { kind: "strLit", value: expr.name.text, type: STRING, loc: locOf(expr.name) };
      return { kind: "dynKeyGet", key, value, type: DYN, loc: locOf(expr) };
    }
    if (value.type.kind === "record") {
      const shape = L.shapes.get(value.type.shapeId);
      const f = shape?.fields.find((x) => x.name === expr.name.text);
      if (f) {
        return {
          kind: "recordGet",
          obj: value,
          shapeId: value.type.shapeId,
          field: f.name,
          type: f.type,
          loc: locOf(expr),
        };
      }
      return null;
    }
    if (value.type.kind !== "union") {
      throw new InternalCompilerError("lowerer bug: union-typed receiver lowered to a non-union");
    }
    const def = L.unions.get(value.type.unionId);
    if (!def) throw new InternalCompilerError(`lowerer bug: unknown union ${value.type.unionId}`);
    const field = expr.name.text;
    let common: IrType | null = null;
    for (const arm of def.arms) {
      let ft: IrType | undefined;
      if (arm.kind === "record") {
        ft = L.shapes.get(arm.shapeId)?.fields.find((f) => f.name === field)?.type;
      } else if (arm.kind === "object") {
        ft = L.classes.get(arm.className)?.fields.get(field);
      }
      if (!ft || ft.kind === "void" || isUnitType(ft) || (common && !typeEquals(common, ft))) {
        common = null;
        break;
      }
      common = ft;
    }
    if (common) {
      return {
        kind: "unionDisc",
        unionId: value.type.unionId,
        field,
        value,
        type: common,
        loc: locOf(expr),
      };
    }
    // The arms answer DIFFERENT types (or through index signatures / unit
    // arms): the JOIN path — `env.PORTLESS_PORT` on `ProcessEnv |
    // Record<string, string>`, the tail read of `loaded?.config.script`.
    const key: IrExpr = { kind: "strLit", value: field, type: STRING, loc: locOf(expr.name) };
    const keyed = lowerUnionKeyedRead(L, expr, value.type.unionId, value, key, field);
    if (keyed) return keyed;
    L.unsupported(
      "SC1090",
      expr,
      `reading '${field}' on a union-typed value (every arm must be an object/record ` +
        `with a same-typed field '${field}'; ` +
        `${NARROW_FIRST})`,
    );
  }

/** The unionDisc generalization: a keyed read on a union receiver whose
   * arms answer DIFFERENT (but joinable) types. Each arm contributes its
   * declared answer — a declared field's type (literal keys), an
   * index-signature arm's value type (plus its declared fields' types for
   * runtime keys, which reach them through the keyed-read helper), and
   * UNDEFINED for unit arms (reachable only through optional-chain tails,
   * where JS short-circuits to undefined; a unit arm the checker narrowed
   * away is simply unreachable). The result type is the JOIN of those
   * answers; every arm's answer must be the join itself or one of its
   * arms (sub-union RE-TAGGING between distinct unions stays fenced).
   * Returns null when any arm cannot answer — the caller owns the fence
   * message. The caller (the property/element dispatch) maybeNarrows. */
  export function lowerUnionKeyedRead(L: Lowerer, expr: ts.Expression,
    unionId: string,
    value: IrExpr,
    key: IrExpr,
    literalField: string | null,): IrExpr | null {
    const def = L.unions.get(unionId);
    if (!def) return null;
    // Pass 1: per-arm declared answers, joined into the result type.
    const joinArms: IrType[] = [];
    const seen = new Set<string>();
    const push = (t: IrType): void => {
      const k = typeKey(t);
      if (!seen.has(k)) {
        seen.add(k);
        joinArms.push(t);
      }
    };
    const pushAnswer = (t: IrType): boolean => {
      if (t.kind === "void") return false;
      if (t.kind === "union") {
        const inner = L.unions.get(t.unionId);
        if (!inner) return false;
        for (const a of inner.arms) push(a);
        return true;
      }
      push(t);
      return true;
    };
    for (const arm of def.arms) {
      if (isUnitType(arm)) {
        push(UNDEFINED_T);
        continue;
      }
      if (arm.kind !== "record") return null;
      const shape = L.shapes.get(arm.shapeId);
      if (!shape || shape.tuple) return null;
      const declared =
        literalField !== null ? shape.fields.find((f) => f.name === literalField)?.type : undefined;
      if (declared) {
        if (!pushAnswer(declared)) return null;
        continue;
      }
      // Runtime keys can reach the declared fields through the keyed-read
      // helper's string switch — every one joins.
      if (literalField === null) {
        for (const f of shape.fields) if (!pushAnswer(f.type)) return null;
      }
      if (!shape.indexValue) {
        if (literalField === null && shape.fields.length > 0) continue;
        return null;
      }
      if (!pushAnswer(shape.indexValue)) return null;
    }
    if (joinArms.length === 0) return null;
    // The join must be a BUILDABLE union: arm kinds the union invariants
    // admit (no map/dyn/jsval/generator arms; func arms only beside
    // func/unit siblings — unionFuncSetArmsOk, the validator's rule). A
    // join mixing, say, a func answer with data answers has no union to
    // surface as; the caller owns the fence message.
    if (
      joinArms.length > 1 &&
      (!unionFuncSetArmsOk(joinArms) ||
        joinArms.some((a) => a.kind === "map" || a.kind === "dyn" || a.kind === "jsval" || a.kind === "generator" || a.kind === "caught"))
    ) {
      return null;
    }
    joinArms.sort((a, b) => (typeKey(a) < typeKey(b) ? -1 : 1));
    const type: IrType =
      joinArms.length === 1 ? joinArms[0]! : { kind: "union", unionId: L.unions.intern(joinArms) };
    // Pass 2: every arm's answer must SURFACE as the join, and index arms
    // must pass the single-record keyed-read constraints (the helper is
    // shared with recordKeyGet, its missing-key policy included).
    const surfaces = (t: IrType): boolean =>
      typeEquals(t, type) || (type.kind === "union" && L.armTag(type.unionId, t) >= 0);
    for (const arm of def.arms) {
      if (isUnitType(arm)) {
        if (!(type.kind === "union" && L.armTag(type.unionId, UNDEFINED_T) >= 0)) return null;
        continue;
      }
      if (arm.kind !== "record") return null;
      const shape = L.shapes.get(arm.shapeId);
      if (!shape) return null;
      const declared =
        literalField !== null ? shape.fields.find((f) => f.name === literalField)?.type : undefined;
      if (declared) {
        if (!surfaces(declared)) return null;
        continue;
      }
      const ovfShape = literalField !== null && shape.indexValue ? { ...shape, fields: [] } : shape;
      if (!recordKeyResultOk(L, ovfShape, type)) return null;
    }
    return { kind: "unionKeyGet", unionId, key, value, type, loc: locOf(expr) };
  }

/** Recognizes `obj.field` as an assignable field target: receiver is a
   * known class instance OR a record, and the member is a field or (class
   * receivers) a declared accessor property. Returns the pieces of a
   * fieldSet/recordSet/accessor-call (minus value/kind) or null. */
  export function fieldTarget(L: Lowerer, access: ts.PropertyAccessExpression): FieldTarget | null {
    if (L.chainBlocked(access)) return null;
    // The checker leaves `this` in an anonymous class expression as an
    // anonymous object type. Method/constructor lowering has already
    // established the exact nominal class, so use that proof instead of
    // losing declared and inherited fields at assignments such as
    // `this.name = ...` in an Error-subclass expression.
    const mappedReceiver = L.mapTypeOf(L.typeOf(access.expression));
    // Exact-new provenance refines a nominal or checker-erased (`any` in
    // JavaScript) class receiver to its concrete class. It must not undo a
    // real representation boundary: an annotated record initialized from
    // a class has already been copy-projected into that record, so its
    // later fields are recordGet targets rather than reads through the
    // initializer's discarded class identity.
    const exactInstance = mappedReceiver?.kind === "record"
      ? null
      : exactInstanceClassOf(L, access.expression);
    const receiverIr: IrType | null =
      access.expression.kind === ts.SyntaxKind.ThisKeyword && L.currentClass
        ? { kind: "object", className: L.currentClass.def.name }
        : exactInstance
          ? { kind: "object", className: exactInstance.def.name }
          : mappedReceiver;
    if (receiverIr?.kind === "object") {
      const info = L.classes.get(receiverIr.className);
      if (!info) {
        // A receiver typed as a class whose collection deferred: the
        // deferred diagnostics are what explains the miss.
        L.flushDeferredClass(receiverIr.className);
        return null;
      }
      const lowerReceiver = (): IrExpr => {
        const obj = L.lowerExpr(access.expression);
        return exactInstance !== null && obj.type.kind === "object" &&
          L.isSubclassOf(receiverIr.className, obj.type.className)
          ? {
              kind: "downcast",
              value: obj,
              type: receiverIr,
              loc: obj.loc,
            }
          : obj;
      };
      const fieldType = info.fields.get(access.name.text);
      if (fieldType) {
        const obj = lowerReceiver();
        return { container: "class", obj, className: receiverIr.className, field: access.name.text, fieldType };
      }
      // Accessor property: either half declared anywhere on the chain
      // makes the name an accessor target (fields and accessors share a
      // namespace — tsc rejects mixing them, so the halves agree on kind).
      const getF = L.findMethodOn(info, `get:${access.name.text}`);
      const setF = L.findMethodOn(info, `set:${access.name.text}`);
      if (getF || setF) {
        const obj = lowerReceiver();
        return {
          container: "accessor",
          obj,
          className: receiverIr.className,
          field: access.name.text,
          fieldType: getF ? getF.sig.ret : setF!.sig.params[0]!.type,
        };
      }
      return null;
    }
    if (receiverIr?.kind === "record") {
      const shape = L.shapes.get(receiverIr.shapeId);
      const fieldType = shape?.fields.find((f) => f.name === access.name.text)?.type;
      if (fieldType) {
        const obj = L.lowerExpr(access.expression);
        // A checker-record receiver whose VALUE stayed dyn (the erased
        // all-unknown-fields cast — `(err as { code?: unknown }).code`):
        // decline, and the dyn keyed-read fallback answers.
        if (obj.type.kind !== "record") return null;
        // A monomorphized generic body can retain the constraint's checker
        // type while the lowered parameter already carries the concrete
        // instance shape. The runtime value is authoritative: naming the
        // constraint shape here emits an invalid recordGet (same field,
        // different layout id). Re-resolve the member on the value shape;
        // if it is absent, decline to the ordinary keyed-read diagnostics.
        if (obj.type.shapeId !== receiverIr.shapeId) {
          const concrete = L.shapes.get(obj.type.shapeId);
          const concreteField = concrete?.fields.find((f) => f.name === access.name.text);
          if (!concreteField) return null;
          return {
            container: "record",
            obj,
            shapeId: obj.type.shapeId,
            field: access.name.text,
            fieldType: concreteField.type,
          };
        }
        return { container: "record", obj, shapeId: receiverIr.shapeId, field: access.name.text, fieldType };
      }
      // A RECORD accessor property: either slot present makes the name an
      // accessor target (get/set share the property namespace — tsc
      // rejects mixing an accessor with a data property, so the halves
      // agree). Reads dispatch the %get: closure, writes the %set: one.
      {
        const getSlot = shape?.fields.find((f) => f.name === `%get:${access.name.text}`)?.type;
        const setSlot = shape?.fields.find((f) => f.name === `%set:${access.name.text}`)?.type;
        if (getSlot?.kind === "func" || setSlot?.kind === "func") {
          const obj = L.lowerExpr(access.expression);
          if (obj.type.kind !== "record") return null; // dyn-valued receiver: the keyed fallback answers
          const getType = getSlot?.kind === "func" ? getSlot : undefined;
          const setType = setSlot?.kind === "func" ? setSlot : undefined;
          return {
            container: "recordAccessor",
            obj,
            shapeId: receiverIr.shapeId,
            field: access.name.text,
            fieldType: getType ? getType.ret : setType!.params[0]!,
            ...(getType ? { getType } : {}),
            ...(setType ? { setType } : {}),
          };
        }
      }
      // Dot access to an UNDECLARED key of an index-signature shape: tsc
      // types it through the signature — the access resolves to NO property
      // symbol (mapped types like Record<string, T>) or to the signature's
      // own `__index` symbol (interface-declared signatures). A real member
      // symbol means a lib member like `toString` — not an index access;
      // those keep their fences below. It IS the bracket access in dot
      // spelling — the same overflow path.
      const nameSym = L.checker.getSymbolAtLocation(access.name);
      if (shape?.indexValue && !shape.tuple) {
        // A member the shape CANONICALIZATION dropped into the overflow
        // (the header family: @types declares `host?: string` on
        // IncomingHttpHeaders while the canonical shape is a pure index
        // record) is the bracket access in dot spelling too: a PROPERTY
        // declaration whose own type fits within the index value. METHOD
        // members (`toString` — the lib's inherited surface) keep their
        // fences: JS finds the prototype function, never an overflow miss.
        const canonicalized = (): boolean => {
          if (!nameSym) return false;
          const nameDecls = L.checker.declarationsOf(nameSym);
          if (!nameDecls.length) return false;
          if (!nameDecls.every((d) => ts.isPropertySignature(d))) return false;
          const declared = L.mapTypeOf(L.typeOf(access));
          if (!declared) return false;
          const iv = shape.indexValue!;
          if (typeEquals(declared, iv)) return true;
          if (iv.kind !== "union") return false;
          const ivArms = L.unions.get(iv.unionId)?.arms;
          if (!ivArms) return false;
          const declaredArms =
            declared.kind === "union" ? (L.unions.get(declared.unionId)?.arms ?? [declared]) : [declared];
          return declaredArms.every((a) => ivArms.some((b) => typeEquals(a, b)));
        };
        if (!nameSym || nameSym.name === ts.InternalSymbolName.Index || canonicalized()) {
          const obj = L.lowerExpr(access.expression);
          return { container: "recordOvf", obj, shapeId: receiverIr.shapeId, field: access.name.text, fieldType: shape.indexValue };
        }
      }
      return null;
    }
    return null;
  }

/** A STATICALLY-RESOLVABLE unique-symbol key: an identifier whose value
   * resolves (imports included) to a module-level `const k = Symbol(...)`
   * with no description or a literal one. tsc types such a const `unique
   * symbol` — a compile-time identity — so a `this[k]` member is an
   * ordinary hidden field of the static layout, named in Node's inspect
   * spelling (`Symbol(limit)`). Everything else is null and keeps the
   * symbol fences: `symbol`-typed parameters and locals (identity known
   * only at runtime), `Symbol.for(...)` consts (two distinct consts can
   * alias ONE runtime symbol through the global registry — tsc still
   * types them as distinct unique symbols, so static slots would split
   * what JS shares), and computed descriptions (the field name below
   * must BE Node's, for inspect). */
  export function uniqueSymbolKeyOf(L: Lowerer, key: ts.Expression): { sym: ts.Symbol; fieldName: string } | null {
    if (!ts.isIdentifier(key)) return null;
    const t = L.typeOf(key);
    // tsgo WIDENS a unique-symbol const's type to plain `symbol` through a
    // CJS require alias (5.9.3 kept `unique symbol` — the finding-5
    // family), so plain symbol passes this early filter too: every
    // correctness-bearing check is the DECLARATION-shape battery below
    // (module-level const initialized by a literal-description Symbol()),
    // which a runtime-identity symbol value can never satisfy.
    if (!(t.flags & (ts.TypeFlags.UniqueESSymbol | ts.TypeFlags.ESSymbol))) return null;
    const sym = L.resolveValueSymbol(key);
    const decl = sym ? L.checker.valueDeclarationOf(sym) : undefined;
    if (!sym || !decl || !ts.isVariableDeclaration(decl)) return null;
    if (!(ts.getCombinedNodeFlags(decl) & ts.NodeFlags.Const)) return null;
    // Module level only: a unique-symbol const inside a FUNCTION is a
    // fresh runtime identity per call — one static slot would conflate
    // what JS keeps distinct.
    if (!ts.isVariableStatement(decl.parent.parent) || !ts.isSourceFile(decl.parent.parent.parent)) return null;
    const init = decl.initializer;
    if (!init || !ts.isCallExpression(init) || init.questionDotToken) return null;
    if (!ts.isIdentifier(init.expression) || init.expression.text !== "Symbol") return null;
    if (!L.isStdlibSymbol(L.checker.getSymbolAtLocation(init.expression))) return null;
    const arg = init.arguments.length === 0 ? null : init.arguments.length === 1 ? init.arguments[0]! : undefined;
    if (arg === undefined) return null;
    if (arg !== null && !ts.isStringLiteral(arg) && !ts.isNoSubstitutionTemplateLiteral(arg)) return null;
    // Symbol() and Symbol('') both print `Symbol()` — Node's toString.
    return { sym, fieldName: `Symbol(${arg?.text ?? ""})` };
  }

/** The declared symbol-keyed field (class name / layout field / type)
   * `expr` resolves to, WITHOUT lowering the receiver — the routing test
   * for the wiring sites (statement dispatch must not emit anything when
   * it declines). Null off class receivers, for non-static keys, and for
   * keys no class on the chain declares. */
  export function symbolFieldInfo(L: Lowerer, expr: ts.ElementAccessExpression,): { className: string; field: string; fieldType: IrType } | null {
    if (L.chainBlocked(expr)) return null;
    const receiverIr = L.mapTypeOf(L.typeOf(expr.expression));
    if (receiverIr?.kind !== "object") return null;
    const info = L.classes.get(receiverIr.className);
    if (!info) {
      L.flushDeferredClass(receiverIr.className);
      return null;
    }
    const key = uniqueSymbolKeyOf(L, expr.argumentExpression);
    if (!key) return null;
    const field = info.symbolFields?.get(key.sym);
    if (field === undefined) return null;
    const fieldType = info.fields.get(field);
    if (!fieldType) return null;
    return { className: receiverIr.className, field, fieldType };
  }

/** `obj[k]` as an assignable field target — the symbol-keyed twin of
   * fieldTarget's class branch (the receiver lowers here, exactly once). */
  export function symbolFieldTarget(L: Lowerer, expr: ts.ElementAccessExpression): FieldTarget | null {
    const info = symbolFieldInfo(L, expr);
    if (!info) return null;
    const obj = L.lowerExpr(expr.expression);
    return { container: "class", obj, className: info.className, field: info.field, fieldType: info.fieldType };
  }

/** The read expression for a field target (fieldGet / recordGet /
   * getter call). `blame` locates the rejection of a setter-only read —
   * tsc-clean (the property types as the setter's param), but Node yields
   * undefined, which these property types cannot represent. */
  export function fieldGetExpr(L: Lowerer, target: FieldTarget, loc: SrcLoc, blame: ts.Node): IrExpr {
    // A record-shaped CHECKER target whose receiver VALUE lives in the checked-dynamic tree
    // (a JS file-scope object-literal global): the checked-dynamic keyed
    // read — dynKeyGet (a missing key answers the dyn undefined, exactly
    // JS); consumers validate (dynCheck) where a static type is required.
    if (
      (target.container === "record" || target.container === "recordOvf") &&
      target.obj.type.kind === "dyn"
    ) {
      return {
        kind: "dynKeyGet",
        key: { kind: "strLit", value: target.field, type: STRING, loc },
        value: target.obj,
        type: DYN,
        loc,
      };
    }
    if (target.container === "accessor") {
      const getF = L.findMethodOn(L.classes.get(target.className) ?? null, `get:${target.field}`);
      if (!getF) {
        L.unsupported(
          "SC1090",
          blame,
          `reading a property that has only a setter ('${target.field}' — Node would yield undefined)`,
        );
      }
      return L.accessorCall(target.className, `get:${target.field}`, target.obj, [], getF.sig.ret, loc);
    }
    // Record accessor properties: the read IS a call of the %get: closure
    // — once per read, side effects and all (JS's evaluation). The
    // setter-only read keeps the class-path fence: the property types as
    // the setter's param where Node yields undefined.
    if (target.container === "recordAccessor") {
      if (!target.getType) {
        L.unsupported(
          "SC1090",
          blame,
          `reading a property that has only a setter ('${target.field}' — Node would yield undefined)`,
        );
      }
      const closure: IrExpr = {
        kind: "recordGet",
        obj: target.obj,
        shapeId: target.shapeId,
        field: `%get:${target.field}`,
        type: target.getType,
        loc,
      };
      return { kind: "callValue", callee: closure, args: [], type: target.getType.ret, loc };
    }
    // Overflow dot reads: exactly the bracket read with a literal key —
    // recordKeyGet, overflowOnly (the name declares no field by
    // construction), typed as the index value armed with undefined under
    // noUncheckedIndexedAccess (mirroring lowerRecordKeyRead).
    if (target.container === "recordOvf") {
      let t: IrType = target.fieldType;
      if (L.program.getCompilerOptions().noUncheckedIndexedAccess) {
        const armed = L.withUndefinedArmOf(t);
        if (!armed) L.badType(blame, L.typeOf(blame));
        t = armed;
      }
      return {
        kind: "recordKeyGet",
        obj: target.obj,
        shapeId: target.shapeId,
        key: { kind: "strLit", value: target.field, type: STRING, loc },
        overflowOnly: true,
        type: t,
        loc,
      };
    }
    if (target.container === "class") {
      const read: IrExpr = { kind: "fieldGet", obj: target.obj, className: target.className, field: target.field, type: target.fieldType, loc };
      // DEFERRED-INIT fields (`stream!: T` assigned past the constructor's
      // top level — ClassInfo.deferredInitFields): the SLOT is the
      // undefined-armed union; the read CHECKED-extracts the declared type
      // — a genuinely unassigned read throws the catchable TypeError
      // where Node reads an undefined the declared type cannot hold.
      if (
        L.classes.get(target.className)?.deferredInitFields?.has(target.field) === true &&
        target.fieldType.kind === "union"
      ) {
        const inner = L.stripUndefinedArm(target.fieldType);
        const helper = L.deferredReadHelper(target.fieldType.unionId, inner, loc);
        if (helper) return { kind: "call", callee: helper, args: [read], type: inner, loc };
      }
      return read;
    }
    return { kind: "recordGet", obj: target.obj, shapeId: target.shapeId, field: target.field, type: target.fieldType, loc };
  }

/** The write statement for a field target (fieldSet / recordSet / setter
   * call). A write to a getter-only property never gets here in a clean
   * program (tsc's TS2540 is the fence); the rejection is the backstop. */
  export function fieldSetStmt(L: Lowerer, target: FieldTarget, value: IrExpr, loc: SrcLoc, blame: ts.Node): IrStmt {
    // A record-shaped CHECKER target whose receiver VALUE lives in the checked-dynamic tree:
    // the checked-dynamic keyed write — dyn.keySet (later writes win,
    // insertion order; Node's TypeErrors on non-object receivers), the
    // value converting into the checked-dynamic tree.
    if (
      (target.container === "record" || target.container === "recordOvf") &&
      target.obj.type.kind === "dyn"
    ) {
      const v = L.coerceToExpected(value, DYN);
      if (v.type.kind !== "dyn") {
        L.unsupported(
          "SC1101",
          blame,
          `storing '${L.fmt(value.type)}' values in a checked-dynamic object (the value cannot convert into the checked-dynamic tree)`,
        );
      }
      return {
        kind: "exprStmt",
        expr: {
          kind: "libCall",
          fn: "dyn.keySet",
          args: [target.obj, { kind: "strLit", value: target.field, type: STRING, loc }, v],
          type: VOID,
          loc,
        },
        loc,
      };
    }
    if (target.container === "accessor") {
      const setF = L.findMethodOn(L.classes.get(target.className) ?? null, `set:${target.field}`);
      if (!setF) L.unsupported("SC1090", blame, `assignment to the getter-only property '${target.field}'`);
      return {
        kind: "exprStmt",
        expr: L.accessorCall(target.className, `set:${target.field}`, target.obj, [value], VOID, loc),
        loc,
      };
    }
    // Record accessor properties: the write calls the %set: closure with
    // the coerced value. A getter-only write never gets here in a clean
    // program (tsc's TS2540); the rejection is the backstop.
    if (target.container === "recordAccessor") {
      if (!target.setType) {
        L.unsupported("SC1090", blame, `assignment to the getter-only property '${target.field}'`);
      }
      const closure: IrExpr = {
        kind: "recordGet",
        obj: target.obj,
        shapeId: target.shapeId,
        field: `%set:${target.field}`,
        type: target.setType,
        loc,
      };
      return {
        kind: "exprStmt",
        expr: { kind: "callValue", callee: closure, args: [value], type: VOID, loc },
        loc,
      };
    }
    // Overflow dot writes: the bracket write with a literal key — a pure
    // overflow insert (recordKeySet, overflowOnly: the name declares no
    // field, so no declared collision exists to validate). The value was
    // coerced into the index-value slot type by the caller.
    if (target.container === "recordOvf") {
      return {
        kind: "recordKeySet",
        obj: target.obj,
        shapeId: target.shapeId,
        key: { kind: "strLit", value: target.field, type: STRING, loc },
        value,
        overflowOnly: true,
        loc,
      };
    }
    return target.container === "class"
      ? { kind: "fieldSet", obj: target.obj, className: target.className, field: target.field, value, loc }
      : { kind: "recordSet", obj: target.obj, shapeId: target.shapeId, field: target.field, value, loc };
  }
