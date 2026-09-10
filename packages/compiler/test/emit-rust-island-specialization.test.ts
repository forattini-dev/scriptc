import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { nodeOracleExecutable } from "../../../tests/harness/oracle-environment.js";
import { compile } from "../src/index.js";

const execFileAsync = promisify(execFile);

// The same operations must work over native dynamic values and engine handles.
// Explicit eval in the second build selects a realm without changing the data.
test.each([false, true])("Rust dynamic specializations preserve semantics with engine=%s", async (engine) => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-rust-specialization-"));
  const entry = join(dir, "main.ts");
  const source = `
const value: any = { count: 42 };
const { count }: { count: number } = value;
console.log(count, Number.isInteger(count), Number.isSafeInteger(count));
value.count = 7;
const { count: updated }: { count: number } = value;
console.log(updated);
const numeric: any = 42;
const text: any = "42";
console.log(Number.isInteger(numeric), Number.isSafeInteger(numeric));
console.log(Number.isInteger(text), Number.isSafeInteger(text));
`;
  await writeFile(entry, source);
  const node = await execFileAsync(nodeOracleExecutable(), [entry]);
  if (engine) await writeFile(entry, source + '\n__island_eval("0");\n');
  const result = await compile(entry, {
    backend: "rust", dynamic: true, allowEngine: engine,
    optimization: "dev", outDir: dir, outPath: join(dir, "program"),
  });
  expect(result.ok, result.ok ? entry : result.diagnostics.map(d => `${d.code}: ${d.message}`).join("; ")).toBe(true);
  if (!result.ok) return;
  if (engine) expect(["boa", "v8"]).toContain(result.execution.engine);
  else expect(result.execution.engine).toBe("none");
  const rust = await execFileAsync(result.binaryPath, [], {
    env: { ...process.env, SCRIPTC_RUST_HEAP_AUDIT: "1" },
  });
  expect(rust.stdout).toBe(node.stdout);
  expect(rust.stderr).toBe(node.stderr);
}, 240_000);
