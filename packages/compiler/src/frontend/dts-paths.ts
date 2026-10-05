import { createRequire } from "node:module";
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
 * undici-types (its dependency — the web-platform globals: fetch/Response/
 * AbortSignal/ReadableStream/...), and the Bun surface (@types/bun →
 * bun-types → @types/node). They declare one ambient world (globals and
 * `declare module "node:*"` blocks), so a program carries exactly one copy
 * of each — see ProjectDeclarations. */
const NODE_TYPE_SURFACE_PACKAGES: ReadonlySet<string> = new Set(["@types/node", "undici-types", "bun-types", "@types/bun"]);

/** True for files belonging to the adopted Node type surface: the
 * @types/node package itself and undici-types (its dependency — the
 * web-platform globals: fetch/Response/AbortSignal/ReadableStream/...).
 * The provenance half of the lowering tables' recognition when the
 * fallback declarations stand down, and of the SC2020-family fence for
 * everything else those packages declare. */
export function isNodeTypesPath(file: string): boolean {
  const pkg = npmPackageNameOf(file);
  // bun-types/@types/bun: the Bun type surface (@types/bun → bun-types →
  // @types/node) — the same recognition applies, the lowering tables key
  // by member name + provenance either way.
  return pkg !== null && NODE_TYPE_SURFACE_PACKAGES.has(pkg);
}

/** The installed Node type surface package that owns `file`: its name and
 * the directory of that installed copy (the path through its last
 * `node_modules/<name>` segment), or null for every other file. Two copies
 * of one package are two roots whatever their versions — identical
 * declarations loaded twice collide exactly like different majors do. */
export function nodeTypeSurfacePackageOf(file: string): { name: string; root: string } | null {
  const parts = tsgoPath(file).split("/");
  const at = parts.lastIndexOf("node_modules");
  if (at < 0 || at + 1 >= parts.length) return null;
  const end = at + (parts[at + 1]!.startsWith("@") ? 3 : 2);
  if (end > parts.length) return null;
  const name = parts.slice(at + 1, end).join("/");
  return NODE_TYPE_SURFACE_PACKAGES.has(name) ? { name, root: parts.slice(0, end).join("/") } : null;
}
