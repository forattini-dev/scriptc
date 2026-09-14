/* Automatic npm admission follows imports, reexports and top-level requires
 * through opted-in runtime sources. Every candidate is judged once per
 * frontend fixpoint, from its importing package's own resolution realm.
 * Library mode additionally diagnoses runtime-only packages lacking types;
 * executable auto retains its existing eligibility/fallback policy. */
import { checkPreflightTypes } from "./preflight-types.js";
import { registerNpmDeclaration } from "./npm-static-declarations.js";
import type { NpmStaticStatus } from "../coverage/report.js";
import type { SrcLoc } from "../ir/ir.js";
import { canonicalBuiltinModule, isNodeTypesPath, loadProgram, locOf, requiresOf, resolveNpmImport, type LoadResult } from "./program.js";
import { npmStaticIneligibleReason, npmStaticPackageOfPath } from "./npm-static.js";
import { resolveBareModule } from "./resolve.js";
import { isRelativeSpecifier } from "./workspace-registry.js";
import { isRuntimeSourceFileName } from "./tsc-codes.js";
import { isKernelModule } from "./builtin-modules.js";

export function detectAutoPackages(
  load: LoadResult,
  statuses: NpmStaticStatus[],
  mode: "auto" | "lib",
  judged: Set<string>,
  sites: Map<string, SrcLoc>,
  nativeKernels = false,
): string[] {
  // package → the resolved types file AND the file whose import found it:
  // the runtime-JS probe below must resolve the SAME specifier from that file,
  // or a package visible only to a nested package.json realm (a pnpm
  // monorepo's packages/*/node_modules, unreachable from the entry's own
  // walk-up) answers "no runtime JS" for perfectly ordinary installs.
  // Packages can expose only subpaths; their root need not be importable.
  const seen = new Map<string, { typesFile: string; fromFile: string; specifier: string }[]>();
  for (const sf of [...load.moduleOrder, load.entry]) {
    if (mode === "auto" && sf.fileName.includes("/node_modules/") && npmStaticPackageOfPath(sf.fileName) === null) continue;
    const edges: { spec: string; loc: SrcLoc }[] = [];
    for (const stmt of sf.statements) {
      if (ts7IsImportWithStringSpec(stmt)) {
        edges.push({ spec: (stmt as { moduleSpecifier: { text: string } }).moduleSpecifier.text, loc: locOf(stmt) });
      } else {
        // CJS packages spell their dep edges as top-level requires; the
        // import-statement scan alone would miss every one of them.
        for (const req of requiresOf(stmt)) edges.push({ spec: req.spec, loc: locOf(req.node) });
      }
    }
    for (const { spec, loc } of edges) {
      if (isRelativeSpecifier(spec) || spec.startsWith("node:") || spec.startsWith("#")) continue;
      // Bare builtin names ("fs", "path") are the builtin machinery's
      // business (and the SC4005 async_free gate's, in library mode) —
      // never npm candidates in either mode.
      if (canonicalBuiltinModule(spec) !== null) continue;
      // Static builds recognize kernel values by their declared provenance.
      // Replacing those declarations with inferred JS destroys that identity
      // and needlessly discovers the kernel package's implementation graph.
      // Dynamic builds still admit that graph under the ordinary npm policy.
      if (nativeKernels && isKernelModule(packageNameOfBareSpecifier(spec))) continue;
      const npm = resolveNpmImport(sf.fileName, spec);
      if (npm !== null && isNodeTypesPath(npm.typesFile)) continue;
      if (npm === null) {
        if (mode !== "lib") continue;
        const js = resolveBareModule(sf.fileName, spec, "js-only");
        if (js === null || judged.has(js.packageName)) continue;
        judged.add(js.packageName);
        sites.set(js.packageName, loc);
        statuses.push({ package: js.packageName, status: "fallback", detail: "it ships no own .d.ts declaration surface" });
        continue;
      }
      // Types-first resolution can name @types/foo for an import of foo.
      // Admission owns executable packages, never their declaration provider.
      // Keep the original declaration provider for identity/version checks.
      const pkg = npm.packageName.startsWith("@types/")
        ? resolveBareModule(sf.fileName, spec, "js-only")?.packageName ?? packageNameOfBareSpecifier(spec)
        : npm.packageName;
      if (judged.has(pkg)) continue;
      const entries = seen.get(pkg) ?? [];
      entries.push({ typesFile: npm.typesFile, fromFile: sf.fileName, specifier: spec });
      seen.set(pkg, entries);
      if (!sites.has(pkg)) sites.set(pkg, loc);
    }
  }
  const chosen: string[] = [];
  for (const [pkg, entries] of seen) {
    judged.add(pkg);
    const pairs: { runtime: string; declaration: string }[] = [];
    const checked = new Set<string>();
    let reason: string | null = null;
    for (const { typesFile, fromFile, specifier } of entries) {
      const jsEntry = resolveBareModule(fromFile, specifier, "js-only");
      const runtime = jsEntry !== null && isRuntimeSourceFileName(jsEntry.typesFile) ? jsEntry.typesFile : null;
      const identity = `${runtime}\0${typesFile}`;
      if (checked.has(identity)) continue;
      checked.add(identity);
      reason = npmStaticIneligibleReason(pkg, typesFile, runtime);
      if (reason !== null) break;
      if (runtime !== null) pairs.push({ runtime, declaration: typesFile });
    }
    if (reason === null) {
      chosen.push(pkg);
      for (const { runtime, declaration } of pairs) registerNpmDeclaration(runtime, declaration);
    } else statuses.push({ package: pkg, status: "fallback", detail: mode === "lib" ? reason : `auto: ${reason}` });
  }
  return chosen;
}

/** Import and reexport declarations both carry a string module specifier. */
function ts7IsImportWithStringSpec(stmt: unknown): stmt is { moduleSpecifier: { text: string } } {
  const s = stmt as { kind?: unknown; moduleSpecifier?: { text?: unknown } };
  return typeof s.moduleSpecifier?.text === "string";
}

/** The package-wide --npm-static name containing an exact bare specifier.
 * External mappings are exact (subpaths included), while npm-static owns a
 * whole package, so any mapped subpath conflicts with that package opt-in. */
function packageNameOfBareSpecifier(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0] ?? specifier;
}

/** External host mappings own their whole package boundary. Apply to each
 * newly discovered batch, not only to the direct imports in the scout. */
export function filterExternalNpmPackages(
  requested: string[], statuses: NpmStaticStatus[],
  externalTypes?: Readonly<Record<string, string>>,
): string[] {
  if (requested.length > 0 && externalTypes !== undefined) {
    const externalSpecifiersByPackage = new Map<string, string[]>();
    for (const specifier of Object.keys(externalTypes)) {
      const pkg = packageNameOfBareSpecifier(specifier);
      const specs = externalSpecifiersByPackage.get(pkg) ?? [];
      specs.push(specifier);
      externalSpecifiersByPackage.set(pkg, specs);
    }
    return requested.filter((pkg) => {
      const specs = externalSpecifiersByPackage.get(pkg);
      if (specs === undefined) return true;
      statuses.push({
        package: pkg,
        status: "fallback",
        detail: `mapped as an external host module by --external-types (${specs.map((s) => JSON.stringify(s)).join(", ")})`,
      });
      return false;
    });
  }
  return requested;
}

/** Preserve interacting packages when removing ONE candidate restores the
 * whole consumer's typecheck. SOLO probes can falsely blame a healthy
 * package for the declarations of its now-unselected dependencies.
 * Each trial uses a disposable real program; the caller must reload the
 * retained set afterwards because npm resolution state is per load. */
export function findSingleNpmSurfaceOffender(
  entryPath: string, packages: ReadonlySet<string>,
  externalTypes?: Readonly<Record<string, string>>,
): string | null {
  for (const candidate of packages) {
    const retained = [...packages].filter((name) => name !== candidate);
    if (!npmSurfaceHasTypeErrors(entryPath, retained, externalTypes)) return candidate;
  }
  return null;
}

/** A disposable type query, never a substitute for the final native preflight. */
export function npmSurfaceHasTypeErrors(
  entryPath: string, packages: Iterable<string>,
  externalTypes?: Readonly<Record<string, string>>,
): boolean {
  const probe = loadProgram(entryPath, { npmStatic: packages, externalTypes });
  try { return checkPreflightTypes(probe).some((d) => d.code === "SC0001"); }
  finally { probe.dispose(); }
}

/** The opted-in packages a consumer-anchored tsc message NAMES: module
 * specifiers in `Module '"spec"'` phrasings, and resolved file paths in
 * `import("…")` type spellings — the two ways the checker points at an
 * import surface from the importer's side. */
export function packagesNamedByDiag(message: string, optedIn: ReadonlySet<string>): Set<string> {
  const hits = new Set<string>();
  for (const m of message.matchAll(/Module '"([^"]+)"'/g)) {
    const spec = m[1]!;
    const parts = spec.split("/");
    const prefix = spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
    if (optedIn.has(prefix)) hits.add(prefix);
  }
  for (const m of message.matchAll(/import\("([^"]+)"\)/g)) {
    const pkg = npmStaticPackageOfPath(m[1]!);
    if (pkg !== null && optedIn.has(pkg)) hits.add(pkg);
  }
  return hits;
}
