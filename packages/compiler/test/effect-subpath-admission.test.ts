import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setImmediate } from "node:timers/promises";
import { expect, test } from "vitest";
import { analyze } from "../src/index.js";

test.each([undefined, "auto", "lib"] as const)("native Effect subpaths are admitted with npmStatic %s", async (npmStatic) => {
  await setImmediate();
  const entry = resolve(import.meta.dirname, "../../../tests/corpus/3171-effect-subpath-imports.ts");
  const { coverage } = analyze(entry, { backend: "rust", allowEngine: false, npmStatic });
  expect(coverage.diagnostics).toEqual([]);
  expect(coverage.npmStatic ?? []).toEqual([]);
  expect(coverage.execution?.engine).toBe("none");
});

test("Effect subpath admission preserves unsupported operation diagnostics", async () => {
  await setImmediate();
  const directory = mkdtempSync(join(tmpdir(), "scriptc-effect-subpath-"));
  try {
    mkdirSync(join(directory, "node_modules"));
    symlinkSync(resolve(import.meta.dirname, "../../../node_modules/effect"), join(directory, "node_modules/effect"), "junction");
    const entry = join(directory, "main.ts");
    writeFileSync(entry, 'import * as FX from "effect/Effect";\nFX.runSync(FX.all([FX.succeed(1)], { concurrency: 2 }));\n');
    const { coverage } = analyze(entry, { backend: "rust", allowEngine: false });
    expect(coverage.preflightFailed).toBe(false);
    expect(coverage.diagnostics.some((d) => d.code === "SC1090" && d.message.includes("concurrency"))).toBe(true);
    expect(coverage.diagnostics.some((d) => d.code === "SC2013")).toBe(false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
