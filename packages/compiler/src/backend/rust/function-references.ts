import type { IrModule } from "../../ir/ir.js";

/** Environment snapshot helpers are emitted only when another function uses them. */
export function isRustFunctionReferenced(mod: IrModule, name: string): boolean {
  let found = false;
  const visit = (value: unknown): void => {
    if (found || value === null || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    const node = value as Record<string, unknown>;
    if ((node.kind === "call" && node.callee === name) || (node.kind === "closure" && node.fnName === name)) {
      found = true;
      return;
    }
    for (const child of Object.values(node)) visit(child);
  };
  for (const fn of mod.functions) {
    if (fn.name !== name) visit(fn.body);
  }
  return found;
}
