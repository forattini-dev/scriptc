/* Where an ambient declaration lives: inside `declare module "name"` (also spelled `node:name`) or inside a global
 * namespace. The type mapper and the platform lowerings recognize runtime surfaces (node builtins, bun:sqlite, the
 * NodeJS global interfaces) by this provenance rather than by name alone. */
import * as ts from "./ts7/adapter.js";

/** True when the declaration's nearest enclosing ambient module is `name` or `node:name`. */
export function isDeclaredInAmbientModule(d: ts.Declaration, name: string): boolean {
  let node: ts.Node | undefined = d.parent;
  while (node) {
    if (ts.isModuleDeclaration(node) && ts.isStringLiteral(node.name)) {
      const spec = node.name.text;
      return spec === name || spec === `node:${name}`;
    }
    node = node.parent;
  }
  return false;
}

/** True when the declaration's nearest enclosing namespace is `name`
 * (`declare global { namespace NodeJS { ... } }` — the NodeJS-global
 * interfaces @types/node declares outside any ambient module). */
export function isDeclaredInAmbientNamespace(d: ts.Declaration, name: string): boolean {
  let node: ts.Node | undefined = d.parent;
  while (node) {
    if (ts.isModuleDeclaration(node) && ts.isIdentifier(node.name)) {
      return node.name.text === name;
    }
    node = node.parent;
  }
  return false;
}
