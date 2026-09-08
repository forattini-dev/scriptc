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
  const visit = (value: ts.Expression | undefined): IrType | null => {
    if (!value || seen.has(value)) return null;
    seen.add(value);
    if (ts.isParenthesizedExpression(value) || ts.isAsExpression(value) || ts.isTypeAssertion(value) || ts.isNonNullExpression(value)) return visit(value.expression);
    if (ts.isAwaitExpression(value)) {
      const inner = visit(value.expression);
      return inner?.kind === "promise" ? inner.inner : inner;
    }
    if (ts.isCallExpression(value)) {
      return nativeImportTargetOf(L, value) ? { kind: "promise", inner: JSVAL } : null;
    }
    if (!ts.isIdentifier(value)) return null;
    let symbol = L.checker.getSymbolAtLocation(value);
    if (!symbol) return null;
    if (symbol.flags & ts.SymbolFlags.Alias) symbol = L.checker.getAliasedSymbol(symbol);
    for (const decl of L.checker.declarationsOf(symbol)) {
      if (ts.isVariableDeclaration(decl) && ts.isIdentifier(decl.name)) {
        const type = visit(decl.initializer);
        if (type) return type;
      }
      if (ts.isParameter(decl) && L.jsvalParamOverrides.has(decl)) return JSVAL;
    }
    return null;
  };
  return visit(expr);
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
