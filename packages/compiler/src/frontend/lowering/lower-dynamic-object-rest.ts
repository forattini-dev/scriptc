import { BOOL, DYN, F64, STRING, VOID, type IrExpr, type IrFunction, type IrStmt, type IrType, type SrcLoc } from "../../ir/ir.js";
import type { Lowerer } from "./lowerer.js";

/** Copy the remaining own enumerable data properties at the rest position.
 * Exclusions precede reads; copying everything then deleting would run
 * excluded getters again. The fresh container retains child identities. */
export function lowerDynamicObjectRest(lowerer: Lowerer, source: IrExpr, excluded: readonly string[], loc: SrcLoc): IrExpr {
  const names = [...new Set(excluded)].sort();
  const key = `object.rest:${names.map(name => `${name.length}:${name}`).join("")}`;
  let callee = lowerer.arrHofHelpers.get(key);
  if (!callee) {
    callee = `%object.rest.${lowerer.arrHofHelpers.size}`;
    const ref = (localId: string, type: IrType): IrExpr => ({ kind: "varRef", localId, type, loc });
    const sourceRef = ref("source.0", DYN);
    const keysRef = ref("keys.0", DYN);
    const restRef = ref("rest.0", DYN);
    const indexRef = ref("index.0", F64);
    const keyRef = ref("key.0", STRING);
    const body: IrStmt[] = [
      { kind: "exprStmt", expr: { kind: "libCall", fn: "dyn.objectRestCheck", args: [sourceRef], type: VOID, loc }, loc },
      { kind: "varDecl", localId: "rest.0", init: { kind: "dynObjLit", fields: [], type: DYN, loc }, loc },
      { kind: "varDecl", localId: "keys.0", init: { kind: "libCall", fn: "dyn.objKeys", args: [sourceRef], type: DYN, loc }, loc },
      { kind: "varDecl", localId: "index.0", init: { kind: "numLit", value: 0, type: F64, loc }, loc },
      { kind: "while", cond: {
        kind: "bin", op: "<", left: indexRef,
        right: { kind: "libCall", fn: "dyn.arrLen", args: [keysRef], type: F64, loc }, type: BOOL, loc,
      }, body: [
        { kind: "varDecl", localId: "key.0", init: {
          kind: "dynCheck", value: { kind: "libCall", fn: "dyn.arrAt", args: [keysRef, indexRef], type: DYN, loc }, type: STRING, loc,
        }, loc },
        { kind: "assign", localId: "index.0", value: {
          kind: "bin", op: "+", left: indexRef, right: { kind: "numLit", value: 1, type: F64, loc }, type: F64, loc,
        }, loc },
        ...names.map((name): IrStmt => ({
          kind: "if", cond: { kind: "strEq", negated: false, left: keyRef, right: { kind: "strLit", value: name, type: STRING, loc }, type: BOOL, loc },
          then: [{ kind: "continue", loc }], else_: null, loc,
        })),
        { kind: "if", cond: { kind: "libCall", fn: "dyn.hasOwn", args: [sourceRef, keyRef], type: BOOL, loc }, then: [{
          kind: "exprStmt", expr: { kind: "libCall", fn: "dyn.keySet", args: [
            restRef, keyRef, { kind: "dynKeyGet", value: sourceRef, key: keyRef, type: DYN, loc },
          ], type: VOID, loc }, loc,
        }], else_: null, loc },
      ], loc },
      { kind: "return", value: restRef, loc },
    ];
    const fn: IrFunction = {
      name: callee, params: [{ localId: "source.0", name: "source", type: DYN }], returnType: DYN,
      locals: [
        { id: "source.0", name: "source", type: DYN, mutable: false },
        { id: "rest.0", name: "rest", type: DYN, mutable: false },
        { id: "keys.0", name: "keys", type: DYN, mutable: false },
        { id: "index.0", name: "index", type: F64, mutable: true },
        { id: "key.0", name: "key", type: STRING, mutable: false },
      ], body, loc,
    };
    lowerer.liftedFns.push(fn);
    lowerer.arrHofHelpers.set(key, callee);
  }
  return { kind: "call", callee, args: [source], type: DYN, loc };
}
