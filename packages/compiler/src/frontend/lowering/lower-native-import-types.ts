import * as ts from "../ts7/adapter.js";
import { isCjsJsFile, pathAliasesProgramModule, resolveImport } from "../program.js";
import { isIslandModulePath } from "../tiering.js";
import { JSVAL, type IrType } from "../../ir/nodes.js";
import { importCallHandleType, type Lowerer } from "./lowerer.js";

/** A literal import whose namespace and evaluation both belong to the
 * compiled ESM graph. Resolution alone is insufficient: declaration-only,
 * CommonJS, JSON and explicitly embedded modules have different contracts. */
export function nativeImportTargetOf(L: Lowerer, call: ts.CallExpression): ts.SourceFile | null {
  if (call.expression.kind !== ts.SyntaxKind.ImportKeyword || call.arguments.length !== 1) return null;
  const arg = call.arguments[0];
  if (!arg || !ts.isStringLiteralLike(arg) || L.externalTypes.has(arg.text)) return null;
  const target = resolveImport(L.program, call.getSourceFile(), arg.text) ??
    pathAliasesProgramModule(L.program, arg.text);
  if (
    !target || target.isDeclarationFile || !L.fileTag.has(target) ||
    target.fileName.endsWith(".json") || target.fileName.endsWith(".cts") ||
    isCjsJsFile(target) || isIslandModulePath(target.fileName)
  ) return null;
  return target;
}

/** Native module namespaces use the backend's handle representation so
 * aliases retain the singleton and its live getters. A checker record
 * would instead copy the exports at every binding. Trace only import
 * results, their identifier aliases and native then-handler parameters;
 * arbitrary expressions keep their ordinary static type rules. */
export function nativeImportHandleType(L: Lowerer, expr: ts.Expression | undefined): IrType | null {
  if (L.dynamic) return null;
  const seen = new Set<ts.Node>();
  // This runs before expression lowering's depth fence. Both transparent
  // wrappers and identifier chains can be arbitrarily deep, so keep the DFS
  // on an explicit stack. These handles have at most one Promise layer.
  const pending: { node: ts.Node | undefined; awaited: boolean }[] = [{ node: expr, awaited: false }];
  while (pending.length > 0) {
    const candidate = pending.pop();
    if (!candidate) break;
    const { node: value, awaited } = candidate;
    if (!value || seen.has(value)) continue;
    seen.add(value);
    if (ts.isVariableDeclaration(value)) {
      if (ts.isIdentifier(value.name)) pending.push({ node: value.initializer, awaited });
      continue;
    }
    if (ts.isParameter(value)) {
      if (L.jsvalParamOverrides.has(value)) return JSVAL;
      continue;
    }
    if (ts.isParenthesizedExpression(value) || ts.isAsExpression(value) || ts.isTypeAssertion(value) || ts.isNonNullExpression(value)) {
      pending.push({ node: value.expression, awaited });
      continue;
    }
    if (ts.isAwaitExpression(value)) {
      pending.push({ node: value.expression, awaited: true });
      continue;
    }
    if (ts.isCallExpression(value)) {
      if (nativeImportTargetOf(L, value)) return awaited ? JSVAL : { kind: "promise", inner: JSVAL };
      continue;
    }
    if (!ts.isIdentifier(value)) continue;
    let symbol = L.checker.getSymbolAtLocation(value);
    if (!symbol) continue;
    if (symbol.flags & ts.SymbolFlags.Alias) symbol = L.checker.getAliasedSymbol(symbol);
    const declarations = L.checker.declarationsOf(symbol);
    // Reverse pushes preserve the recursive walk's declaration precedence.
    for (let index = declarations.length - 1; index >= 0; index--) {
      const declaration = declarations[index];
      if (declaration && (ts.isVariableDeclaration(declaration) || ts.isParameter(declaration))) {
        pending.push({ node: declaration, awaited });
      }
    }
  }
  return null;
}

/** The storage type behind a promise-valued expression whose CHECKER type
 * has no mapping — the dynamic-import receiver rule (--dynamic): a direct
 * `import("...")` call is the island promise itself; an identifier bound
 * to a promise-of-jsval local or module global answers the binding's
 * type. Null everywhere else. */
export function islandPromiseStorageTypeOf(L: Lowerer, e: ts.Expression): IrType | null {
  const direct = importCallHandleType(e);
  if (direct?.kind === "promise") return direct;
  if (!ts.isIdentifier(e)) return null;
  const local = L.resolveLocal(e);
  if (local?.type.kind === "promise" && local.type.inner.kind === "jsval") return local.type;
  if (local) return null;
  let sym = L.checker.getSymbolAtLocation(e);
  if (sym && sym.flags & ts.SymbolFlags.Alias) sym = L.checker.getAliasedSymbol(sym);
  const g = sym ? L.globalsBySymbol.get(sym) : undefined;
  if (g?.type.kind === "promise" && g.type.inner.kind === "jsval") return g.type;
  return null;
}
