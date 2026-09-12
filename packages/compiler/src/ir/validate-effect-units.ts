import type { IrExpr, IrLibFn, SrcLoc } from "./ir.js";

// These positions box program payloads rather than passing native units
// through an ordinary call ABI. Keep callback and handle slots excluded.
const BOXED_VALUES: Partial<Record<IrLibFn, number>> = {
  "effect.succeed": 0, "effect.fail": 0, "effect.die": 0,
  "effect.as": 1, "effect.exitSucceed": 0, "effect.exitFail": 0,
  "effect.causeFail": 0, "option.some": 0,
  "effect.refMake": 0, "effect.refMakeUnsafe": 0,
  "effect.syncRefMake": 0, "effect.syncRefMakeUnsafe": 0,
  "effect.refSet": 1, "effect.deferredSettle": 1,
  "effect.queueOffer": 1, "effect.pubsubPublish": 1,
};

/** Returns true only when this boxed payload owns the unit literal check. */
export function validateEffectUnitArgument(
  fn: IrLibFn, argument: IrExpr, index: number,
  error: (message: string, loc: SrcLoc) => void,
): boolean {
  if (argument.kind !== "unitLit" || BOXED_VALUES[fn] !== index) return false;
  const expected = argument.unit === "null" ? "nullT" : "undefinedT";
  if (argument.type.kind !== expected) {
    error(`unitLit '${argument.unit}' typed ${argument.type.kind}`, argument.loc);
  }
  return true;
}
