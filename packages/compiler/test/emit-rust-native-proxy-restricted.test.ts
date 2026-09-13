import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { nodeOracleExecutable } from "../../../tests/harness/oracle-environment.js";
import { compile } from "../src/index.js";

const execFileAsync = promisify(execFile);

test("native Proxy refuses unrepresented descriptor invariants through aliases and live traps", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-rust-proxy-restricted-"));
  const entry = join(dir, "main.ts");
  await writeFile(entry, `
let calls = 0;
function restrict(value: unknown): void {
  Object.defineProperties(value, { value: { value: 1, writable: false, configurable: false } });
}
function report(label: string, read: () => unknown): void {
  try { read(); console.log(label, 'missed'); }
  catch (error) {
    if (error instanceof Error) console.log(label, error.name, error.message.includes('native Proxy'));
    else console.log(label, 'unexpected');
  }
}
const frozen = Object.freeze({ value: 1 });
const first = new Proxy(frozen, { get() { calls++; return 2; } });
report('frozen', () => first.value);
const target = { value: 1 };
const alias: any = target;
const second = new Proxy(target, { get() { calls++; return 2; } });
restrict(alias);
report('later', () => second.value);
const nested = new Proxy(second, {});
report('nested', () => nested.value);
const changed = { value: 1 };
const during = new Proxy(changed, { get(object) {
  calls++;
  restrict(object);
  return 2;
} });
report('during', () => during.value);
console.log('calls', calls);
export {};
`);
  try {
    const result = await compile(entry, {
      outDir: dir, outPath: join(dir, "program"), backend: "rust",
      allowEngine: false, target: "node24", optimization: "dev",
    });
    expect(result.ok, result.ok ? entry : JSON.stringify(result.diagnostics)).toBe(true);
    if (!result.ok) return;
    expect(result.execution).toEqual({ engine: "none", externalFfi: false });
    expect(result.runtimeFences).toEqual([]);
    const [node, rust] = await Promise.all([
      execFileAsync(nodeOracleExecutable(), [entry]),
      execFileAsync(result.binaryPath, [], { env: { ...process.env, SCRIPTC_RUST_HEAP_AUDIT: "1" } }),
    ]);
    // Rust deliberately refuses this unsupported slice before executing a trap.
    // Node executes the trap and enforces the full descriptor invariants.
    expect(node.stdout).toBe("frozen TypeError false\nlater TypeError false\nnested TypeError false\nduring TypeError false\ncalls 4\n");
    expect(rust.stdout).toBe("frozen Error true\nlater Error true\nnested Error true\nduring Error true\ncalls 1\n");
    expect(rust.stderr).toBe(node.stderr);
    expect(rust.stderr).toBe("");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
