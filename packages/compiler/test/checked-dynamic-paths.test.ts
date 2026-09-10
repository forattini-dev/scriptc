import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

const execFileAsync = promisify(execFile);

test("native checked views retain field and index paths through nested containers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "scriptc-checked-paths-"));
  const cases = [
    ['{"items":[1,"wrong"]}', '{ items: number[] }', 'number at $.items[1], got string'],
    ['{"outer":{"enabled":"wrong"}}', '{ outer: { enabled: boolean } }', 'boolean at $.outer.enabled, got string'],
    ['{"odd key":[false]}', '{ "odd key": string[] }', 'string at $.odd key[0], got boolean'],
    ['[[1],["wrong"]]', 'number[][]', 'number at $[1][0], got string'],
    ['{"values":{"first":1,"second":"wrong"}}', '{ values: Record<string, number> }', 'number at $.values.second, got string'],
    ['{"items":42}', '{ items?: number[] }', 'array or undefined at $.items, got number'],
    ['{"pair":[1,"wrong"]}', '{ pair: [number, number] }', 'number at $.pair[1], got string'],
  ];
  try {
    const entry = join(directory, "main.ts");
    const source = cases.map(([json, type]) => `{
      const input: unknown = JSON.parse(${JSON.stringify(json)});
      try { const checked = input as ${type}; console.log("unexpected success", JSON.stringify(checked)); }
      catch (error) { console.log(String(error)); }
    }`).join("\n");
    await writeFile(entry, source);
    const result = await compile(entry, {
      outDir: directory, outPath: join(directory, "program"),
      backend: "rust", optimization: "dev", allowEngine: false,
    });
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
    const native = await execFileAsync(result.binaryPath, [], {
      env: { ...process.env, SCRIPTC_RUST_HEAP_AUDIT: "1" },
    });
    expect(native.stderr).toBe("");
    expect(native.stdout).toBe(cases.map(([, , message]) => `TypeError: expected ${message}\n`).join(""));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 120_000);
