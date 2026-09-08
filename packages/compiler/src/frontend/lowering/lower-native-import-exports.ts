import * as ts from "../ts7/adapter.js";
import { isCjsJsFile, orderedImportsOf } from "../program.js";
import { isIslandModulePath } from "../tiering.js";
import type { Lowerer } from "./lowerer.js";

function isTypeOnly(L: Lowerer, symbol: ts.Symbol): boolean {
  return L.checker.declarationsOf(symbol).some(decl =>
    ts.isExportSpecifier(decl) && (decl.isTypeOnly ||
      (ts.isExportDeclaration(decl.parent.parent) && decl.parent.parent.isTypeOnly)));
}

type ExportBinding = { symbol: ts.Symbol } | { module: ts.SourceFile; name: string; site: ts.Node };
interface ExportTable {
  direct: Map<string, ExportBinding>;
  stars: ts.SourceFile[];
}

const AMBIGUOUS = Symbol("ambiguous module export");
type Resolution = ts.Symbol | typeof AMBIGUOUS | null;

/** Runtime GetExportedNames/ResolveExport over the compiled ESM graph.
 * Symbol.getExports() only contains direct declarations. The checker's
 * resolved export table also represents type-only edges and cannot by itself
 * describe a runtime namespace. Keep runtime edges, explicit overrides and
 * original binding identity together here instead of merging copied values. */
export function nativeModuleExports(L: Lowerer, root: ts.SourceFile, site: ts.CallExpression): [string, ts.Symbol][] {
  const tables = new Map<ts.SourceFile, ExportTable>();
  const dependencies = new Map<ts.SourceFile, Map<ts.Statement, ts.SourceFile | null>>();
  const dependenciesOf = (sf: ts.SourceFile): Map<ts.Statement, ts.SourceFile | null> => {
    let deps = dependencies.get(sf);
    if (!deps) {
      deps = new Map(orderedImportsOf(L.program, sf).map(({ stmt, dep }) => [stmt, dep]));
      dependencies.set(sf, deps);
    }
    return deps;
  };
  const compiledEsm = (dep: ts.SourceFile | null | undefined): dep is ts.SourceFile =>
    dep !== null && dep !== undefined && !dep.isDeclarationFile && L.fileTag.has(dep) &&
    !dep.fileName.endsWith(".cts") && !isCjsJsFile(dep) && !isIslandModulePath(dep.fileName);

  const bindingOf = (symbol: ts.Symbol): ExportBinding | null => {
    const seen = new Set<ts.Symbol>();
    while (!seen.has(symbol)) {
      seen.add(symbol);
      // A default expression owns storage before alias resolution. This is
      // also where ordinary live variable bindings terminate.
      if (L.globalsBySymbol.has(symbol)) return { symbol };
      for (const decl of L.checker.declarationsOf(symbol)) {
        let stmt: ts.ImportDeclaration | ts.ExportDeclaration | undefined;
        let name: string | undefined;
        if (ts.isExportSpecifier(decl) && ts.isExportDeclaration(decl.parent.parent)) {
          if (decl.isTypeOnly || decl.parent.parent.isTypeOnly) return null;
          stmt = decl.parent.parent;
          name = (decl.propertyName ?? decl.name).text;
        } else if (ts.isImportSpecifier(decl) && ts.isImportDeclaration(decl.parent.parent.parent)) {
          stmt = decl.parent.parent.parent;
          if (decl.isTypeOnly || stmt.importClause?.phaseModifier === ts.SyntaxKind.TypeKeyword) return null;
          name = (decl.propertyName ?? decl.name).text;
        } else if (ts.isImportClause(decl) && ts.isImportDeclaration(decl.parent)) {
          if (decl.phaseModifier === ts.SyntaxKind.TypeKeyword) return null;
          stmt = decl.parent;
          name = "default";
        }
        if (stmt?.moduleSpecifier && name !== undefined) {
          const dep = dependenciesOf(stmt.getSourceFile()).get(stmt);
          if (compiledEsm(dep)) return { module: dep, name, site: decl };
        }
      }
      if (!(symbol.flags & ts.SymbolFlags.Alias)) {
        return symbol.flags & ts.SymbolFlags.Value ? { symbol } : null;
      }
      const next = L.checker.getImmediateAliasedSymbol(symbol);
      if (!next) return null;
      symbol = next;
    }
    return null;
  };

  const tableOf = (sf: ts.SourceFile): ExportTable => {
    const cached = tables.get(sf);
    if (cached) return cached;
    const moduleSymbol = L.checker.getSymbolAtLocation(sf);
    if (!moduleSymbol) L.unsupported("SC1090", site, "native import() namespace without a module export table");
    const table: ExportTable = { direct: new Map(), stars: [] };
    tables.set(sf, table);
    for (const [key, symbol] of moduleSymbol.getExports()) {
      if (symbol.flags & ts.SymbolFlags.ExportStar || key === "export=" || isTypeOnly(L, symbol)) continue;
      const binding = bindingOf(symbol);
      if (!binding) continue;
      // Symbol.name is unescaped; the raw table key adds an underscore to __.
      table.direct.set(symbol.name, binding);
    }
    for (const [stmt, dep] of dependenciesOf(sf)) {
      if (!ts.isExportDeclaration(stmt) || stmt.exportClause !== undefined) continue;
      if (!compiledEsm(dep)) {
        L.unsupported("SC1090", stmt,
          "native import() runtime 'export *' requires a compiled ESM dependency");
      }
      table.stars.push(dep);
    }
    return table;
  };

  const namesOf = (sf: ts.SourceFile, visited: Set<ts.SourceFile>): Set<string> => {
    if (visited.has(sf)) return new Set();
    visited.add(sf);
    const table = tableOf(sf);
    const names = new Set(table.direct.keys());
    for (const dep of table.stars) {
      for (const name of namesOf(dep, visited)) if (name !== "default") names.add(name);
    }
    return names;
  };

  // The visited set belongs to ONE export-name resolution. Sharing cached
  // partial results between names or cycle roots would drop valid bindings.
  const resolve = (sf: ts.SourceFile, name: string, visited: Map<ts.SourceFile, Set<string>>): Resolution => {
    let names = visited.get(sf);
    if (names?.has(name)) return null;
    if (!names) visited.set(sf, names = new Set());
    names.add(name);
    const table = tableOf(sf);
    const direct = table.direct.get(name);
    if (direct) {
      if ("symbol" in direct) return direct.symbol;
      const target = resolve(direct.module, direct.name, visited);
      if (target === AMBIGUOUS) L.unsupported("SC1090", direct.site,
        `native import() named re-export '${name}' resolves to conflicting wildcard bindings`);
      return target;
    }
    if (name === "default") return null;
    let result: ts.Symbol | null = null;
    for (const dep of table.stars) {
      const candidate = resolve(dep, name, visited);
      if (candidate === AMBIGUOUS) return AMBIGUOUS;
      if (candidate === null) continue;
      if (result !== null && result !== candidate) return AMBIGUOUS;
      result = candidate;
    }
    return result;
  };

  const exports: [string, ts.Symbol][] = [];
  const names = namesOf(root, new Set());
  // Linking validates named re-exports even if an explicit root export hides
  // them. Give each indirect binding its own resolution set: earlier stars
  // must not hide one side of a conflict in a dependent module. Resolving an
  // indirect target may append another table; Map iteration visits it too.
  for (const [sf, table] of tables) {
    for (const [name, binding] of table.direct) {
      if ("module" in binding) resolve(sf, name, new Map());
    }
  }
  for (const name of names) {
    const symbol = resolve(root, name, new Map());
    // ESM namespace objects omit ambiguous wildcard exports. An explicit
    // named import of such a binding is still rejected during preflight.
    if (symbol !== null && symbol !== AMBIGUOUS) exports.push([name, symbol]);
  }
  return exports.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
}
