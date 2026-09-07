import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setImmediate } from "node:timers/promises";
import { expect, test } from "vitest";
import { analyze } from "../src/index.js";

async function coverageFor(source: string) {
  // Let Vitest flush task updates between synchronous compiler analyses.
  await setImmediate();
  const directory = mkdtempSync(join(tmpdir(), "scriptc-effect-options-"));
  try {
    mkdirSync(join(directory, "node_modules"));
    symlinkSync(resolve(import.meta.dirname, "../../../node_modules/effect"), join(directory, "node_modules/effect"), "junction");
    const entry = join(directory, "main.ts");
    writeFileSync(entry, `import { Effect } from "effect";\n${source}`);
    return analyze(entry, { backend: "rust", allowEngine: false }).coverage;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

for (const combinator of ["all", "forEach"]) {
  const call = (options: string): string => combinator === "all"
    ? `Effect.all([Effect.succeed(1)], ${options})`
    : `Effect.forEach([1], (n) => Effect.succeed(n), ${options})`;

  for (const options of [
    "{ concurrency: 2 }",
    "{ discard: true, concurrency: 2 }",
    '{ concurrency: "unbounded", discard: true }',
    '{ discard: true, concurrency: "inherit" }',
    '{ discard: true, concurrency: (console.log("options"), 1) }',
  ]) {
    test(`Effect.${combinator} refuses unsupported concurrency: ${options}`, async () => {
      const coverage = await coverageFor(`Effect.runSync(${call(options)});`);
      expect(coverage.preflightFailed, JSON.stringify(coverage.diagnostics)).toBe(false);
      expect(coverage.diagnostics.some((d) => d.code === "SC1090" && d.message.includes("concurrency"))).toBe(true);
    });
  }

  test(`Effect.${combinator} refuses a discard expression whose evaluation would be lost`, async () => {
    const coverage = await coverageFor(`Effect.runSync(${call('{ discard: (console.log("options"), true) }')});`);
    expect(coverage.preflightFailed, JSON.stringify(coverage.diagnostics)).toBe(false);
    expect(coverage.diagnostics.some((d) => d.code === "SC1090" && d.message.includes("discard"))).toBe(true);
  });

  test(`Effect.${combinator} admits explicit sequential options`, async () => {
    const coverage = await coverageFor(`Effect.runSync(${call("{ discard: false, concurrency: 1 }")});`);
    expect(coverage.preflightFailed, JSON.stringify(coverage.diagnostics)).toBe(false);
    expect(coverage.diagnostics).toEqual([]);
    expect(coverage.execution?.engine).toBe("none");
  });
}

test("Effect.all checks options after discard", async () => {
  const coverage = await coverageFor('Effect.runSync(Effect.all([Effect.succeed(1)], { discard: true, mode: "result" }));');
  expect(coverage.preflightFailed, JSON.stringify(coverage.diagnostics)).toBe(false);
  expect(coverage.diagnostics.some((d) => d.code === "SC1090" && d.message.includes("mode"))).toBe(true);
});
