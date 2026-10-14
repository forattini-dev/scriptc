import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { nodeOracleExecutable } from "../../../tests/harness/oracle-environment.js";
import { compile } from "../src/index.js";

const run = promisify(execFile);

test("Rust optional string indexing retains lone UTF-16 surrogate payloads without an engine", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-rust-optional-string-"));
  const entry = join(dir, "main.ts");
  await writeFile(join(dir, "tsconfig.json"), JSON.stringify({
    compilerOptions: { target: "ES2022", strict: true, noUncheckedIndexedAccess: true, types: [] },
    files: ["main.ts"],
  }));
  await writeFile(entry, `const text = "a\\u{1f680}z";
for (let index = 0; index < text.length; index++) {
  const char = text[index];
  if (char !== undefined) console.log(char.length, char.charCodeAt(0));
}
console.log(text[100] === undefined);
`);
  const result = await compile(entry, {
    backend: "rust", allowEngine: false, optimization: "dev", outDir: dir,
    outPath: join(dir, process.platform === "win32" ? "probe.exe" : "probe"),
  });
  expect(result.ok, result.ok ? "" : JSON.stringify(result.diagnostics)).toBe(true);
  if (!result.ok) return;
  expect(result.execution).toEqual({ engine: "none", externalFfi: false });
  expect(result.runtimeFences).toEqual([]);
  const [node, rust] = await Promise.all([
    run(nodeOracleExecutable(), [entry]),
    run(result.binaryPath, [], { env: { ...process.env, SCRIPTC_RUST_HEAP_AUDIT: "1" } }),
  ]);
  expect(node.stdout).toBe("1 97\n1 55357\n1 56960\n1 122\ntrue\n");
  expect(rust.stdout).toBe(node.stdout);
  expect(rust.stderr).toBe(node.stderr);
});
