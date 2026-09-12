import type { IrExpr, IrFunction, IrLocal } from "../../ir/ir.js";
import { mangleLocal } from "../mangle.js";

interface BytesBorrowContext {
  currentFunction(): IrFunction | null;
  localIsBoxed(local: IrLocal): boolean;
}

/** Borrow the handle, never its RefCell storage. The byte operation acquires
 * its storage borrow only after the index has finished evaluating. Keep an
 * owned receiver snapshot for calls, assignments, suspension, boxed bindings,
 * globals and expressions outside this deliberately small whitelist. */
export function borrowedRustBytesLocal(
  receiver: IrExpr,
  later: readonly IrExpr[],
  context: BytesBorrowContext,
): string | null {
  const fn = context.currentFunction();
  if (fn === null || fn.async || fn.generator !== undefined) return null;
  const locals = new Map(fn.locals.map(local => [local.id, local]));
  function plainBytes(expr: IrExpr): boolean {
    if (expr.kind !== "varRef" || expr.type.kind !== "bytes") return false;
    const local = locals.get(expr.localId);
    return local?.type.kind === "bytes" && !local.tdz && !context.localIsBoxed(local);
  }
  function scalar(expr: IrExpr, depth = 0): boolean {
    if (depth > 64 || (expr.type.kind !== "f64" && expr.type.kind !== "bool")) return false;
    const child = (value: IrExpr) => scalar(value, depth + 1);
    switch (expr.kind) {
      case "numLit": case "boolLit": return true;
      case "varRef": return locals.has(expr.localId);
      // A numeric increment cannot replace the byte receiver binding. Its
      // value and side effect are still emitted once, in their original order.
      case "incDec": return locals.get(expr.localId)?.type.kind === "f64";
      case "bin": case "logical": return child(expr.left) && child(expr.right);
      case "unary": return child(expr.operand);
      case "ternary": return child(expr.cond) && child(expr.then) && child(expr.else_);
      case "bytesIntrinsic":
        return plainBytes(expr.receiver) &&
          ((expr.method === "get" && expr.args.length === 1 && expr.args.every(child)) ||
            ((expr.method === "length" || expr.method === "byteLength") && expr.args.length === 0));
      default: return false;
    }
  }
  return receiver.kind === "varRef" && plainBytes(receiver) && later.every(expr => scalar(expr))
    ? mangleLocal(receiver.localId)
    : null;
}
