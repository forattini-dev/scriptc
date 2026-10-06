import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";

// The driver itself, end to end, without running the compiler: argument
// handling (the form `pnpm dogfood:ledger` forwards), missing consumers, and
// --replay provenance. Each run is a child under the Node that runs the test
// (Node 24 and Node 26 are both first-class hosts).
const repoRoot = resolve(__dirname, "../..");
const driver = join(repoRoot, "scripts/dogfood-ledger.mjs");
const options = { backend: "rust", allowEngine: false, npmStatic: "auto", target: "node26", optimization: "dev" };

let scratch: string;
beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "dogfood-ledger-driver-"));
});
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function run(args: string[], env: Record<string, string> = {}) {
  const result = spawnSync(process.execPath, [driver, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 60_000,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

test("the package script is the tsx run of the driver", () => {
  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  expect(pkg.scripts["dogfood:ledger"]).toBe("tsx scripts/dogfood-ledger.mjs");
});

test("flags parse with or without the literal -- separator pnpm and npm forward", () => {
  // Parsing succeeded when the run gets as far as entry selection.
  for (const args of [["--entry", "no-such-entry"], ["--", "--entry", "no-such-entry"], ["--entry", "no-such-entry", "--"]]) {
    const out = run(args);
    expect(out.stderr).toContain("no entries selected");
    expect(out.stderr).not.toContain("unknown argument");
    expect(out.status).toBe(1);
  }
  const bad = run(["--", "--bogus"]);
  expect(bad.status).toBe(1);
  expect(bad.stderr).toContain("unknown argument --bogus");
  expect(bad.stderr).toContain("usage: pnpm dogfood:ledger [--entry <name>]");
  expect(run(["--help"]).status).toBe(0);
});

test("a missing consumer is an unavailable row, never a crash, and writes nothing", () => {
  const missing = join(scratch, "no-such-consumer");
  const env = { SCRIPTC_DOGFOOD_RED_SKILLS: missing, SCRIPTC_DOGFOOD_RED_DEV: missing, SCRIPTC_DOGFOOD_BALDIM: missing, MISSION_SCRATCH: scratch };
  const table = run(["--", "--entry", "redskilled-statusline", "--entry", "baldim-s3-smoke"], env);
  expect(table.status).toBe(0);
  expect(table.stdout).toMatch(/redskilled-statusline\s+unavailable/);
  expect(table.stdout).toMatch(/baldim-s3-smoke\s+unavailable/);
  expect(table.stdout).toContain("redskilled-statusline: unavailable — missing on this machine:");
  const json = run(["--json", "--entry", "baldim-s3-smoke"], env);
  expect(json.status).toBe(0);
  const [record] = JSON.parse(json.stdout);
  expect(record).toMatchObject({ name: "baldim-s3-smoke", stage: "unavailable", firstPartyPackages: ["@baldim/*"] });
  expect(JSON.stringify(record)).not.toContain(scratch);
});

function replayFixture(name: string, kept: Record<string, unknown> | null) {
  const dir = join(scratch, name);
  const results = join(dir, "dogfood-ledger");
  mkdirSync(results, { recursive: true });
  const entry = join(dir, "main.ts");
  writeFileSync(entry, "console.log(1);\n");
  const mission = join(dir, "mission.json");
  writeFileSync(
    mission,
    JSON.stringify({ roots: {}, options, entries: [{ name: "replayed", entry, consumer: { kind: "npm", dir: dir, packages: [] }, firstPartyPackages: ["@acme/*"] }] }),
  );
  if (kept !== null) writeFileSync(join(results, "latest-replayed.json"), JSON.stringify(kept));
  return { mission, env: { MISSION_SCRATCH: dir } };
}

const keptCoverage = {
  file: "/w/main.ts",
  dynamic: false,
  preflightFailed: false,
  backend: "rust",
  stats: { statementsTotal: 10, statementsFailed: 1, statementsIsland: 0, functionsSkipped: 0 },
  diagnostics: [{ code: "SC1090", message: "spread arguments are not supported yet", loc: { file: "/w/main.ts", start: 1, end: 2 } }],
};

test("--replay reports the compiler, consumer and time stamped when the analysis ran", () => {
  const stamp = {
    generatedAt: "2026-01-02T03:04:05.000Z",
    compiler: { head: "0123456789abcdef0123456789abcdef01234567", branch: "old", dirtyPaths: 3 },
    entrySha256: "abc",
    consumer: { kind: "npm", dir: "${baldim}", lockfileSha256: "feed", installed: {}, typesNode: { distinctVersions: ["25.5.2"], roots: [] } },
  };
  const { mission, env } = replayFixture("stamped", { ok: true, node: "v26.0.0", coverage: keptCoverage, sources: 7, elapsedMs: 1234, peakRssKiB: 1, stamp });
  const out = run(["--replay", "--json", "--mission", mission, "--entry", "replayed"], env);
  expect(out.status).toBe(0);
  const [record] = JSON.parse(out.stdout);
  expect(record).toMatchObject({
    stage: "frontier",
    generatedAt: "2026-01-02T03:04:05.000Z",
    compiler: { head: "0123456789abcdef0123456789abcdef01234567", dirtyPaths: 3 },
    entrySha256: "abc",
    node: "v26.0.0",
    sources: 7,
    elapsedMs: 1234,
    consumer: { lockfileSha256: "feed", typesNode: { distinctVersions: ["25.5.2"] } },
    firstPartyPackages: ["@acme/*"],
  });
  // The replay notes that the producing compiler is not this checkout's.
  expect(out.stderr).toContain("replaying a result produced by compiler 01234567");
});

test("--replay refuses a kept result without a stamp and one that does not exist", () => {
  const unstamped = replayFixture("unstamped", { ok: true, node: "v26.0.0", coverage: keptCoverage, sources: 7, elapsedMs: 1 });
  const [record] = JSON.parse(run(["--replay", "--json", "--mission", unstamped.mission, "--entry", "replayed"], unstamped.env).stdout);
  expect(record.stage).toBe("crashed");
  expect(record.crashed).toMatchObject({ name: "NoReplay" });
  expect(record.crashed.message).toContain("carries no provenance stamp");
  const absent = replayFixture("absent", null);
  const [none] = JSON.parse(run(["--replay", "--json", "--mission", absent.mission, "--entry", "replayed"], absent.env).stdout);
  expect(none.stage).toBe("crashed");
  expect(none.crashed.message).toContain("no kept result for replayed");
});
