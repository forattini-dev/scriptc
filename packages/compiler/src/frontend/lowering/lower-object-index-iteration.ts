import type * as ts from "../ts7/adapter.js";
import { BOOL, DYN, F64, STRING, UNDEFINED_T, VOID, arrayOf, isUnitType, typeEquals, typeKey } from "../../ir/nodes.js";
import type { IrExpr, IrFunction, IrRecordShape, IrStmt, IrType, SrcLoc } from "../../ir/nodes.js";
import { countedFor, varRef } from "../../ir/build.js";
import type { Lowerer } from "./lowerer.js";

export type ObjectIterationResult = Extract<IrType, { kind: "array" | "dyn" }>;

/** `Object.keys/values/entries` over an INDEX-SIGNATURE (overflow-carrying)
   * record shape: declared fields answer first from the compile-time field
   * list (declaration order, undefined-valued fields skipped — exactly the
   * fixed-shape lowering and SEMANTICS.md 37), then the overflow map's live
   * keys in JS OWN-KEY order (canonical array indices ascending, then
   * insertion order — recordOvfKeys). For a PURE index-signature shape
   * (Record<string, T> — no declared fields, the typical CLI config patterns) the
   * result order is Node-exact; hybrids inherit the documented
   * declared-then-overflow divergence. Values surface as the checker's
   * result element type: identity, an arm-into-union wrap, or (dyn
   * results) the dyn conversion — recordKeyGet's own surfacing rules for
   * the overflow, mirrored statically for declared fields. */
  /** The construction core, receiver/result pre-resolved — `node` anchors
   * the fences. for-in reuses the "keys" arm directly (it iterates exactly
   * the keys Object.keys answers; same intern key, one helper). */
  export function objectIterOverIndexShape(L: Lowerer, node: ts.Node,
    member: "keys" | "values" | "entries",
    argIr: IrType & { kind: "record" },
    shape: IrRecordShape,
    receiver: IrExpr,
    resultT: ObjectIterationResult,
    loc: SrcLoc,): IrExpr {
    const iv = shape.indexValue!;

    // The result-element type values flow into (string for keys, the
    // checker's element for values, the [string, V] tuple's "1" for
    // entries).
    let valueT: IrType | null = null;
    let tupleT: (IrType & { kind: "record" }) | null = null;
    if (member === "values") valueT = resultT.kind === "dyn" ? DYN : resultT.elem;
    if (member === "entries") {
      if (resultT.kind !== "array" || resultT.elem.kind !== "record") L.badType(node, L.typeOf(node as ts.Expression));
      tupleT = resultT.elem;
      const tupleShape = L.shapes.get(resultT.elem.shapeId);
      if (!tupleShape?.tuple || tupleShape.fields.length !== 2) L.badType(node, L.typeOf(node as ts.Expression));
      valueT = tupleShape.fields.find((f) => f.name === "1")!.type;
    }

    // JS lists integer-like OWN keys first regardless of where they live;
    // the declared-then-overflow order can only honor that when no
    // DECLARED field name is integer-like (the overflow walk handles its
    // own). Shapes that mix one in keep a fence, not a silent reorder.
    const arrayIndexRe = /^(0|[1-9][0-9]{0,9})$/;
    if (shape.fields.some((f) => arrayIndexRe.test(f.name) && Number(f.name) <= 4294967294)) {
      L.unsupported(
        "SC1090",
        node,
        `Object.${member} over '${L.fmt(argIr)}' (a declared field name is integer-like — JS orders integer keys first, across declared and overflow keys)`,
      );
    }
    // The overflow value must surface as the element type (identity, an
    // arm of a union element, or a dyn element over a dyn signature).
    if (valueT) {
      const ivSurfaces =
        typeEquals(iv, valueT) ||
        (valueT.kind === "union" && L.armTag(valueT.unionId, iv) >= 0) ||
        (valueT.kind === "dyn" && iv.kind === "dyn");
      if (!ivSurfaces) {
        L.unsupported(
          "SC1090",
          node,
          `Object.${member} over '${L.fmt(argIr)}' (the index signature's '${L.fmt(iv)}' value cannot flow into the '${L.fmt(valueT)}' result element)`,
        );
      }
    }

    const key = `obj.${member}:ovf:${argIr.shapeId}:${typeKey(resultT)}`;
    let helper = L.arrHofHelpers.get(key);
    if (!helper) {
      helper = `%obj.${member}.${L.arrHofHelpers.size}`;

      const outRef = varRef("out.0", resultT, loc);
      const rRef = varRef("r.0", argIr, loc);
      const push = (value: IrExpr): IrStmt => ({
        kind: "exprStmt",
        expr: resultT.kind === "dyn"
          ? { kind: "libCall", fn: "dyn.packPush", args: [outRef, value], type: VOID, loc }
          : { kind: "arrIntrinsic", method: "push", receiver: outRef, args: [value], type: F64, loc },
        loc,
      });
      const body: IrStmt[] = [
        { kind: "varDecl", localId: "out.0", init: resultT.kind === "dyn" ? { kind: "dynArrLit", elems: [], type: DYN, loc } : { kind: "arrayLit", elems: [], type: resultT, loc }, loc },
      ];
      const fieldStmts = new Map<string, IrStmt>();

      // Declared fields, in declaration order. Undefined-valued fields
      // skip at runtime (the unset-optional convention); values surface
      // into the element type or the site fences with the field named.
      const order = shape.declaredOrder ?? shape.fields.map((f) => f.name);
      for (const name of order) {
        const f = shape.fields.find((x) => x.name === name)!;
        const raw: IrExpr = { kind: "recordGet", obj: rRef, shapeId: argIr.shapeId, field: f.name, type: f.type, loc };
        const utag = f.type.kind === "union" ? L.armTag(f.type.unionId, UNDEFINED_T) : -1;
        // The pushed value per member; null when the field cannot surface.
        const surfaced = (): IrExpr | null => {
          if (!valueT) return null;
          if (typeEquals(f.type, valueT)) return raw;
          if (valueT.kind === "dyn") {
            return L.dynConvertible(f.type) ? { kind: "dynFrom", value: raw, type: DYN, loc } : null;
          }
          if (valueT.kind === "union") {
            const tag = L.armTag(valueT.unionId, f.type);
            if (tag >= 0) return { kind: "unionWrap", unionId: valueT.unionId, tag, value: raw, type: valueT, loc };
            // An undefined-armed field union whose ONE other arm is an
            // element arm: narrow (the undefined case is guard-skipped),
            // then wrap.
            if (utag >= 0 && f.type.kind === "union") {
              const others = (L.unions.get(f.type.unionId)?.arms ?? []).filter((a) => a.kind !== "undefinedT");
              if (others.length === 1) {
                const otherTag = L.armTag(valueT.unionId, others[0]!);
                const narrowTag = L.armTag(f.type.unionId, others[0]!);
                if (otherTag >= 0 && narrowTag >= 0) {
                  const other = others[0]!;
                  // A UNIT other arm pushes the unit LITERAL (undefined
                  // was filtered above, so the unit is null; units carry
                  // no payload and narrowing to a unit arm is malformed
                  // IR) — the fixed-shape helper's rule exactly.
                  const narrowed: IrExpr = isUnitType(other)
                    ? { kind: "unitLit", unit: "null", type: other, loc }
                    : { kind: "unionNarrow", unionId: f.type.unionId, tag: narrowTag, value: raw, type: other, loc };
                  return { kind: "unionWrap", unionId: valueT.unionId, tag: otherTag, value: narrowed, type: valueT, loc };
                }
              }
            }
          }
          return null;
        };
        let pushed: IrExpr;
        if (member === "keys") {
          pushed = { kind: "strLit", value: f.name, type: STRING, loc };
        } else {
          const s = surfaced();
          if (!s) {
            L.unsupported(
              "SC1090",
              node,
              `Object.${member} over '${L.fmt(argIr)}' (field '${f.name}' of type '${L.fmt(f.type)}' cannot flow into the '${L.fmt(valueT!)}' result element — read the fields directly)`,
            );
          }
          pushed =
            member === "values"
              ? s
              : {
                  kind: "recordLit",
                  fields: [
                    { name: "0", value: { kind: "strLit", value: f.name, type: STRING, loc } },
                    { name: "1", value: s },
                  ],
                  type: tupleT!,
                  loc,
                };
        }
        const fieldStmt: IrStmt =
          utag >= 0 && f.type.kind === "union"
            ? {
                kind: "if",
                cond: { kind: "unionIsTag", unionId: f.type.unionId, tag: utag, negated: true, value: raw, type: BOOL, loc },
                then: [push(pushed)],
                else_: null,
                loc,
              }
            : push(pushed);
        fieldStmts.set(f.name, fieldStmt);
        body.push(fieldStmt);
      }

      // The overflow walk: a fresh key snapshot in JS own-key order, each
      // value read back through the overflow-only keyed read (declared
      // names never live in the overflow map).
      const ksT = arrayOf(STRING);
      const ksRef = varRef("ks.0", ksT, loc);
      const kRef = varRef("k.0", STRING, loc);
      const readValue: IrExpr | null = valueT
        ? { kind: "recordKeyGet", obj: rRef, shapeId: argIr.shapeId, key: kRef, overflowOnly: true, type: valueT, loc }
        : null;
      const loopPushed: IrExpr =
        member === "keys"
          ? kRef
          : member === "values"
            ? readValue!
            : {
                kind: "recordLit",
                fields: [
                  { name: "0", value: kRef },
                  { name: "1", value: readValue! },
                ],
                type: tupleT!,
                loc,
              };
      body.push(
        { kind: "varDecl", localId: "ks.0", init: { kind: "recordOvfKeys", obj: rRef, shapeId: argIr.shapeId, type: ksT, loc }, loc },
        countedFor(loc, { kind: "arrIntrinsic", method: "length", receiver: ksRef, args: [], type: F64, loc }, () => [
            { kind: "varDecl", localId: "k.0", init: { kind: "arrayGet", arr: ksRef, index: varRef("i.0", F64, loc), type: STRING, loc }, loc },
            push(loopPushed),
          ],
        ),
        { kind: "return", value: outRef, loc },
      );
      const suffix = body.slice(1 + fieldStmts.size);
      L.arrHofHelpers.set(key, helper);
      const fn: IrFunction = {
        name: helper,
        params: [{ localId: "r.0", name: "r", type: argIr }],
        returnType: resultT,
        locals: [
          { id: "r.0", name: "r", type: argIr, mutable: true },
          { id: "out.0", name: "out", type: resultT, mutable: false },
          { id: "ks.0", name: "ks", type: ksT, mutable: false },
          { id: "i.0", name: "i", type: F64, mutable: true },
          { id: "k.0", name: "k", type: STRING, mutable: false },
        ],
        body,
        loc,
      };
      L.shapeOrderHelperFinalizers.push(() => {
        const current = L.shapes.get(argIr.shapeId) ?? shape;
        const currentOrder = current.declaredOrder ?? current.fields.map((f) => f.name);
        fn.body = [body[0]!, ...currentOrder.flatMap((name) => {
          const stmt = fieldStmts.get(name);
          return stmt ? [stmt] : [];
        }), ...suffix];
      });
      L.liftedFns.push(fn);
    }
    return { kind: "call", callee: helper, args: [receiver], type: resultT, loc };
  }

