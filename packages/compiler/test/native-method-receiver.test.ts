import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

async function emit(source: string) {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-method-receiver-"));
  const entry = join(dir, "main.ts");
  const outPath = join(dir, "out", "main.rs");
  writeFileSync(entry, source + '\nexport {};\n');
  const result = await compile(entry, { backend: "rust", allowEngine: false, outputKind: "rust", outDir: join(dir, "out"), outPath });
  return { dir, outPath, result };
}

test("programs without explicit this keep the direct closure call path", async () => {
  const f = await emit(`const proxy = new Proxy({}, { get: () => () => 7 });
const reader = proxy as { read: () => number }; console.log(reader.read());`);
  try {
    expect(f.result.ok, JSON.stringify(f.result)).toBe(true);
    const source = readFileSync(f.outPath, "utf8");
    // The runtime can use guards internally, but generated source call sites
    // must not push an undefined receiver when no body observes it.
    expect(source).not.toContain('sc_dyn_this_push(sc_dyn_value::Undefined)');
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test.each([false, true])("a method receiver crossing await refuses before producing output (protected=%s)", async protected_ => {
  const f = await emit(`
const object = { value: 7, read: function(this: { value: number }, add: number): number { return this.value + add; } };
async function main(): Promise<void> { ${protected_ ? 'try {' : ''} console.log(object.read(await Promise.resolve(1))); ${protected_ ? '} catch { console.log("failed"); }' : ''} }
main();`);
  try {
    expect(f.result.ok).toBe(false);
    if (!f.result.ok) expect(f.result.diagnostics).toEqual([
      expect.objectContaining({ code: "SC3001", message: expect.stringContaining("method receiver across await") }),
    ]);
    expect(existsSync(f.outPath)).toBe(false);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test.each([
  { kind: "async", source: 'async function read(this: unknown): Promise<boolean> { await Promise.resolve(1); return this === undefined; } read();' },
  { kind: "generator", source: 'function* read(this: unknown): Generator<boolean, void, unknown> { yield this === undefined; } const iterator = read(); console.log(iterator.next().value);' },
])("$kind bodies cannot read an uncaptured native receiver", async ({ kind, source }) => {
  const f = await emit(source);
  try {
    expect(f.result.ok).toBe(false);
    if (!f.result.ok) expect(f.result.diagnostics).toEqual([
      expect.objectContaining({ code: "SC3001", message: expect.stringContaining(`explicit this in ${kind} functions requires a captured native receiver`) }),
    ]);
    expect(existsSync(f.outPath)).toBe(false);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("async and generator declarations without receiver reads retain native admission", async () => {
  const f = await emit(`
async function read(this: unknown): Promise<number> { await Promise.resolve(1); return 7; }
function* sequence(this: unknown): Generator<number, void, unknown> { yield 8; }
async function main(): Promise<void> { console.log(await read()); }
main();
const iterator = sequence(); console.log(iterator.next().value);
const sync = { read: function(this: unknown): boolean { return this !== undefined; } };
console.log(sync.read());`);
  try {
    expect(f.result.ok, JSON.stringify(f.result)).toBe(true);
    expect(existsSync(f.outPath)).toBe(true);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});
