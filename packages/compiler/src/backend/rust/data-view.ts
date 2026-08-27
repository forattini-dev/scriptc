import type { IrExpr } from "../../ir/nodes.js";

type BytesIntrinsic = Extract<IrExpr, { kind: "bytesIntrinsic" }>;

export interface RustDataViewContext {
  emitExpr(expr: IrExpr): string;
}

const GET_KINDS = new Map<BytesIntrinsic["method"], string>([
  ["dvGetUint8", "u8"],
  ["dvGetInt8", "i8"],
  ["dvGetUint16", "u16"],
  ["dvGetInt16", "i16"],
  ["dvGetUint32", "u32"],
  ["dvGetInt32", "i32"],
  ["dvGetFloat32", "f32"],
  ["dvGetFloat64", "f64"],
  ["dvGetBigUint64Number", "u64"],
  ["dvGetBigInt64Number", "i64"],
]);

const SET_KINDS = new Map<BytesIntrinsic["method"], string>([
  ["dvSetUint8", "u8"],
  ["dvSetInt8", "i8"],
  ["dvSetUint16", "u16"],
  ["dvSetInt16", "i16"],
  ["dvSetUint32", "u32"],
  ["dvSetInt32", "i32"],
  ["dvSetFloat32", "f32"],
  ["dvSetFloat64", "f64"],
]);

export function emitRustDataViewIntrinsic(
  expr: BytesIntrinsic,
  context: RustDataViewContext,
): string | null {
  const receiver = context.emitExpr(expr.receiver);
  if (expr.method === "byteOffset" && expr.args.length === 0) {
    return `runtime::bytes_byte_offset(&(${receiver}))`;
  }
  if (expr.method === "dataViewNew" && expr.args.length <= 2) {
    const offset = expr.args[0] === undefined ? "0.0" : context.emitExpr(expr.args[0]);
    const length = expr.args[1] === undefined ? "0.0" : context.emitExpr(expr.args[1]);
    return `runtime::data_view_new(&(${receiver}), ${offset}, ${expr.args[1] !== undefined}, ${length})`;
  }
  const getKind = GET_KINDS.get(expr.method);
  if (getKind !== undefined && expr.args[0] !== undefined && expr.args.length <= 2) {
    const littleEndian = expr.args[1] === undefined ? "false" : context.emitExpr(expr.args[1]);
    return `runtime::data_view_get(&(${receiver}), "${getKind}", ${context.emitExpr(expr.args[0])}, ${littleEndian})`;
  }
  const setKind = SET_KINDS.get(expr.method);
  if (setKind !== undefined && expr.args[0] !== undefined && expr.args[1] !== undefined && expr.args.length <= 3) {
    const littleEndian = expr.args[2] === undefined ? "false" : context.emitExpr(expr.args[2]);
    return `runtime::data_view_set(&(${receiver}), "${setKind}", ${context.emitExpr(expr.args[0])}, ${context.emitExpr(expr.args[1])}, ${littleEndian})`;
  }
  return null;
}
