import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { analyze } from "../src/index.js";

function diagnostics(source: string) {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-container-admission-"));
  try {
    const entry = join(directory, "main.ts");
    writeFileSync(entry, source);
    return analyze(entry, { backend: "rust", allowEngine: false }).coverage;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

for (const predicate of [
  "(value): value is string => true",
  "(value): value is string => value !== null",
  '(value = "replacement"): value is string => value != null',
]) {
  test(`written filter refuses an unproven payload tag: ${predicate}`, () => {
    const coverage = diagnostics(`
      const values: (string | null | undefined)[] = [null, undefined, "ok"];
      console.log(values.filter(${predicate}).join(","));
    `);
    expect(coverage.preflightFailed).toBe(false);
    expect(coverage.diagnostics.some((d) => d.code === "SC1090" && d.message.includes("hand-written type predicate"))).toBe(true);
  });
}

test("length writes that introduce holes retain their refusal", () => {
  const coverage = diagnostics("const values = [1, 2]; values.length = 5; console.log(values.length);");
  expect(coverage.preflightFailed).toBe(false);
  expect(coverage.diagnostics.some((d) => d.code === "SC1090")).toBe(true);
});

for (const level of [-2, 1, 2, 3, 4, 5, 6, 7, 8, 10]) {
  test(`deflate level ${level} retains an explicit compatibility refusal`, () => {
    const coverage = diagnostics(`
      import { deflateSync } from "node:zlib";
      console.log(deflateSync(Buffer.from("native native native"), { level: ${level} }).toString("hex"));
    `);
    expect(coverage.preflightFailed).toBe(false);
    expect(coverage.diagnostics.some((d) => d.code === "SC2020" && d.message.includes("deflateSync compression level"))).toBe(true);
  });
}
