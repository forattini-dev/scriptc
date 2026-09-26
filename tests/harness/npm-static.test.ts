/* --npm-static: opted-in npm packages' shipped JS compiles STATICALLY as
 * program modules (no island) — the slice-2 pilot. Three tiers pinned
 * here:
 *
 *   1. GREEN pilots (escape-string-regexp, slash — real packages, vendored
 *      under tests/fixtures/npm-static): fully static builds whose stdout
 *      byte-matches Node across the argv-free programs.
 *   2. HONEST PARTIALS (ms, picocolors, commander): the packages COMPILE
 *      (preflight admits them; the coverage report says "static") but
 *      carry runtime fences on driven paths — the coverage numbers are
 *      pinned so the frontier only moves deliberately.
 *   3. The FALLBACK contract: a package whose preflight refuses (an
 *      unshimmed-builtin require inside its files) drops back to the
 *      island under --dynamic with a coverage note — never a build
 *      failure, and the flag never changes a flagless build.
 *
 * The flag defaults OFF: nothing here touches the production npm/island
 * lanes (npm.test.ts, vercel-e2e.test.ts pin those). */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { globSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import { NODE_COMPAT_MATRIX, analyze, compile } from "@scriptc/compiler";
import { primaryOracleExecutable } from "./node-matrix.js";

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, "../..");
const fixturesRoot = join(repoRoot, "tests/fixtures");
const pilotRoot = join(fixturesRoot, "npm-static");
const cacheDir = join(repoRoot, "node_modules/.cache/scriptc-tests");
const sanitize = process.env["SCRIPTC_SAN"] === "1";
// SEMANTIC oracle (differential.test.ts's rationale, node-matrix.ts's
// header): stdout must match ONE Node's fixed behavior, so this pins to
// the compat matrix primary rather than whichever `node` the PATH happens
// to resolve.
const oracleExecutable = primaryOracleExecutable(NODE_COMPAT_MATRIX);

interface RunResult {
  stdout: Buffer;
  exitCode: number;
}

async function runBinary(cmd: string, args: string[]): Promise<RunResult> {
  try {
    const { stdout } = await execFileAsync(cmd, args, { encoding: "buffer" });
    return { stdout, exitCode: 0 };
  } catch (err) {
    const e = err as { code?: unknown; stdout?: Buffer };
    if (typeof e.code !== "number" || !Buffer.isBuffer(e.stdout)) throw err;
    return { stdout: e.stdout, exitCode: e.code };
  }
}

/** Compile one pilot statically (no --dynamic — the whole point) with the
 * named packages opted in; cache-keyed over the program and the vendored
 * packages. */
async function buildStatic(entry: string, npmStatic: string[] | "auto", backend: "c" | "rust" = "c"): Promise<string> {
  const hash = createHash("sha256");
  const inputs = [
    entry,
    ...globSync(join(pilotRoot, "**/node_modules/**/*.{js,mjs,cjs,json,d.ts}")).sort(),
    // the bundler-emitted-CJS mini packages (cases 2465-2469, 2556-2557)
    ...globSync(join(fixturesRoot, "npm/node_modules/gt*/**/*.{js,json}")).sort(),
    // the require()-of-JSON mini package (the json-require case)
    ...globSync(join(fixturesRoot, "npm/node_modules/jsonzoo/**/*.{js,json}")).sort(),
  ];
  for (const f of inputs) hash.update(f).update(readFileSync(f));
  const key = hash
    .update(backend)
    .update(npmStatic === "auto" ? "auto" : npmStatic.join(","))
    .update(sanitize ? "san" : "plain")
    .digest("hex")
    .slice(0, 16);
  const outDir = join(cacheDir, `npm-static-${key}`);
  mkdirSync(outDir, { recursive: true });
  const result = await compile(entry, {
    outPath: join(outDir, "program"),
    outDir,
    sanitize,
    npmStatic,
    // Pinned: the suite pins --npm-static's FRONTEND frontier (coverage
    // numbers, fence sites); existing pilots stay on C. A newly admitted
    // message-map path also runs explicitly on the primary Rust backend.
    backend,
  });
  if (!result.ok) {
    throw new Error(
      "npm-static pilot failed to compile:\n" +
        result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"),
    );
  }
  expect(result.execution.engine).toBe("none");
  return result.binaryPath;
}

describe(`npm-static pilots${sanitize ? " (sanitized)" : ""}`, () => {
  // Tier 1: fully static, byte-exact against Node. ms's driven surface —
  // BOTH the parse and format directions — joined when implicit-any
  // monomorphization and aliased-typeof narrowing landed; its one
  // remaining fence sits on the garbage-input path (pinned below), which
  // ms-cli.ts deliberately never drives.
  test.for([
    ["escape-string-regexp", "escape-cli.ts"],
    ["slash", "slash-cli.ts"],
    ["ms", "ms-cli.ts"],
    // dualist pins the "node" exports condition: Node runs ./node.js
    // (yaml's browser-vs-node shape) and the opted-in resolution must
    // land on the SAME artifact, never the browser build.
    ["dualist", "dualist-cli.ts"],
    // statuses pins the EXPANDO-FUNCTION idiom (`module.exports = status`
    // with the data tables hung off the function) — the shape Express and
    // its middleware reach for. Its driven surface is the member reads;
    // statuses-cli.ts documents the two undriven ones.
    ["statuses", "statuses-cli.ts"],
  ] as const)("%s compiles statically and byte-matches Node", async ([pkg, file]) => {
    const entry = join(pilotRoot, file);
    const binary = await buildStatic(entry, [pkg]);
    const [nodeRes, nativeRes] = await Promise.all([
      runBinary(oracleExecutable, [entry]),
      runBinary(binary, []),
    ]);
    expect(nativeRes.stdout.toString("utf8")).toBe(nodeRes.stdout.toString("utf8"));
    expect(nativeRes.exitCode).toBe(nodeRes.exitCode);
  }, 120_000);

  test("picocolors compiles fully statically and byte-matches both color branches", async () => {
    const entry = join(pilotRoot, "colors-cli.ts");
    const { coverage } = analyze(entry, { npmStatic: ["picocolors"] });
    expect(coverage.npmStatic).toEqual([{ package: "picocolors", status: "static" }]);
    expect(coverage.preflightFailed).toBe(false);
    expect(coverage.diagnostics).toHaveLength(0);
    expect(coverage.runtimeFences ?? []).toHaveLength(0);
    expect(coverage.stats.statementsFailed).toBe(0);

    const binary = await buildStatic(entry, ["picocolors"]);
    const plainEnv: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1" };
    delete plainEnv["FORCE_COLOR"];
    const colorEnv: NodeJS.ProcessEnv = { ...process.env, FORCE_COLOR: "1" };
    delete colorEnv["NO_COLOR"];

    for (const env of [plainEnv, colorEnv]) {
      const [nodeRes, nativeRes] = await Promise.all([
        runBinary("node", [entry], env),
        runBinary(binary, [], env),
      ]);
      expect(nativeRes.stdout).toEqual(nodeRes.stdout);
      expect(comparableStderr(nativeRes.stderr)).toEqual(nodeRes.stderr);
      expect(nativeRes.exitCode).toBe(nodeRes.exitCode);
    }
  }, 180_000);

  test("createRequire loads an opted-in package through its require entry", async () => {
    const entry = join(pilotRoot, "create-require-cli.ts");
    const { coverage } = analyze(entry, { npmStatic: ["picocolors"] });
    expect(coverage.npmStatic).toEqual([{ package: "picocolors", status: "static" }]);
    expect(coverage.preflightFailed).toBe(false);
    expect(coverage.diagnostics).toHaveLength(0);
    expect(coverage.runtimeFences ?? []).toHaveLength(0);
    expect(coverage.stats.statementsFailed).toBe(0);

    const binary = await buildStatic(entry, ["picocolors"]);
    const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1" };
    delete env["FORCE_COLOR"];
    const [nodeRes, nativeRes] = await Promise.all([
      runBinary("node", [entry], env),
      runBinary(binary, [], env),
    ]);
    expect(nativeRes.stdout).toEqual(nodeRes.stdout);
    expect(comparableStderr(nativeRes.stderr)).toEqual(nodeRes.stderr);
    expect(nativeRes.exitCode).toBe(nodeRes.exitCode);
  }, 180_000);

  test("picocolors inherited valueOf retains the prototype-method fence", () => {
    const entry = join(pilotRoot, "colors-prototype-cli.ts");
    const { coverage } = analyze(entry, { npmStatic: ["picocolors"] });
    expect(coverage.npmStatic).toEqual([{ package: "picocolors", status: "static" }]);
    expect(coverage.preflightFailed).toBe(false);
    expect(coverage.runtimeFences ?? []).toHaveLength(0);
    expect(coverage.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["SC2020"]);
    expect(coverage.diagnostics.map((diagnostic) => diagnostic.message)).toEqual([
      expect.stringContaining(".valueOf' is part of the standard library types"),
    ]);
  }, 120_000);

  test("picocolors inherited hasOwnProperty matches Node", async () => {
    const entry = join(pilotRoot, "colors-hasown-cli.ts");
    const { coverage } = analyze(entry, { npmStatic: ["picocolors"] });
    expect(coverage.preflightFailed).toBe(false);
    expect(coverage.diagnostics).toHaveLength(0);
    expect(coverage.runtimeFences ?? []).toHaveLength(0);

    const binary = await buildStatic(entry, ["picocolors"]);
    const [nodeRes, nativeRes] = await Promise.all([
      runBinary("node", [entry]),
      runBinary(binary, []),
    ]);
    expect(nativeRes.stdout).toEqual(nodeRes.stdout);
    expect(comparableStderr(nativeRes.stderr)).toEqual(nodeRes.stderr);
    expect(nativeRes.exitCode).toBe(nodeRes.exitCode);
  }, 180_000);

