import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";
const run = promisify(execFile);

test("native array views validate all current elements and recheck later reads", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-native-array-check-"));
  const entry = join(dir, "main.ts");
  await writeFile(entry, `
const bad: unknown = JSON.parse('[1,"wrong"]');
try { const checked = bad as number[]; console.log("missed", checked.length); }
catch (error) { console.log("initial", error instanceof TypeError); }
const source: unknown[] = JSON.parse('[2,3]');
const numbers = source as number[];
source[1] = "bad";
try { console.log("missed", numbers[1]); }
catch (error) { console.log("read", error instanceof TypeError); }
source[1] = 4;
console.log("recovered", numbers[1], numbers === (source as number[]));
const nested: unknown = JSON.parse('[[1],["wrong"]]');
try { const checked = nested as number[][]; console.log("missed", checked.length); }
catch (error) { console.log("nested", error instanceof TypeError); }
`);
  const result = await compile(entry, { backend: "rust", allowEngine: false, optimization: "dev", outDir: dir, outPath: join(dir, "program") });
  expect(result.ok, result.ok ? entry : JSON.stringify(result.diagnostics)).toBe(true);
  if (!result.ok) return;
  expect(result.execution.engine).toBe("none");
  const outcome = await run(result.binaryPath, [], { env: { ...process.env, SCRIPTC_RUST_HEAP_AUDIT: "1" } });
  expect(outcome.stdout).toBe("initial true\nread true\nrecovered 4 true\nnested true\n");
  expect(outcome.stderr).toBe("");
}, 120_000);
