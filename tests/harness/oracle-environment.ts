import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

const nativeTransformTypes = new Map<string, boolean>();

/** The Node executable used as the differential oracle. */
export function nodeOracleExecutable(
  env: NodeJS.ProcessEnv = process.env,
  hostExecutable: string = process.execPath,
): string {
  return env["SCRIPTC_NODE_ORACLE"] || hostExecutable;
}

/** The argv prefix for TypeScript syntax that needs a runtime transform.
 * Node 24 exposes the native transform behind a CLI flag; Node 26 removed
 * that mode, so those oracles load the repository's TypeScript hook. */
export function nodeTransformTypesArgs(executable: string, hookUrl: string): string[] {
  let supported = nativeTransformTypes.get(executable);
  if (supported === undefined) {
    try {
      execFileSync(executable, ["--experimental-transform-types", "-e", ""], {
        stdio: "ignore",
        timeout: 10_000,
      });
      supported = true;
    } catch {
      supported = false;
    }
    nativeTransformTypes.set(executable, supported);
  }
  return supported
    ? ["--experimental-transform-types", "--disable-warning=ExperimentalWarning"]
    : ["--import", hookUrl];
}

/**
 * The complete inherited environment visible to the Node oracle. Corpus
 * programs may read arbitrary process.env keys directly or through imported
 * modules, so an allowlist cannot soundly describe this input. Keys sort by
 * UTF-16 code unit for a deterministic order; names and values are
 * length-framed so missing, empty, and delimiter-containing entries remain
 * distinct.
 */
export function oracleEnvironmentFingerprint(env: NodeJS.ProcessEnv): string {
  return Object.keys(env)
    .sort((a, b) => a < b ? -1 : a > b ? 1 : 0)
    .map((key) => {
      const value = env[key];
      const framedValue = value === undefined ? "unset" : `${value.length}:${value}`;
      return `${key.length}:${key}:${framedValue};`;
    })
    .join("");
}

interface OracleCacheKeyBaseInputs {
  nodeVersion: string;
  typescriptVersion: string;
  comptimeShim: string;
  islandShim: string;
  transformTypesHook: string;
  environment: NodeJS.ProcessEnv;
  cwd: string;
}

/** The shared, testable base of every per-program Node oracle cache key. */
export function oracleCacheKeyBase(inputs: OracleCacheKeyBaseInputs): string {
  return createHash("sha256")
    .update("oracle-v4\0")
    .update(inputs.nodeVersion).update("\0")
    .update(inputs.typescriptVersion).update("\0")
    .update(inputs.comptimeShim).update("\0")
    .update(inputs.islandShim).update("\0")
    .update(inputs.transformTypesHook).update("\0")
    .update(oracleEnvironmentFingerprint(inputs.environment)).update("\0")
    .update(inputs.cwd).update("\0")
    .digest("hex");
}
