import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";
import { nodeOracleExecutable } from "../../../tests/harness/oracle-environment.js";

const exec = promisify(execFile);
const cases = [
  ["resolved iterator values", `
const pending = Promise.resolve(41);
const reader = ReadableStream.from<unknown>([pending, 42]).getReader();
console.log((await reader.read()).value);
console.log((await reader.read()).value);
console.log((await reader.read()).done);
`],
  ["rejected iterator value", `
const reader = ReadableStream.from<unknown>([Promise.reject("iterator failed")]).getReader();
try { await reader.read(); console.log("unexpected"); }
catch (error) { console.log("rejected", error); }
`],
  ["iterator Promise job order", `
const reader = ReadableStream.from([1]).getReader();
void reader.read().then((part) => { console.log("read", part.value); });
for (let index = 0; index < 6; index++) {
  await Promise.resolve();
  console.log("tick", index);
}
`],
  ["multiple pending reads keep Promise job order", `
const reader = ReadableStream.from([1, 2]).getReader();
void reader.read().then((part) => { console.log("first", part.value); });
void reader.read().then((part) => { console.log("second", part.value); });
for (let index = 0; index < 12; index++) {
  await Promise.resolve();
  console.log("tick", index);
}
`],
  ["nested array identity and shared mutation", `
const nested = [1];
const reader = ReadableStream.from([nested, nested]).getReader();
const first = await reader.read();
if (!first.done) {
  first.value.push(2);
  console.log(first.value === nested, nested.length);
}
nested.push(3);
const second = await reader.read();
if (!first.done && !second.done) {
  console.log(first.value === second.value, first.value.length, second.value.length);
}
`],
] as const;

test.skipIf(process.env["SCRIPTC_SAN"] === "1").each(cases)(
  "native Rust ReadableStream.from: %s",
  async (_name, source) => {
    const dir = await mkdtemp(join(tmpdir(), "scriptc-rust-stream-from-"));
    const entry = join(dir, "main.mts");
    await writeFile(entry, source);
    const result = await compile(entry, {
      backend: "rust", allowEngine: false, optimization: "dev",
      outDir: dir, outPath: join(dir, "program"),
    });
    expect(result.ok, result.ok ? "" : result.diagnostics.map(d => `${d.code}: ${d.message}`).join("\n")).toBe(true);
    if (!result.ok) return;
    expect(result.execution.engine).toBe("none");
    const [native, node] = await Promise.all([
      exec(result.binaryPath, [], { env: { ...process.env, SCRIPTC_RUST_HEAP_AUDIT: "1" }, timeout: 30_000 }),
      exec(nodeOracleExecutable(), [entry], { timeout: 30_000 }),
    ]);
    expect(native.stdout).toBe(node.stdout);
    expect(native.stderr).toBe(node.stderr);
  },
);
