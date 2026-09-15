/* Lifting static values into island jsval handles (--dynamic builds): scalars directly; unions, records and arrays
 * through interned marshal helpers. */
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
import { arrayOf, BOOL, canMarshalTypedFuncIntoIsland, isUnitType, JSVAL, STRING, VOID } from "../../ir/ir.js";
import {
  typeKey,
} from "../type-mapper.js";
import type { ExpandoMember } from "./lower-expando.js";
import { numLit, varRef } from "../../ir/build.js";
import type { Lowerer } from "./lowerer.js";

  /** True when a static value can become ONE island value: jsval itself,
   * anything boundary-safe (the deep JSON marshal), a record whose fields
   * all can (built as an island OBJECT literal, field by field), or an
   * array of such (built as an island ARRAY, element by element). The
   * lift beyond boundarySafe exists for jsval-BEARING composites —
   * `{ role: string; content: any[] }[]` flowing into an `any[]` slot —
   * which have no JSON serialization (a handle isn't JSON) but an honest
   * per-field construction. Recursion terminates: recursive shapes are
   * rejected at mapping time. */
  export function jsvalLiftable(lowerer: Lowerer, t: IrType, visiting: Set<string> = new Set()): boolean {
    if (t.kind === "jsval") return true;
    if (lowerer.boundarySafe(t)) return true;
    // Typed arrays and URLs marshal IN without joining the round-trip
    // (JSON) set: an engine typed-array copy / an engine URL from href.
    if (t.kind === "bytes" || t.kind === "url") return true;
    // Checked-dynamic values deep-copy in (scr_jsval_from_dyn — data
    // kinds; a boxed function/handle/promise throws at runtime).
    if (t.kind === "dyn") return true;
    // Marshalable CLOSURES cross as host functions — a record carrying
    // methods (the service-registry entry: `{ label, load: () =>
    // Promise<any>, defaultFallback: (cfg) => any }`) lifts field by
    // field like any other.
    if (t.kind === "func") {
      return canMarshalTypedFuncIntoIsland(t, (id) => lowerer.shapes.get(id), (id) => lowerer.unions.get(id));
    }
    if (t.kind === "record") {
      const shape = lowerer.shapes.get(t.shapeId);
      if (!shape || shape.tuple) return false;
      // Recursive shapes reaching here answer FALSE: this branch is the
      // per-field island lift (jsval/bytes-bearing composites — the
      // JSON-safe ones already answered true through boundarySafe, where
      // a cyclic value throws the circular TypeError at the marshal), and
      // the lift helpers walk values with no circular guard — fencing the
      // TYPE is the honest answer.
      if (visiting.has(t.shapeId)) return false;
      const path = new Set(visiting);
      path.add(t.shapeId);
      // An INDEX-SIGNATURE record lifts when its value slot does (dyn
      // included): declared fields write first, then the overflow keys.
      if (shape.indexValue && !lowerer.jsvalLiftable(shape.indexValue, path)) return false;
      return shape.fields.every((f) => !f.name.startsWith("%") && lowerer.jsvalLiftable(f.type, path));
    }
    if (t.kind === "array") return lowerer.jsvalLiftable(t.elem, visiting);
    // A union crossing IN lifts arm by arm (a runtime tag switch — see
    // unionToJsvalHelper) when every arm does: unit arms become the
    // engine's own undefined/null (which is why bare undefined-armed
    // unions lift here despite being JSON-unsafe), the rest lift as
    // themselves. Arms never nest unions, so this terminates (recursive
    // knots pass through records, guarded above).
    if (t.kind === "union") {
      const def = lowerer.unions.get(t.unionId);
      return !!def && def.arms.every((a) => isUnitType(a) || lowerer.jsvalLiftable(a, visiting));
    }
    return false;
  }

  /** A jsval-typed expression carrying `e`'s value into the island —
   * jsvalLiftable's constructive side. Primitives and JSON-safe composites
   * keep the jsMarshal deep copy; jsval-bearing records and arrays go
   * through interned per-type builder helpers (%jsin.*), so the operand is
   * always evaluated exactly once (as the helper's argument). */
  export function jsvalLiftExpr(lowerer: Lowerer, e: IrExpr, loc: SrcLoc): IrExpr {
    if (e.type.kind === "jsval") return e;
    if (lowerer.boundarySafe(e.type)) {
      return { kind: "jsMarshal", value: e, type: JSVAL, loc };
    }
    if (e.type.kind === "bytes" || e.type.kind === "url") {
      return { kind: "jsMarshal", value: e, type: JSVAL, loc };
    }
    if (e.type.kind === "record") {
      const helper = lowerer.recordToJsvalHelper(e.type.shapeId, loc);
      return { kind: "call", callee: helper, args: [e], type: JSVAL, loc };
    }
    if (e.type.kind === "array") {
      const helper = lowerer.arrayToJsvalHelper(e.type.elem, loc);
      return { kind: "call", callee: helper, args: [e], type: JSVAL, loc };
    }
    if (e.type.kind === "union") {
      const helper = lowerer.unionToJsvalHelper(e.type.unionId, loc);
      return { kind: "call", callee: helper, args: [e], type: JSVAL, loc };
    }
    // Checked-dynamic values and marshalable closures ride jsMarshal
    // directly (the checked-dynamic tree deep copy / the host-function wrap).
    if (e.type.kind === "dyn" || e.type.kind === "func") {
      return { kind: "jsMarshal", value: e, type: JSVAL, loc };
    }
    throw new InternalCompilerError(`lowerer bug: jsvalLiftExpr of unliftable ${e.type.kind}`);
  }

  /** Interned `%jsin.union.<n>(u)` — the runtime tag switch marshaling a
   * union value INTO the island: unit arms become the engine's own
   * undefined/null (JS-exact — `{ instructions: undefined }` crossing in
   * has the property present and undefined, exactly what the source
   * spells), every other arm narrows and lifts as itself (strings by
   * value, JSON-safe composites as deep copies, typed arrays as engine
   * typed-array copies, URLs as engine URL instances). Caller must have
   * checked jsvalLiftable. */
  export function unionToJsvalHelper(lowerer: Lowerer, unionId: string, loc: SrcLoc): string {
    const key = `union:${unionId}`;
    const existing = lowerer.jsinHelpers.get(key);
    if (existing) return existing;
    const def = lowerer.unions.get(unionId);
    if (!def) throw new InternalCompilerError(`lowerer bug: jsval lift of unknown union ${unionId}`);
    const name = `%jsin.union.${lowerer.jsinHelpers.size}`;
    lowerer.jsinHelpers.set(key, name);
    const fromT: IrType = { kind: "union", unionId };
    const u: IrExpr = { kind: "varRef", localId: "u.0", type: fromT, loc };
    const body: IrStmt[] = [];
    def.arms.forEach((arm, i) => {
      const cond: IrExpr = { kind: "unionIsTag", unionId, tag: i, negated: false, value: u, type: BOOL, loc };
      const value: IrExpr = isUnitType(arm)
        ? { kind: "jsOp", op: arm.kind === "undefinedT" ? "undefLit" : "nullLit", args: [], type: JSVAL, loc }
        : lowerer.jsvalLiftExpr({ kind: "unionNarrow", unionId, tag: i, value: u, type: arm, loc }, loc);
      body.push({ kind: "if", cond, then: [{ kind: "return", value, loc }], else_: null, loc });
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
      returnType: JSVAL,
      locals: [{ id: "u.0", name: "u", type: fromT, mutable: true }],
      body,
      loc,
    });
    return name;
  }

  /** Interned `%jsin.rec.<n>(r)` — builds an island OBJECT from a
   * jsval-bearing record: marshaled key strings, each field lifted through
   * jsvalLiftExpr (jsval fields pass as handles, JSON-safe fields deep-copy,
   * nested composites recurse through their own helpers). Caller must have
   * checked jsvalLiftable. */
  export function recordToJsvalHelper(lowerer: Lowerer, shapeId: string, loc: SrcLoc): string {
    const key = `rec:${shapeId}`;
    const existing = lowerer.jsinHelpers.get(key);
    if (existing) return existing;
    const shape = lowerer.shapes.get(shapeId);
    if (!shape) throw new InternalCompilerError(`lowerer bug: jsval lift of unknown shape ${shapeId}`);
    const name = `%jsin.rec.${lowerer.jsinHelpers.size}`;
    lowerer.jsinHelpers.set(key, name);
    const recT: IrType = { kind: "record", shapeId };
    const r: IrExpr = { kind: "varRef", localId: "r.0", type: recT, loc };
    const args: IrExpr[] = [];
    for (const f of shape.fields) {
      args.push({
        kind: "jsMarshal",
        value: { kind: "strLit", value: f.name, type: STRING, loc },
        type: JSVAL,
        loc,
      });
      args.push(
        lowerer.jsvalLiftExpr(
          { kind: "recordGet", obj: r, shapeId, field: f.name, type: f.type, loc },
          loc,
        ),
      );
    }
    const lit: IrExpr = { kind: "jsOp", op: "objLit", args, type: JSVAL, loc };
    if (!shape.indexValue) {
      lowerer.liftedFns.push({
        name,
        params: [{ localId: "r.0", name: "r", type: recT }],
        returnType: JSVAL,
        locals: [{ id: "r.0", name: "r", type: recT, mutable: true }],
        body: [{ kind: "return", value: lit, loc }],
        loc,
      });
      return name;
    }
    // An INDEX-SIGNATURE shape: the declared pairs build the object, then
    // the overflow map's live keys append in JS own-key order (setIdx —
    // runtime keys have no property-name literal).
    const iv = shape.indexValue;
    const f64: IrType = { kind: "f64" };
    const ksT = arrayOf(STRING);

    const kRef = varRef("k.0", STRING, loc);
    lowerer.liftedFns.push({
      name,
      params: [{ localId: "r.0", name: "r", type: recT }],
      returnType: JSVAL,
      locals: [
        { id: "r.0", name: "r", type: recT, mutable: true },
        { id: "out.0", name: "out", type: JSVAL, mutable: false },
        { id: "ks.0", name: "ks", type: ksT, mutable: false },
        { id: "i.0", name: "i", type: f64, mutable: true },
        { id: "k.0", name: "k", type: STRING, mutable: false },
      ],
      body: [
        { kind: "varDecl", localId: "out.0", init: lit, loc },
        { kind: "varDecl", localId: "ks.0", init: { kind: "recordOvfKeys", obj: r, shapeId, type: ksT, loc }, loc },
        {
          kind: "for",
          init: { kind: "varDecl", localId: "i.0", init: numLit(0, loc), loc },
          cond: {
            kind: "bin",
            op: "<",
            left: varRef("i.0", f64, loc),
            right: { kind: "arrIntrinsic", method: "length", receiver: varRef("ks.0", ksT, loc), args: [], type: f64, loc },
            type: BOOL,
            loc,
          },
          update: { kind: "assign", localId: "i.0", value: { kind: "bin", op: "+", left: varRef("i.0", f64, loc), right: numLit(1, loc), type: f64, loc }, loc },
          body: [
            { kind: "varDecl", localId: "k.0", init: { kind: "arrayGet", arr: varRef("ks.0", ksT, loc), index: varRef("i.0", f64, loc), type: STRING, loc }, loc },
            {
              kind: "exprStmt",
              expr: {
                kind: "jsOp",
                op: "setIdx",
                args: [
                  varRef("out.0", JSVAL, loc),
                  { kind: "jsMarshal", value: kRef, type: JSVAL, loc },
                  lowerer.jsvalLiftExpr({ kind: "recordKeyGet", obj: r, shapeId, key: kRef, overflowOnly: true, type: iv, loc }, loc),
                ],
                type: VOID,
                loc,
              },
              loc,
            },
          ],
          loc,
        },
        { kind: "return", value: varRef("out.0", JSVAL, loc), loc },
      ],
      loc,
    });
    return name;
  }

  /** Interned `%jsin.arr.<n>(a)` — builds ONE island ARRAY from a native
   * array whose elements lift: out = []; for (...) out[i] = lift(a[i]);
   * return out. The index marshals by value like any number. Caller must
   * have checked jsvalLiftable of the element. */
  export function arrayToJsvalHelper(lowerer: Lowerer, elem: IrType, loc: SrcLoc): string {
    const key = `arr:${typeKey(elem)}`;
    const existing = lowerer.jsinHelpers.get(key);
    if (existing) return existing;
    const name = `%jsin.arr.${lowerer.jsinHelpers.size}`;
    lowerer.jsinHelpers.set(key, name);
    const arrT: IrType = { kind: "array", elem };
    const f64: IrType = { kind: "f64" };

    lowerer.liftedFns.push({
      name,
      params: [{ localId: "a.0", name: "a", type: arrT }],
      returnType: JSVAL,
      locals: [
        { id: "a.0", name: "a", type: arrT, mutable: true },
        { id: "out.0", name: "out", type: JSVAL, mutable: false },
        { id: "n.0", name: "n", type: f64, mutable: false },
        { id: "i.0", name: "i", type: f64, mutable: true },
      ],
      body: [
        { kind: "varDecl", localId: "out.0", init: { kind: "jsOp", op: "arrLit", args: [], type: JSVAL, loc }, loc },
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
                kind: "jsOp",
                op: "setIdx",
                args: [
                  varRef("out.0", JSVAL, loc),
                  { kind: "jsMarshal", value: varRef("i.0", f64, loc), type: JSVAL, loc },
                  lowerer.jsvalLiftExpr(
                    { kind: "arrayGet", arr: varRef("a.0", arrT, loc), index: varRef("i.0", f64, loc), type: elem, loc },
                    loc,
                  ),
                ],
                type: { kind: "void" },
                loc,
              },
              loc,
            },
          ],
          loc,
        },
        { kind: "return", value: varRef("out.0", JSVAL, loc), loc },
      ],
      loc,
    });
    return name;
  }

  /** Interned `%jsin.elems.<n>(a)` — a NATIVE array of island handles from
   * a native array whose elements lift: the `any[]`-slot coercion (each
   * element becomes one island value; the array stays static). Null when
   * the element doesn't lift. */
  export function arrayToJsvalArrayHelper(lowerer: Lowerer, fromElem: IrType, loc: SrcLoc): string | null {
    if (fromElem.kind === "jsval" || !lowerer.jsvalLiftable(fromElem)) return null;
    const key = `elems:${typeKey(fromElem)}`;
    const existing = lowerer.jsinHelpers.get(key);
    if (existing) return existing;
    const name = `%jsin.elems.${lowerer.jsinHelpers.size}`;
    lowerer.jsinHelpers.set(key, name);
    const arrT: IrType = { kind: "array", elem: fromElem };
    const outT: IrType = { kind: "array", elem: JSVAL };
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
                  lowerer.jsvalLiftExpr(
                    { kind: "arrayGet", arr: varRef("a.0", arrT, loc), index: varRef("i.0", f64, loc), type: fromElem, loc },
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

