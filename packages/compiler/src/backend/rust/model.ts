import type { IrClassDef, IrExpr, IrFunction, IrType } from "../../ir/nodes.js";

export type IrFuncType = Extract<IrType, { kind: "func" }>;
type IrLibCallExpr = Extract<IrExpr, { kind: "libCall" }>;
export type IrAwaitExpr =
  | Extract<IrExpr, { kind: "awaitExpr" | "awaitUnionExpr" }>
  | (IrLibCallExpr & { readonly fn: "async.awaitDyn" });

export function isRustAwaitExpr(value: unknown): value is IrAwaitExpr {
  if (value === null || typeof value !== "object") return false;
  const expr = value as { kind?: unknown; fn?: unknown };
  return expr.kind === "awaitExpr" || expr.kind === "awaitUnionExpr" ||
    (expr.kind === "libCall" && expr.fn === "async.awaitDyn");
}

export interface RustClosureShape {
  readonly index: number;
  readonly type: IrFuncType;
  readonly targets: IrFunction[];
  runtimeCallback?: boolean;
}

export interface RustClassMeta {
  readonly def: IrClassDef;
  base: RustClassMeta | null;
  readonly children: RustClassMeta[];
  root: RustClassMeta;
  pre: number;
  post: number;
  hierarchy: boolean;
  readonly slots: RustVtSlot[];
}

export interface RustVtSlot {
  readonly method: string;
  readonly declarer: RustClassMeta;
  readonly fn: IrFunction;
}
