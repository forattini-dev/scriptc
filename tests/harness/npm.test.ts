/* npm imports under --dynamic: every fixture program under
 * tests/fixtures/npm/cases (plus the commander acceptance fixture) runs
 * under Node AND as a scriptc-compiled binary; stdout and stderr must match
 * byte-for-byte and exit codes must agree — the differential contract,
 * extended with argv (CLI packages parse process.argv).
 * Intentional link errors and unhandled rejections pin the exact native fatal
 * diagnostic, since Node prints source/stack/version for these errors.
 *
 * The fixture node_modules are COMMITTED TEST DATA (hand-made minimal
 * packages exercising ESM/CJS/dual/scoped/JSON resolution, and a pinned
 * real commander for the acceptance CLI). Binaries embed the package
 * sources at build time — nothing here reads node_modules at runtime.
 *
 * SCRIPTC_SAN=1 rebuilds everything with ASan + the runtime RC audit; the
 * island's counting allocator asserts zero live engine allocations at
 * teardown.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { globSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import { NODE_COMPAT_MATRIX, compile } from "@scriptc/compiler";
import { npmCases, npmOracleFlags } from "./npm-cases.js";
import { primaryOracleExecutable } from "./node-matrix.js";
import { shardSelect, shardSuffix } from "./shard.js";
import { discardPassedBinary } from "./passed-binary.js";

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, "../..");
const fixturesRoot = join(repoRoot, "tests/fixtures");
const cacheDir = join(repoRoot, "node_modules/.cache/scriptc-tests");
const sanitize = process.env["SCRIPTC_SAN"] === "1";
// Use vitest.config.ts's shared native-build timeout. The former 120s
// overrides expired while compiling the Rust Commander fixture under the
// resource limiter, before an executable existed; its runtime cases complete.
// SEMANTIC oracle (differential.test.ts's rationale, node-matrix.ts's
// header): stdout must match ONE Node's fixed behavior, so this pins to
// the compat matrix primary rather than whichever `node` the PATH happens
// to resolve — a bare "node" spawn would silently compare against
// whatever major is running the suite.
const oracleExecutable = primaryOracleExecutable(NODE_COMPAT_MATRIX);
/* The primary plain lane uses Rust. Sanitized runs explicitly select C;
 * SCRIPTC_TEST_BACKEND can select another comparison lane. */
const backend = (process.env["SCRIPTC_TEST_BACKEND"] as "c" | "llvm" | "rust" | undefined)
  ?? (sanitize ? "c" : "rust");

// The case table lives in npm-cases.ts: the Linux lane runs the identical
// cases (same entries, same argv lists) inside its container. The shard
// split (SCRIPTC_TEST_SHARD, CI's matrix) is applied HERE, not in the
// table, so that lane keeps its full list.
const cases = shardSelect(npmCases(fixturesRoot, backend), (c) => c.name);

// The ESM fixture scope declares its module type to avoid Node's
// MODULE_TYPELESS_PACKAGE_JSON configuration warning on stderr. The two
// import()-only script fixtures retain explicit CommonJS scopes.

interface RunResult {
  stdout: Buffer;
  stderr: Buffer;
  exitCode: number;
}

async function runBinary(cmd: string, args: string[]): Promise<RunResult> {
  // Linux ASan emits this exact advisory on the first fiber switch (the
  // existing island/error harnesses exclude it too). Preserve all other
  // bytes, including actual sanitizer errors, and never filter Node output.
  const stderrForProgram = (stderr: Buffer): Buffer => sanitize && cmd !== oracleExecutable
    ? Buffer.from(stderr.toString("latin1").replace(
        /^==\d+==WARNING: ASan doesn't fully support makecontext\/swapcontext functions and may produce false positives in some cases!\n/gm,
        "",
      ), "latin1")
    : stderr;
  try {
    // stdin closes immediately (differential.test.ts's contract): fixture
    // programs may read fd 0 to EOF (process.stdin is a real Readable in
    // the island now), and a default open pipe would hang both lanes.
    const pending = execFileAsync(cmd, args, { encoding: "buffer" });
    pending.child.stdin?.end();
    const { stdout, stderr } = await pending;
    return { stdout, stderr: stderrForProgram(stderr), exitCode: 0 };
  } catch (err) {
    const e = err as { code?: unknown; stdout?: Buffer; stderr?: Buffer };
    if (typeof e.code !== "number" || !Buffer.isBuffer(e.stdout) || !Buffer.isBuffer(e.stderr)) throw err;
    return { stdout: e.stdout, stderr: stderrForProgram(e.stderr), exitCode: e.code };
  }
}

/** Compile once per (entry, lane); the cache key hashes the program AND
 * the fixture packages so edits to either rebuild. */
async function build(entry: string): Promise<string> {
  const hash = createHash("sha256");
  const fixtureDir = join(entry, "../..");
  const inputs = [
    entry,
    ...globSync(join(fixtureDir, "**/node_modules/**/*.{js,mjs,cjs,json,d.ts,node}")).sort(),
  ];
  for (const f of inputs) hash.update(f).update(readFileSync(f));
  const key = hash
    .update(sanitize ? "san" : "plain")
    .update(backend ?? "default")
    .digest("hex")
    .slice(0, 16);
  const outDir = join(cacheDir, `npm-${key}`);
  mkdirSync(outDir, { recursive: true });
  const result = await compile(entry, {
    outPath: join(outDir, "program"),
    outDir,
    sanitize,
    dynamic: true,
    ...(backend === undefined ? {} : { backend }),
  });
  if (!result.ok) {
    throw new Error(
      "npm fixture failed to compile:\n" +
        result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"),
    );
  }
  return result.binaryPath;
}

describe(`typed-callback boundary (scriptc-only${sanitize ? ", sanitized" : ""})`, () => {
  test("DNS promises imports load and network queries reject at the call", async () => {
    const binary = await build(join(fixturesRoot, "npm/divergent/dns-promises.ts"));
    const res = await runBinary(binary, []);
    expect(res.stdout.toString("utf8")).toBe(
      "lookup:ENOTFOUND:lookup:node:dns 'lookup' is not supported in the scriptc island yet\n" +
        "resolve4:ENOTFOUND:resolve4:node:dns 'resolve4' is not supported in the scriptc island yet\n",
    );
    expect(res.exitCode).toBe(0);
  }, 120_000);
