import { InternalCompilerError } from "../../errors.js";
import type * as ts from "../ts7/adapter.js";
import { DYN, F64, JSVAL, STRING, arrayOf, typeEquals, type IrExpr, type IrType, type SrcLoc } from "../../ir/nodes.js";
import { nativeArrayViewSupported } from "../../ir/native-record.js";
import { nativeTupleElement } from "../../ir/native-tuple.js";
import { numLit } from "../../ir/build.js";
import { locOf } from "../program.js";
import type { Lowerer } from "./lowerer.js";

/** The Rust width helper retains tuple storage; ordinary backends keep its body. */
export function lowerNativeTupleArrayView(L: Lowerer, source: IrExpr): IrExpr | null {
  if (source.type.kind !== "record") return null;
  const element = nativeTupleElement(L.shapes.get(source.type.shapeId));
  if (!element) return null;
  const type = { kind: "array", elem: element } as const;
  const helper = L.tupleArrayWidthHelper(source.type.shapeId, type, source.loc);
  return helper ? { kind: "call", callee: helper, args: [source], type, loc: source.loc } : null;
}

/** Evaluate the receiver even when a backend can use its fixed tuple arity. */
export function lowerTupleLength(L: Lowerer, receiver: IrExpr, arity: number, loc: SrcLoc): IrExpr {
  if (receiver.type.kind === "jsval") return { kind: "jsExit", value: { kind: "jsOp", op: "getProp", name: "length", args: [receiver], type: JSVAL, loc }, type: F64, loc };
  if (receiver.type.kind === "dyn") return { kind: "dynCheck", value: { kind: "dynKeyGet", value: receiver, key: { kind: "strLit", value: "length", type: STRING, loc }, type: DYN, loc }, type: F64, loc };
  if (receiver.type.kind === "array") return { kind: "arrIntrinsic", method: "length", receiver, args: [], type: F64, loc };
  if (receiver.type.kind !== "record") throw new InternalCompilerError("tuple length needs an array or record receiver");
  const key = `tupleLength:${receiver.type.shapeId}`;
  let helper = L.arrHofHelpers.get(key);
  if (!helper) {
    helper = `%tuple.length.${L.arrHofHelpers.size}`;
    L.arrHofHelpers.set(key, helper);
    L.liftedFns.push({ name: helper, params: [{ localId: "tuple.0", name: "tuple", type: receiver.type }],
      locals: [{ id: "tuple.0", name: "tuple", type: receiver.type, mutable: false }], returnType: F64,
      body: [{ kind: "return", value: numLit(arity, loc), loc }], loc });
  }
  return { kind: "call", callee: helper, args: [receiver], type: F64, loc };
}

/** Rest packing copies the current tail, including elements added by an alias. */
export function lowerNativeTupleTail(L: Lowerer, source: IrExpr, from: number, target: IrType | null, blame: ts.Node): IrExpr | null {
  if (!target || source.type.kind !== "record") return null;
  const element = nativeTupleElement(L.shapes.get(source.type.shapeId));
  const targetElement = target.kind === "array" ? target.elem : target.kind === "record" ? nativeTupleElement(L.shapes.get(target.shapeId)) : undefined;
  if (!element || !targetElement || !typeEquals(element, targetElement)) return null;
  const view = lowerNativeTupleArrayView(L, source);
  if (!view) return null;
  const loc = locOf(blame);
  const slice: IrExpr = { kind: "arrIntrinsic", method: "slice", receiver: view, args: [numLit(from, loc)], type: arrayOf(element), loc };
  return target.kind === "array" ? slice : { kind: "dynCheck", value: { kind: "dynFrom", value: slice, type: DYN, loc }, type: target, loc };
}

/** Comparing a tuple to its array alias compares the shared backing identity. */
export function lowerNativeTupleArrayEquality(L: Lowerer, left: IrExpr, right: IrExpr, negated: boolean): IrExpr | null {
  const tuple = left.type.kind === "record" ? left : right;
  const array = tuple === left ? right : left;
  if (tuple.type.kind !== "record" || !nativeTupleElement(L.shapes.get(tuple.type.shapeId)) || !nativeArrayViewSupported(array.type)) return null;
  const box = (value: IrExpr): IrExpr => ({ kind: "dynFrom", value, type: DYN, loc: value.loc });
  return { kind: "dynScalarEq", left: box(left), right: box(right), ...(negated ? { negated: true as const } : {}), type: { kind: "bool" }, loc: left.loc };
}
