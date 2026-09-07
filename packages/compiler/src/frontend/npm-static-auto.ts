/* Automatic npm admission follows imports, reexports and top-level requires
 * through opted-in runtime sources. Every candidate is judged once per
 * frontend fixpoint, from its importing package's own resolution realm.
 * Library mode additionally diagnoses runtime-only packages lacking types;
 * executable auto retains its existing eligibility/fallback policy. */
import type { NpmStaticStatus } from "../coverage/report.js";
import type { SrcLoc } from "../ir/nodes.js";
import { canonicalBuiltinModule, checkPreflight, isNodeTypesPath, loadProgram, locOf, requiresOf, resolveNpmImport, type LoadResult } from "./program.js";
import { npmStaticIneligibleReason, npmStaticPackageOfPath } from "./npm-static.js";
import { resolveBareModule } from "./resolve.js";
import { isRelativeSpecifier, isRuntimeSourceFileName } from "./shared.js";

export function detectAutoPackages(
  load: LoadResult,
  statuses: NpmStaticStatus[],
  mode: "auto" | "lib",
  judged: Set<string>,
  sites: Map<string, SrcLoc>,
): string[] {
  // package → the resolved types file AND the file whose import found it:
  // the runtime-JS probe below must resolve from the SAME importing file,
  // or a package visible only to a nested package.json realm (a pnpm
  // monorepo's packages/*/node_modules, unreachable from the entry's own
  // walk-up) answers "no runtime JS" for perfectly ordinary installs.
  const seen = new Map<string, { typesFile: string; fromFile: string }>();
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
      if (judged.has(npm.packageName)) continue;
      if (!seen.has(npm.packageName)) {
        seen.set(npm.packageName, { typesFile: npm.typesFile, fromFile: sf.fileName });
        sites.set(npm.packageName, loc);
      }
    }
  }
  const chosen: string[] = [];
  for (const [pkg, { typesFile, fromFile }] of seen) {
    judged.add(pkg);
    const jsEntry = resolveBareModule(fromFile, pkg, "js-only");
    const reason = npmStaticIneligibleReason(
      pkg,
      typesFile,
      jsEntry !== null && isRuntimeSourceFileName(jsEntry.typesFile) ? jsEntry.typesFile : null,
    );
    if (reason === null) chosen.push(pkg);
    else statuses.push({ package: pkg, status: "fallback", detail: mode === "lib" ? reason : `auto: ${reason}` });
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
    const probe = loadProgram(entryPath, { npmStatic: retained, externalTypes });
    try {
      if (!checkPreflight(probe).some((d) => d.code === "SC0001")) return candidate;
    } finally { probe.dispose(); }
  }
  return null;
}
