import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { satisfies } from "semver";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import * as ts from "../frontend/ts7/adapter.js";
import { packageNameOfSpecifier } from "../frontend/workspace-registry.js";
import { activeRuntimeConditions } from "../compat/runtime-target.js";
import { DeclarationOverlay, withDeclarationOverlay } from "./context.js";
import { discoverMissingTypes, lockDirectory } from "./discovery.js";
import { atomicWrite, DeclarationStore, readTypesLock } from "./store.js";

export interface TypeAcquisitionOptions {
  /** API calls default to local. The CLI selects auto unless overridden. */
  mode?: "local" | "auto" | "offline";
  lockPath?: string;
  cacheDir?: string;
  frozenLock?: boolean;
}

/** All downloads finish before the frontend runs. The overlay and lock are
 * complete for an operation; no ambient global or consumer install is edited. */
export async function prepareTypeAcquisition(entry: string, options: TypeAcquisitionOptions = {},
  externalTypes?: Readonly<Record<string, string>>): Promise<DeclarationOverlay> {
  const overlay = new DeclarationOverlay();
  const mode = options.mode ?? "local";
  if (mode === "local") return overlay;
  const root = lockDirectory(entry);
  const lockPath = resolve(options.lockPath ?? join(root, "scriptc.types.lock.json"));
  const lock = await readTypesLock(lockPath);
  const original = JSON.stringify(lock);
  const store = new DeclarationStore(options.cacheDir ?? join(process.env["XDG_CACHE_HOME"] ?? join(homedir(), ".cache"), "scriptc", "types-v1"), lock, mode === "offline");
  const conditions = [...activeRuntimeConditions()];
  const requests = discoverMissingTypes(entry, root, conditions, externalTypes);
  for (const request of requests) {
    let pinned = lock.requests[request.key];
    if (pinned === undefined) {
      if (options.frozenLock || mode === "offline") throw new Error(`declaration lock miss for ${request.specifier}; frozen/offline mode cannot select a version`);
      const key = await store.acquire(request.typesName, request.range);
      pinned = { package: key, subpath: request.specifier.slice(packageNameOfSpecifier(request.specifier).length) };
      lock.requests[request.key] = pinned;
    }
    const selected = lock.packages[pinned.package];
    if (selected?.name !== request.typesName || !satisfies(selected.version, request.range) ||
        pinned.subpath !== request.specifier.slice(packageNameOfSpecifier(request.specifier).length)) {
      throw new Error(`incompatible declaration lock for ${request.specifier}`);
    }
    const occupied = overlay.mounts.get(request.mount);
    if (occupied !== undefined && occupied !== pinned.package) throw new Error(`ambiguous declaration versions at ${request.mount}`);
    await mountPackage(store, overlay, pinned.package, request.mount, new Set());
    const pkg = lock.packages[pinned.package];
    if (!pkg) throw new Error("missing pinned declaration package");
    const typesFile = declarationEntry(overlay, request.from, request.specifier, conditions);
    overlay.resolutions.set(`${resolve(request.from)}\0${request.specifier}`, { typesFile, packageName: pkg.name, version: pkg.version });
  }
  store.validateGraph();
  // Let TS7 verify exact subpaths and declaration references.
  // Loading the same world also proves the checker consumes the mounted types.
  if (requests.length > 0) {
    const remaining = withDeclarationOverlay(overlay, () => discoverMissingTypes(entry, root, conditions, externalTypes));
    if (remaining.length > 0) throw new Error(`acquired declarations do not resolve ${remaining.map(r => r.specifier).join(", ")}`);
  }
  if (JSON.stringify(lock) !== original) {
    // Exclusive publication prevents a check/rename race between builds.
    await mkdir(dirname(lockPath), { recursive: true });
    const guard = `${lockPath}.writing`;
    await mkdir(guard);
    try {
      if (JSON.stringify(await readTypesLock(lockPath)) !== original) throw new Error("types lock changed during acquisition; retry the build");
      await atomicWrite(lockPath, JSON.stringify(lock, null, 2) + "\n");
    } finally { await rm(guard, { recursive: true }); }
  }
  return overlay;
}

async function mountPackage(store: DeclarationStore, overlay: DeclarationOverlay, key: string, mount: string, ancestors: Set<string>): Promise<void> {
  const pkg = store.lock.packages[key];
  if (!pkg) throw new Error(`missing declaration dependency ${key}`);
  if (ancestors.has(key)) throw new Error(`cyclic declaration package dependencies need explicit support: ${key}`);
  if (ancestors.size > 32 || overlay.files.size > 20_000) throw new Error("declaration graph exceeds size limit");
  const previous = overlay.mounts.get(mount);
  if (previous === key) return;
  if (previous !== undefined) throw new Error(`ambiguous declaration mount ${mount}`);
  overlay.mounts.set(mount, key);
  for (const [file, text] of await store.files(key)) overlay.add(join(mount, file), text);
  const next = new Set(ancestors).add(key);
  for (const [name, dependency] of Object.entries(pkg.dependencies)) {
    await mountPackage(store, overlay, dependency, join(mount, "node_modules", name), next);
  }
}

function declarationEntry(overlay: DeclarationOverlay, from: string, specifier: string, conditions: string[]): string {
  // TS7 resolves exports/types/typesVersions and exact subpaths itself, from
  // the original importer. The probe never joins the executable graph.
  return withDeclarationOverlay(overlay, () => {
    const probe = join(dirname(from), `.scriptc-declaration-probe-${randomUUID()}.ts`);
    const host = new ts.Ts7Host({ cwd: dirname(from) });
    try {
      host.addVirtualFile(probe, `import type * as T from ${JSON.stringify(specifier)};\n`);
      const program = ts.createProgram([probe], {
        module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
        customConditions: conditions, types: [], noLib: true,
      }, host);
      try {
        const broken = [...program.getSyntacticDiagnostics(),
          ...program.getSemanticDiagnostics().filter(d => [2307, 2688, 7016, 6053].includes(d.code))]
          .find(d => d.fileName !== undefined && overlay.files.has(resolve(d.fileName)));
        if (broken) throw new Error(`acquired declaration graph is incomplete: TS${broken.code} in ${broken.fileName}`);
        const source = program.getSourceFile(probe);
        const statement = source?.statements[0];
        const checker = program.getTypeChecker();
        const symbol = statement && ts.isImportDeclaration(statement)
          ? checker.getSymbolAtLocation(statement.moduleSpecifier) : undefined;
        const declaration = symbol ? checker.declarationsOf(symbol)[0]?.getSourceFile() : undefined;
        if (!declaration?.isDeclarationFile || !overlay.files.has(resolve(declaration.fileName))) {
          throw new Error(`acquired declarations do not cover exact subpath '${specifier}'`);
        }
        return declaration.fileName;
      } finally { program.dispose(); }
    } finally { host.close(); }
  });
}
