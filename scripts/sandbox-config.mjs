import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";

const example = "vcr.vercel.com/<team>/<project>/<repository>:<tag>";
const localEnv = fileURLToPath(new URL("../.env.local", import.meta.url));
let loadedLocalEnv = false;

function loadLocalEnv() {
  if (loadedLocalEnv) return;
  loadedLocalEnv = true;
  try {
    // Node preserves variables already present in the process environment,
    // allowing an agent or shell to override values from this local file.
    loadEnvFile(localEnv);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

export function sandboxRunnerConfig(env) {
  loadLocalEnv();
  const source = env ?? process.env;
  return {
    vcpus: source.SCRIPTC_SANDBOX_VCPUS ?? "8",
    testWorkers: source.SCRIPTC_TEST_WORKERS ?? "2",
    localTestWorkers: source.SCRIPTC_LOCAL_TEST_WORKERS ?? "2",
    localCaseShards: source.SCRIPTC_LOCAL_CASE_SHARDS ?? "2",
    sandboxTimeout: source.SCRIPTC_SANDBOX_TIMEOUT ?? "45m",
  };
}

/** Reserve one Vitest worker for each concurrently scheduled side process
 * without ever starving the case-sharded corpus or exceeding the configured
 * per-Sandbox worker budget. Extra side processes share the reserved slots. */
export function sandboxTestWorkerAllocation(workerCount, sideTaskCount) {
  if (!Number.isInteger(workerCount) || workerCount < 1) {
    throw new Error("workerCount must be a positive integer");
  }
  if (!Number.isInteger(sideTaskCount) || sideTaskCount < 0) {
    throw new Error("sideTaskCount must be a non-negative integer");
  }
  const sideConcurrency = Math.min(sideTaskCount, Math.max(0, workerCount - 1));
  return {
    caseWorkers: workerCount - sideConcurrency,
    sideConcurrency,
  };
}

export function sandboxImageConfig() {
  loadLocalEnv();
  // Keep tenancy explicit: a public clone must use a Vercel project its
  // operator owns rather than inheriting a maintainer's scope or project.
  const reference = process.env.SCRIPTC_SANDBOX_IMAGE;
  if (!reference) {
    throw new Error(`SCRIPTC_SANDBOX_IMAGE is required (for example: ${example})`);
  }

  const match = /^vcr\.vercel\.com\/([^/]+)\/([^/]+)\/([^/:]+):([^/:]+)$/.exec(reference);
  if (!match) {
    throw new Error(`SCRIPTC_SANDBOX_IMAGE must be a fully qualified VCR image (${example})`);
  }

  const [, team, project, repository, tag] = match;
  return {
    reference,
    team,
    project,
    repository,
    tag,
    sandboxImage: `${repository}:${tag}`,
  };
}
