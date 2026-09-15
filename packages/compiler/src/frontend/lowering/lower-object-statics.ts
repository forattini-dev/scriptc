/* Object statics (static builds): `Object.is`, `create`, `assign`, `defineProperty`/`defineProperties`, `freeze`,
 * `hasOwn` (and the legacy `hasOwnProperty.call` spelling), `keys`/`values`/`entries`. Records answer by their compiled
 * shape: `assign` copies declared fields (or builds a schema with statics, a decorated SqlClient, or a hybrid
 * function-with-properties record); members with no honest compiled answer keep their named fences. */
import { lowerObjectHasOwnArgs } from "./lower-record-membership.js";
import { preserveNativeFreeze } from "./lower-native-freeze.js";
import { lowerTypedObjectIteration } from "./lower-object-iteration.js";
import * as ts from "../ts7/adapter.js";
import type { Lowerer } from "./lowerer.js";
import { BOOL, DYN, IrExpr, IrStmt, IrType, JSVAL, STRING, SrcLoc, UNDEFINED_T, VOID, canBoxFuncIntoDyn, isUnitType, shapeHasAccessorSlots, typeEquals } from "../../ir/ir.js";
import { isJsSourceFile, locOf } from "../program.js";
import { lowerNativeNamespaceObjectWalk } from "./lower-native-namespace.js";
import { NARROW_FIRST } from "./surfaces.js";
import type { ScrDiagnostic } from "../../diagnostics/diagnostic.js";
import { lowerObjectAssignIndexShape } from "./lower-containers.js";
import { droppableStatic, probeLower } from "./lower-exprs.js";
import { lowerObjectAssignSchema } from "./lower-schema.js";
import { lowerSqlClientDecorate } from "./lower-sql-client.js";

  /** Legacy robust-own-property idiom emitted by transpilers and agents:
   * Object.prototype.hasOwnProperty.call(obj, key). */
  export function lowerLegacyHasOwnCall(lowerer: Lowerer, call: ts.CallExpression): IrExpr | null {
    if (call.questionDotToken || call.arguments.length !== 2 || call.arguments.some((a) => ts.isSpreadElement(a))) return null;
    const callMember = call.expression;
    if (!ts.isPropertyAccessExpression(callMember) || callMember.questionDotToken || callMember.name.text !== "call") return null;
    const hasOwn = callMember.expression;
    if (!ts.isPropertyAccessExpression(hasOwn) || hasOwn.questionDotToken || hasOwn.name.text !== "hasOwnProperty") return null;
    const prototype = hasOwn.expression;
    if (!ts.isPropertyAccessExpression(prototype) || prototype.questionDotToken || prototype.name.text !== "prototype") return null;
    if (!lowerer.isStdlibGlobal(prototype.expression, "Object")) return null;
    return lowerObjectHasOwnArgs(lowerer, call, call.arguments[0]!, call.arguments[1]!);
  }

  /** Interned `%obj.assign.<n>(t, s)` — Object.assign's per-field copy
   * over signature-free records (every source field lands on a same-named,
   * same-typed target field — the caller's gate): undefined-armed source
   * fields copy behind the not-undefined guard, everything else straight,
   * and the TARGET returns (JS's aliasing). */
  function recordAssignHelper(lowerer: Lowerer, targetShapeId: string, srcShapeId: string, loc: SrcLoc): string {
    const key = `obj.assign:${targetShapeId}:${srcShapeId}`;
    const existing = lowerer.arrHofHelpers.get(key);
    if (existing) return existing;
    const helper = `%obj.assign.${lowerer.arrHofHelpers.size}`;
    lowerer.arrHofHelpers.set(key, helper);
    const sShape = lowerer.shapes.get(srcShapeId)!;
    const tT: IrType = { kind: "record", shapeId: targetShapeId };
    const sT: IrType = { kind: "record", shapeId: srcShapeId };
    const tRef: IrExpr = { kind: "varRef", localId: "t.0", type: tT, loc };
    const sRef: IrExpr = { kind: "varRef", localId: "s.0", type: sT, loc };
    const body: IrStmt[] = [];
    for (const f of sShape.fields) {
      const get: IrExpr = { kind: "recordGet", obj: sRef, shapeId: srcShapeId, field: f.name, type: f.type, loc };
      const set: IrStmt = { kind: "recordSet", obj: tRef, shapeId: targetShapeId, field: f.name, value: get, loc };
      const utag = f.type.kind === "union" ? lowerer.armTag(f.type.unionId, UNDEFINED_T) : -1;
      body.push(
        utag >= 0 && f.type.kind === "union"
          ? {
              kind: "if",
              cond: { kind: "unionIsTag", unionId: f.type.unionId, tag: utag, negated: true, value: get, type: BOOL, loc },
              then: [set],
              else_: null,
              loc,
            }
          : set,
      );
    }
    body.push({ kind: "return", value: tRef, loc });
    lowerer.liftedFns.push({
      name: helper,
      params: [
        { localId: "t.0", name: "t", type: tT },
        { localId: "s.0", name: "s", type: sT },
      ],
      returnType: tT,
      locals: [
        { id: "t.0", name: "t", type: tT, mutable: true },
        { id: "s.0", name: "s", type: sT, mutable: true },
      ],
      body,
      loc,
    });
    return helper;
  }

  /** Object.is over statically disjoint kinds: the constant false, with
   * both operands still evaluated for their effects (droppable statics
   * fold away — JS evaluates arguments, but nothing observes a pure one). */
  function objectIsDisjointFalse(left: IrExpr, right: IrExpr, loc: SrcLoc): IrExpr {
    const stmts: IrStmt[] = [];
    for (const e of [left, right]) {
      if (!droppableStatic(e)) stmts.push({ kind: "exprStmt", expr: e, loc });
    }
    const answer: IrExpr = { kind: "boolLit", value: false, type: BOOL, loc };
    if (stmts.length === 0) return answer;
    return { kind: "seqExpr", stmts, result: answer, type: BOOL, loc };
  }

  export function lowerObjectStaticCall(lowerer: Lowerer, call: ts.CallExpression,
    access: ts.PropertyAccessExpression,): IrExpr | null {
    if (call.questionDotToken || access.questionDotToken) return null;
    if (!lowerer.isStdlibGlobal(access.expression, "Object")) return null;
    const member = access.name.text;
    const namespaceWalk = lowerNativeNamespaceObjectWalk(lowerer, call, member);
    if (namespaceWalk) return namespaceWalk;
    // Object.is — the spec's SameValue over the static kinds. Number
    // pairs take the runtime SameValue (NaN equals NaN, +0 differs from
    // -0 — the two divergences from ===); every other supported pair
    // rides exactly the strict-equality machinery, whose answers
    // SameValue shares: strings by bytes, bools by value, unit literals
    // by tag, unions per arm (a number arm's payload compare upgrades to
    // SameValue via unionEq's flag), and the reference kinds by pointer
    // identity. Statically DISJOINT kind pairs answer the constant false
    // with the operands still evaluated (tsc admits any pair — Object.is
    // is (any, any) — and JS evaluates the arguments either way).
    // dyn/jsval operands keep strict equality's stance: validate first.
    if (member === "is") {
      if (call.arguments.length !== 2 || call.arguments.some((a) => ts.isSpreadElement(a))) {
        lowerer.noLowering(
          `Object.is with ${call.arguments.length} arguments`,
          call,
          "exactly two arguments are the lowered form (JS treats a missing one as undefined — pass it explicitly)",
        );
      }
      const loc = locOf(call);
      const leftNode = call.arguments[0]!;
      const rightNode = call.arguments[1]!;
      const left = lowerer.lowerExpr(leftNode);
      const right = lowerer.lowerExpr(rightNode);
      const lk = left.type.kind;
      const rk = right.type.kind;
      if (lk === "f64" && rk === "f64") {
        return { kind: "libCall", fn: "num.sameValue", args: [left, right], type: BOOL, loc };
      }
      if (left.type.kind === "string" && right.type.kind === "string") {
        return { kind: "strEq", negated: false, left, right, type: BOOL, loc };
      }
      if (lk === "bool" && rk === "bool") {
        return { kind: "bin", op: "===", left, right, type: BOOL, loc };
      }
      const unitTest = lowerer.lowerUnitComparison(left, right, false, loc);
      if (unitTest) return unitTest;
      if (lk === "dyn" || rk === "dyn" || lk === "jsval" || rk === "jsval") {
        lowerer.noLowering(
          "Object.is over a dynamic operand",
          call,
          "validate/narrow the value first (strict equality's rule) — SameValue only differs from === on numbers (NaN, ±0)",
        );
      }
      if (left.type.kind === "union" || right.type.kind === "union") {
        const ut = left.type.kind === "union" ? left.type : (right.type as IrType & { kind: "union" });
        const bothUnion = left.type.kind === "union" && right.type.kind === "union";
        const sameUnion = bothUnion && typeEquals(left.type, right.type);
        if ((sameUnion || !bothUnion) && lowerer.eqComparableUnion(ut.unionId)) {
          const plain = left.type.kind === "union" ? right : left;
          const arms = lowerer.unions.get(ut.unionId)?.arms ?? [];
          // The plain side wraps into the union exactly like === when the
          // union holds its type; a plain PRIMITIVE the union has no arm
          // for is the disjoint constant false (coercing it would strand).
          if (bothUnion || arms.some((a) => typeEquals(a, plain.type))) {
            const sameValue = arms.some((a) => a.kind === "f64");
            return {
              kind: "unionEq",
              unionId: ut.unionId,
              negated: false,
              sameValue,
              left: lowerer.coerceInto(leftNode, left, ut),
              right: lowerer.coerceInto(rightNode, right, ut),
              type: BOOL,
              loc,
            };
          }
          if (
            plain.type.kind === "f64" || plain.type.kind === "string" ||
            plain.type.kind === "bool" || isUnitType(plain.type)
          ) {
            return objectIsDisjointFalse(left, right, loc);
          }
        }
        lowerer.noLowering(
          "Object.is over these union operands",
          call,
          `union-typed comparisons need one comparable shape (${NARROW_FIRST})`,
        );
      }
      // Reference kinds: pointer identity — exactly strict equality
      // (hierarchy-related classes widen the derived side first).
      let idLeft = left;
      let idRight = right;
      if (left.type.kind === "object" && right.type.kind === "object") {
        if (lowerer.isSubclassOf(left.type.className, right.type.className)) {
          idLeft = lowerer.upcastTo(left, right.type.className);
        } else if (lowerer.isSubclassOf(right.type.className, left.type.className)) {
          idRight = lowerer.upcastTo(right, left.type.className);
        }
      }
      if (
        (idLeft.type.kind === "func" && idRight.type.kind === "func") ||
        (idLeft.type.kind === "classval" && idRight.type.kind === "classval")
      ) {
        return { kind: "bin", op: "===", left: idLeft, right: idRight, type: BOOL, loc };
      }
      if (
        (idLeft.type.kind === "array" || idLeft.type.kind === "map" ||
          idLeft.type.kind === "set" || idLeft.type.kind === "object" ||
          idLeft.type.kind === "record" || idLeft.type.kind === "symbol" ||
          idLeft.type.kind === "bytes" || idLeft.type.kind === "promise") &&
        typeEquals(idLeft.type, idRight.type)
      ) {
        return { kind: "bin", op: "===", left: idLeft, right: idRight, type: BOOL, loc };
      }
      // Statically disjoint pairs with a primitive/unit side: SameValue
      // never crosses kinds, so the answer is the constant false.
      const disjoint = new Set(["f64", "string", "bool", "undefinedT", "nullT"]);
      if (lk !== rk && (disjoint.has(lk) || disjoint.has(rk))) {
        return objectIsDisjointFalse(left, right, loc);
      }
      lowerer.noLowering(
        `Object.is over '${lowerer.fmt(left.type)}' and '${lowerer.fmt(right.type)}' operands`,
        call,
        "the operands must share one comparable kind (numbers, strings, booleans, units, one union shape, or one reference type)",
      );
    }
    // Object.create — the null-prototype DICTIONARY (`Object.create(null)`
    // then keyed assignment, the memo-table idiom prettier's index/
    // group-mode maps spell) and, under --dynamic, the engine's own
    // Object.create for engine-held prototypes. Everything else is a
    // NAMED fence: the compiled representations have no prototype chain,
    // and the own-copy stand-in would answer WRONG observably — Node's
    // Object.keys/inspect/JSON of the created object list NO own keys,
    // and mutating the prototype afterwards is visible through the
    // created object (live delegation), which no copy can honor.
    if (member === "create") {
      if (call.arguments.some((a) => ts.isSpreadElement(a))) {
        lowerer.noLowering("Object.create with spread arguments", call);
      }
      if (call.arguments.length >= 2) {
        lowerer.noLowering(
          "Object.create with a properties-descriptor argument",
          call,
          "create first, then assign: const o = Object.create(null); o.k = v",
        );
      }
      if (call.arguments.length !== 1) {
        lowerer.noLowering(`Object.create with ${call.arguments.length} arguments`, call);
      }
      const loc = locOf(call);
      let protoNode: ts.Expression = call.arguments[0]!;
      while (ts.isParenthesizedExpression(protoNode)) protoNode = protoNode.expression;
      const nullProto = protoNode.kind === ts.SyntaxKind.NullKeyword;
      if (lowerer.dynamic) {
        // The checker types the result `any` — an ENGINE value under
        // --dynamic — and the engine's own Object.create answers with
        // REAL prototype semantics: reads delegate LIVE, writes shadow,
        // and inspect renders Node's exact shapes ("[Object: null
        // prototype]" included). null and engine-held (jsval) prototypes
        // route; checked-dynamic (dyn) prototypes keep the named fence —
        // their marshal into the engine is a DEEP COPY, so a later
        // prototype mutation would be invisible through the created
        // object where Node delegates live.
        const objectGlobal = (): IrExpr => ({ kind: "jsOp", op: "globalGet", name: "Object", args: [], type: JSVAL, loc });
        if (nullProto) {
          const nullIn: IrExpr = { kind: "jsOp", op: "nullLit", args: [], type: JSVAL, loc };
          return { kind: "jsOp", op: "callMethod", name: "create", args: [objectGlobal(), nullIn], type: JSVAL, loc };
        }
        const proto = lowerer.lowerExpr(protoNode);
        if (proto.type.kind === "jsval") {
          return { kind: "jsOp", op: "callMethod", name: "create", args: [objectGlobal(), proto], type: JSVAL, loc };
        }
        lowerer.noLowering(
          `Object.create over '${lowerer.fmt(proto.type)}' prototypes`,
          call,
          "prototype reads delegate LIVE in Node (mutating the prototype shows through the created object), which the boundary's deep copy cannot honor — only null and engine-held ('any') prototypes lower",
        );
      }
      if (nullProto) {
        return { kind: "libCall", fn: "dyn.objCreateNullProto", args: [], type: DYN, loc };
      }
      const proto = lowerer.lowerExpr(protoNode);
      lowerer.noLowering(
        `Object.create over '${lowerer.fmt(proto.type)}' prototypes`,
        call,
        "the compiled representations have no prototype chain, and an own-copy would answer wrong observably (Node lists NO own keys on the created object, and prototype mutations show through it live) — only Object.create(null) lowers",
      );
    }
    // `Object.assign(fn, { props })` whose RESULT type maps to the hybrid
    // (function-with-properties) record: the chalk-shape CONSTRUCTOR.
    if (member === "assign") {
      // A schema with statics (lower-schema.ts), members added to a native SqlClient (lower-sql-client.ts), or the
      // hybrid function-with-properties record just below.
      const decorated = lowerObjectAssignSchema(lowerer, call);
      if (decorated) return decorated;
      const sqlClient = lowerSqlClientDecorate(lowerer, call);
      if (sqlClient) return sqlClient;
      const hybrid = lowerObjectAssignHybrid(lowerer, call);
      if (hybrid) return hybrid;
      // `Object.assign({}, lit)` — an EMPTY fresh-literal target and one
      // object-literal source: the result is a fresh object carrying
      // exactly the source literal's properties, which IS the source
      // literal evaluated (both fresh, no alias can tell them apart).
      // Everything else keeps the spread hint (stdlibMemberFence).
      if (call.arguments.length === 2 && !call.arguments.some((a) => ts.isSpreadElement(a))) {
        let target: ts.Expression = call.arguments[0]!;
        while (ts.isParenthesizedExpression(target)) target = target.expression;
        let source: ts.Expression = call.arguments[1]!;
        while (ts.isParenthesizedExpression(source)) source = source.expression;
        if (
          ts.isObjectLiteralExpression(target) && target.properties.length === 0 &&
          ts.isObjectLiteralExpression(source)
        ) {
          return lowerer.lowerExpr(source);
        }
      }
      // `Object.assign(target, ...sources)` into an INDEX-SIGNATURE record
      // (the init-config merge pattern): the keyed-write walk over each
      // source, returning the target — lower-containers owns the matrix.
      const merged = lowerObjectAssignIndexShape(lowerer, call);
      if (merged) return merged;
      // `Object.assign(target, source)` over signature-free RECORDS whose
      // source fields all land on same-named, same-typed target fields
      // (the mockable-clock restore: `Object.assign(mocked,
      // implementations)` over one shape): the per-field copy helper,
      // returning the TARGET — JS's aliasing, the target mutates in
      // place. Undefined-armed source fields copy behind the
      // not-undefined guard (an omitted optional field holds the
      // undefined arm and must not erase the target's value — Node
      // copies own keys only; an EXPLICIT `k: undefined` source diverges,
      // the explicit-undefined-is-absent stance). Everything else keeps
      // the spread hint.
      if (call.arguments.length === 2 && !call.arguments.some((a) => ts.isSpreadElement(a))) {
        const tProbe = probeLower(lowerer, call.arguments[0]!);
        const sProbe = probeLower(lowerer, call.arguments[1]!);
        // CHECKED-DYNAMIC target and source (the JS file-scope
        // object-literal identity story): the runtime dyn copy — own
        // members of the source land on the target, which returns.
        if (tProbe?.type.kind === "dyn") {
          const loc = locOf(call);
          const target = lowerer.lowerExpr(call.arguments[0]!);
          const source = lowerer.coerceToExpected(lowerer.lowerExpr(call.arguments[1]!), DYN);
          if (target.type.kind === "dyn" && source.type.kind === "dyn") {
            return { kind: "libCall", fn: "dyn.assign", args: [target, source], type: DYN, loc };
          }
        }
        if (tProbe?.type.kind === "record" && sProbe?.type.kind === "record") {
          const tShape = lowerer.shapes.get(tProbe.type.shapeId);
          const sShape = lowerer.shapes.get(sProbe.type.shapeId);
          const ok =
            tShape && sShape &&
            !tShape.tuple && !sShape.tuple &&
            !tShape.indexValue && !sShape.indexValue &&
            !shapeHasAccessorSlots(tShape) && !shapeHasAccessorSlots(sShape) &&
            sShape.fields.every((sf) => {
              const tf = tShape.fields.find((x) => x.name === sf.name);
              return tf !== undefined && typeEquals(tf.type, sf.type);
            });
          if (ok) {
            const loc = locOf(call);
            const target = lowerer.lowerExpr(call.arguments[0]!);
            const source = lowerer.lowerExpr(call.arguments[1]!);
            if (target.type.kind === "record" && source.type.kind === "record") {
              const helper = recordAssignHelper(lowerer, target.type.shapeId, source.type.shapeId, loc);
              return { kind: "call", callee: helper, args: [target, source], type: target.type, loc };
            }
          }
        }
      }
      // `Object.assign(target, ...sources)` over a CHECKED-DYNAMIC target
      // — the n-ary/spread form (`Object.assign({}, ...plugins.map(p =>
      // p.options), coreOptions)`, support.js's option-table merge). The
      // sources pack into one fresh dyn array FIRST — plain sources
      // retain in, spread sources flatten through the spread-call walk
      // (V8's exact TypeError texts, the source spelling carried for the
      // nullish form) — so every source evaluates and flattens before any
      // copying (JS's ArgumentListEvaluation: a throwing spread leaves
      // the target untouched), then one runtime walk copies each source's
      // own enumerable keys left to right and answers the TARGET
      // (identity, like JS). Each source must enter the dyn world (dyn
      // already, or dynFrom's JSON-safe conversion — a STATIC array
      // spread copies in at the boundary, the documented aliasing
      // stance); anything else keeps the fence. Targets: dyn values, a
      // FRESH object-literal target (`Object.assign({}, ...)` — no alias
      // exists, so building it as a dyn object instead of a record is
      // unobservable), or a nullish unit (Node's ToObject TypeError
      // throws at the call, catchably); aliased record targets keep the
      // fence — their identity could not survive the conversion.
      if (call.arguments.length >= 1 && !ts.isSpreadElement(call.arguments[0]!)) {
        let targetNode: ts.Expression = call.arguments[0]!;
        while (ts.isParenthesizedExpression(targetNode)) targetNode = targetNode.expression;
        const freshLiteralTarget = ts.isObjectLiteralExpression(targetNode);
        const tProbe = freshLiteralTarget ? null : probeLower(lowerer, call.arguments[0]!);
        const tKind = tProbe?.type.kind;
        if (freshLiteralTarget || tKind === "dyn" || tKind === "nullT" || tKind === "undefinedT") {
          const loc = locOf(call);
          const target = lowerer.lowerExprExpecting(call.arguments[0]!, DYN);
          if (target.type.kind === "dyn") {
            const t = lowerer.declareHiddenLocal("%oat", DYN);
            const p = lowerer.declareHiddenLocal("%oap", DYN);
            const tRef = (): IrExpr => ({ kind: "varRef", localId: t.id, type: DYN, loc });
            const pRef = (): IrExpr => ({ kind: "varRef", localId: p.id, type: DYN, loc });
            const stmts: IrStmt[] = [
              { kind: "varDecl", localId: t.id, init: target, loc },
              { kind: "varDecl", localId: p.id, init: { kind: "dynArrLit", elems: [], type: DYN, loc }, loc },
            ];
            // V8 spells the optimized apply-path texts (the expression
            // named for a nullish source) only when the spread is the
            // SINGLE LAST argument; every other spread position drives
            // the real iterator protocol, whose failure describes the
            // value — the two runtime variants, picked here by position.
            const sources = call.arguments.slice(1);
            const spreadCount = sources.filter((a) => ts.isSpreadElement(a)).length;
            let ok = true;
            for (let i = 0; i < sources.length; i++) {
              const argNode = sources[i]!;
              const spread = ts.isSpreadElement(argNode);
              const srcNode = spread ? argNode.expression : argNode;
              const src = lowerer.coerceToExpected(lowerer.lowerExpr(srcNode), DYN);
              if (src.type.kind !== "dyn") {
                ok = false;
                break;
              }
              const argLoc = locOf(argNode);
              const optimized = spreadCount === 1 && i === sources.length - 1;
              stmts.push({
                kind: "exprStmt",
                expr: spread
                  ? optimized
                    ? {
                        kind: "libCall",
                        fn: "dyn.packPushSpread",
                        args: [pRef(), src, { kind: "strLit", value: srcNode.getText(), type: STRING, loc: argLoc }],
                        type: VOID,
                        loc: argLoc,
                      }
                    : { kind: "libCall", fn: "dyn.packPushSpreadIter", args: [pRef(), src], type: VOID, loc: argLoc }
                  : { kind: "libCall", fn: "dyn.packPush", args: [pRef(), src], type: VOID, loc: argLoc },
                loc: argLoc,
              });
            }
            if (ok) {
              return {
                kind: "seqExpr",
                stmts,
                result: { kind: "libCall", fn: "dyn.assignAll", args: [tRef(), pRef()], type: DYN, loc },
                type: DYN,
                loc,
              };
            }
          }
        }
      }
      return null;
    }
    // Object.defineProperty over a CHECKED-DYNAMIC target or a boxable
    // compiled closure. Reuse the defineProperties runtime operation with
    // a one-entry descriptor map: FUNC property tables live on the closure
    // itself, so later boxes of the same function observe the property.
    // Literal string keys cover the component/displayName idiom without
    // pretending that arbitrary PropertyKey coercion is implemented.
    if (member === "defineProperty" && call.arguments.length === 3 &&
        !call.arguments.some((a) => ts.isSpreadElement(a))) {
      const keyNode = call.arguments[1]!;
      if (ts.isStringLiteralLike(keyNode)) {
        let target = probeLower(lowerer, call.arguments[0]!);
        if (
          target && target.type.kind === "func" &&
          canBoxFuncIntoDyn(target.type, (id) => lowerer.shapes.get(id), (id) => lowerer.unions.get(id))
        ) {
          target = { kind: "dynFrom", value: target, type: DYN, loc: locOf(call.arguments[0]!) };
        }
        if (target?.type.kind === "dyn") {
          const descriptor = lowerer.lowerExprExpecting(call.arguments[2]!, DYN);
          if (descriptor.type.kind === "dyn") {
            const loc = locOf(call);
            const descriptors: IrExpr = {
              kind: "dynObjLit",
              fields: [{
                key: { kind: "strLit", value: keyNode.text, type: STRING, loc: locOf(keyNode) },
                value: descriptor,
              }],
              type: DYN,
              loc,
            };
            return { kind: "libCall", fn: "dyn.defineProps", args: [target, descriptors], type: DYN, loc };
          }
        }
      }
      return null;
    }
    // Object.defineProperties over a CHECKED-DYNAMIC target (test/common's
    // _mustCallInner copying name/length onto the mustCall wrapper): the
    // runtime turns each descriptor's `value` into a plain own property on
    // the dyn node (OBJ members; FUNC nodes carry an own-property table) —
    // flags accepted and ignored, accessors throw loudly (SEMANTICS.md).
    // The result is the target, like JS. Typed targets keep the fence:
    // static shapes have no property table to extend.
    if (member === "defineProperties" && call.arguments.length === 2 &&
        !call.arguments.some((a) => ts.isSpreadElement(a))) {
      let target = probeLower(lowerer, call.arguments[0]!);
      // A FUNCTION-typed target boxes through the dyn boundary: the
      // property table lives on the CLOSURE (shared by every box of this
      // function value), so defining through a fresh box sticks — the
      // wrapper returned later reads the same table.
      if (
        target && target.type.kind === "func" &&
        canBoxFuncIntoDyn(target.type, (id) => lowerer.shapes.get(id), (id) => lowerer.unions.get(id))
      ) {
        target = { kind: "dynFrom", value: target, type: DYN, loc: locOf(call.arguments[0]!) };
      }
      if (target?.type.kind === "dyn") {
        const descs = lowerer.lowerExprExpecting(call.arguments[1]!, DYN);
        if (descs.type.kind === "dyn") {
          return { kind: "libCall", fn: "dyn.defineProps", args: [target, descs], type: DYN, loc: locOf(call) };
        }
      }
      return null;
    }
    // Object.freeze: on a FRESH literal (object or array) the result IS
    // the argument — no alias exists, so the frozen bit is unobservable
    // (writes through the Readonly<T> result are compile errors, and no
    // other reference can write). Primitives pass through per ES2015.
    // Aliased objects keep a fence: a later write through the original
    // reference would need the runtime frozen bit (strict mode throws).
    if (member === "freeze") {
      if (call.arguments.length !== 1 || ts.isSpreadElement(call.arguments[0]!)) {
        lowerer.noLowering(`Object.freeze with ${call.arguments.length} arguments`, call);
      }
      const argNode = call.arguments[0]!;
      let inner: ts.Expression = argNode;
      while (ts.isParenthesizedExpression(inner) || ts.isAsExpression(inner)) inner = inner.expression;
      const value = lowerer.lowerExpr(argNode);
      if (ts.isObjectLiteralExpression(inner) || ts.isArrayLiteralExpression(inner)) {
        return preserveNativeFreeze(lowerer, value, locOf(call));
      }
      if (
        value.type.kind === "string" || value.type.kind === "f64" ||
        value.type.kind === "bool" || value.type.kind === "symbol" ||
        isUnitType(value.type)
      ) {
        return value; // ES2015: freeze of a primitive is the primitive
      }
      lowerer.noLowering(
        "Object.freeze of a possibly-aliased value",
        call,
        "freeze of a FRESH object/array literal (and of primitives) compiles — frozen-ness is unobservable there; an aliased target's later writes would need the runtime frozen bit",
      );
    }
    // `Object.hasOwn(r, k)` over a RECORD receiver: a record's own-key set
    // is its declared field list, so membership is a compare chain against
    // the field names (interned per shape). Undefined-armed (optional)
    // fields answer by their runtime tag — the explicit-undefined-is-absent
    // stance: an omitted optional field holds the undefined arm and reads
    // as NOT own, exactly Node's absent key (an EXPLICIT `k: undefined`
    // diverges — documented next to the child-env/JSON rule). Index-
    // signature records consult their live overflow-key snapshot. Tuple
    // and accessor-carrying shapes keep the SC2020 fence; non-record
    // receivers do too.
    if (member === "hasOwn" && call.arguments.length === 2 && !call.arguments.some((a) => ts.isSpreadElement(a))) {
      return lowerObjectHasOwnArgs(lowerer, call, call.arguments[0]!, call.arguments[1]!);
    }
    if (member !== "keys" && member !== "values" && member !== "entries") return null;
    if (call.arguments.length !== 1 || ts.isSpreadElement(call.arguments[0]!)) return null;
    const argNode = call.arguments[0]!;
    // A CHECKED-DYNAMIC argument — the checker may still spell a record
    // type (the JS file-scope object-literal identity story stores the
    // dyn object), so the LOWERED value's kind is the dispatch: the
    // runtime walks the dyn node's own keys (integer-like keys first,
    // JS's own-key order) and answers a dyn array.
    {
      const probed = probeLower(lowerer, argNode);
      const isDyn = probed?.type.kind === "dyn";
      const isJsval = probed?.type.kind === "jsval";
      // Unit-typed arguments (Object.keys(null)) ride the same runtime
      // walk: it throws Node's catchable TypeError.
      const isUnit = probed !== null && probed !== undefined && isUnitType(probed.type);
      if (isJsval && member === "keys") {
        const loc = locOf(call);
        const objectGlobal: IrExpr = {
          kind: "jsOp",
          op: "globalGet",
          name: "Object",
          args: [],
          type: JSVAL,
          loc,
        };
        return {
          kind: "jsOp",
          op: "callMethod",
          name: "keys",
          args: [objectGlobal, lowerer.lowerExpr(argNode)],
          type: JSVAL,
          loc,
        };
      }
      if (isDyn || isUnit) {
        const fn = member === "keys" ? "dyn.objKeys" : member === "values" ? "dyn.objValues" : "dyn.objEntries";
        let v = lowerer.lowerExpr(argNode);
        if (v.type.kind !== "dyn") v = { kind: "dynFrom", value: v, type: DYN, loc: locOf(call) };
        return { kind: "libCall", fn, args: [v], type: DYN, loc: locOf(call) };
      }
    }
    let argIr = lowerer.mapTypeOf(lowerer.typeOf(argNode));
    // JS: an unmappable CHECKER type over a value that lowered to a real
    // record (the narrowed export-table literal) — the lowered value's
    // shape is the honest dispatch key, exactly the identity-Set stance.
    if (argIr === null && isJsSourceFile(argNode.getSourceFile())) {
      const probed = probeLower(lowerer, argNode);
      if (probed?.type.kind === "record") argIr = probed.type;
    }
    return lowerTypedObjectIteration(lowerer, call, member, argIr);
  }

/** `Object.assign(fn, { bold, ... })` → a HYBRID record literal: the
   * reserved %call field takes the function, each source object literal's
   * properties fill their declared fields (later sources override, JS's
   * last-write-wins — one entry per name, source values still evaluate in
   * order through the literal lowering's shared rules). Bounded to the
   * chalk shape on purpose: the RESULT type must map to a %call-carrying
   * record, sources must be plain object literals (an `as` cast unwraps),
   * and every declared field must be filled. REPRESENTATION NOTE
   * (SEMANTICS.md): the result is a FRESH record, not the mutated `fn` —
   * `assigned === fn` is false here where JS answers true, and `typeof`
   * would answer object; portless's colors.ts never observes either.
   * Null (→ the stdlib fence) for every other Object.assign form. */
  function lowerObjectAssignHybrid(lowerer: Lowerer, call: ts.CallExpression): IrExpr | null {
    const mapped = lowerer.mapTypeOf(lowerer.typeOf(call));
    if (mapped?.kind !== "record") return null;
    const shape = lowerer.shapes.get(mapped.shapeId);
    const callField = shape?.fields.find((f) => f.name === "%call");
    if (!shape || !callField || callField.type.kind !== "func") return null;
    if (call.arguments.length < 2 || call.arguments.some((a) => ts.isSpreadElement(a))) return null;
    const loc = locOf(call);
    const values = new Map<string, IrExpr>();
    values.set("%call", lowerer.lowerExprExpecting(call.arguments[0]!, callField.type));
    for (const argNode of call.arguments.slice(1)) {
      let src: ts.Expression = argNode;
      while (ts.isParenthesizedExpression(src) || ts.isAsExpression(src) || ts.isTypeAssertion(src)) src = src.expression;
      if (!ts.isObjectLiteralExpression(src)) {
        lowerer.unsupported(
          "SC1090",
          argNode,
          "Object.assign sources other than plain object literals when building a function-with-properties value",
        );
      }
      for (const prop of src.properties) {
        const nameOk =
          (ts.isPropertyAssignment(prop) || ts.isShorthandPropertyAssignment(prop)) &&
          (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name));
        if (!nameOk) {
          lowerer.unsupported(
            "SC1090",
            prop,
            "this property form in an Object.assign source building a function-with-properties value",
          );
        }
        const name = (prop.name as ts.Identifier | ts.StringLiteral).text;
        const fieldType = shape.fields.find((f) => f.name === name)?.type;
        if (!fieldType) {
          lowerer.unsupported(
            "SC1090",
            prop,
            `the property '${name}' missing from the assigned result type '${lowerer.fmt(mapped)}'`,
          );
        }
        const value = ts.isPropertyAssignment(prop)
          ? lowerer.lowerExprExpecting(prop.initializer, fieldType)
          : lowerer.coerceInto(prop, lowerer.lowerShorthandValue(prop as ts.ShorthandPropertyAssignment), fieldType);
        values.set(name, value);
      }
    }
    const fields: { name: string; value: IrExpr }[] = [];
    for (const f of shape.fields) {
      const v = values.get(f.name);
      if (!v) {
        const absent = lowerer.wrappedUndefined(f.type, loc);
        if (!absent) {
          lowerer.unsupported(
            "SC1090",
            call,
            `Object.assign leaving the required field '${f.name}' of '${lowerer.fmt(mapped)}' unfilled`,
          );
        }
        fields.push({ name: f.name, value: absent });
        continue;
      }
      fields.push({ name: f.name, value: v });
    }
    return { kind: "recordLit", fields, type: mapped, loc };
  }
