import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { analyze } from "../src/index.js";

function coverageOf(dependency: string, strict: boolean, backend: "rust" | "c" | "llvm" = "rust") {
  const root = mkdtempSync(join(tmpdir(), "scriptc-native-optional-params-"));
  try {
    const entry = join(root, "main.ts");
    writeFileSync(entry, 'const ns = await import("./module.ts"); console.log(typeof ns); export {};');
    writeFileSync(join(root, "module.ts"), dependency);
    writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict, strictNullChecks: true, target: "ES2022", module: "ESNext", moduleResolution: "Bundler", allowImportingTsExtensions: true, noEmit: true }, files: ["main.ts", "module.ts"] }));
    return analyze(entry, { backend, allowEngine: false }).coverage;
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test.each([true, false])("native imports admit optional parameters with strict=%s", strict => {
  for (const dependency of [
    'export function value(input?: string): string { return input ?? "missing"; }',
    'export function value(input?: number): number { return input ?? -1; }',
    'export function value(input?: boolean): boolean { return input ?? false; }',
    'export function value(input?: string | null): string { return input ?? "missing"; }',
    'export async function value(input?: string): Promise<string> { return input ?? "missing"; }',
    'export function value(input?: { count: number }): number { return input?.count ?? 0; }',
    'export function value(input?: number[]): number { return input?.length ?? 0; }',
    'export function value(input?: string): string[] { return [input ?? ""]; }',
    'export function value(input: string = "default"): string { return input; }',
    'export async function value(input = "default"): Promise<string> { return input; }',
    'export function value(first: string, input = "default"): string { return first + input; }',
    'export function value(input: { count: number } = { count: 1 }): number { return input.count; }',
    'export function value(input: number[] = []): number { return input.length; }',
    'export function value(first = "default", last: string): string { return first + last; }',
  ]) {
    const coverage = coverageOf(dependency, strict);
    expect(coverage.preflightFailed, JSON.stringify(coverage)).toBe(false);
    expect(coverage.diagnostics, dependency).toEqual([]);
    expect(coverage.execution?.engine).toBe("none");
  }
});

test.each([
  ["rest parameters", 'export function value(...inputs: string[]): string { return inputs.join(","); }'],
] as const)("native imports retain the boundary for %s", (_name, dependency) => {
  const coverage = coverageOf(dependency, true);
  expect(coverage.preflightFailed).toBe(false);
  expect(coverage.diagnostics).toContainEqual(expect.objectContaining({ code: "SC1090", message: expect.stringContaining("native import() export 'value'") }));
});

test("optional argument counts retain their explicit diagnostic", () => {
  const coverage = coverageOf('export function value(input?: string): number { return arguments.length; }', true);
  expect(coverage.preflightFailed).toBe(false);
  expect(coverage.diagnostics).toContainEqual(expect.objectContaining({ code: "SC1090", message: expect.stringContaining("'arguments.length'") }));
});

test.each(["c", "llvm"] as const)("%s keeps its native-module backend refusal for optional parameters", backend => {
  const coverage = coverageOf('export function value(input?: string): string { return input ?? "missing"; }', true, backend);
  expect(coverage.preflightFailed).toBe(false);
  expect(coverage.diagnostics).toContainEqual(expect.objectContaining({ code: "SC3001", message: expect.stringContaining("native local module imports") }));
});
