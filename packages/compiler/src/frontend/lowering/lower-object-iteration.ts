import * as ts from "../ts7/adapter.js";
import { BOOL, DYN, F64, STRING, UNDEFINED_T, VOID, isUnitType, shapeHasAccessorSlots, typeEquals, typeKey } from "../../ir/nodes.js";
import type { IrExpr, IrFunction, IrStmt, IrType } from "../../ir/nodes.js";
import { locOf } from "../program.js";
import type { Lowerer } from "./lowerer.js";
import { objectIterOverIndexShape, type ObjectIterationResult } from "./lower-object-index-iteration.js";
import { recordKeysArrayCall } from "./lower-calls.js";

type ObjectIteration = "keys" | "values" | "entries";
type RecordType = Extract<IrType, { kind: "record" }>;

/** Each arm keeps its own storage and iteration helper. Passing the receiver
 * as one argument evaluates coalescing calls/getters exactly once. */
export function lowerTypedObjectIteration(
  L: Lowerer, call: ts.CallExpression, member: ObjectIteration, argIr: IrType | null,
): IrExpr | null {
  if (argIr?.kind !== "record" && argIr?.kind !== "union") return null;
  const arms = argIr.kind === "union" ? L.unions.get(argIr.unionId)?.arms : undefined;
  if (argIr.kind === "union" && (!arms?.length || !arms.every(arm => arm.kind === "record"))) return null;
  const resultT = L.irTypeOf(call);
  if (resultT.kind !== "array" && !(resultT.kind === "dyn" && member === "values")) L.badType(call, L.typeOf(call));
  const receiver = L.lowerExpr(call.arguments[0]!);
  if (argIr.kind === "record") return lowerRecordIteration(L, call, member, argIr, receiver, resultT);
  const key = `obj.${member}:union:${argIr.unionId}:${typeKey(resultT)}`;
  let helper = L.arrHofHelpers.get(key);
  const loc = locOf(call);
  if (!helper) {
    helper = `%obj.${member}.union.${L.arrHofHelpers.size}`;
    const ref: IrExpr = { kind: "varRef", localId: "r.0", type: argIr, loc };
    const body: IrStmt[] = [];
    for (const [tag, arm] of arms!.entries()) {
      if (arm.kind !== "record") return null;
      const narrowed: IrExpr = { kind: "unionNarrow", unionId: argIr.unionId, tag, value: ref, type: arm, loc };
      const value = lowerRecordIteration(L, call, member, arm, narrowed, resultT);
      if (!value) return null;
      const returned: IrStmt = { kind: "return", value, loc };
      body.push(tag === arms!.length - 1 ? returned : {
        kind: "if",
        cond: { kind: "unionIsTag", unionId: argIr.unionId, tag, negated: false, value: ref, type: BOOL, loc },
        then: [returned], else_: null, loc,
      });
    }
    L.arrHofHelpers.set(key, helper);
    L.liftedFns.push({ name: helper,
      params: [{ localId: "r.0", name: "r", type: argIr }],
      locals: [{ id: "r.0", name: "r", type: argIr, mutable: false }],
      returnType: resultT, body, loc,
    });
  }
  return { kind: "call", callee: helper, args: [receiver], type: resultT, loc };
}

// A heterogeneous Object.values/entries result can be checked-dynamic even
// for typed inputs. Scalar boxing and existing dynamic values cannot copy
// a referenced composite; other typed composites retain the explicit fence.
function scalarObjectValue(L: Lowerer, type: IrType): boolean {
  return type.kind === "union"
    ? L.unions.get(type.unionId)?.arms.every(arm => scalarObjectValue(L, arm)) ?? false
    : ["f64", "bool", "string", "dyn", "nullT", "undefinedT"].includes(type.kind);
}

function lowerRecordIteration(
  L: Lowerer, call: ts.CallExpression, member: ObjectIteration, argIr: RecordType,
  receiver: IrExpr, resultT: ObjectIterationResult,
): IrExpr | null {
    const shape = L.shapes.get(argIr.shapeId);
    if (!shape || shape.tuple) return null; // tuple → the fence
    // Accessor-carrying shapes: Node's answer includes the accessor NAMES
    // (own enumerable properties) and — for values/entries — the getter
    // RESULTS, invoked in key order. The static field walk models neither
    // (accessor slots live outside declaredOrder), so the surface fences.
    if (shapeHasAccessorSlots(shape)) {
      L.unsupported(
        "SC1090",
        call,
        `Object.${member} over a shape carrying get/set accessor properties (Node lists the accessor names${member === "keys" ? "" : " and invokes the getters"} — the static key walk cannot; read the properties explicitly)`,
      );
    }
    if (shape.indexValue) {
      // Index-signature (overflow-carrying) shapes: the runtime walk —
      // declared fields first, then the overflow in JS own-key order
      // (lowerObjectIterOverIndexShape in lower-containers).
      return objectIterOverIndexShape(L, call, member, argIr, shape, receiver, resultT, locOf(call));
    }
    const loc = locOf(call);
    if (member === "keys") {
      // The keys walk is shared with for-in (which iterates exactly the
      // keys Object.keys answers — one construction, one intern key).
      return recordKeysArrayCall(L, receiver, argIr, shape, loc);
    }

    // The result-element type each field's value flows into: string for
    // keys, the checker's value union for values, the [string, V] tuple's
    // "1" field for entries.
    let valueT: IrType | null = null;
    let tupleT: (IrType & { kind: "record" }) | null = null;
    if (member === "values") valueT = resultT.kind === "dyn" ? DYN : resultT.elem;
    if (member === "entries") {
      if (resultT.kind !== "array" || resultT.elem.kind !== "record") L.badType(call, L.typeOf(call));
      tupleT = resultT.elem;
      const tupleShape = L.shapes.get(resultT.elem.shapeId);
      if (!tupleShape?.tuple || tupleShape.fields.length !== 2) L.badType(call, L.typeOf(call));
      valueT = tupleShape.fields.find((f) => f.name === "1")!.type;
    }

    const key = `obj.${member}:${argIr.shapeId}:${typeKey(resultT)}`;
    let helper = L.arrHofHelpers.get(key);
    if (!helper) {
      helper = `%obj.${member}.${L.arrHofHelpers.size}`;
      const recT = argIr;
      const ref: IrExpr = { kind: "varRef", localId: "r.0", type: recT, loc };
      const outRef: IrExpr = { kind: "varRef", localId: "out.0", type: resultT, loc };
      L.arrHofHelpers.set(key, helper);
      const fn: IrFunction = {
        name: helper,
        params: [{ localId: "r.0", name: "r", type: recT }],
        returnType: resultT,
        locals: [
          { id: "r.0", name: "r", type: recT, mutable: true },
          { id: "out.0", name: "out", type: resultT, mutable: false },
        ],
        body: [],
        loc,
      };
      const finalize = (): void => {
        const current = L.shapes.get(argIr.shapeId) ?? shape;
        const body: IrStmt[] = [
          { kind: "varDecl", localId: "out.0", init: resultT.kind === "dyn" ? { kind: "dynArrLit", elems: [], type: DYN, loc } : { kind: "arrayLit", elems: [], type: resultT, loc }, loc },
        ];
        const order = current.declaredOrder ?? current.fields.map((f) => f.name);
        for (const name of order) {
          const f = current.fields.find((x) => x.name === name)!;
          const raw: IrExpr = { kind: "recordGet", obj: ref, shapeId: argIr.shapeId, field: f.name, type: f.type, loc };
          // The pushed element per member; null when the field's value
          // cannot flow into the result element type.
          const elemOf = (value: IrExpr, vt: IrType): IrExpr | null => {
            if (!valueT) return null;
            if (typeEquals(vt, valueT)) return value;
            if (valueT.kind === "dyn" && scalarObjectValue(L, vt)) {
              return { kind: "dynFrom", value, type: DYN, loc };
            }
            if (valueT.kind === "union" && vt.kind !== "union") {
              const tag = L.armTag(valueT.unionId, vt);
              if (tag >= 0) {
                return { kind: "unionWrap", unionId: valueT.unionId, tag, value, type: valueT, loc };
              }
            }
            return null;
          };
          // Undefined-armed fields: the push is guarded by a tag test, and
          // the pushed value is the narrowed non-undefined arm.
          let guardUndefTag: number | null = null;
          let value: IrExpr = raw;
          let vt: IrType = f.type;
          if (f.type.kind === "union") {
            const undefTag = L.armTag(f.type.unionId, UNDEFINED_T);
            if (undefTag >= 0) {
              guardUndefTag = undefTag;
              const arms = L.unions.get(f.type.unionId)?.arms ?? [];
              const others = arms.filter((a) => a.kind !== "undefinedT");
              if (typeEquals(f.type, valueT ?? f.type) || (valueT?.kind === "dyn" && scalarObjectValue(L, f.type))) {
              // The field union IS the result union (single-field shapes):
              // push the raw box — but then the undefined skip must NOT
              // narrow. Handled below via vt === valueT.
                value = raw;
                vt = f.type;
              } else if (others.length === 1) {
                vt = others[0]!;
              // A UNIT other arm (`null | undefined` fields — the mixed-
              // defaults spread idiom; undefined was filtered above, so
              // the unit is null): units carry no payload, so the guarded
              // push writes the unit LITERAL — unionNarrow to a unit arm
              // (and unionWrap of a narrowed unit) is malformed IR; the
              // literal is the one legal unit spelling.
                value = isUnitType(vt)
                  ? { kind: "unitLit", unit: "null", type: vt, loc }
                  : { kind: "unionNarrow", unionId: f.type.unionId, tag: L.armTag(f.type.unionId, vt), value: raw, type: vt, loc };
              } else {
                L.unsupported(
                  "SC1090",
                  call,
                  `Object.${member} over '${L.fmt(argIr)}' (field '${f.name}' is a multi-arm union that ` +
                    "cannot re-tag into the result element type — read the fields directly)",
                );
              }
            } else if (!typeEquals(f.type, valueT ?? f.type) && !(valueT?.kind === "dyn" && scalarObjectValue(L, f.type))) {
              L.unsupported(
                "SC1090",
                call,
                `Object.${member} over '${L.fmt(argIr)}' (field '${f.name}' is a union that cannot ` +
                  "re-tag into the result element type — read the fields directly)",
              );
            }
          }
          const coerced = elemOf(value, vt);
          if (!coerced) {
            L.unsupported(
              "SC1090",
              call,
              `Object.${member} over '${L.fmt(argIr)}' (field '${f.name}' of type '${L.fmt(f.type)}' ` +
                `cannot flow into the '${L.fmt(valueT!)}' result element — read the fields directly)`,
            );
          }
          const pushed: IrExpr =
            member === "values"
              ? coerced
              : {
                  kind: "recordLit",
                  fields: [
                    { name: "0", value: { kind: "strLit", value: f.name, type: STRING, loc } },
                    { name: "1", value: coerced },
                  ],
                  type: tupleT!,
                  loc,
                };
          const pushStmt: IrStmt = {
            kind: "exprStmt",
            expr: resultT.kind === "dyn"
              ? { kind: "libCall", fn: "dyn.packPush", args: [outRef, pushed], type: VOID, loc }
              : { kind: "arrIntrinsic", method: "push", receiver: outRef, args: [pushed], type: F64, loc },
            loc,
          };
          body.push(
            guardUndefTag !== null && f.type.kind === "union"
              ? {
                  kind: "if",
                  cond: { kind: "unionIsTag", unionId: f.type.unionId, tag: guardUndefTag, negated: true, value: raw, type: BOOL, loc },
                  then: [pushStmt],
                  else_: null,
                  loc,
                }
              : pushStmt,
          );
        }
        body.push({ kind: "return", value: outRef, loc });
        fn.body = body;
      };
      finalize();
      L.shapeOrderHelperFinalizers.push(finalize);
      L.liftedFns.push(fn);
    }
    return { kind: "call", callee: helper, args: [receiver], type: resultT, loc };
  }
