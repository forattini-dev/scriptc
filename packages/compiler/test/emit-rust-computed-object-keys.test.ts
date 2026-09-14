import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { nodeOracleExecutable } from "../../../tests/harness/oracle-environment.js";
import { compile } from "../src/index.js";

const execFileAsync = promisify(execFile);
async function compare(fixture: string, dir: string): Promise<void> {
  const result = await compile(fixture, {
    outDir: dir, outPath: join(dir, "program"), backend: "rust",
    allowEngine: false, optimization: "dev",
  });
  expect(result.ok, result.ok ? "" : result.diagnostics.map(diag => diag.message).join("; ")).toBe(true);
  if (!result.ok) return;
  expect(result.execution.engine).toBe("none");
  expect(result.runtimeFences).toEqual([]);
  const [node, rust] = await Promise.all([
    execFileAsync(nodeOracleExecutable(), [fixture]),
    execFileAsync(result.binaryPath, [], { env: { ...process.env, SCRIPTC_RUST_HEAP_AUDIT: "1" } }),
  ]);
  expect(rust.stdout).toBe(node.stdout);
  expect(rust.stderr).toBe(node.stderr);
}

test("Rust compiles computed keys in the original variadic JS corpus without an engine", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-rust-computed-keys-"));
  await compare(resolve("tests/corpus/1703-arguments-rest-props.cjs"), dir);
});

test("Rust computed string keys convert before values and retain duplicate-key order", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-rust-key-order-"));
  const fixture = join(dir, "main.cjs");
  await writeFile(fixture, `
let events = "";
function key(value) { events += "key;"; return value; }
function value(n) { events += "value" + n + ";"; return n; }
function build(k) {
  return { [k]: value(1), stable: value(2), [key(k)]: value(3) };
}
for (const k of ["word", 4, true, null, undefined]) {
  events = "";
  const object = build(k);
  console.log(JSON.stringify(object), events);
}
const coercible = { toString() { events += "convert;"; return "converted"; } };
events = "";
console.log(JSON.stringify(build(coercible)), events);
const failure = { toString() { events += "throw;"; throw new Error("key failure"); } };
events = "";
try { build(failure); } catch (error) { console.log(String(error), events); }
`);
  await compare(fixture, dir);
});

test("Rust indexed records accept JS-residue computed keys and preserve spread order", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-rust-indexed-keys-"));
  const fixture = join(dir, "main.ts");
  await writeFile(fixture, `
function build(key: any, source: { [key: string]: number }): { [key: string]: number } {
  return { ...source, [key]: 7, after: 8 };
}
console.log(JSON.stringify(build("first", { first: 1, middle: 2 })));
console.log(JSON.stringify(build(42, { first: 1 })));
`);
  await compare(fixture, dir);
});

test("computed symbol storage remains an explicit native admission boundary", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-rust-symbol-key-boundary-"));
  const fixture = join(dir, "main.ts");
  await writeFile(fixture, `
function build(key: symbol): { [key: string]: number } { return { [key]: 1 }; }
console.log(JSON.stringify(build(Symbol("key"))));
`);
  const result = await compile(fixture, {
    outDir: dir, outPath: join(dir, "program"), backend: "rust", allowEngine: false,
  });
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.diagnostics.some(diag => /symbol.*computed property keys/.test(diag.message)), JSON.stringify(result.diagnostics)).toBe(true);
});
