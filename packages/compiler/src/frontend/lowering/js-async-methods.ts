import * as ts from "../ts7/adapter.js";
import { isJsSourceFile } from "../program.js";
import type { ClassInfo } from "./lower-classes.js";
import type { Lowerer } from "./lowerer.js";

const deferredMethods = new WeakMap<Lowerer, ReadonlySet<ts.MethodDeclaration>>();
const deferredNames = new WeakMap<Lowerer, Map<ts.ClassLikeDeclaration, Set<string>>>();

function memberName(member: ts.MethodDeclaration | ts.PropertyDeclaration | ts.AccessorDeclaration): string | null {
  const name = member.name;
  return name && (ts.isIdentifier(name) || ts.isPrivateIdentifier(name) || ts.isStringLiteral(name))
    ? name.text : null;
}

function isAsyncJsMethod(node: ts.Node): node is ts.MethodDeclaration {
  return ts.isMethodDeclaration(node) && isJsSourceFile(node.getSourceFile()) &&
    node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword) === true;
}

/** Only closed, non-overridden JS method families use direct async calls.
 * Mark actual declaration identities, not all methods sharing a name:
 * an unrelated subclass's destroy() must not disable another resource.
 * Scan before base-first collection, including future and mixin classes. */
function deferredMethodSet(lowerer: Lowerer): ReadonlySet<ts.MethodDeclaration> {
  const cached = deferredMethods.get(lowerer);
  if (cached) return cached;
  const found = new Set<ts.MethodDeclaration>();
  const visit = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      const bases = node.heritageClauses?.filter(clause => clause.token === ts.SyntaxKind.ExtendsKeyword)
        .flatMap(clause => clause.types.map(type => lowerer.checker.getTypeAtLocation(type))) ?? [];
      for (const member of node.members) {
        if (!ts.isMethodDeclaration(member) && !ts.isPropertyDeclaration(member) &&
            !ts.isGetAccessor(member) && !ts.isSetAccessor(member)) continue;
        if (ts.getModifiers(member)?.some(modifier => modifier.kind === ts.SyntaxKind.StaticKeyword)) continue;
        const name = memberName(member);
        if (name === null || ts.isPrivateIdentifier(member.name)) continue;
        for (const base of bases) {
          const inherited = lowerer.checker.getPropertyOfType(base, name);
          if (!inherited) continue;
          if (isAsyncJsMethod(member)) found.add(member);
          for (const declaration of lowerer.checker.declarationsOf(inherited)) {
            if (isAsyncJsMethod(declaration)) found.add(declaration);
          }
        }
      }
    }
    node.forEachChild(visit);
  };
  for (const file of new Set([...lowerer.moduleOrder, lowerer.entry])) visit(file);
  deferredMethods.set(lowerer, found);
  return found;
}

export function deferJsAsyncMethod(lowerer: Lowerer, member: ts.MethodDeclaration): boolean {
  return isAsyncJsMethod(member) && (member.asteriskToken !== undefined || memberName(member) === null ||
    deferredMethodSet(lowerer).has(member));
}

/** Collection already resolved computed member names to their canonical
 * IR keys. Retain that key so a skipped declaration still shadows its base. */
export function noteDeferredJsAsyncMethod(lowerer: Lowerer, decl: ts.ClassLikeDeclaration, name: string): void {
  let classes = deferredNames.get(lowerer);
  if (!classes) {
    classes = new Map();
    deferredNames.set(lowerer, classes);
  }
  const names = classes.get(decl) ?? new Set<string>();
  names.add(name);
  classes.set(decl, names);
}

/** A deferred own declaration shadows its ancestor even without an ABI.
 * Lookup must not silently select the base implementation instead. */
export function ownsDeferredJsAsyncMethod(lowerer: Lowerer, info: ClassInfo, name: string): boolean {
  return info.decl !== null && deferredNames.get(lowerer)?.get(info.decl)?.has(name) === true;
}

/** Unknown receivers can dispatch into a deferred descendant; exact
 * receivers can still use an unrelated, synchronous base implementation. */
export function deferredJsAsyncOverrideBelow(lowerer: Lowerer, info: ClassInfo, name: string): boolean {
  return info.subclasses.some(child => ownsDeferredJsAsyncMethod(lowerer, child, name) ||
    deferredJsAsyncOverrideBelow(lowerer, child, name));
}
