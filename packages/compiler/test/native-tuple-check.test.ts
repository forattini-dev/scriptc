import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";
const run = promisify(execFile);

test("checked homogeneous tuple views validate arrays and preserve extra positions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-tuple-check-"));
  const entry = join(dir, "main.ts");
  await writeFile(entry, `
const source: string[] = ["a", "b"];
const boxed: unknown = source;
const tuple = boxed as [string, string];
tuple[0] = "changed";
source.push("extra");
console.log("identity", tuple === source, Array.isArray(tuple), source[0]);
console.log("length", tuple.length, JSON.stringify(tuple));
const short: unknown = JSON.parse('["one"]');
try { const value = short as [string, string]; console.log("missed", value.length); }
catch (error) { console.log("arity", error instanceof TypeError); }
const bad: unknown = JSON.parse('["one",2]');
try { const value = bad as [string, string]; console.log("missed", value.length); }
catch (error) { console.log("element", error instanceof TypeError); }
const object: unknown = JSON.parse('{"0":"one","1":"two"}');
try { const value = object as [string, string]; console.log("missed", value.length); }
catch (error) { console.log("container", error instanceof TypeError); }
export {};
`);
  const result = await compile(entry, { backend: "rust", allowEngine: false, optimization: "dev", outDir: dir, outPath: join(dir, "program") });
  expect(result.ok, result.ok ? entry : JSON.stringify(result.diagnostics)).toBe(true);
  if (!result.ok) return;
  expect(result.execution.engine).toBe("none");
  const outcome = await run(result.binaryPath, [], { env: { ...process.env, SCRIPTC_RUST_HEAP_AUDIT: "1" } });
  expect(outcome.stdout).toBe('identity true true changed\nlength 3 ["changed","b","extra"]\narity true\nelement true\ncontainer true\n');
  expect(outcome.stderr).toBe("");
}, 120_000);
