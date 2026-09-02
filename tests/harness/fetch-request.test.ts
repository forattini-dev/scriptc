/* Focused Request differential: every fixture is self-contained, runs under
 * the Node 24 semantic oracle and as a Rust native binary, and must agree on
 * stdout, stderr, and exit status. Keeping this out of fetch.test.ts lets the
 * Request surface grow without turning the server/transport harness into a
 * second monolith. */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { NODE_COMPAT_MATRIX, compile } from "@scriptc/compiler";
import { primaryOracleExecutable } from "./node-matrix.js";

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, "../..");
const fixturesRoot = join(repoRoot, "tests/fixtures/fetch");
const cacheDir = join(repoRoot, "node_modules/.cache/scriptc-tests");
const oracleExecutable = primaryOracleExecutable(NODE_COMPAT_MATRIX);
const sanitize = process.env["SCRIPTC_SAN"] === "1";

interface RunResult {
  stdout: Buffer;
  stderr: Buffer;
  exitCode: number;
}

async function runBinary(
  command: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
): Promise<RunResult> {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      encoding: "buffer",
      env,
    });
    return { stdout, stderr, exitCode: 0 };
  } catch (error) {
    const result = error as { code?: unknown; stdout?: Buffer; stderr?: Buffer };
    if (
      typeof result.code !== "number" ||
      !Buffer.isBuffer(result.stdout) ||
      !Buffer.isBuffer(result.stderr)
    ) {
      throw error;
    }
    return { stdout: result.stdout, stderr: result.stderr, exitCode: result.code };
  }
}

async function build(entry: string): Promise<string> {
  const key = createHash("sha256")
    .update(entry)
    .update(readFileSync(entry))
    .update("rust-request-dev")
    .digest("hex")
    .slice(0, 16);
  const outDir = join(cacheDir, `fetch-request-${key}`);
  mkdirSync(outDir, { recursive: true });
  const result = await compile(entry, {
    outPath: join(outDir, "program"),
    outDir,
    dynamic: true,
    backend: "rust",
    optimization: "dev",
  });
  if (!result.ok) {
    throw new Error(
      "Request fixture failed to compile:\n" +
        result.diagnostics.map((diagnostic) =>
          `${diagnostic.code}: ${diagnostic.message}`).join("\n"),
    );
  }
  return result.binaryPath;
}

const cases = [
  ["Request instanceof uses realm identity", "fetch-request-instanceof/main.ts"],
  ["Request.text consumes a textual body", "fetch-request-text/main.ts"],
  ["Request.bytes returns exact UTF-8 bytes", "fetch-request-bytes/main.ts"],
  ["Request.json parses a textual body", "fetch-request-json/main.ts"],
  ["Request.arrayBuffer exposes the body byte length", "fetch-request-array-buffer/main.ts"],
  ["Request.body exposes a lazy readable stream", "fetch-request-body/main.ts"],
  ["Request.body reads disturb the Body state", "fetch-request-body-read/main.ts"],
  ["Request.clone keeps Body consumption independent", "fetch-request-clone/main.ts"],
  ["Request.clone tees a materialized Body", "fetch-request-clone-materialized/main.ts"],
  ["Request.clone rejects a consumed Body", "fetch-request-clone-used/main.ts"],
  ["Request body rejects a second read", "fetch-request-second-read/main.ts"],
] as const;

for (const [name, fixture] of cases) {
  test.skipIf(sanitize)(`Rust dynamic ${name}`, async () => {
    const entry = join(fixturesRoot, fixture);
    const binary = await build(entry);
    const [nodeResult, nativeResult] = await Promise.all([
      runBinary(oracleExecutable, ["--no-warnings", entry]),
      runBinary(binary, [], {
        ...process.env,
        SCRIPTC_RUST_HEAP_AUDIT: "1",
      }),
    ]);
    expect(nodeResult.exitCode, nodeResult.stderr.toString("utf8")).toBe(0);
    expect(nativeResult.exitCode, nativeResult.stderr.toString("utf8")).toBe(0);
    expect(nativeResult.stdout.toString("utf8")).toBe(nodeResult.stdout.toString("utf8"));
    expect(nativeResult.stderr.toString("utf8")).toBe(nodeResult.stderr.toString("utf8"));
  }, 120_000);
}
