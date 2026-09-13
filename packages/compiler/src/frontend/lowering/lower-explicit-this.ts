import * as ts from "../ts7/adapter.js";
import { DYN, type IrExpr } from "../../ir/ir.js";
import { locOf } from "../program.js";
import type { Lowerer } from "./lowerer.js";

/** A TypeScript function's explicit receiver is an ABI contract, not a normal
 * argument. Lexical arrow receivers require capture lowering, not ambient reads. */
export function lowerExplicitThis(L: Lowerer, expr: ts.Expression): IrExpr | null {
  for (let node = expr.parent; node; node = node.parent) {
    if (ts.isArrowFunction(node)) return null;
    if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) {
      const parameter = node.parameters.find(p => ts.isIdentifier(p.name) && p.name.text === "this");
      if (!parameter?.type) return null;
      const type = L.mapTypeOf(L.checker.getTypeAtLocation(parameter));
      if (!type) return null;
      const value: IrExpr = { kind: "libCall", fn: "dyn.this", args: [], type: DYN, loc: locOf(expr) };
      return type.kind === "dyn" ? value : L.coerceToExpected(value, type);
    }
    if (ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) return null;
  }
  return null;
}
