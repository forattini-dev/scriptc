import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { nodeOracleExecutable } from "../../../tests/harness/oracle-environment.js";
import { compile } from "../src/index.js";

const execFileAsync = promisify(execFile);

test("native Proxy Promise resolution refuses each top-level bridge without inspecting container children", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-rust-proxy-promise-"));
  const entry = join(dir, "main.ts");
  await writeFile(entry, `
let gets = 0;
const proxy = new Proxy({}, { get() { gets++; return undefined; } });
type View = { value?: number };
const view = proxy as unknown as View;
function choose(flag: boolean): View | number { return flag ? view : 3; }
function isProxy(value: unknown): boolean { return value === proxy; }
async function report(label: string, action: () => unknown): Promise<void> {
  try { const result = await action(); console.log(label, 'ok', result === proxy); }
  catch (error) {
    console.log(label, 'refused', error instanceof Error && error.message.includes('Promise thenable assimilation on native Proxy'));
  }
}
async function returning(): Promise<unknown> { return proxy; }
async function awaiting(): Promise<unknown> { return await proxy; }
async function main(): Promise<void> {
  await report('resolve', () => Promise.resolve(proxy));
  await report('typed', () => Promise.resolve(view));
  await report('resolver', () => new Promise<unknown>(resolve => { resolve(proxy); }));
  await report('await', awaiting);
  await report('return', returning);
  await report('union', () => Promise.resolve(choose(true)));
  await report('then', () => Promise.resolve(1).then(() => proxy));
  console.log('scalar', await Promise.resolve(choose(false)));
  const array = await Promise.resolve([proxy]);
  console.log('array', isProxy(array[0]));
  const container = await Promise.resolve({ nested: proxy });
  console.log('container', isProxy(container.nested));
  console.log('gets', gets);
}
main();
`);
  try {
    const result = await compile(entry, {
      backend: "rust", allowEngine: false, target: "node24", optimization: "dev",
      outDir: dir, outPath: join(dir, "program"),
    });
    expect(result.ok, result.ok ? entry : JSON.stringify(result.diagnostics)).toBe(true);
    if (!result.ok) return;
    expect(result.execution).toEqual({ engine: "none", externalFfi: false });
    const [node, native] = await Promise.all([
      execFileAsync(nodeOracleExecutable(), [entry]),
      execFileAsync(result.binaryPath, [], { env: { ...process.env, SCRIPTC_RUST_HEAP_AUDIT: "1" } }),
    ]);
    const labels = ["resolve", "typed", "resolver", "await", "return", "union", "then"];
    expect(node.stdout).toBe(labels.map(label => `${label} ok true\n`).join("") + "scalar 3\narray true\ncontainer true\ngets 8\n");
    expect(native.stdout).toBe(labels.map(label => `${label} refused true\n`).join("") + "scalar 3\narray true\ncontainer true\ngets 0\n");
    expect(native.stderr).toBe(node.stderr);
    expect(native.stderr).toBe("");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
