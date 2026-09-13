import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { expect, test } from "vitest";
import { analyzeAsync, compile } from "../src/index.js";
import { nodeOracleExecutable } from "../../../tests/harness/oracle-environment.js";
import { fixture, registry } from "../src/type-acquisition/fixtures.js";

test("acquisition preserves the inferred native executable instead of substituting declared signatures", async () => {
  const root = fixture({ "main.ts": 'import { answer, type Row } from "type-example"; const row: Row = { value: answer() }; console.log(row.value);\n' });
  // Intentionally incorrect library declaration: native mode must infer
  // answer's actual number-returning body, never invent a string result.
  registry({ "index.d.ts": "export function answer(): string; export interface Row { value: number }\n" });
  const result = await compile(join(root, "main.ts"), {
    backend: "rust", allowEngine: false, npmStatic: "auto",
    typeAcquisition: { mode: "auto", cacheDir: join(root, "cache") },
    outDir: join(root, "out"), outPath: join(root, "out/program"),
  });
  expect(result.ok, result.ok ? undefined : JSON.stringify(result.diagnostics)).toBe(true);
  if (!result.ok) return;
  expect(result.execution.engine).toBe("none");
  const native = spawnSync(result.binaryPath, [], { encoding: "utf8", timeout: 30_000 });
  const node = spawnSync(nodeOracleExecutable(), [join(root, "main.ts")], { encoding: "utf8", timeout: 30_000 });
  expect(native.error).toBeUndefined();
  expect(node.error).toBeUndefined();
  expect([native.stdout, native.stderr, native.status]).toEqual([node.stdout, node.stderr, node.status]);
  expect(native.stdout).toBe("42\n");
  const replay = await analyzeAsync(join(root, "main.ts"), {
    backend: "rust", allowEngine: false, npmStatic: "auto",
    typeAcquisition: { mode: "offline", frozenLock: true, cacheDir: join(root, "cache") },
  });
  expect(replay.coverage.npmStatic).toEqual([{ package: "type-example", status: "static" }]);
  expect(replay.coverage.diagnostics).toEqual([]);
});

test("async analysis reports acquisition failures as diagnostics", async () => {
  const root = fixture();
  const result = await analyzeAsync(join(root, "main.ts"), { typeAcquisition: { mode: "offline", cacheDir: join(root, "empty-cache") } });
  expect(result.coverage.preflightFailed).toBe(true);
  expect(result.coverage.diagnostics.map(d => d.code)).toEqual(["SC4030"]);
  expect(result.coverage.diagnostics[0]?.message).toContain("lock miss");
});
