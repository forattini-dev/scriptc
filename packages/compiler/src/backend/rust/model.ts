import type { IrClassDef, IrExpr, IrFunction, IrType } from "../../ir/nodes.js";

export type IrFuncType = Extract<IrType, { kind: "func" }>;
export type IrAwaitExpr = Extract<IrExpr, { kind: "awaitExpr" | "awaitUnionExpr" }>;

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
