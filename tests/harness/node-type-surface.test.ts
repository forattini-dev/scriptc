/* One Node type surface per program. A workspace whose projects resolve
 * different @types/node copies (the entry's real old-layout 24.13.3, a
 * reached library's new-layout copy — tests/fixtures/node-type-surface)
 * used to load both into one checker program, where the two layouts'
 * opposite module directions merged into a `node:events` with two
 * `export =` assignments and left ChildProcess and net.Server without
 * their EventEmitter members ("Property 'on' does not exist on type
 * 'ChildProcess'"). The entry project's resolution is the surface now; the
 * reached project's copy stands down, and the program compiles and runs
 * like Node. Both lanes: the Node oracle (Node 24 and Node 26 are
 * first-class hosts) and the compiled binary. */
import { execFile } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, test } from "vitest";
import { NODE_COMPAT_MATRIX, analyze, compile } from "@scriptc/compiler";
import { primaryOracleExecutable } from "./node-matrix.js";

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, "../..");
const sanitize = process.env["SCRIPTC_SAN"] === "1";
const oracle = primaryOracleExecutable(NODE_COMPAT_MATRIX);

/* The fixture is copied out of the repository so the entry project can be
 * linked to the vendored @types/node 24.13.3 (tests/fixtures/node-types)
 * without committing a second copy, and so the reached project's copy is
 * exactly the committed new-layout test data. */
let workspace = "";
beforeAll(() => {
  workspace = mkdtempSync(join(tmpdir(), "scriptc-node-type-surface-"));
  cpSync(join(repoRoot, "tests/fixtures/node-type-surface"), workspace, { recursive: true });
  symlinkSync(join(repoRoot, "tests/fixtures/node-types/node_modules"), join(workspace, "app", "node_modules"), "dir");
});
afterAll(() => {
  if (workspace !== "") rmSync(workspace, { recursive: true, force: true });
});

const options = { backend: "rust", allowEngine: false, target: "node26", optimization: "dev" } as const;

test("the entry project's @types/node is the surface: listeners on ChildProcess and net.Server typecheck and lower", () => {
  const result = analyze(join(workspace, "app", "main.ts"), options);
  expect(result.coverage.preflightFailed).toBe(false);
  expect(result.coverage.diagnostics).toEqual([]);
  expect(result.coverage.stats.statementsFailed).toBe(0);
  expect(result.coverage.stats.statementsTotal).toBeGreaterThan(0);
});

test.skipIf(sanitize)("the compiled binary matches the Node oracle (the Rust lane has no sanitizer mode)", async () => {
  const entry = join(workspace, "app", "main.ts");
  const outDir = mkdtempSync(join(tmpdir(), "scriptc-node-type-surface-out-"));
  try {
    const result = await compile(entry, { ...options, outDir, outPath: join(outDir, "main") });
    expect(result.ok, !result.ok ? JSON.stringify(result.diagnostics, null, 2) : "").toBe(true);
    if (!result.ok) return;
    const [node, native] = await Promise.all([
      execFileAsync(oracle, [entry]),
      execFileAsync(result.binaryPath),
    ]);
    expect(node.stdout).toBe("lib:start\nlistening\nserver closed\nchild exit 3 none\n");
    expect(native.stdout).toBe(node.stdout);
    expect(native.stderr).toBe(node.stderr);
  } finally { rmSync(outDir, { recursive: true, force: true }); }
});

test("off() typechecks under the one surface; the Rust lane's verdict on the member is the pinned refusal", () => {
  const result = analyze(join(workspace, "app", "off.ts"), options);
  expect(result.coverage.preflightFailed).toBe(false);
  expect(result.coverage.diagnostics.map((d) => [d.code, d.message])).toEqual([
    ["SC2020", "'Server.off' is typed by @types/node but has no scriptc lowering yet"],
    ["SC2020", "'ChildProcess.off' is typed by @types/node but has no scriptc lowering yet"],
  ]);
});

test("a type error inside the stood-down project names both copies", () => {
  const broken = join(workspace, "lib", "src", "broken.ts");
  const entry = join(workspace, "app", "broken-entry.ts");
  writeFileSync(broken, "export function broken(): number { const n: number = \"not a number\"; return n; }\n");
  writeFileSync(entry, 'import { broken } from "../lib/src/broken.ts";\nconsole.log(broken());\n');
  const result = analyze(entry, options);
  expect(result.coverage.preflightFailed).toBe(true);
  const error = result.coverage.diagnostics.find((d) => d.loc.file === broken);
  expect(error?.code).toBe("SC0001");
  expect(error?.message).toBe("Type 'string' is not assignable to type 'number'.");
  expect(error?.hint).toContain("resolves @types/node 26.0.0-fixture");
  expect(error?.hint).toContain("checked against @types/node 24.13.3");
});
