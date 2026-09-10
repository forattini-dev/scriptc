import type { IrExpr, IrType } from "../../ir/nodes.js";

/** ToUint8(x & 255) = ToUint8(x) for every number, including NaN and
 * infinities. The byte store already truncates and keeps the low eight bits.
 * Only remove the literal mask; the remaining operand still evaluates once
 * in its original index/value order. Wider and floating stores differ. */
export function rustByteStoreValue(destination: IrType, value: IrExpr): IrExpr {
  if (destination.kind !== "bytes" || destination.elem !== "u8" ||
    value.kind !== "bin" || value.op !== "&" || value.type.kind !== "f64") return value;
  if (value.right.kind === "numLit" && value.right.value === 255 && value.left.type.kind === "f64") return value.left;
  if (value.left.kind === "numLit" && value.left.value === 255 && value.right.type.kind === "f64") return value.right;
  return value;
}
