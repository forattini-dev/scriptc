import * as ts from "../ts7/adapter.js";
import type { Lowerer } from "./lowerer.js";

const overrideNames = new WeakMap<Lowerer, ReadonlySet<string>>();

/** Class shapes collect base-first, before their subclass tables exist.
 * Pre-scan the complete source graph so a future override cannot be hidden
 * by implicit-any specialization of the base method. Names deliberately
 * over-approximate ancestry: an unrelated override can cost specialization,
 * but can never incorrectly redirect a virtual call to the base body.
 * Include class expressions and nested/mixin classes, not just declarations. */
export function implicitMethodMayBeOverridden(lowerer: Lowerer, name: string): boolean {
  let names = overrideNames.get(lowerer);
  if (names === undefined) {
    const found = new Set<string>();
    const visit = (node: ts.Node): void => {
      if (
        (ts.isClassDeclaration(node) || ts.isClassExpression(node)) &&
        node.heritageClauses?.some((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword)
      ) {
        for (const member of node.members) {
          if (!ts.isMethodDeclaration(member) && !ts.isPropertyDeclaration(member) && !ts.isGetAccessor(member) && !ts.isSetAccessor(member)) continue;
          if (!member.name || ts.getModifiers(member)?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword)) continue;
          if (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name)) found.add(member.name.text);
        }
      }
      node.forEachChild(visit);
    };
    for (const file of lowerer.moduleOrder.length > 0 ? lowerer.moduleOrder : [lowerer.entry]) visit(file);
    names = found;
    overrideNames.set(lowerer, names);
  }
  return names.has(name);
}
