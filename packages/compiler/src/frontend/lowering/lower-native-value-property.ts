import { F64, JSVAL, STRING, type IrExpr } from "../../ir/ir.js";
import { nativeRecordCheckSupported } from "../../ir/native-record.js";
import { locOf } from "../program.js";
import * as ts from "../ts7/adapter.js";
import type { Lowerer } from "./lowerer.js";

/** A scalar index signature describes values, but does not prove key presence. */
export function nativeRecordOverflowRead(L: Lowerer, node: ts.Node): boolean {
  if (!L.nativeDenseArrays || L.dynamic || !ts.isPropertyAccessExpression(node)) return false;
  const parent = node.parent;
  if (parent && (ts.isPostfixUnaryExpression(parent) ||
      ts.isPrefixUnaryExpression(parent) && (parent.operator === ts.SyntaxKind.PlusPlusToken || parent.operator === ts.SyntaxKind.MinusMinusToken) ||
      ts.isBinaryExpression(parent) && parent.left === node &&
        parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment)) return false;
  const owner = L.mapTypeOf(L.typeOf(node.expression));
  const shape = owner?.kind === "record" ? L.shapes.get(owner.shapeId) : undefined;
  return !!shape?.indexValue && ["string", "f64", "bool"].includes(shape.indexValue.kind) &&
    !shape.fields.some(field => field.name === node.name.text);
}

/** A native namespace/function can retain a record as a shared handle. */
export function isNativeRecordHandle(L: Lowerer, receiver: IrExpr, node: ts.Expression): boolean {
  if (!L.nativeDenseArrays || L.dynamic || receiver.type.kind !== "jsval") return false;
  const declared = L.mapTypeOf(L.typeOf(node));
  return declared?.kind === "record" && nativeRecordCheckSupported(declared, id => L.shapes.get(id), id => L.unions.get(id));
}

/** Read from the native representation when the checker retains a wider
 * spelling. Implicit JS specialization can produce string[] locals from
 * checker-any calls; their array length remains the native runtime length.
 * The emitted read evaluates the supplied receiver once. */
export function lowerNativeValueProperty(
  L: Lowerer, receiver: IrExpr, expression: ts.PropertyAccessExpression,
): IrExpr | null {
  const loc = locOf(expression);
  const name = expression.name.text;
  if (isNativeRecordHandle(L, receiver, expression.expression)) {
    const read: IrExpr = { kind: "jsOp", op: "getProp", name, args: [receiver], type: JSVAL, loc };
    const declared = L.mapTypeOf(L.typeOf(expression));
    // Scalars can leave by value; nested records retain their shared handle.
    if (!expression.questionDotToken && declared &&
        (declared.kind === "string" || declared.kind === "f64" || declared.kind === "bool")) {
      const owner = L.mapTypeOf(L.typeOf(expression.expression));
      const shape = owner?.kind === "record" ? L.shapes.get(owner.shapeId) : undefined;
      // An index signature does not prove that this property exists, even
      // when noUncheckedIndexedAccess is disabled in the source project.
      const overflow = shape?.indexValue && !shape.fields.some(field => field.name === name);
      if (overflow) return { kind: "jsExit", value: read, type: L.withUndefinedArmOf(declared)!, loc };
      return { kind: "jsExit", value: read, type: declared, loc };
    }
    return read;
  }
  // Per-call factory specialization can refine a checker-any return to
  // a native class value. Preserve evaluation of the computed receiver.
  if (receiver.type.kind === "classval" && name === "name") {
    const info = L.classes.get(receiver.type.className);
    const shadowedName = (candidate: NonNullable<typeof info>): boolean =>
      candidate.staticFields.some(field => field.name === "name") || candidate.staticMethods?.has("name") === true ||
      candidate.subclasses.some(shadowedName);
    if (info && shadowedName(info)) L.unsupported("SC1090", expression,
      "class-value names with a shadowed static name (native metadata is not the mutable property)");
    return { kind: "libCall", fn: "class.name", args: [receiver], type: STRING, loc };
  }
  if (name === "length") {
    if (receiver.type.kind === "array") return { kind: "arrIntrinsic", method: "length", receiver, args: [], type: F64, loc };
    if (receiver.type.kind === "string") return { kind: "strIntrinsic", method: "length", receiver, args: [], type: F64, loc };
  }
  // A declared Uint8Array member can already have exited the island as a
  // checked native copy. Read its storage without sending it back in.
  if (receiver.type.kind === "bytes" && (name === "length" || name === "byteLength" || name === "byteOffset")) {
    return { kind: "bytesIntrinsic", method: name, receiver, args: [], type: F64, loc };
  }
  // E.g. a named-capture groups projection already returned a record even
  // though its checker surface still includes undefined. Preserve the
  // existing declared-field/overflow policy against the actual layout.
  if (receiver.type.kind !== "record") return null;
  const shape = L.shapes.get(receiver.type.shapeId);
  const field = shape?.fields.find(candidate => candidate.name === name);
  if (field) return {
    kind: "recordGet", obj: receiver, shapeId: receiver.type.shapeId, field: field.name, type: field.type, loc,
  };
  if (shape?.indexValue === undefined || shape.tuple) return null;
  return {
    kind: "recordKeyGet", obj: receiver, shapeId: receiver.type.shapeId,
    key: { kind: "strLit", value: name, type: STRING, loc: locOf(expression.name) },
    overflowOnly: true, type: shape.indexValue, loc,
  };
}
