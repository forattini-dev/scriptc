import * as ts from "../ts7/adapter.js";
import { arrayOf, BOOL, F64, STRING, UNDEFINED_T, shapeHasAccessorSlots, type IrExpr, type IrLocal, type IrStmt, type IrType, type SrcLoc } from "../../ir/ir.js";
import { countedFor, varRef } from "../../ir/build.js";
import { nativeRecordShapeSupported } from "../../ir/native-record.js";
import { locOf } from "../program.js";
import { probeLower } from "./lower-exprs.js";
import type { Lowerer } from "./lowerer.js";

  /** Interned `%obj.hasOwn.<n>(r, k)` — Object.hasOwn's membership walk
   * over a record shape: the key compares against each
   * declared field name, undefined-armed fields answering by their tag
   * (a key is own exactly when Object.keys would list it — the two share
   * the guard), everything else true. Index-signature overflow keys then
   * consult their live key snapshot; a signature-free no-match is false. */
  function recordHasOwnHelper(lowerer: Lowerer, shapeId: string, loc: SrcLoc, own = true): string {
    const operation = own ? "obj.hasOwn" : "rec.hasIn";
    const key = `${operation}:${shapeId}`;
    const existing = lowerer.arrHofHelpers.get(key);
    if (existing) return existing;
    const helper = `%${operation}.${lowerer.arrHofHelpers.size}`;
    lowerer.arrHofHelpers.set(key, helper);
    const shape = lowerer.shapes.get(shapeId);
    if (!shape) throw new Error(`scriptc: unknown membership record '${shapeId}'`);
    const recT: IrType = { kind: "record", shapeId };
    const rRef: IrExpr = { kind: "varRef", localId: "r.0", type: recT, loc };
    const kRef: IrExpr = { kind: "varRef", localId: "k.0", type: STRING, loc };
    const body: IrStmt[] = [];
    for (const f of shape.fields) {
      const utag = f.type.kind === "union" ? lowerer.armTag(f.type.unionId, UNDEFINED_T) : -1;
      const answer: IrExpr =
        utag >= 0 && f.type.kind === "union"
          ? {
              kind: "unionIsTag",
              unionId: f.type.unionId,
              tag: utag,
              negated: true,
              value: { kind: "recordGet", obj: rRef, shapeId, field: f.name, type: f.type, loc },
              type: BOOL,
              loc,
            }
          : { kind: "boolLit", value: true, type: BOOL, loc };
      body.push({
        kind: "if",
        cond: { kind: "strEq", negated: false, left: kRef, right: { kind: "strLit", value: f.name, type: STRING, loc }, type: BOOL, loc },
        then: [{ kind: "return", value: answer, loc }],
        else_: null,
        loc,
      });
    }
    const locals: IrLocal[] = [
      { id: "r.0", name: "r", type: recT, mutable: true },
      { id: "k.0", name: "k", type: STRING, mutable: false },
    ];
    if (shape.indexValue) {
      const keysT = arrayOf(STRING);
      locals.push({ id: "ks.0", name: "ks", type: keysT, mutable: false });
      body.push({
        kind: "varDecl",
        localId: "ks.0",
        init: { kind: "recordOvfKeys", obj: rRef, shapeId, type: keysT, loc },
        loc,
      });
      body.push({
        kind: "return",
        value: {
          kind: "arrIntrinsic",
          method: "includes",
          receiver: { kind: "varRef", localId: "ks.0", type: keysT, loc },
          args: [kRef],
          type: BOOL,
          loc,
        },
        loc,
      });
    } else {
      body.push({ kind: "return", value: { kind: "boolLit", value: false, type: BOOL, loc }, loc });
    }
    lowerer.liftedFns.push({
      name: helper,
      params: own ? [
        { localId: "r.0", name: "r", type: recT },
        { localId: "k.0", name: "k", type: STRING },
      ] : [
        { localId: "k.0", name: "k", type: STRING },
        { localId: "r.0", name: "r", type: recT },
      ],
      returnType: BOOL,
      locals,
      body,
      loc,
    });
    return helper;
  }

/** Preserve membership as an operation until Rust plans shared storage.
 * A later checked view can be a Proxy; field presence cannot be inferred
 * from its asserted type and optional fields must not trigger Get. Static
 * records retain the existing helper body in every backend. */
export function lowerTypedRecordIn(lowerer: Lowerer, receiver: IrExpr, key: IrExpr, loc: SrcLoc): IrExpr | null {
  const supported = (type: IrType): boolean => {
    const shape = type.kind === "record" ? lowerer.shapes.get(type.shapeId) : undefined;
    return !!shape && !shape.tuple && nativeRecordShapeSupported(shape, lowerer.unions, id => lowerer.shapes.get(id));
  };
  if (key.type.kind !== "string") return null;
  if (receiver.type.kind === "record" && supported(receiver.type)) {
    return { kind: "call", callee: recordHasOwnHelper(lowerer, receiver.type.shapeId, loc, false), args: [key, receiver], type: BOOL, loc };
  }
  const union = receiver.type.kind === "union" ? lowerer.unions.get(receiver.type.unionId) : undefined;
  if (!union || union.arms.length === 0 || !union.arms.every(supported)) return null;
  const cacheKey = `rec.hasInUnion:${union.id}`;
  let helper = lowerer.arrHofHelpers.get(cacheKey);
  if (!helper) {
    helper = `%rec.hasInUnion.${lowerer.arrHofHelpers.size}`;
    lowerer.arrHofHelpers.set(cacheKey, helper);
    const r = varRef("r.0", receiver.type, loc), k = varRef("k.0", STRING, loc);
    const body: IrStmt[] = union.arms.map((arm, tag) => {
      const value = lowerTypedRecordIn(lowerer, { kind: "unionNarrow", unionId: union.id, tag, value: r, type: arm, loc }, k, loc);
      if (!value) throw new Error("scriptc: admitted membership arm lost its record shape");
      return { kind: "if", cond: { kind: "unionIsTag", unionId: union.id, tag, negated: false, value: r, type: BOOL, loc }, then: [{ kind: "return", value, loc }], else_: null, loc };
    });
    body.push({ kind: "return", value: { kind: "boolLit", value: false, type: BOOL, loc }, loc });
    lowerer.liftedFns.push({ name: helper, params: [{ localId: "k.0", name: "k", type: STRING }, { localId: "r.0", name: "r", type: receiver.type }],
      locals: [{ id: "k.0", name: "k", type: STRING, mutable: false }, { id: "r.0", name: "r", type: receiver.type, mutable: false }], returnType: BOOL, body, loc });
  }
  return { kind: "call", callee: helper, args: [key, receiver], type: BOOL, loc };
}

  /** Shared Object.hasOwn / legacy hasOwnProperty.call lowering. Both
   * forms perform ToPropertyKey and the same own-membership test. */
  export function lowerObjectHasOwnArgs(lowerer: Lowerer, call: ts.CallExpression,
    recvNode: ts.Expression, keyNode: ts.Expression,): IrExpr | null {
    const probed = probeLower(lowerer, recvNode);
    // A CHECKED-DYNAMIC receiver (the JS file-scope object-literal
    // identity story): the runtime dyn probe — OBJ member presence, ARR
    // index bounds, Node's ToObject TypeError on nullish.
    if (probed?.type.kind === "dyn") {
      const loc = locOf(call);
      const receiver = lowerer.lowerExpr(recvNode);
      let key = lowerer.lowerExpr(keyNode);
      if (key.type.kind === "f64" || key.type.kind === "bool" || key.type.kind === "dyn") {
        key = { kind: "toString", operand: key, type: STRING, loc: locOf(keyNode) };
      }
      if (key.type.kind !== "string") return null;
      return { kind: "libCall", fn: "dyn.hasOwn", args: [receiver, key], type: BOOL, loc };
    }
    if (probed?.type.kind !== "record") return null;
    const shape = lowerer.shapes.get(probed.type.shapeId);
    if (!shape || shape.tuple || shapeHasAccessorSlots(shape)) return null;
    const loc = locOf(call);
    const receiver = lowerer.lowerExpr(recvNode);
    if (receiver.type.kind !== "record") return null; // probe/lower drift: keep the fence
    let key = lowerer.lowerExpr(keyNode);
    // Number/boolean/dyn keys stringify — ToPropertyKey, the keyed-write
    // path's rule; symbol and composite keys keep the fence.
    if (key.type.kind === "f64" || key.type.kind === "bool" || key.type.kind === "dyn") {
      key = { kind: "toString", operand: key, type: STRING, loc: locOf(keyNode) };
    }
    if (key.type.kind !== "string") return null;
    const helper = recordHasOwnHelper(lowerer, receiver.type.shapeId, loc);
    return { kind: "call", callee: helper, args: [receiver, key], type: BOOL, loc };
  }

/** The runtime-key `in` (see lowerInExpression): `k in r` where k is a
   * runtime string and r an index-signature record — an interned
   * `%rec.haskey.<n>(k, r)` walks the declared names (a string-equality
   * chain: non-optional fields and accessor slots answer true, optional
   * slots answer their per-value tag test) and then the overflow map's
   * live keys. Null when the pair is outside that shape (the caller keeps
   * its fence). */
  export function lowerRuntimeKeyIn(lowerer: Lowerer, expr: ts.BinaryExpression, loc: SrcLoc): IrExpr | null {
    if (lowerer.mapTypeOf(lowerer.typeOf(expr.left))?.kind !== "string") return null;
    const recvT = lowerer.mapTypeOf(lowerer.typeOf(expr.right));
    if (recvT?.kind !== "record") return null;
    const shape = lowerer.shapes.get(recvT.shapeId);
    if (!shape?.indexValue || shape.tuple) return null;
    const keyIr = lowerer.lowerExprExpecting(expr.left, STRING);
    const recv = lowerer.lowerExprExpecting(expr.right, recvT);
    const hkey = `haskey:${recvT.shapeId}`;
    let helper = lowerer.widthHelpers.get(hkey);
    if (!helper) {
      helper = `%rec.haskey.${lowerer.widthHelpers.size}`;
      lowerer.widthHelpers.set(hkey, helper);
      const recT: IrType = { kind: "record", shapeId: recvT.shapeId };

      const k = varRef("k.0", STRING, loc);
      const r = varRef("r.0", recT, loc);
      const body: IrStmt[] = [];
      const ret = (value: IrExpr): IrStmt => ({ kind: "return", value, loc });
      for (const f of shape.fields) {
        const accessor = f.name.startsWith("%get:") || f.name.startsWith("%set:");
        if (f.name.startsWith("%") && !accessor) continue;
        const name = accessor ? f.name.slice(5) : f.name;
        const eq: IrExpr = { kind: "strEq", negated: false, left: k, right: { kind: "strLit", value: name, type: STRING, loc }, type: BOOL, loc };
        const utag = !accessor && f.type.kind === "union" ? lowerer.armTag(f.type.unionId, UNDEFINED_T) : -1;
        const answer: IrExpr =
          utag >= 0 && f.type.kind === "union"
            ? {
                kind: "unionIsTag",
                unionId: f.type.unionId,
                tag: utag,
                negated: true,
                value: { kind: "recordGet", obj: r, shapeId: recvT.shapeId, field: f.name, type: f.type, loc },
                type: BOOL,
                loc,
              }
            : { kind: "boolLit", value: true, type: BOOL, loc };
        body.push({ kind: "if", cond: eq, then: [ret(answer)], else_: null, loc });
      }
      const ksT = arrayOf(STRING);
      body.push(
        { kind: "varDecl", localId: "ks.0", init: { kind: "recordOvfKeys", obj: r, shapeId: recvT.shapeId, type: ksT, loc }, loc },
        countedFor(
          loc,
          { kind: "arrIntrinsic", method: "length", receiver: varRef("ks.0", ksT, loc), args: [], type: F64, loc },
          () => [
            {
              kind: "if",
              cond: { kind: "strEq", negated: false, left: k, right: { kind: "arrayGet", arr: varRef("ks.0", ksT, loc), index: varRef("i.0", F64, loc), type: STRING, loc }, type: BOOL, loc },
              then: [ret({ kind: "boolLit", value: true, type: BOOL, loc })],
              else_: null,
              loc,
            },
          ],
        ),
        ret({ kind: "boolLit", value: false, type: BOOL, loc }),
      );
      lowerer.liftedFns.push({
        name: helper,
        params: [
          { localId: "k.0", name: "k", type: STRING },
          { localId: "r.0", name: "r", type: recT },
        ],
        returnType: BOOL,
        locals: [
          { id: "k.0", name: "k", type: STRING, mutable: true },
          { id: "r.0", name: "r", type: recT, mutable: true },
          { id: "ks.0", name: "ks", type: ksT, mutable: false },
          { id: "i.0", name: "i", type: F64, mutable: true },
        ],
        body,
        loc,
      });
    }
    return { kind: "call", callee: helper, args: [keyIr, recv], type: BOOL, loc };
  }
