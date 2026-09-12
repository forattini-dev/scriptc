import type { CEmitter, Temp } from "./c-emitter.js";
import type { IrExpr } from "../../ir/ir.js";
type LibCallExpr = Extract<IrExpr, { kind: "libCall" }>;

export interface LibCallState {
  emitter: CEmitter;
  e: LibCallExpr;
  args: Temp[];
  arg: (index: number) => string;
  finish: (call: string) => Temp;
}
