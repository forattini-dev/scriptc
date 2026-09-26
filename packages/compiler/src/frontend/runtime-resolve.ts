/* Node runtime resolution used by compile-time-folded module introspection.
 *
 * This is deliberately separate from resolve.ts: that resolver answers the
 * TypeScript program's TYPE surface and may correctly select a .d.ts file,
 * while import.meta.resolve / require.resolve must answer Node's executable
 * file or URL. CJS resolution delegates to the pinned Node 24 host for exact
 * exports/main/extension/error behavior. The host API does not expose its
 * failed lookup candidates, so those builds decline persistent frontend-cache
 * publication rather than retaining an incomplete dependency snapshot. ESM
 * package success uses the tracked embedded-graph resolver under Node's import
 * conditions; relative and URL-like specifiers are pure URL resolution and do
 * not require the target to exist, matching Node. */

import { createRequire, isBuiltin } from "node:module";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { markFrontendInputsUnstable } from "./input-tracker.js";
import { NpmGraphBuilder, probeNodeImportRefusal } from "./npm.js";
import { wasiGuestPath } from "../wasi-paths.js";

export interface RuntimeResolveError {
  name: string;
  code: string;
  message: string;
}

export type RuntimeResolveResult =
  | { ok: true; value: string }
  | { ok: false; error: RuntimeResolveError };

function errorShape(error: unknown): RuntimeResolveError {
  const e = error as { name?: unknown; code?: unknown; message?: unknown };
  return {
    name: typeof e?.name === "string" ? e.name : "Error",
    code: typeof e?.code === "string" ? e.code : "",
    message: typeof e?.message === "string" ? e.message : String(error),
  };
}

export function runtimePathForTarget(path: string, targetPlatform: string): string {
  if (targetPlatform !== "wasi") return path;
  return wasiGuestPath(path) ?? path.replaceAll("\\", "/");
}

function targetFileUrl(path: string, targetPlatform: string): string {
  return pathToFileURL(runtimePathForTarget(path, targetPlatform), {
    windows: targetPlatform === "win32",
  }).href;
}

function urlLike(specifier: string): boolean {
  return /^[A-Za-z][A-Za-z\d+.-]*:/.test(specifier);
}

/** import.meta.resolve for a static string and the containing source file.
 * Package-import (`#name`) resolution remains a named lowering fence until
 * its Node error/success path can share the package-import resolver without
 * crossing back into TypeScript's declaration-file answer. */
export function resolveImportMetaRuntime(
  fromFile: string,
  specifier: string,
  targetPlatform: string,
): RuntimeResolveResult | null {
  const base = targetFileUrl(fromFile, targetPlatform);
  if (
    specifier.startsWith("./") || specifier.startsWith("../") ||
    isAbsolute(specifier) || urlLike(specifier)
  ) {
    try {
      return { ok: true, value: new URL(specifier, base).href };
    } catch (error) {
      return { ok: false, error: errorShape(error) };
    }
  }
  if (isBuiltin(specifier)) {
    return { ok: true, value: specifier.startsWith("node:") ? specifier : `node:${specifier}` };
  }
  if (specifier.startsWith("#")) return null;

  const builder = new NpmGraphBuilder();
  const key = builder.resolveForIntrospection(fromFile, specifier, "import");
  if (key !== null) return { ok: true, value: targetFileUrl(key, targetPlatform) };
  const refusal = probeNodeImportRefusal(fromFile, specifier);
  if (refusal !== null) {
    return {
      ok: false,
      error: { name: "Error", code: refusal.code, message: refusal.message },
    };
  }
  return null;
}

/** require.resolve under the containing file's CommonJS resolver. */
export function resolveRequireRuntime(
  fromFile: string,
  specifier: string,
  targetPlatform: string,
  paths?: readonly string[],
): RuntimeResolveResult {
  markFrontendInputsUnstable();
  try {
    const require = createRequire(pathToFileURL(fromFile));
    const value = paths === undefined
      ? require.resolve(specifier)
      : require.resolve(specifier, { paths: [...paths] });
    return {
      ok: true,
      value: isAbsolute(value) ? runtimePathForTarget(value, targetPlatform) : value,
    };
  } catch (error) {
    return { ok: false, error: errorShape(error) };
  }
}

/** require.resolve.paths under the containing file's CommonJS resolver. */
export function requireResolvePathsRuntime(
  fromFile: string,
  specifier: string,
  targetPlatform: string,
): readonly string[] | null | RuntimeResolveError {
  markFrontendInputsUnstable();
  try {
    const paths = createRequire(pathToFileURL(fromFile)).resolve.paths(specifier);
    return paths?.map((path) => runtimePathForTarget(path, targetPlatform)) ?? null;
  } catch (error) {
    return errorShape(error);
  }
}
