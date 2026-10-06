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
 * what makes the evaluation unobservable; the failure cases are not
 * reproduced, exactly as a bundler does not reproduce them. A package that
 * declares `sideEffects: false` untruthfully diverges here. So does a
 * dependency package outside the program (its files are never scanned)
 * that imports an undeclared package which runs code at load, or that
 * awaits at the top level: only packages in the program are read for
 * cycles and awaits. A nested
 * format scope's own package.json (dist/esm/package.json) is not
 * consulted: the named package root decides.
 *
 * Three conditions keep the decision from reaching beyond that declaration.
 * An edge is pruned only when everything its target can reach is covered
 * by it: no import of a package the purity check did not prove (an
 * undeclared, hoisted or dev dependency would have run its top level in
 * Node), no import Node resolves outside the program, no import cycle and
 * no top-level await.
 * The cycle condition keeps evaluation order exact: dropping a subtree
 * that could enter a cycle through a different module changes which module
 * of the cycle evaluates first, and scriptc's TDZ guard then refuses (or,
 * worse, admits) a program Node runs in another order. The await condition
 * does the same for asynchronous modules: Node starts an importer's body
 * only after every asynchronous dependency completed, so a skipped module
 * that awaits would let the importers of its barrel run ahead of their
 * siblings even though awaiting has no effect of its own, and the
 * declaration, however truthful, says nothing about that order. A pruned
 * closure that is acyclic, synchronous and covered is a successor-closed
 * region of modules that have no effects to order, so the modules left in
 * the program keep their relative order.
 *
 * Keep the decision per tsgo program: preflight, the link checks, and
 * emitted module init headers must see one graph. */

import * as ts from "./ts7/adapter.js";
import { isBuiltin } from "node:module";
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

  const valueReexport = (stmt: ts.Statement): stmt is ts.ExportDeclaration & { moduleSpecifier: ts.StringLiteral } =>
    ts.isExportDeclaration(stmt) && !erasedTypeOnlyReexport(stmt) &&
    stmt.moduleSpecifier !== undefined && ts.isStringLiteral(stmt.moduleSpecifier);

  /** Everything one module evaluates at load besides itself, as written:
   * its import declarations, its value re-exports and its literal
   * require() and import() calls (anywhere in the file, an over-approximation
   * of what runs at load), each with the module the program resolved or
   * null when it resolved to none. */
  interface ModuleEdge {
    spec: string;
    dep: ts.SourceFile | null;
  }
  const moduleEdgesMemo = new Map<ts.SourceFile, readonly ModuleEdge[]>();
  const moduleEdgesOf = (sf: ts.SourceFile): readonly ModuleEdge[] => {
    const cached = moduleEdgesMemo.get(sf);
    if (cached !== undefined) return cached;
    const out: ModuleEdge[] = [];
    for (const stmt of sf.statements) {
      if (ts.isImportDeclaration(stmt)) {
        if (ts.isStringLiteral(stmt.moduleSpecifier) && !erasedTypeOnlyImport(stmt)) {
          out.push({ spec: stmt.moduleSpecifier.text, dep: edge(sf, stmt.moduleSpecifier.text) });
        }
      } else if (valueReexport(stmt)) {
        out.push({ spec: stmt.moduleSpecifier.text, dep: edge(sf, stmt.moduleSpecifier.text) });
      }
    }
    ts.walkPreorder(sf, (node) => {
      if (!ts.isCallExpression(node) || node.arguments.length !== 1) return undefined;
      const arg = node.arguments[0];
      if (arg === undefined || !ts.isStringLiteralLike(arg)) return undefined;
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          ts.isIdentifier(node.expression) && node.expression.text === "require") {
        out.push({ spec: arg.text, dep: edge(sf, arg.text) });
      }
      return undefined;
    });
    moduleEdgesMemo.set(sf, out);
    return out;
  };

  // Whether the module's own package makes the whole-tree promise.
  const modulePurityMemo = new Map<ts.SourceFile, boolean>();
  const modulePackagePure = (sf: ts.SourceFile): boolean => {
    let pure = modulePurityMemo.get(sf);
    if (pure === undefined) {
      const pkg = npmStaticPackageOfPath(sf.fileName);
      const pkgPath = pkg === null ? null : packageRootJsonPath(sf.fileName, pkg);
      pure = pkgPath !== null && purePackageTree(pkgPath, pureMemo, new Set()).pure;
      modulePurityMemo.set(sf, pure);
    }
    return pure;
  };

  /** An import the program never scanned: a Node builtin, or a bare
   * specifier naming another package whose whole declared tree makes the
   * promise. Anything else (a file outside the program, an unresolvable
   * name, the module's own package by its name, a `#imports` entry) is
   * outside what the declaration covers. */
  const unscannedImportCovered = (from: ts.SourceFile, spec: string): boolean => {
    if (isBuiltin(spec)) return true;
    if (spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("#")) return false;
    const resolved = resolveBareModule(from.fileName, spec, "js-only");
    if (resolved === null || resolved.packageName === npmStaticPackageOfPath(from.fileName)) return false;
    const rootPath = packageRootJsonPath(resolved.typesFile, resolved.packageName);
    return rootPath !== null && purePackageTree(rootPath, pureMemo, new Set()).pure;
  };

  /** A module is asynchronous when an await or for-await sits outside every
   * nested function-like boundary, the same reading the lowering uses to
   * make a module's init asynchronous (lower-module-init.ts). */
  const awaitMemo = new Map<ts.SourceFile, boolean>();
  const awaitsAtTopLevel = (sf: ts.SourceFile): boolean => {
    let found = awaitMemo.get(sf);
    if (found === undefined) {
      found = false;
      ts.walkPreorder(sf, (node) => {
        if (node !== sf && ts.isFunctionLike(node)) return "skip";
        if (ts.isAwaitExpression(node) || (ts.isForOfStatement(node) && node.awaitModifier !== undefined)) {
          found = true;
          return "stop";
        }
        return undefined;
      });
      awaitMemo.set(sf, found);
    }
    return found;
  };

  const inProgram = (dep: ts.SourceFile): boolean => dep.fileName.endsWith(".json") || available.has(dep);
  const moduleCovered = (sf: ts.SourceFile): boolean =>
    modulePackagePure(sf) && !awaitsAtTopLevel(sf) &&
    moduleEdgesOf(sf).every(({ spec, dep }) => (dep !== null && inProgram(dep)) || unscannedImportCovered(sf, spec));

  const closureMemo = new Map<ts.SourceFile, boolean>();
  interface Visit {
    sf: ts.SourceFile;
    /** Discovery order, and the lowest order this module can reach. */
    at: number;
    low: number;
    covered: boolean;
    edges: readonly ModuleEdge[];
    next: number;
  }
  /** True when everything `root` can load is covered by the purity
   * declaration and none of it sits on an import cycle or awaits at the top
   * level: every module it reaches belongs to a package that makes the
   * whole-tree promise, every import it makes is a program module, a
   * builtin or a package that does, none of those modules is
   * asynchronous, and the reachable graph is acyclic. Only then does
   * skipping `root` neither skip an uncovered module's evaluation nor
   * change the order in which the remaining modules evaluate. Tarjan,
   * memoized across roots: a component is final when its root pops. */
  const closureCovered = (root: ts.SourceFile): boolean => {
    if (root.fileName.endsWith(".json")) return true;
    const known = closureMemo.get(root);
    if (known !== undefined) return known;
    if (!available.has(root)) {
      closureMemo.set(root, false);
      return false;
    }
    // Iterative on purpose: an import chain thousands of modules deep
    // (generated code does that) must not overflow the compiler's stack.
    const visits = new Map<ts.SourceFile, Visit>();
    const onStack = new Set<ts.SourceFile>();
    const stack: Visit[] = [];
    const path: Visit[] = [];
    const enter = (sf: ts.SourceFile): void => {
      const visit: Visit = { sf, at: visits.size, low: visits.size, covered: moduleCovered(sf), edges: moduleEdgesOf(sf), next: 0 };
      visits.set(sf, visit);
      stack.push(visit);
      onStack.add(sf);
      path.push(visit);
    };
    enter(root);
    for (let visit = path.at(-1); visit !== undefined; visit = path.at(-1)) {
      const next = visit.edges[visit.next++];
      if (next !== undefined) {
        const dep = next.dep;
        if (dep === null || dep === visit.sf || dep.fileName.endsWith(".json") || !available.has(dep)) continue;
        const done = closureMemo.get(dep);
        if (done !== undefined) {
          visit.covered &&= done;
          continue;
        }
        const seen = visits.get(dep);
        if (seen === undefined) enter(dep);
        else if (onStack.has(dep)) visit.low = Math.min(visit.low, seen.at);
        continue;
      }
      path.pop();
      if (visit.low === visit.at) {
        const component: ts.SourceFile[] = [];
        for (let member = stack.pop(); member !== undefined; member = stack.pop()) {
          onStack.delete(member.sf);
          component.push(member.sf);
          if (member === visit) break;
        }
        // A component of several modules is an import cycle.
        const result = component.length === 1 && visit.covered;
        for (const member of component) closureMemo.set(member, result);
      }
      const parent = path.at(-1);
      if (parent !== undefined) {
        parent.low = Math.min(parent.low, visit.low);
        parent.covered &&= closureMemo.get(visit.sf) ?? true;
      }
    }
    return closureMemo.get(root) ?? false;
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
  // The star chain is walked recursively: past this depth the surface is
  // answered as not enumerable (the whole target is followed), which is
  // always sound and keeps a pathological chain from overflowing the stack.
  const MAX_STAR_DEPTH = 64;
  const exportNamesOf = (sf: ts.SourceFile): ReadonlySet<string> | null => {
    const cached = exportNamesMemo.get(sf);
    if (cached !== undefined) return cached;
    if (exportNamesVisiting.has(sf) || exportNamesVisiting.size >= MAX_STAR_DEPTH) return null;
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
   * answer is only ever given for a prunable edge whose target's whole
   * closure the purity declaration covers (closureCovered); an edge that
   * fails it answers as a statement that cannot be pruned. */
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
    const answer = demandThrough(stmt, dep, narrowed);
    if (answer === null || answer.length > 0 || (dep !== null && closureCovered(dep))) return answer;
    return demandThrough(stmt, dep, null);
  };

  const demandThrough = (
    stmt: ts.ExportDeclaration,
    dep: ts.SourceFile | null,
    narrowed: ReadonlySet<string> | null,
  ): readonly string[] | null => {
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

  // Imports and require()/import() calls evaluate their target whatever
  // is demanded from this module: one pass per file. Re-exports depend on
  // the demand and are revisited whenever it grows.
  const scanned = new Set<ts.SourceFile>();
  for (let index = 0; index < queue.length; index++) {
    const sf = queue[index];
    if (sf === undefined) continue;
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
    packages: prunedPackages(prunedTargets, available, demanded, moduleEdgesOf),
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
  edgesOf: (sf: ts.SourceFile) => readonly { dep: ts.SourceFile | null }[],
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
    const sf = queue[index];
    if (sf === undefined) continue;
    for (const { dep } of edgesOf(sf)) visit(dep);
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
