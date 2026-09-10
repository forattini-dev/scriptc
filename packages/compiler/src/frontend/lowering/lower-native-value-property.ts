import { F64, STRING, type IrExpr } from "../../ir/nodes.js";
import { locOf } from "../program.js";
import type * as ts from "../ts7/adapter.js";
import type { Lowerer } from "./lowerer.js";

/** Read from the native representation when the checker retains a wider
 * spelling. Implicit JS specialization can produce string[] locals from
 * checker-any calls; their array length remains the native runtime length.
 * The emitted read evaluates the supplied receiver once. */
export function lowerNativeValueProperty(
  L: Lowerer, receiver: IrExpr, expression: ts.PropertyAccessExpression,
): IrExpr | null {
  const loc = locOf(expression);
  const name = expression.name.text;
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
