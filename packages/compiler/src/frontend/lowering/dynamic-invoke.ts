import { DYN, type IrExpr, type SrcLoc } from "../../ir/nodes.js";

export function dynamicMethodInvoke(
  receiver: IrExpr,
  method: string,
  calleeName: string,
  args: IrExpr[],
  loc: SrcLoc,
): IrExpr {
  return {
    kind: "dynInvoke",
    recv: { kind: "dynFrom", value: receiver, type: DYN, loc },
    method,
    calleeName,
    args,
    type: DYN,
    loc,
  };
}
