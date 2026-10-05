import type { SrcLoc } from "../../ir/ir.js";

/** A named C-backend refusal, distinct from a compiler invariant failure. */
export class CUnsupportedError extends Error {
  constructor(
    readonly kind: string,
    readonly loc?: SrcLoc,
  ) {
    super(`the C backend does not support this construct yet (${kind}); use --backend rust`);
    this.name = "CUnsupportedError";
  }
}
