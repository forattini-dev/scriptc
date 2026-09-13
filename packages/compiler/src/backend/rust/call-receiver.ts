import type { IrExpr, IrFunction, SrcLoc } from "../../ir/ir.js";
import { mangleFunction } from "../mangle.js";
import type { RustExpressionContext } from "./expression-context.js";

const explicitThisFunctions = new WeakMap<IrFunction, boolean>();

/** A deferred body cannot borrow the caller's thread-local receiver. Until
 * its frame captures this, refuse even bodies whose first read is synchronous. */
export function rejectRustDeferredReceivers(
  functions: readonly IrFunction[], unsupported: (kind: string, loc?: SrcLoc) => never,
): void {
  for (const fn of functions) {
    if ((fn.async || fn.generator !== undefined) && rustFunctionReadsThis(fn)) {
      unsupported(`explicit this in ${fn.async ? "async" : "generator"} functions requires a captured native receiver`, fn.loc);
    }
  }
}

/** Only source functions that read an explicit this need a bare-call guard.
 * Compiler helpers and closure adapters keep their internal calling contract. */
export function rustFunctionReadsThis(fn: IrFunction): boolean {
  const known = explicitThisFunctions.get(fn);
  if (known !== undefined) return known;
  const visit = (value: unknown): boolean => {
    if (Array.isArray(value)) return value.some(visit);
    if (value === null || typeof value !== "object") return false;
    const node = value as { kind?: string; fn?: string };
    return (node.kind === "libCall" && node.fn === "dyn.this") || Object.values(value).some(visit);
  };
  const found = visit(fn.body);
  explicitThisFunctions.set(fn, found);
  return found;
}

/** A checked member still carries a JavaScript reference until invocation.
 * An extracted local does not: its receiver is undefined. */
export function rustCallReceiver(callee: IrExpr): IrExpr | null {
  switch (callee.kind) {
    case "dynCheck": case "jsExit": case "upcast": case "downcast": case "unionNarrow":
      return rustCallReceiver(callee.value);
    case "dynKeyGet": return callee.value;
    case "recordGet": case "recordKeyGet": case "fieldGet": return callee.obj;
    default: return null;
  }
}

export function emitRustDirectCall(
  context: RustExpressionContext, expr: Extract<IrExpr, { kind: "call" }>, emit: (value: IrExpr) => string,
): string {
  const callee = context.functions.get(expr.callee);
  if (callee === undefined) context.unsupported(`unknown call target '${expr.callee}'`, expr.loc);
  if (callee.captures !== undefined) context.unsupported(`direct call to lifted closure '${callee.name}'`, expr.loc);
  if (context.hasExplicitThis() && rustFunctionReadsThis(callee)) {
    const args = expr.args.map(() => context.nextName("sc_rt"));
    const bindings = expr.args.map((arg, index) => `let ${args[index]} = ${emit(arg)};`).join(" ");
    return `{ ${bindings} let _this_guard = sc_dyn_this_push(${context.dynTypeName()}::Undefined); ${mangleFunction(callee.name)}(${args.join(", ")}) }`;
  }
  return `${mangleFunction(callee.name)}(${expr.args.map(emit).join(", ")})`;
}
