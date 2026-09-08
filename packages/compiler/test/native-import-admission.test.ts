import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { analyze } from "../src/index.js";

function coverageOf(source: string, dependency = "export let count = 0; export function bump(): void { count++; }\n") {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-native-import-admission-"));
  try {
    const entry = join(directory, "main.ts");
    writeFileSync(entry, source);
    writeFileSync(join(directory, "module.ts"), dependency);
    return analyze(entry, { backend: "rust", allowEngine: false }).coverage;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test.each([
  ["local namespace aliases", `
    async function main(): Promise<void> {
      const ns = await import("./module.ts");
      let alias = ns;
      var hoisted = alias;
      hoisted.bump();
      console.log(alias.count, ns === hoisted);
    }
    main();
  `],
  ["global promise and namespace aliases", `
    const pending = import("./module.ts");
    const another = pending;
    const ns = await another;
    const alias = ns;
    alias.bump();
    console.log(ns.count, ns === alias);
    export {};
  `],
  ["direct then and an aliased promise", `
    import("./module.ts").then(ns => {
      const alias = ns;
      alias.bump();
      console.log(ns.count);
    });
    const pending = import("./module.ts");
    const alias = pending;
    alias.then(ns => { console.log(ns.count); });
  `],
] as const)("native literal import preserves handle routing for %s", (_name, source) => {
  const coverage = coverageOf(source);
  expect(coverage.preflightFailed).toBe(false);
  expect(coverage.diagnostics).toEqual([]);
  expect(coverage.backend).toBe("rust");
  expect(coverage.execution?.engine).toBe("none");
});

test("a computed import still requires an explicit supported runtime path", () => {
  const coverage = coverageOf(`
    const specifier: string = "./module.ts";
    async function main(): Promise<void> { await import(specifier); }
    main();
  `);
  expect(coverage.preflightFailed).toBe(false);
  expect(coverage.diagnostics.some(d => d.code === "SC2012" && d.message.includes("import()"))).toBe(true);
});


test.each([
  ["mutable object identity", "export const state = { count: 0 };", "identity"],
  ["typed index record", "export const state: Record<string, number> = { count: 0 };", "identity"],
  ["declared unknown index record", "export const state: { count: number; [key: string]: unknown } = { count: 0 };", "identity"],
  ["indexed record callback argument", "export function update(state: Record<string, unknown>): void { state.count = 1; }", "identity"],
  ["indexed record callback result", "export function state(): Record<string, unknown> { return { count: 0 }; }", "identity"],
  ["array identity", "export const values = [1, 2];", "identity"],
  ["namespace thenable", "export function then(): void {}", "thenable"],
  ["namespace JSON hook", "export function toJSON(): string { return \"custom\"; }", "coercion"],
  ["namespace coercion hook", "export function toString(): string { return \"custom\"; }", "coercion"],
  ["async object result", "export async function state() { return { count: 0 }; }", "identity"],
  ["async array result", "export async function state() { return [1, 2]; }", "identity"],
  ["async record argument", "export async function update(state: { count: number }): Promise<void> { state.count++; }", "identity"],
  ["callable object result", "export function state() { return { count: 0 }; }", "identity"],
] as const)("native import refuses unsupported %s explicitly", (_name, dependency, detail) => {
  const coverage = coverageOf(`async function main(): Promise<void> { await import("./module.ts"); } main();`, dependency);
  expect(coverage.preflightFailed).toBe(false);
  expect(coverage.diagnostics.some(d => d.code === "SC1090" && d.message.includes(detail))).toBe(true);
});


test("static namespace identity cannot silently become a record snapshot", () => {
  const coverage = coverageOf(`
    import * as staticNamespace from "./module.ts";
    async function main(): Promise<void> {
      const dynamicNamespace = await import("./module.ts");
      console.log(staticNamespace === dynamicNamespace);
    }
    main();
  `, "export const count = 1;");
  expect(coverage.preflightFailed).toBe(false);
  expect(coverage.diagnostics.some(d => d.code === "SC1013" && d.message.includes("shared namespace"))).toBe(true);
});

test.each([
  `function read(ns: { count: number }): void { console.log(ns.count); }
   async function main(): Promise<void> { read(await import("./module.ts")); } main();`,
  `async function load(): Promise<{count:number}> { return await import("./module.ts"); } load();`,
  `function read(ns: {count:number}): void { console.log(ns.count); }
   async function main(): Promise<void> { const ns = await import("./module.ts"); read(ns as {count:number}); } main();`,
])("native namespaces cannot silently copy into a typed record: %s", source => {
  const coverage = coverageOf(source);
  expect(coverage.preflightFailed).toBe(false);
  expect(coverage.diagnostics.some(d => d.code === "SC1090" && d.message.includes("namespace"))).toBe(true);
});
