/* A package may declare that all of its published files have no module
 * evaluation side effects. For opted-in static npm packages, that promise
 * lets a re-export edge nobody asks for disappear just as it does in a
 * bundler: `export * as name from "./module.js"`, `export { a, b as c } from
 * "./module.js"` (default forms included), and `export * from "./module.js"`
 * when the target's export names are syntactically known. Importing one
 * name from a barrel then admits that name's modules, not the package.
 *
 * What Node does differently for a pruned module: it still resolves, links
 * and evaluates it, so its top-level statements run, and a missing file,
 * syntax error, link error or top-level throw inside it fails the program
 * at startup. The package's whole-tree `sideEffects: false` declaration is
 * the proof that the evaluation is unobservable; the failure cases are not
 * reproduced, exactly as a bundler does not reproduce them. A package that
 * declares `sideEffects: false` untruthfully diverges here.
 *
 * Keep the decision per tsgo program: preflight, the link checks, and
 * emitted module init headers must see one graph. */

import * as ts from "./ts7/adapter.js";
import { dirname, join, relative, resolve } from "node:path";
import { nearestPackageType, resolveBareModule } from "./resolve.js";
import { npmStaticPackageOfPath } from "./npm-static.js";
import { trackedReadFile } from "./input-tracker.js";
import { npmPackageNameOf } from "./workspace-registry.js";
import { erasedTypeOnlyImport, erasedTypeOnlyReexport } from "./module-erasure.js";

/** One package's modules that the plan left out of the executable program
 * because only pruned re-export edges reach them. Paths are relative to the
 * package root when it is known, absolute otherwise. */
export interface NpmStaticPrunedPackage {
  package: string;
  modules: readonly string[];
}

interface PrunePlan {
  statements: ReadonlySet<ts.ExportDeclaration>;
  packages: readonly NpmStaticPrunedPackage[];
}

const planByProgram = new WeakMap<ts.Program, PrunePlan>();

export function isPrunedNpmReexport(program: ts.Program, stmt: ts.ExportDeclaration): boolean {
  return planByProgram.get(program)?.statements.has(stmt) ?? false;
}

/** The audit trail of the plan: every module Node would have evaluated but
 * the executable program omits, grouped by package and sorted. Empty when
 * nothing was pruned (or no plan ran for this program). */
export function prunedNpmStaticModules(program: ts.Program): readonly NpmStaticPrunedPackage[] {
  return planByProgram.get(program)?.packages ?? [];
}

function packageJson(path: string): Record<string, unknown> | null {
  const source = trackedReadFile(path);
  if (source === null) return null;
  try {
    const parsed: unknown = JSON.parse(source);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function noSideEffects(value: unknown): boolean {
  return value === false || (Array.isArray(value) && value.length === 0);
}

/** A nested format scope such as dist/esm/package.json is not the package's
 * published metadata. Stay inside the resolved package while finding its
 * named root, including pnpm's realpath and workspace-linked installs. */
function packageRootJsonPath(fromFile: string, packageName: string): string | null {
  let dir = dirname(resolve(fromFile));
  let root: string | null = null;
  while (npmPackageNameOf(dir.replaceAll("\\", "/")) === packageName) {
    const path = join(dir, "package.json");
    if (packageJson(path)?.["name"] === packageName) root = path;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return root;
}

/** A package's own sideEffects declaration cannot cover imports of a
 * dependency that runs at module init. Require the whole declared runtime
 * dependency tree to make the same promise before removing an edge. A cycle
 * back-edge is provisionally pure, but its result cannot be cached for a
 * descendant until all dependencies of the ancestor have been checked. */
type PackagePurity = { pure: boolean; provisional: boolean };

function purePackageTree(
  path: string,
  memo: Map<string, boolean>,
  visiting: Set<string>,
): PackagePurity {
  const cached = memo.get(path);
  if (cached !== undefined) return { pure: cached, provisional: false };
  if (visiting.has(path)) return { pure: true, provisional: true };
  const json = packageJson(path);
  if (json === null || !noSideEffects(json["sideEffects"])) {
    memo.set(path, false);
    return { pure: false, provisional: false };
  }
  visiting.add(path);
  let pure = true;
  let provisional = false;
  for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
    const dependencies = json[field];
    if (dependencies === null || typeof dependencies !== "object" || Array.isArray(dependencies)) continue;
    for (const name of Object.keys(dependencies as Record<string, unknown>)) {
      const resolved = resolveBareModule(path, name, "js-only");
      const depPath = resolved === null ? null : packageRootJsonPath(resolved.typesFile, name);
      const dep = depPath === null ? { pure: false, provisional: false } : purePackageTree(depPath, memo, visiting);
      if (!dep.pure) {
        pure = false;
        break;
      }
      provisional ||= dep.provisional;
    }
    if (!pure) break;
  }
  visiting.delete(path);
  // False is final. A true result is final only when it did not borrow an
  // ancestor's optimistic back-edge, or when the entire traversal is done.
  if (!pure || !provisional || visiting.size === 0) memo.set(path, pure);
  return { pure, provisional };
}

type Demand = Set<string> | null; // null requests the entire namespace

/** What one ES module exports by its own statements: the names it declares
 * or re-exports explicitly, and its `export * from` statements. */
interface ExportShape {
  names: ReadonlySet<string>;
  stars: readonly ts.ExportDeclaration[];
}

function bindingNames(name: ts.BindingName, out: Set<string>): void {
  if (ts.isIdentifier(name)) {
    out.add(name.text);
    return;
  }
  for (const element of name.elements) {
    if (ts.isBindingElement(element) && element.name !== undefined) bindingNames(element.name, out);
  }
}

/** An ES module's export names are fixed by its syntax. Collect a superset
 * (type-only declarations included: a candidate that is no runtime export
 * only costs precision), or answer null for a statement shape this reader
 * does not enumerate — the caller then requests the whole module. */
function exportShapeOf(sf: ts.SourceFile): ExportShape | null {
  const names = new Set<string>();
  const stars: ts.ExportDeclaration[] = [];
  for (const stmt of sf.statements) {
    if (ts.isExportAssignment(stmt)) {
      if (stmt.isExportEquals) return null;
      names.add("default");
      continue;
    }
    if (ts.isExportDeclaration(stmt)) {
      const clause = stmt.exportClause;
      if (clause === undefined) {
        if (stmt.isTypeOnly) continue;
        if (stmt.moduleSpecifier === undefined || !ts.isStringLiteral(stmt.moduleSpecifier)) return null;
        stars.push(stmt);
      } else if (ts.isNamespaceExport(clause)) {
        names.add(clause.name.text);
      } else {
        for (const element of clause.elements) names.add(element.name.text);
      }
      continue;
    }
    if (!ts.canHaveModifiers(stmt)) continue;
    const modifiers = ts.getModifiers(stmt);
    if (modifiers === undefined || !modifiers.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) continue;
    if (modifiers.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)) {
      names.add("default");
    } else if (ts.isVariableStatement(stmt)) {
      for (const declaration of stmt.declarationList.declarations) bindingNames(declaration.name, names);
    } else if (
      (ts.isFunctionDeclaration(stmt) || ts.isClassDeclaration(stmt) || ts.isEnumDeclaration(stmt) ||
        ts.isModuleDeclaration(stmt) || ts.isInterfaceDeclaration(stmt) || ts.isTypeAliasDeclaration(stmt) ||
        ts.isImportEqualsDeclaration(stmt)) &&
      stmt.name !== undefined && ts.isIdentifier(stmt.name)
    ) {
      names.add(stmt.name.text);
    } else {
      return null;
    }
  }
  return { names, stars };
}

/** Package files outside the demanded module graph are absent from the
 * executable program. All ordinary project files retain their preflight
 * behavior, including files not imported by the entry.
 *
 * Demand is tracked per module as the set of export names somebody asks
 * for (null: the whole namespace). Import statements always evaluate their
 * target, so they are always followed. A re-export statement is followed
 * for the names demanded THROUGH it, each passed on under the name the
 * target exports it by, so a chain of barrels narrows at every hop. A
 * statement nobody demands a name through is pruned only inside one
 * ES-module package whose whole dependency tree declares no side effects;
 * everywhere else it keeps evaluating its target. */
export function planNpmStaticReexports(
  program: ts.Program,
  entry: ts.SourceFile,
  files: readonly ts.SourceFile[],
  extraRoots: readonly string[],
  resolveEdge: (from: ts.SourceFile, spec: string) => ts.SourceFile | null,
  isEsModule: (sf: ts.SourceFile) => boolean,
): ts.SourceFile[] {
  const available = new Set(files);
  const demanded = new Map<ts.SourceFile, Demand>();
  const queue: ts.SourceFile[] = [];
  const request = (sf: ts.SourceFile | null, name: string | null): void => {
    if (sf === null || !available.has(sf)) return;
    if (npmStaticPackageOfPath(sf.fileName) === null) name = null;
    const previous = demanded.get(sf);
    if (previous === null) return;
    if (previous === undefined) {
      demanded.set(sf, name === null ? null : new Set([name]));
      queue.push(sf);
    } else if (name === null) {
      demanded.set(sf, null);
      queue.push(sf);
    } else if (!previous.has(name)) {
      previous.add(name);
      queue.push(sf);
    }
  };

  for (const sf of files) {
    if (npmStaticPackageOfPath(sf.fileName) === null) request(sf, null);
  }
  request(entry, null);
  for (const path of extraRoots) request(program.getSourceFile(path) ?? null, null);

  const edgeMemo = new Map<ts.SourceFile, Map<string, ts.SourceFile | null>>();
  const edge = (from: ts.SourceFile, spec: string): ts.SourceFile | null => {
    let bySpec = edgeMemo.get(from);
    if (bySpec === undefined) edgeMemo.set(from, bySpec = new Map());
    let dep = bySpec.get(spec);
    if (dep === undefined) bySpec.set(spec, dep = resolveEdge(from, spec));
    return dep;
  };

  // The package whose re-export edges may be pruned from this module: an
  // ES-module file of an opted-in package whose whole declared dependency
  // tree promises no evaluation side effects. Null keeps every edge.
  const pureMemo = new Map<string, boolean>();
  const prunablePackageMemo = new Map<ts.SourceFile, string | null>();
  const prunablePackageOf = (sf: ts.SourceFile): string | null => {
    const cached = prunablePackageMemo.get(sf);
    if (cached !== undefined) return cached;
    const pkg = npmStaticPackageOfPath(sf.fileName);
    const pkgPath = pkg === null ? null : packageRootJsonPath(sf.fileName, pkg);
    const result = pkg !== null && pkgPath !== null && nearestPackageType(sf.fileName) === "module" &&
      purePackageTree(pkgPath, pureMemo, new Set()).pure
      ? pkg
      : null;
    prunablePackageMemo.set(sf, result);
    return result;
  };

  // Every export name an ES module can provide, `export *` targets
  // included, or null when the surface is not syntactically enumerable: a
  // CommonJS or JSON target, an unresolved star target, or a star cycle.
  const shapeMemo = new Map<ts.SourceFile, ExportShape | null>();
  const shapeOf = (sf: ts.SourceFile): ExportShape | null => {
    let shape = shapeMemo.get(sf);
    if (shape === undefined) {
      shape = sf.isDeclarationFile || sf.fileName.endsWith(".json") || !isEsModule(sf) ? null : exportShapeOf(sf);
      shapeMemo.set(sf, shape);
    }
    return shape;
  };
  const exportNamesMemo = new Map<ts.SourceFile, ReadonlySet<string> | null>();
  const exportNamesVisiting = new Set<ts.SourceFile>();
  const exportNamesOf = (sf: ts.SourceFile): ReadonlySet<string> | null => {
    const cached = exportNamesMemo.get(sf);
    if (cached !== undefined) return cached;
    if (exportNamesVisiting.has(sf)) return null;
    const shape = shapeOf(sf);
    let names: Set<string> | null = shape === null ? null : new Set(shape.names);
    if (shape !== null && names !== null) {
      exportNamesVisiting.add(sf);
      for (const star of shape.stars) {
        const target = edge(sf, (star.moduleSpecifier as ts.StringLiteral).text);
        const targetNames = target === null ? null : exportNamesOf(target);
        if (targetNames === null) {
          names = null;
          break;
        }
        for (const name of targetNames) if (name !== "default") names.add(name);
      }
      exportNamesVisiting.delete(sf);
    }
    exportNamesMemo.set(sf, names);
    return names;
  };

  /** The names a value re-export asks of its target, given what is
   * demanded from the re-exporting module: null for the whole target, an
   * empty list when nothing is — the statement is then pruned. An empty
   * answer is only ever given for a prunable edge. */
  const reexportDemand = (
    sf: ts.SourceFile,
    stmt: ts.ExportDeclaration,
    dep: ts.SourceFile | null,
  ): readonly string[] | null => {
    const names = demanded.get(sf);
    const pkg = prunablePackageOf(sf);
    const narrowed = names !== undefined && names !== null && dep !== null && pkg !== null &&
      npmStaticPackageOfPath(dep.fileName) === pkg
      ? names
      : null;
    const clause = stmt.exportClause;
    if (clause === undefined) {
      // `export * from`: by name only where the target's candidates are
      // known; a star never carries `default`. A name this module also
      // exports explicitly shadows the star's at link time, but following
      // it anyway only admits a module Node evaluates too.
      if (narrowed === null || dep === null) return null;
      const candidates = exportNamesOf(dep);
      if (candidates === null) return null;
      return [...narrowed].filter((name) => name !== "default" && candidates.has(name));
    }
    if (ts.isNamespaceExport(clause)) {
      return narrowed !== null && !narrowed.has(clause.name.text) ? [] : null;
    }
    // Named forms pass each followed name on under the target's spelling.
    // A clause with no value binding (`export {} from`, or inline type-only
    // elements a Node target keeps as an empty request) asks for the
    // target's evaluation alone, like a bare import.
    const elements = clause.elements.filter((element) => !element.isTypeOnly);
    if (elements.length === 0) return null;
    const followed = narrowed === null ? elements : elements.filter((element) => narrowed.has(element.name.text));
    return [...new Set(followed.map((element) => (element.propertyName ?? element.name).text))];
  };

  const valueReexport = (stmt: ts.Statement): stmt is ts.ExportDeclaration & { moduleSpecifier: ts.StringLiteral } =>
    ts.isExportDeclaration(stmt) && !erasedTypeOnlyReexport(stmt) &&
    stmt.moduleSpecifier !== undefined && ts.isStringLiteral(stmt.moduleSpecifier);

  // Imports and require()/import() calls evaluate their target whatever
  // is demanded from this module: one pass per file. Re-exports depend on
  // the demand and are revisited whenever it grows.
  const scanned = new Set<ts.SourceFile>();
  for (let index = 0; index < queue.length; index++) {
    const sf = queue[index]!;
    for (const stmt of sf.statements) {
      if (!valueReexport(stmt)) continue;
      const dep = edge(sf, stmt.moduleSpecifier.text);
      const names = reexportDemand(sf, stmt, dep);
      if (names === null) request(dep, null);
      else for (const name of names) request(dep, name);
    }
    if (scanned.has(sf)) continue;
    scanned.add(sf);
    for (const stmt of sf.statements) {
      if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
      const clause = stmt.importClause;
      if (erasedTypeOnlyImport(stmt)) continue;
      const dep = edge(sf, stmt.moduleSpecifier.text);
      if (
        clause === undefined ||
        (clause.namedBindings !== undefined && (
          ts.isNamespaceImport(clause.namedBindings) ||
          ts.isNamedImports(clause.namedBindings) && clause.namedBindings.elements.every(element => element.isTypeOnly)
        ))
      ) {
        request(dep, null);
      } else {
        if (clause.name !== undefined) request(dep, "default");
        if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
          for (const element of clause.namedBindings.elements) {
            if (!element.isTypeOnly) request(dep, (element.propertyName ?? element.name).text);
          }
        }
      }
    }
    ts.walkPreorder(sf, (node) => {
      if (!ts.isCallExpression(node) || node.arguments.length !== 1) return undefined;
      const arg = node.arguments[0];
      if (arg === undefined || !ts.isStringLiteralLike(arg)) return undefined;
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          ts.isIdentifier(node.expression) && node.expression.text === "require") {
        request(edge(sf, arg.text), null);
      }
      return undefined;
    });
  }

  const pruned = new Set<ts.ExportDeclaration>();
  const prunedTargets: ts.SourceFile[] = [];
  for (const sf of demanded.keys()) {
    for (const stmt of sf.statements) {
      if (!valueReexport(stmt)) continue;
      const dep = edge(sf, stmt.moduleSpecifier.text);
      if (reexportDemand(sf, stmt, dep)?.length !== 0) continue;
      pruned.add(stmt);
      if (dep !== null) prunedTargets.push(dep);
    }
  }
  planByProgram.set(program, {
    statements: pruned,
    packages: prunedPackages(prunedTargets, available, demanded, edge),
  });
  return files.filter((sf) => npmStaticPackageOfPath(sf.fileName) === null || demanded.has(sf));
}

/** The modules only pruned edges reach: everything a pruned statement's
 * target would have admitted had the edge been followed whole, minus what
 * the program demands anyway. Files the checker loaded for other reasons
 * (type-only edges) were never candidates and are not reported. */
function prunedPackages(
  targets: readonly ts.SourceFile[],
  available: ReadonlySet<ts.SourceFile>,
  demanded: ReadonlyMap<ts.SourceFile, Demand>,
  edge: (from: ts.SourceFile, spec: string) => ts.SourceFile | null,
): NpmStaticPrunedPackage[] {
  const skipped = new Set<ts.SourceFile>();
  const queue: ts.SourceFile[] = [];
  const visit = (sf: ts.SourceFile | null): void => {
    if (sf === null || !available.has(sf) || demanded.has(sf) || skipped.has(sf)) return;
    skipped.add(sf);
    queue.push(sf);
  };
  for (const target of targets) visit(target);
  for (let index = 0; index < queue.length; index++) {
    const sf = queue[index]!;
    for (const stmt of sf.statements) {
      if (ts.isImportDeclaration(stmt)) {
        if (ts.isStringLiteral(stmt.moduleSpecifier) && !erasedTypeOnlyImport(stmt)) visit(edge(sf, stmt.moduleSpecifier.text));
      } else if (
        ts.isExportDeclaration(stmt) && !erasedTypeOnlyReexport(stmt) &&
        stmt.moduleSpecifier !== undefined && ts.isStringLiteral(stmt.moduleSpecifier)
      ) {
        visit(edge(sf, stmt.moduleSpecifier.text));
      }
    }
    ts.walkPreorder(sf, (node) => {
      if (!ts.isCallExpression(node) || node.arguments.length !== 1) return undefined;
      const arg = node.arguments[0];
      if (arg === undefined || !ts.isStringLiteralLike(arg)) return undefined;
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          ts.isIdentifier(node.expression) && node.expression.text === "require") {
        visit(edge(sf, arg.text));
      }
      return undefined;
    });
  }
  const byPackage = new Map<string, string[]>();
  for (const sf of skipped) {
    const pkg = npmStaticPackageOfPath(sf.fileName);
    if (pkg === null) continue;
    const rootJson = packageRootJsonPath(sf.fileName, pkg);
    const path = rootJson === null ? sf.fileName : relative(dirname(rootJson), sf.fileName).replaceAll("\\", "/");
    const modules = byPackage.get(pkg);
    if (modules === undefined) byPackage.set(pkg, [path]);
    else modules.push(path);
  }
  return [...byPackage]
    .map(([name, modules]) => ({ package: name, modules: modules.sort() }))
    .sort((a, b) => (a.package < b.package ? -1 : a.package > b.package ? 1 : 0));
}
