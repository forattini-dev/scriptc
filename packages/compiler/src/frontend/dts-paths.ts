import { createRequire } from "node:module";
import { trackedReadFile } from "./input-tracker.js";
import { npmPackageNameOf } from "./workspace-registry.js";

const require = createRequire(import.meta.url);

/** tsgo uses slash-normalized file names on Windows (for SourceFile names
 * and virtual-FS callbacks), while Node's path APIs use backslashes there.
 * POSIX backslashes stay literal: they are valid filename characters. */
export function tsgoPath(path: string, platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? path.replaceAll("\\", "/") : path;
}

/** Path of the shipped ambient declarations — the always-shipped CORE
 * (comptime/__island_eval, setTimeout). Part of EVERY program scriptc
 * builds, the project-world preflight program included. */
export function ambientDtsPath(): string {
  return tsgoPath(require.resolve("@scriptc/compiler/scriptc.d.ts"));
}

/** Path of the shipped divergence/precision OVERRIDES (JSON.parse():
 * unknown, pop(): T, the Promise executor shape, ...). Part of the LOWERING
 * program only — preflight's project-world second chance builds without it,
 * so a project that typechecks under its own tsc never fails preflight over
 * an override-manufactured error (checkPreflight). */
export function overridesDtsPath(): string {
  return tsgoPath(require.resolve("@scriptc/compiler/scriptc-overrides.d.ts"));
}

/** Path of the shipped FALLBACK declarations (console, process, node:fs) —
 * part of the program only when the target project has no @types/node.
 * With @types/node, the project's real Node types stand in and this file
 * stands down (its declaration forms would collide). */
export function fallbackDtsPath(): string {
  return tsgoPath(require.resolve("@scriptc/compiler/scriptc-node-fallback.d.ts"));
}

/** The packages that declare the Node type surface: @types/node itself,
 * undici-types (its dependency: the web-platform globals fetch, Response,
 * AbortSignal, ReadableStream and the rest), and the Bun surface (@types/bun,
 * which chains bun-types, which chains @types/node). Provenance for the
 * lowering tables keys on this whole set. */
const NODE_TYPE_SURFACE_PACKAGES: ReadonlySet<string> = new Set(["@types/node", "undici-types", "bun-types", "@types/bun"]);

/** The AMBIENT half of the surface: packages whose declarations are globals
 * and `declare module "node:*"` blocks, so two copies in one checker program
 * redeclare one world (two `export =` assignments on `node:events`, merged
 * classes that lose their members). A program carries one copy of each, see
 * ProjectDeclarations. undici-types is not in this set: it is module-shaped
 * (every file is an ES module that @types/node imports from its own
 * install), so a second copy beside the first declares nothing twice. */
const AMBIENT_SURFACE_PACKAGES: ReadonlySet<string> = new Set(["@types/node", "bun-types", "@types/bun"]);

/** Which declaration files belong to an ambient surface copy that no
 * node_modules path names (a vendored directory a tsconfig `typeRoots` points
 * at): memoized per directory for one load, reset by resetNodeTypesPathCache. */
const vendoredOwnerCache = new Map<string, { name: string; root: string } | null>();

/** Forgets what isNodeTypesPath learned about vendored copies (every load starts clean). */
export function resetNodeTypesPathCache(): void {
  vendoredOwnerCache.clear();
}

/** True for files belonging to the adopted Node type surface: the
 * @types/node package itself and undici-types (its dependency — the
 * web-platform globals: fetch/Response/AbortSignal/ReadableStream/...).
 * The provenance half of the lowering tables' recognition when the
 * fallback declarations stand down, and of the SC2020-family fence for
 * everything else those packages declare. A copy outside node_modules (a
 * vendored directory named by tsconfig `typeRoots`) is recognized by its
 * package.json name, like the program's election of copies does. */
export function isNodeTypesPath(file: string): boolean {
  const pkg = npmPackageNameOf(file);
  // bun-types/@types/bun: the Bun type surface (@types/bun → bun-types →
  // @types/node) — the same recognition applies, the lowering tables key
  // by member name + provenance either way.
  if (pkg !== null) return NODE_TYPE_SURFACE_PACKAGES.has(pkg);
  return nodeTypeSurfacePackageOf(file, vendoredOwnerCache) !== null;
}

/** True for a file of the undici-types package (the web-platform half of a
 * Node type surface copy; see AMBIENT_SURFACE_PACKAGES). */
export function isUndiciTypesPath(file: string): boolean {
  return npmPackageNameOf(file) === "undici-types";
}

/** The installed ambient Node type surface package that owns the declaration
 * file `file`: its name and the directory of that installed copy, or null for
 * every other file. The owner is the nearest package.json upward, matched by
 * its `name`: a copy is a copy wherever it lives (a node_modules install, a
 * vendored directory a tsconfig `typeRoots` names), and two copies are two
 * roots whatever their versions. `cache` memoizes the answer per directory
 * for one program load. */
export function nodeTypeSurfacePackageOf(
  file: string,
  cache: Map<string, { name: string; root: string } | null> = new Map(),
): { name: string; root: string } | null {
  const path = tsgoPath(file);
  if (!/\.d\.(?:ts|mts|cts)$/.test(path)) return null;
  const visited: string[] = [];
  let owner: { name: string; root: string } | null = null;
  for (let dir = path.slice(0, path.lastIndexOf("/")); ; ) {
    const cached = cache.get(dir);
    if (cached !== undefined) { owner = cached; break; }
    visited.push(dir);
    const text = trackedReadFile(`${dir}/package.json`);
    if (text !== null) {
      let name: unknown;
      try { name = (JSON.parse(text) as { name?: unknown }).name; } catch { name = undefined; }
      owner = typeof name === "string" && AMBIENT_SURFACE_PACKAGES.has(name) ? { name, root: dir } : null;
      break;
    }
    const parent = dir.slice(0, dir.lastIndexOf("/"));
    if (parent === dir || parent === "") break;
    dir = parent;
  }
  for (const dir of visited) cache.set(dir, owner);
  return owner;
}
