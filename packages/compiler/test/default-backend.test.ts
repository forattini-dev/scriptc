import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { analyze, compile } from "../src/index.js";

function fixture(run: (entry: string, dir: string) => void | Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-default-backend-"));
  const entry = join(dir, "main.ts");
  writeFileSync(entry, 'console.log("native default");\n');
  return Promise.resolve().then(() => run(entry, dir)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

test("flagless API builds and executes Rust without a JS engine or C compiler", async () => {
  vi.stubEnv("SCRIPTC_CC", "/nonexistent-scriptc-c-compiler");
  try { await fixture(async (entry, dir) => {
    const result = await compile(entry, { outDir: dir, outPath: join(dir, "program"), optimization: "dev" });
    expect(result.ok, result.ok ? "" : JSON.stringify(result.diagnostics)).toBe(true);
    if (!result.ok) return;
    expect(result.backend).toBe("rust");
    expect(result.execution.engine).toBe("none");
    expect(result.llvmRefusal).toBeUndefined();
    expect(result.sourcePath).toMatch(/\.rs$/);
    expect(readFileSync(result.sourcePath!, "utf8")).toContain("#![forbid(unsafe_code)]");
    const actual = spawnSync(result.binaryPath, [], { encoding: "utf8", timeout: 30_000 });
    expect(actual.error).toBeUndefined();
    expect(actual.status).toBe(0);
    expect(actual.stdout).toBe("native default\n");
    expect(actual.stderr).toBe("");
  }); } finally { vi.unstubAllEnvs(); }
});

test("flagless coverage validates and reports Rust emission", async () => {
  await fixture((entry) => {
    const { coverage } = analyze(entry);
    expect(coverage.diagnostics).toEqual([]);
    expect(coverage.backend).toBe("rust");
    expect(coverage.execution?.engine).toBe("none");
  });
});

test("unsupported Rust targets refuse rather than selecting LLVM", async () => {
  vi.stubEnv("SCRIPTC_TARGET", "wasm32-wasi");
  try {
    await fixture(async (entry, dir) => {
      const options = { outDir: dir, outPath: join(dir, "program") };
      const result = await compile(entry, options);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.diagnostics.some(d => d.code === "SC3001" && d.message.includes("rust"))).toBe(true);
      const { coverage } = analyze(entry);
      expect(coverage.backend).toBe("rust");
      expect(coverage.diagnostics.some(d => d.code === "SC3001" && d.message.includes("rust"))).toBe(true);
    });
  } finally { vi.unstubAllEnvs(); }
});

test.each(["c", "llvm"] as const)("explicit %s selection remains available", async (backend) => {
  await fixture(async (entry, dir) => {
    const result = await compile(entry, { backend, outDir: dir, outPath: join(dir, "program"),
      sanitize: process.env["SCRIPTC_SAN"] === "1", optimization: "dev" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.backend).toBe(backend);
  });
});
