import * as ts from "../ts7/adapter.js";
import { locOf } from "../program.js";
import { numLit, strLit, varRef } from "../../ir/build.js";
import { BOOL, F64, STRING, VOID, arrayOf, typeEquals, typeKey, type IrExpr, type IrStmt, type IrType } from "../../ir/ir.js";
import type { Lowerer } from "./lowerer.js";

/** Dense arrays can be cleared without introducing holes or changing identity.
 * Other length writes retain their existing fence until sparse storage exists. */
export function lowerArrayClearAssignment(
  L: Lowerer,
  target: ts.PropertyAccessExpression,
  value: ts.Expression,
): IrStmt | null {
  if (target.name.text !== "length" || !ts.isNumericLiteral(value) || Number(value.text) !== 0) return null;
  const type = L.mapTypeOf(L.typeOf(target.expression));
  if (type?.kind !== "array" || !L.isStdlibMember(target)) return null;
  const receiver = L.lowerExpr(target.expression);
  if (receiver.type.kind !== "array") return null;
  const loc = locOf(target);
  return {
    kind: "exprStmt",
    expr: { kind: "arrIntrinsic", method: "splice", receiver, args: [numLit(0, loc)], type: receiver.type, loc },
    loc,
  };
}

/** TypedArray.set copies numeric arrays and tuples after evaluating the offset.
 * In particular, an offset expression may mutate the source before it is read. */
export function lowerBytesSetCall(
  L: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
  destinationType: IrType & { kind: "bytes" },
): IrExpr {
  const loc = locOf(call);
  if (call.arguments.length < 1 || call.arguments.length > 2) {
    L.noLowering(`.set with ${call.arguments.length} arguments on typed arrays`, call);
  }
  const receiver = L.lowerExpr(access.expression);
  const sourceNode = call.arguments[0]!;
  const source: IrExpr = ts.isArrayLiteralExpression(sourceNode) && !sourceNode.elements.some(ts.isSpreadElement)
    ? { kind: "arrayLit", elems: sourceNode.elements.map((el) => L.lowerExprExpecting(el, F64)), type: arrayOf(F64), loc: locOf(sourceNode) }
    : L.lowerExpr(sourceNode);
  const offset = call.arguments[1] ? L.lowerExprExpecting(call.arguments[1], F64) : numLit(0, loc);
  if (typeEquals(source.type, destinationType)) {
    return { kind: "bytesIntrinsic", method: "setFrom", receiver, args: [source, offset], type: VOID, loc };
  }
  const tuple = source.type.kind === "record" ? L.shapes.get(source.type.shapeId) : undefined;
  if (!(source.type.kind === "array" && source.type.elem.kind === "f64") &&
      !(tuple?.tuple && tuple.fields.every((field) => field.type.kind === "f64"))) {
    L.noLowering(`.set from '${L.fmt(source.type)}' values`, sourceNode,
      "supported sources are a same-kind typed array, number[] or a numeric tuple");
  }
  const key = `bytesSet:${typeKey(destinationType)}:${typeKey(source.type)}`;
  let helper = L.arrHofHelpers.get(key);
  if (helper === undefined) {
    helper = `%bytes.set.${L.arrHofHelpers.size}`;
    L.arrHofHelpers.set(key, helper);
    const sourceRef = varRef("source.0", source.type, loc);
    const seed: IrExpr = source.type.kind === "record" && tuple
      ? { kind: "arrayLit", elems: [...tuple.fields].sort((a, b) => Number(a.name) - Number(b.name)).map((field): IrExpr => ({
        kind: "recordGet", obj: sourceRef, shapeId: tuple.id, field: field.name, type: F64, loc,
      })), type: arrayOf(F64), loc }
      : sourceRef;
    const parameters = [
      { localId: "destination.0", name: "destination", type: destinationType },
      { localId: "source.0", name: "source", type: source.type },
      { localId: "offset.0", name: "offset", type: F64 },
    ];
    L.liftedFns.push({
      name: helper, params: parameters, returnType: VOID,
      locals: parameters.map((p) => ({ id: p.localId, name: p.name, type: p.type, mutable: false })),
      body: [{ kind: "exprStmt", expr: {
        kind: "bytesIntrinsic", method: "setFrom", receiver: varRef("destination.0", destinationType, loc),
        args: [{ kind: "bytesNew", source: seed, type: destinationType, loc }, varRef("offset.0", F64, loc)],
        type: VOID, loc,
      }, loc }], loc,
    });
  }
  return { kind: "call", callee: helper, args: [receiver, source, offset], type: VOID, loc };
}

/** A runtime index into a homogeneous tuple selects one field from its native
 * record. Keep the same out-of-bounds trap discipline as ordinary arrays. */
export function lowerHomogeneousTupleRead(
  L: Lowerer,
  expression: ts.ElementAccessExpression,
  receiver: IrExpr,
): IrExpr | null {
  if (receiver.type.kind !== "record") return null;
  const shape = L.shapes.get(receiver.type.shapeId);
  if (!shape?.tuple || shape.fields.length === 0) return null;
  const element = shape.fields[0]!.type;
  if (!["f64", "string", "bool"].includes(element.kind) || !shape.fields.every((f) => typeEquals(f.type, element))) return null;
  const loc = locOf(expression);
  const index = L.lowerExprExpecting(expression.argumentExpression, F64);
  const key = `tupleRead:${shape.id}`;
  let helper = L.arrHofHelpers.get(key);
  if (helper === undefined) {
    helper = `%tuple.read.${L.arrHofHelpers.size}`;
    L.arrHofHelpers.set(key, helper);
    const tupleRef = varRef("tuple.0", receiver.type, loc);
    const indexRef = varRef("index.0", F64, loc);
    const fields = [...shape.fields].sort((a, b) => Number(a.name) - Number(b.name));
    const reads = fields.map((field): IrExpr => ({
      kind: "recordGet", obj: tupleRef, shapeId: shape.id, field: field.name, type: element, loc,
    }));
    const body: IrStmt[] = reads.map((value, position) => ({
      kind: "if", cond: { kind: "bin", op: "===", left: indexRef, right: numLit(position, loc), type: BOOL, loc },
      then: [{ kind: "return", value, loc }], else_: null, loc,
    }));
    body.push({ kind: "return", value: {
      kind: "arrayGet", arr: { kind: "arrayLit", elems: reads, type: arrayOf(element), loc }, index: indexRef, type: element, loc,
    }, loc });
    L.liftedFns.push({
      name: helper, returnType: element,
      params: [
        { localId: "tuple.0", name: "tuple", type: receiver.type },
        { localId: "index.0", name: "index", type: F64 },
      ],
      locals: [
        { id: "tuple.0", name: "tuple", type: receiver.type, mutable: false },
        { id: "index.0", name: "index", type: F64, mutable: false },
      ], body, loc,
    });
  }
  return L.maybeNarrow({ kind: "call", callee: helper, args: [receiver, index], type: element, loc }, expression);
}

/** Tuple.join snapshots its scalar fields after evaluating the separator. */
export function lowerTupleJoinCall(
  L: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  if (!L.isStdlibMember(access)) return null;
  const type = L.mapTypeOf(L.typeOf(access.expression));
  const shape = type?.kind === "record" ? L.shapes.get(type.shapeId) : undefined;
  if (type?.kind !== "record" || !shape?.tuple || shape.fields.length === 0) return null;
  const element = shape.fields[0]!.type;
  if (!["f64", "string", "bool"].includes(element.kind) || !shape.fields.every((f) => typeEquals(f.type, element))) return null;
  if (call.arguments.length > 1) L.noLowering(`.join with ${call.arguments.length} arguments`, call);
  const receiver = L.lowerExpr(access.expression);
  if (receiver.type.kind !== "record") return null;
  const loc = locOf(call);
  const separator = call.arguments[0] ? L.lowerExprExpecting(call.arguments[0], STRING) : strLit(",", loc);
  const key = `tupleJoin:${shape.id}`;
  let helper = L.arrHofHelpers.get(key);
  if (helper === undefined) {
    helper = `%tuple.join.${L.arrHofHelpers.size}`;
    L.arrHofHelpers.set(key, helper);
    const snapshot: IrExpr = {
      kind: "arrayLit", type: arrayOf(element), loc,
      elems: [...shape.fields].sort((a, b) => Number(a.name) - Number(b.name)).map((field) => ({
        kind: "recordGet", obj: varRef("tuple.0", type, loc), shapeId: shape.id, field: field.name, type: element, loc,
      })),
    };
    const parameters = [
      { localId: "tuple.0", name: "tuple", type },
      { localId: "separator.0", name: "separator", type: STRING },
    ];
    L.liftedFns.push({ name: helper, params: parameters, returnType: STRING,
      locals: parameters.map((p) => ({ id: p.localId, name: p.name, type: p.type, mutable: false })),
      body: [{ kind: "return", value: {
        kind: "arrIntrinsic", method: "join", receiver: snapshot, args: [varRef("separator.0", STRING, loc)], type: STRING, loc,
      }, loc }], loc,
    });
  }
  return { kind: "call", callee: helper, args: [receiver, separator], type: STRING, loc };
}

/** Argument packs snapshot each spread before evaluating the next argument;
 * insertion happens only after every argument has been evaluated. */
export function lowerArraySpreadInsert(
  L: Lowerer,
  call: ts.CallExpression,
  receiver: IrExpr,
  type: IrType & { kind: "array" },
  method: "push" | "unshift",
): IrExpr {
  const loc = locOf(call);
  const spreads: number[] = [];
  const elems = call.arguments.map((arg, index): IrExpr => {
    if (!ts.isSpreadElement(arg)) return L.lowerExprExpecting(arg, type.elem);
    let value = L.lowerExpr(arg.expression);
    if (value.type.kind === "set" && typeEquals(value.type.elem, type.elem)) {
      value = { kind: "setIntrinsic", method: "toArray", receiver: value, args: [], type, loc: locOf(arg) };
    }
    value = tupleSpreadArray(L, value, type) ?? value;
    if (!typeEquals(value.type, type)) L.noLowering(`.${method} spread from '${L.fmt(value.type)}'`, arg);
    spreads.push(index);
    return value;
  });
  return { kind: "arrIntrinsic", method: method === "push" ? "pushSpread" : "unshiftSpread", receiver,
    args: [{ kind: "arrayLit", elems, spreads, type, loc }], type: F64, loc };
}

/** Snapshot a homogeneous tuple once for an array spread destination. */
export function tupleSpreadArray(L: Lowerer, source: IrExpr, target: IrType & { kind: "array" }): IrExpr | null {
  if (source.type.kind !== "record") return null;
  const shape = L.shapes.get(source.type.shapeId);
  if (!shape?.tuple || !shape.fields.every((field) => typeEquals(field.type, target.elem))) return null;
  const loc = source.loc;
  const key = `tupleSpread:${shape.id}:${typeKey(target)}`;
  let helper = L.arrHofHelpers.get(key);
  if (helper === undefined) {
    helper = `%tuple.spread.${L.arrHofHelpers.size}`;
    L.arrHofHelpers.set(key, helper);
    const snapshot: IrExpr = { kind: "arrayLit", type: target, loc,
      elems: [...shape.fields].sort((a, b) => Number(a.name) - Number(b.name)).map((field) => ({
        kind: "recordGet", obj: varRef("tuple.0", source.type, loc), shapeId: shape.id, field: field.name, type: target.elem, loc,
      })),
    };
    L.liftedFns.push({ name: helper, params: [{ localId: "tuple.0", name: "tuple", type: source.type }], returnType: target,
      locals: [{ id: "tuple.0", name: "tuple", type: source.type, mutable: false }],
      body: [{ kind: "return", value: snapshot, loc }], loc,
    });
  }
  return { kind: "call", callee: helper, args: [source], type: target, loc };
}
