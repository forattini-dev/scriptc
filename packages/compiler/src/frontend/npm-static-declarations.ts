/* Third-party declarations authorize an AUTO attempt, never executable
 * signatures. Exact importer resolutions are paired with runtime entries
 * within one frontend fixpoint, including its fallback reloads. */
import { AsyncLocalStorage } from "node:async_hooks";
import { dirname, resolve } from "node:path";
import { parse } from "semver";
import { acquiredDeclarations } from "../type-acquisition/context.js";
import { trackedReadFile, trackedRealpath } from "./input-tracker.js";
import { npmPackageNameOf } from "./workspace-registry.js";

const candidates = new AsyncLocalStorage<Map<string, string | null>>();
export function withNpmDeclarationCandidates<T>(run: () => T): T { return candidates.run(new Map(), run); }
export function npmDeclarationCandidates(): ReadonlyMap<string, string | null> | undefined { return candidates.getStore(); }
export const declarationText = (path: string): string | null =>
  acquiredDeclarations()?.files.get(resolve(path)) ?? trackedReadFile(path);
const normalize = (path: string): string => resolve(path).replaceAll("\\", "/");

function manifestOf(path: string): Record<string, unknown> | null {
  for (let dir = dirname(path); ; dir = dirname(dir)) {
    const text = declarationText(`${dir}/package.json`);
    try {
      const pkg: unknown = text === null ? null : JSON.parse(text);
      if (pkg !== null && typeof pkg === "object" && !Array.isArray(pkg) && "name" in pkg) return pkg as Record<string, unknown>;
    } catch { return null; }
    if (dirname(dir) === dir || dir.endsWith("/node_modules")) return null;
  }
}

/** Matching stable series is deliberately conservative, not evidence of
 * API equivalence. The normal inferred-surface and lowering gates remain. */
export function thirdPartyDeclarationReason(name: string, typesFile: string, runtimeFile: string): string | null {
  const provider = `@types/${name.startsWith("@") ? name.slice(1).replace("/", "__") : name}`;
  const types = manifestOf(typesFile);
  const runtime = manifestOf(runtimeFile);
  if (npmPackageNameOf(typesFile) !== provider || types?.["name"] !== provider || runtime?.["name"] !== name) {
    return "its third-party declaration provider does not match the runtime package identity";
  }
  const runtimeVersion = typeof runtime["version"] === "string" ? parse(runtime["version"]) : null;
  const typesVersion = typeof types["version"] === "string" ? parse(types["version"]) : null;
  if (!runtimeVersion || !typesVersion || runtimeVersion.prerelease.length > 0 || typesVersion.prerelease.length > 0) {
    return "third-party declarations require valid stable runtime and @types versions";
  }
  if (runtimeVersion.major !== typesVersion.major || (runtimeVersion.major === 0 && runtimeVersion.minor !== typesVersion.minor)) {
    return `its runtime and @types version series differ (${runtimeVersion.version} / ${typesVersion.version})`;
  }
  return null;
}

/** One runtime file cannot borrow incompatible type-only surfaces from
 * different subpaths. A null entry remembers ambiguity for this operation. */
export function registerNpmDeclaration(runtime: string, declaration: string): void {
  const map = candidates.getStore();
  if (!map || !npmPackageNameOf(declaration)?.startsWith("@types/")) return;
  const declared = normalize(trackedRealpath(declaration) ?? declaration);
  for (const path of new Set([normalize(runtime), normalize(trackedRealpath(runtime) ?? runtime)])) {
    const previous = map.get(path);
    map.set(path, previous === undefined || previous === declared ? declared : null);
  }
}
