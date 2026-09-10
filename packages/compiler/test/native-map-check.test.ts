import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";
const run = promisify(execFile);

test("native map views validate entries, recheck reads and preserve unit values", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-native-map-check-"));
  const entry = join(dir, "main.ts");
  await writeFile(entry, `
const bad: unknown = JSON.parse('{"ok":1,"bad":"wrong"}');
try { const checked = bad as Record<string, number>; console.log("missed", checked.ok); }
catch (error) { console.log("initial", error instanceof TypeError); }
const source: Record<string, unknown> = JSON.parse('{"value":2}');
const numbers = source as Record<string, number>;
source.value = "bad";
try { console.log("missed", numbers.value); }
catch (error) { console.log("read", error instanceof TypeError); }
source.value = 3;
console.log("recovered", numbers.value, numbers === (source as Record<string, number>));
const nulls: Record<string, null> = { value: null };
const boxedNulls: unknown = nulls;
const nullView = boxedNulls as Record<string, null>;
const absent: Record<string, undefined> = { value: undefined };
const boxedAbsent: unknown = absent;
const absentView = boxedAbsent as Record<string, undefined>;
console.log("unit identity", nullView === nulls, absentView === absent);
console.log("unit values", nullView.value === null, absentView.value === undefined);
console.log("unit json", JSON.stringify(nullView), JSON.stringify(absentView));
`);
  const result = await compile(entry, { backend: "rust", allowEngine: false, optimization: "dev", outDir: dir, outPath: join(dir, "program") });
  expect(result.ok, result.ok ? entry : JSON.stringify(result.diagnostics)).toBe(true);
  if (!result.ok) return;
  expect(result.execution.engine).toBe("none");
  const outcome = await run(result.binaryPath, [], { env: { ...process.env, SCRIPTC_RUST_HEAP_AUDIT: "1" } });
  expect(outcome.stdout).toBe("initial true\nread true\nrecovered 3 true\nunit identity true true\nunit values true true\nunit json {\"value\":null} {}\n");
  expect(outcome.stderr).toBe("");
}, 120_000);
