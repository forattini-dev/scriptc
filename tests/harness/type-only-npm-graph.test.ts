import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { compile } from "@scriptc/compiler";
import { nodeOracleExecutable } from "./oracle-environment.js";

const execFileAsync = promisify(execFile);

test("Rust type-only npm graph preserves module effects without an engine", async () => {
  const entry = resolve("tests/fixtures/type-only-npm-graph/main.ts");
  const dir = await mkdtemp(join(tmpdir(), "scriptc-type-only-npm-"));
  try {
    const result = await compile(entry, {
      backend: "rust", npmStatic: "auto", allowEngine: false,
      outDir: dir, outPath: join(dir, "program"),
    });
    expect(result.ok, result.ok ? undefined : JSON.stringify(result.diagnostics)).toBe(true);
    if (!result.ok) return;
    expect(result.execution).toEqual({ engine: "none", externalFfi: false });
    expect(result.runtimeFences).toEqual([]);
    const [node, rust] = await Promise.all([
      execFileAsync(nodeOracleExecutable(), [entry]),
      execFileAsync(result.binaryPath, [], { env: { ...process.env, SCRIPTC_RUST_HEAP_AUDIT: "1" } }),
    ]);
    // execFile rejects nonzero exits; both success statuses are pinned here.
    expect(rust.stdout).toBe(node.stdout);
    expect(rust.stderr).toBe(node.stderr);
    expect(node.stdout).toBe("npm inline type import evaluated\nnpm inline type reexport evaluated\ntype-only npm stays erased 4\n");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
