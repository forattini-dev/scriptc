import type { IrExpr } from "../../ir/ir.js";

/** Prove absence only on a freshly constructed dynamic object with known
 * own keys. Variables, spreads, computed keys and prototype overrides may
 * carry capabilities that the caller's invalid-argument ladder accepts. */
export function isFreshObjectWithout(value: IrExpr, capabilities: ReadonlySet<string>): boolean {
  if (value.kind === "recordLit") {
    return value.fields.every(({ name }) => name !== "__proto__" && !capabilities.has(name));
  }
  return value.kind === "dynObjLit" && (value.fields ?? []).every(({ key }) =>
    key.kind === "strLit" && key.value !== "__proto__" && !capabilities.has(key.value));
}
