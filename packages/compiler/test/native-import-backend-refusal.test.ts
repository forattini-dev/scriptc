import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { analyze, compile } from "../src/index.js";

function fixture(run: (entry: string, directory: string) => void | Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-native-import-backend-"));
  const entry = join(directory, "main.ts");
  writeFileSync(entry, `
    async function main(): Promise<void> {
      const module = await import("./module.ts");
      console.log(module.value);
    }
    main();
  `);
  writeFileSync(join(directory, "module.ts"), "export const value = 42;\n");
  return Promise.resolve().then(() => run(entry, directory))
    .finally(() => rmSync(directory, { recursive: true, force: true }));
}

test.each(["c", "llvm"] as const)("%s coverage reports native import refusal without throwing", async (backend) => {
  await fixture((entry) => {
    const { coverage, sourceTexts } = analyze(entry, { backend, allowEngine: false });
    expect(coverage.preflightFailed).toBe(false);
    expect(coverage.backend).toBe(backend);
    expect(coverage.diagnostics).toEqual([expect.objectContaining({
      code: "SC3001",
      message: `the ${backend} backend does not support native local module imports yet; use --backend rust`,
    })]);
    for (const diagnostic of coverage.diagnostics) {
      expect(sourceTexts.has(diagnostic.loc.file)).toBe(true);
    }
  });
});

test.each(["c", "llvm"] as const)("%s compilation returns native import diagnostics before writing artifacts", async (backend) => {
  await fixture(async (entry, directory) => {
    const outDir = join(directory, "out");
    const result = await compile(entry, { backend, allowEngine: false, outDir, outPath: join(outDir, "program") });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics).toEqual([expect.objectContaining({
      code: "SC3001",
      message: `the ${backend} backend does not support native local module imports yet; use --backend rust`,
    })]);
    expect(existsSync(outDir)).toBe(false);
  });
});


test.each(["c", "llvm"] as const)("%s ignores native imports confined to an unreached function", async backend => {
  await fixture(entry => {
    writeFileSync(entry, `async function unused() { return import("./module.ts"); } console.log("entry");`);
    const { coverage } = analyze(entry, { backend, allowEngine: false });
    expect(coverage.preflightFailed).toBe(false);
    expect(coverage.diagnostics).toEqual([]);
  });
});


test("Rust builds and runs a native import with the engine prohibited", async () => {
  await fixture(async (entry, directory) => {
    const outDir = join(directory, "out");
    const result = await compile(entry, { backend: "rust", allowEngine: false, optimization: "dev", outDir, outPath: join(outDir, "program") });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.backend).toBe("rust");
    expect(result.execution.engine).toBe("none");
    expect(execFileSync(result.binaryPath, { encoding: "utf8", timeout: 10000 })).toBe("42\n");
  });
});
