import { countedFor, varRef } from "../../ir/build.js";
import {
  DYN, F64, STRING, VOID, arrayOf, funcOf, typeKey,
  type IrExpr, type IrLocal, type IrStmt, type IrType, type SrcLoc,
} from "../../ir/nodes.js";
import type { Lowerer } from "./lowerer.js";

/** A typed source mapped into unknown[] needs no dynamic source/callback
 * conversion. Keep both in their original ABI: copying the source can lose
 * identity and callback mutations, and class instances need not be boxable.
 * Only the fresh output lives in the dynamic array representation.
 */
export function lowerArrayMapDynamic(
  L: Lowerer, receiver: IrExpr, callback: IrExpr,
  elem: IrType, arity: number, loc: SrcLoc,
): IrExpr {
  const key = `mapDynamic:${typeKey(elem)}:${arity}`;
  let name = L.arrHofHelpers.get(key);
  if (name === undefined) {
    name = `%arr.mapDynamic.${L.arrHofHelpers.size}`;
    L.arrHofHelpers.set(key, name);
    const arrT = arrayOf(elem);
    const fnT = funcOf([elem, F64, arrT].slice(0, arity), DYN);
    const source = varRef("a.0", arrT, loc);
    const fn = varRef("f.0", fnT, loc);
    const index = varRef("i.0", F64, loc);
    const length = varRef("n.0", F64, loc);
    const output = varRef("out.0", DYN, loc);
    const currentLength = (): IrExpr => ({
      kind: "arrIntrinsic", method: "length", receiver: source, args: [], type: F64, loc,
    });
    const write = (key: IrExpr, value: IrExpr): IrStmt => ({
      kind: "exprStmt",
      expr: { kind: "libCall", fn: "dyn.keySet", args: [output, key, value], type: VOID, loc },
      loc,
    });
    const item: IrExpr = { kind: "arrayGet", arr: source, index, type: elem, loc };
    const call: IrExpr = {
      kind: "callValue", callee: fn,
      args: [item, index, source].slice(0, arity),
      type: DYN, loc,
    };
    const locals: IrLocal[] = [
      { id: "a.0", name: "a", type: arrT, mutable: true },
      { id: "f.0", name: "f", type: fnT, mutable: true },
      { id: "n.0", name: "n", type: F64, mutable: false },
      { id: "i.0", name: "i", type: F64, mutable: true },
      { id: "out.0", name: "out", type: DYN, mutable: false },
    ];
    const body: IrStmt[] = [
      { kind: "varDecl", localId: "n.0", init: currentLength(), loc },
      { kind: "varDecl", localId: "out.0", init: { kind: "dynArrLit", elems: [], type: DYN, loc }, loc },
      // Like the ordinary typed-map helper, snapshot length and read each
      // element fresh. Appended entries are not visited; indexed reads
      // retain the typed array's checked-read contract.
      countedFor(loc, length, () => [write({ kind: "toString", operand: index, type: STRING, loc }, call)]),
      { kind: "return", value: output, loc },
    ];
    L.liftedFns.push({ name, locals, body, returnType: DYN, loc, params: [
      { localId: "a.0", name: "a", type: arrT },
      { localId: "f.0", name: "f", type: fnT },
    ] });
  }
  return { kind: "call", callee: name, args: [receiver, callback], type: DYN, loc };
}
