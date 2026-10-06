/* One copy of each ambient Node type package per program. A workspace whose
 * projects resolve different @types/node copies (the entry project's real
 * old-layout 24.13.3, a reached library's real new-layout 26.1.2: see
 * tests/fixtures/node-type-surface) used to load both into one checker
 * program, where the two layouts' opposite module directions merged into a
 * `node:events` with two `export =` assignments and left ChildProcess and
 * net.Server without their EventEmitter members ("Property 'on' does not
 * exist on type 'ChildProcess'"). The newest copy any reached project
 * resolves is the surface now (26.1.2 here); the other copy stands down, and
 * the program compiles and runs like Node. Both first-class targets run
 * against their own Node oracle (Node 24 and Node 26): the analysis, the
 * compiled binary, and the pinned refusal shapes. */
import { execFile } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, test } from "vitest";
import { NODE_COMPAT_MATRIX, analyze, compile } from "@scriptc/compiler";
import { oracleExecutableForTarget } from "./node-matrix.js";

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, "../..");
const sanitize = process.env["SCRIPTC_SAN"] === "1";
const targets = ["node24", "node26"] as const;

/* The fixture is copied out of the repository so the entry project can be
 * linked to the vendored @types/node 24.13.3 (tests/fixtures/node-types)
 * without committing a second copy of it; the reached project's copy is the
 * committed real 26.1.2. */
let workspace = "";
beforeAll(() => {
  workspace = mkdtempSync(join(tmpdir(), "scriptc-node-type-surface-"));
  cpSync(join(repoRoot, "tests/fixtures/node-type-surface"), workspace, { recursive: true });
  symlinkSync(join(repoRoot, "tests/fixtures/node-types/node_modules"), join(workspace, "app", "node_modules"), "dir");
});
afterAll(() => {
  if (workspace !== "") rmSync(workspace, { recursive: true, force: true });
});

const optionsFor = (target: (typeof targets)[number]) =>
  ({ backend: "rust", allowEngine: false, target, optimization: "dev" }) as const;

test.each(targets)("[%s] listeners on ChildProcess and net.Server typecheck and lower under the one carried copy", (target) => {
  const result = analyze(join(workspace, "app", "main.ts"), optionsFor(target));
  expect(result.coverage.preflightFailed).toBe(false);
  expect(result.coverage.diagnostics).toEqual([]);
  expect(result.coverage.stats.statementsFailed).toBe(0);
  expect(result.coverage.stats.statementsTotal).toBeGreaterThan(0);
});

test.skipIf(sanitize).each(targets)("[%s] the compiled binary matches the Node oracle (the Rust lane has no sanitizer mode)", async (target) => {
  const entry = join(workspace, "app", "main.ts");
  const outDir = mkdtempSync(join(tmpdir(), "scriptc-node-type-surface-out-"));
  try {
    const result = await compile(entry, { ...optionsFor(target), outDir, outPath: join(outDir, "main") });
    expect(result.ok, !result.ok ? JSON.stringify(result.diagnostics, null, 2) : "").toBe(true);
    if (!result.ok) return;
    const [node, native] = await Promise.all([
      execFileAsync(oracleExecutableForTarget(target, NODE_COMPAT_MATRIX), [entry]),
      execFileAsync(result.binaryPath),
    ]);
    expect(node.stdout).toBe("lib:start\nlistening\nserver closed\nchild exit 3 none\n");
    expect(native.stdout).toBe(node.stdout);
    expect(native.stderr).toBe(node.stderr);
  } finally { rmSync(outDir, { recursive: true, force: true }); }
}, 120_000);

test.each(targets)("[%s] off() typechecks under the one copy; the Rust lane's verdict on the member is the pinned refusal", (target) => {
  const result = analyze(join(workspace, "app", "off.ts"), optionsFor(target));
  expect(result.coverage.preflightFailed).toBe(false);
  expect(result.coverage.diagnostics.map((d) => [d.code, d.message])).toEqual([
    ["SC2020", "'Server.off' is typed by @types/node but has no scriptc lowering yet"],
    ["SC2020", "'ChildProcess.off' is typed by @types/node but has no scriptc lowering yet"],
  ]);
});

test("a declaration the stood-down copy has and the carried copy dropped is an honest error whose hint names both copies; a plain type error carries no hint", () => {
  const entry = join(workspace, "app", "removed.ts");
  const result = analyze(entry, optionsFor("node26"));
  expect(result.coverage.preflightFailed).toBe(true);
  const errors = result.coverage.diagnostics.filter((d) => d.loc.file === entry);
  expect(errors.map((d) => [d.code, d.message])).toEqual([
    ["SC0001", "Module '\"node:util\"' has no exported member 'isDate'."],
    ["SC0001", "Type 'string' is not assignable to type 'number'."],
  ]);
  expect(errors[0]!.hint).toContain("resolves @types/node 24.13.3");
  expect(errors[0]!.hint).toContain("checked against @types/node 26.1.2");
  expect(errors[1]!.hint).toBeUndefined();
});

test.skipIf(sanitize).each(targets)("[%s] a copy vendored outside node_modules and named by typeRoots is the surface: it typechecks, lowers, and matches the Node oracle", async (target) => {
  // The project's tsconfig points typeRoots at a vendored copy of the real
  // 24.13.3 (no node_modules path names it): the copy is identified by its
  // package.json, so the lowering recognizes the Node types it declares.
  const project = mkdtempSync(join(tmpdir(), "scriptc-node-type-surface-vendored-"));
  const outDir = mkdtempSync(join(tmpdir(), "scriptc-node-type-surface-vendored-out-"));
  try {
    const fixtureModules = join(repoRoot, "tests/fixtures/node-types/node_modules");
    cpSync(join(fixtureModules, "@types/node"), join(project, "vendor", "node"), { recursive: true });
    mkdirSync(join(project, "node_modules"));
    symlinkSync(join(fixtureModules, "undici-types"), join(project, "node_modules", "undici-types"), "dir");
    writeFileSync(join(project, "tsconfig.json"), JSON.stringify({
      compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", strict: true, noEmit: true, allowImportingTsExtensions: true, typeRoots: ["./vendor"], types: ["node"] },
      include: ["*.ts"],
    }));
    const entry = join(project, "main.ts");
    writeFileSync(entry, [
      'import { spawn } from "node:child_process";',
      'const child = spawn("/bin/sh", ["-c", "exit 3"], { stdio: "ignore" });',
      'child.once("error", (err) => { console.log("child error", err.message); });',
      'child.on("exit", (code, signal) => { console.log("child exit", code ?? -1, signal ?? "none"); });',
      "",
    ].join("\n"));
    const analysis = analyze(entry, optionsFor(target));
    expect(analysis.coverage.preflightFailed).toBe(false);
    expect(analysis.coverage.diagnostics).toEqual([]);
    expect(analysis.coverage.stats.statementsFailed).toBe(0);
    const result = await compile(entry, { ...optionsFor(target), outDir, outPath: join(outDir, "main") });
    expect(result.ok, !result.ok ? JSON.stringify(result.diagnostics, null, 2) : "").toBe(true);
    if (!result.ok) return;
    const [node, native] = await Promise.all([
      execFileAsync(oracleExecutableForTarget(target, NODE_COMPAT_MATRIX), [entry]),
      execFileAsync(result.binaryPath),
    ]);
    expect(node.stdout).toBe("child exit 3 none\n");
    expect(native.stdout).toBe(node.stdout);
    expect(native.stderr).toBe(node.stderr);
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
}, 120_000);
