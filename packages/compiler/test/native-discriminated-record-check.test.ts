import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";
const run = promisify(execFile);

test("checked discriminated maps reject invalid tags and recheck mutations", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-discriminated-check-"));
  const entry = join(dir, "main.ts");
  await writeFile(entry, `
type Flag = { kind: "boolean" } | { kind: "value"; coerce: (raw: string) => unknown };
const invalid: unknown = { kind: "bad" };
try { const view = invalid as Flag; console.log("missed", view.kind); }
catch (error) { console.log("tag", error instanceof TypeError); }
const broken: unknown = { item: { kind: "value", coerce: 1 } };
try { const view = broken as Record<string, Flag>; console.log("missed", view.item.kind); }
catch (error) { console.log("method", error instanceof TypeError); }
const source = { kind: "value", coerce: (raw: string) => Number(raw) };
const opaque: unknown = { item: source };
const view = opaque as Record<string, Flag>;
source.kind = "invalid";
try { console.log("missed", view.item.kind); }
catch (error) { console.log("read", error instanceof TypeError); }
source.kind = "boolean";
console.log("recovered", view.item.kind);
type Message = { kind: "plain"; text: string } | { kind: "count"; text: string; count: number };
try { const rows = JSON.parse('[{"kind":"invalid","text":"x","count":1}]') as Message[]; console.log("missed", rows.length); }
catch (error) { console.log("json tag", error instanceof TypeError); }
try { const rows = JSON.parse('[{"kind":"count","text":"x","count":"bad"}]') as Message[]; console.log("missed", rows.length); }
catch (error) { console.log("json payload", error instanceof TypeError); }
export {};
`);
  const result = await compile(entry, { backend: "rust", allowEngine: false, optimization: "dev", outDir: dir, outPath: join(dir, "program") });
  expect(result.ok, result.ok ? entry : JSON.stringify(result.diagnostics)).toBe(true);
  if (!result.ok) return;
  expect(result.execution.engine).toBe("none");
  const outcome = await run(result.binaryPath, [], { env: { ...process.env, SCRIPTC_RUST_HEAP_AUDIT: "1" } });
  expect(outcome.stdout).toBe("tag true\nmethod true\nread true\nrecovered boolean\njson tag true\njson payload true\n");
  expect(outcome.stderr).toBe("");
}, 120_000);
