import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

const execFileAsync = promisify(execFile);

test("native object reads refuse missing built-in prototype properties without hiding own or null-prototype values", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-object-prototype-refusal-"));
  const keys = ["constructor", "__defineGetter__", "__defineSetter__", "hasOwnProperty", "__lookupGetter__", "__lookupSetter__", "isPrototypeOf", "propertyIsEnumerable", "toString", "valueOf", "__proto__", "toLocaleString"];
  try {
    const entry = join(dir, "main.js");
    await writeFile(entry, `
function probe(label, value, key) {
  try { console.log(label, typeof value[key]); }
  catch (error) { console.log(label, error.message); }
}
const plain = {};
for (const key of ${JSON.stringify(keys)}) probe(key, plain, key);
probe('ordinary-miss', plain, 'missing');
probe('own-undefined', { toString: undefined }, 'toString');
probe('own-number', { toString: 7 }, 'toString');
const dictionary = Object.create(null);
for (const key of ${JSON.stringify(keys)}) probe('null-' + key, dictionary, key);
`);
    const result = await compile(entry, {
      backend: "rust", allowEngine: false, optimization: "dev",
      outDir: dir, outPath: join(dir, "program"),
    });
    expect(result.ok, result.ok ? undefined : JSON.stringify(result.diagnostics)).toBe(true);
    if (!result.ok) return;
    expect(result.execution.engine).toBe("none");
    const actual = await execFileAsync(result.binaryPath, [], {
      env: { ...process.env, SCRIPTC_RUST_HEAP_AUDIT: "1" }, timeout: 10_000,
    });
    const refusal = (key: string) => `scriptc: reading inherited Object.prototype.${key} on native objects is not supported yet`;
    expect(actual.stdout).toBe([
      ...keys.map(key => `${key} ${refusal(key)}`),
      "ordinary-miss undefined", "own-undefined undefined", "own-number number",
      ...keys.map(key => `null-${key} undefined`),
      "",
    ].join("\n"));
    expect(actual.stderr).toBe("");
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 180_000);
