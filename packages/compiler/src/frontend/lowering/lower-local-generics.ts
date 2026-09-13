import * as ts from "../ts7/adapter.js";
import type { Lowerer } from "./lowerer.js";
import type { IrExpr } from "../../ir/ir.js";
import { bindingContextualGenericFnNodeOf, bindingGenericFnInfoOf, bindingGenericFnNodeOf } from "./lower-calls.js";
import { lowerFamilyImpl } from "./lower-families.js";

function insideFunction(declaration: ts.VariableDeclaration): boolean {
  for (let node: ts.Node = declaration.parent; node && !ts.isSourceFile(node); node = node.parent) {
    if (ts.isFunctionLike(node)) return true;
  }
  return false;
}

/** Module bindings are immutable monomorphization aliases. Local generic
 * bindings need runtime storage so captures and reassignment are observable. */
export function registerModuleGenericBinding(L: Lowerer, declaration: ts.VariableDeclaration): boolean {
  const node = bindingGenericFnNodeOf(declaration) ?? bindingContextualGenericFnNodeOf(L, declaration);
  if (!node || insideFunction(declaration)) return false;
  bindingGenericFnInfoOf(L, declaration, node);
  return true;
}

/** A contextually generic initializer may have no explicit type parameters.
 * Join the declared slot's family before ordinary lambda signature lowering. */
export function lowerLocalGenericInitializer(L: Lowerer, declaration: ts.VariableDeclaration): IrExpr | null {
  if (!insideFunction(declaration)) return null;
  const node = bindingGenericFnNodeOf(declaration) ?? bindingContextualGenericFnNodeOf(L, declaration);
  if (!node) return null;
  const slot = L.typeOf(declaration.name);
  const type = L.mapTypeOf(slot);
  if (type?.kind !== "genericFunc") L.badType(declaration.name, slot);
  return lowerFamilyImpl(L, node, type.familyId, slot);
}
