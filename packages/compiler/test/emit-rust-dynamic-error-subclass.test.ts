import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { nodeOracleExecutable } from "../../../tests/harness/oracle-environment.js";
import { compile } from "../src/index.js";

const execFileAsync = promisify(execFile);

test.each([
  "1554-caught-into-unknown.ts",
  "1431-caught-tostring.ts",
  "2164-js-then-dyn-handler.cjs",
])("Rust preserves builtin and user Error values through unknown: %s", async (name) => {
  const fixture = resolve("tests/corpus", name);
  const dir = await mkdtemp(join(tmpdir(), "scriptc-rust-dynamic-error-"));
  const result = await compile(fixture, {
    outDir: dir,
    outPath: join(dir, "program"),
    backend: "rust",
    allowEngine: false,
    optimization: "dev",
  });
  expect(
    result.ok,
    result.ok ? fixture : result.diagnostics.map((diagnostic) => diagnostic.message).join("; "),
  ).toBe(true);
  if (!result.ok) return;
  expect(result.execution.engine).toBe("none");
  expect(result.runtimeFences).toEqual([]);

  const [node, rust] = await Promise.all([
    execFileAsync(nodeOracleExecutable(), [fixture]),
    execFileAsync(result.binaryPath, [], {
      env: { ...process.env, SCRIPTC_RUST_HEAP_AUDIT: "1" },
    }),
  ]);
  expect(rust.stdout).toBe(node.stdout);
  expect(rust.stderr).toBe(node.stderr);
});

test("Rust dynamic error coercion preserves formatting and own conversion hooks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-rust-error-coercion-"));
  const fixture = join(dir, "main.cjs");
  await writeFile(fixture, `
function dynamic(value) { return value; }
const error = dynamic(new TypeError("bad"));
console.log(String(error), \`<\${error}>\`, String("" + error));
console.log(String(dynamic(new RangeError(""))));
const unnamed = dynamic(new Error("only-message"));
unnamed.name = "";
console.log(String(unnamed));
error.toString = function () { return this.message + "!"; };
console.log(String(error), \`<\${error}>\`, String("" + error));
error.valueOf = function () { return 7; };
console.log(String(error + 1), String(error));
const fake = dynamic({ name: "TypeError", message: "not-an-error", "%error": true });
console.log(String(fake), String("" + fake));
`);
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
});
