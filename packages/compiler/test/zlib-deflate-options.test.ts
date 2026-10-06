import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { analyze } from "../src/index.js";

function coverageOf(source: string, backend: "rust" | "c" | "llvm" = "rust") {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-zlib-options-"));
  try {
    const entry = join(directory, "main.ts");
    writeFileSync(entry, source);
    return analyze(entry, { backend, allowEngine: false }).coverage;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const program = (call: string) => `
  import { deflateSync, deflateRawSync, gzipSync, inflateSync } from "node:zlib";
  declare const options: { level: number };
  declare const level: number;
  const data = Buffer.from("native native native");
  console.log(${call}.length);
`;

// The zlib entry point decides the call shape before anything else sees it:
// the fixed-level form must not be shadowed by the default-options family.
test.each([
  "deflateSync(data, { level: 9 })",
  "deflateSync(data, { level: 0 })",
  "deflateSync(data, { level: -1 })",
  "deflateSync(data, { level: 9 as const })",
  'deflateSync(data, { "level": 9 })',
  'deflateSync("a string payload", { level: 9 })',
  "deflateSync(new Uint8Array(4), { level: 9 })",
])("deflateSync lowers the fixed-level form natively: %s", (call) => {
  const coverage = coverageOf(program(call));
  expect(coverage.preflightFailed).toBe(false);
  expect(coverage.diagnostics).toEqual([]);
  expect(coverage.stats.statementsFailed).toBe(0);
});

test.each([
  ["windowBits", "deflateSync(data, { windowBits: 15 })"],
  ["memLevel", "deflateSync(data, { memLevel: 9 })"],
  ["strategy", "deflateSync(data, { strategy: 1 })"],
  ["chunkSize", "deflateSync(data, { chunkSize: 1024 })"],
  ["dictionary", "deflateSync(data, { dictionary: Buffer.from('a') })"],
  ["level with windowBits", "deflateSync(data, { level: 9, windowBits: 15 })"],
  ["level with memLevel", "deflateSync(data, { level: 9, memLevel: 8 })"],
  ["empty options", "deflateSync(data, {})"],
  ["options variable", "deflateSync(data, options)"],
  ["spread options", "deflateSync(data, { ...options })"],
  ["shorthand level", "deflateSync(data, { level })"],
  ["computed level key", 'deflateSync(data, { ["level"]: 9 })'],
])("deflateSync keeps a precise refusal for %s", (_name, call) => {
  const coverage = coverageOf(program(call));
  expect(coverage.preflightFailed).toBe(false);
  const refusals = coverage.diagnostics.filter((d) => d.code === "SC2020");
  expect(refusals).toHaveLength(1);
  expect(refusals[0]!.message).toContain("deflateSync options");
});

test("deflateSync refuses a level that is not a compile-time -1, 0 or 9", () => {
  const coverage = coverageOf(program("deflateSync(data, { level: level })"));
  expect(coverage.diagnostics.map((d) => d.code)).toEqual(["SC2020"]);
  expect(coverage.diagnostics[0]!.message).toContain("deflateSync compression level");
});

test.each([
  ["deflateRawSync", "deflateRawSync(data, { level: 9 })"],
  ["gzipSync", "gzipSync(data, { level: 9 })"],
  ["inflateSync", "inflateSync(data, { level: 9 })"],
])("%s with explicit options is still refused", (member, call) => {
  const coverage = coverageOf(program(call));
  const refusals = coverage.diagnostics.filter((d) => d.code === "SC2020");
  expect(refusals).toHaveLength(1);
  expect(refusals[0]!.message).toContain(`${member} with explicit options`);
});

// Only the Rust runtime reproduces Node's level 0, 6 and 9 streams. The C and
// LLVM runtimes link the system zlib, whose bytes differ for non-trivial
// inputs, so the fixed-level form must stay refused there instead of
// compiling into a silently different stream.
test.each([
  ["c", "deflateSync(data, { level: 9 })"],
  ["c", "deflateSync(data, { level: 0 })"],
  ["c", "deflateSync(data, { level: -1 })"],
  ["llvm", "deflateSync(data, { level: 9 })"],
  ["llvm", "deflateSync(data, { level: -1 })"],
] as const)("the %s backend keeps refusing %s", (backend, call) => {
  const coverage = coverageOf(program(call), backend);
  const refusals = coverage.diagnostics.filter((d) => d.code === "SC2020");
  expect(refusals).toHaveLength(1);
  expect(refusals[0]!.message).toContain("deflateSync with explicit options");
});
