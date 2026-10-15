import * as ts from "../ts7/adapter.js";
import { activeRuntimeTarget } from "../../compat/runtime-target.js";
import type { Lowerer } from "./lowerer.js";

/** Recognize Bun's ambient module alias without claiming shadowed user objects. */
export function isBunGlobalMember(L: Lowerer, node: ts.Expression, member: string): boolean {
  while (ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node)) node = node.expression;
  if (!L.nativeDenseArrays || activeRuntimeTarget().family !== "bun" || !ts.isPropertyAccessExpression(node) ||
      node.questionDotToken || node.name.text !== member) return false;
  if (L.isStdlibGlobal(node.expression, "Bun")) return true;
  // bun-types uses `export import Bun = BunModule`, resolving to module "bun".
  let receiver = node.expression;
  while (ts.isParenthesizedExpression(receiver)) receiver = receiver.expression;
  const name = ts.isIdentifier(receiver) ? receiver : ts.isPropertyAccessExpression(receiver) &&
    !receiver.questionDotToken && L.isStdlibGlobal(receiver.expression, "globalThis") ? receiver.name : null;
  if (!name || name.text !== "Bun") return false;
  const symbol = L.checker.getSymbolAtLocation(name);
  if (!symbol || !L.isStdlibSymbol(symbol)) return false;
  const resolved = symbol.flags & ts.SymbolFlags.Alias ? L.checker.getAliasedSymbol(symbol) : symbol;
  return L.isStdlibSymbol(resolved) && L.checker.declarationsOf(resolved).some(decl =>
    ts.isModuleDeclaration(decl) && ts.isStringLiteral(decl.name) && decl.name.text === "bun");
}
