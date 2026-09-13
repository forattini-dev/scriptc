import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { analyze } from "../src/index.js";
import { fixture } from "../src/type-acquisition/fixtures.js";

function installed(runtimeVersion = "1.2.0", typesVersion = "1.0.9", extra: Record<string, string> = {}): string {
  return fixture({
    "node_modules/type-example/package.json": JSON.stringify({ name: "type-example", version: runtimeVersion, type: "module", main: "index.js" }),
    "node_modules/@types/type-example/package.json": JSON.stringify({ name: "@types/type-example", version: typesVersion, types: "index.d.ts" }),
    "node_modules/@types/type-example/index.d.ts": "export function answer(): string; export interface Row { value: number }\n",
    ...extra,
  });
}
function inspect(root: string) {
  return analyze(join(root, "main.ts"), { backend: "rust", allowEngine: false, npmStatic: "auto" }).coverage;
}

test("AUTO admits installed @types while preserving structural exports and runtime inference", () => {
  const root = installed("1.2.0", "1.0.9", {
    "main.ts": 'import { answer, type Row } from "type-example"; const row: Row = { value: answer() }; console.log(row.value);\n',
  });
  const coverage = inspect(root);
  expect(coverage.npmStatic).toEqual([{ package: "type-example", status: "static" }]);
  expect(coverage.diagnostics).toEqual([]);
});

test.each([["2.0.0", "1.9.0"], ["0.2.0", "0.3.0"]])("AUTO refuses incompatible declaration series %s / %s", (runtime, types) => {
  const coverage = inspect(installed(runtime, types));
  expect(coverage.npmStatic).toEqual([{ package: "type-example", status: "fallback", detail: expect.stringContaining("version series") }]);
});

test.each([["1.2.0-rc.1", "1.2.0"], ["1.2.0", "1.2.0-beta.1"]])("AUTO refuses unverified prerelease series %s / %s", (runtime, types) => {
  expect(inspect(installed(runtime, types)).npmStatic?.[0]?.detail).toContain("valid stable");
});

test("AUTO verifies the declaration manifest identity instead of trusting its directory", () => {
  const root = installed("1.2.0", "1.2.3", {
    "node_modules/@types/type-example/package.json": JSON.stringify({ name: "@types/unrelated", version: "1.2.3", types: "index.d.ts" }),
  });
  expect(inspect(root).npmStatic?.[0]?.detail).toContain("package identity");
});

test("a declaration-only value cannot become a native export", () => {
  const root = installed("1.2.0", "1.2.3", {
    "main.ts": 'import { imaginary } from "type-example"; console.log(imaginary());\n',
    "node_modules/@types/type-example/index.d.ts": "export function imaginary(): number;\n",
  });
  expect(inspect(root).npmStatic).toEqual([{ package: "type-example", status: "fallback", detail: expect.stringContaining("inferred export surface") }]);
});

test.each(["auto", "lib"] as const)("%s admits a versioned scoped declaration provider", (mode) => {
  const root = fixture({
    "main.ts": 'import { answer } from "@fixture/value"; console.log(answer);\n',
    "node_modules/@fixture/value/package.json": JSON.stringify({ name: "@fixture/value", version: "1.0.0", type: "module", main: "index.js" }),
    "node_modules/@fixture/value/index.js": "export const answer = 42;\n",
    "node_modules/@types/fixture__value/package.json": JSON.stringify({ name: "@types/fixture__value", version: "1.0.1", types: "index.d.ts" }),
    "node_modules/@types/fixture__value/index.d.ts": "export const answer: number;\n",
  });
  const { coverage } = analyze(join(root, "main.ts"), { backend: "rust", allowEngine: false, npmStatic: mode });
  expect(coverage.npmStatic).toEqual([{ package: "@fixture/value", status: "static" }]);
  expect(coverage.diagnostics).toEqual([]);
});

test("exact third-party subpaths retain separate structural declarations", () => {
  const root = installed("1.2.0", "1.2.3", {
    "main.ts": 'import { answer, type Row } from "type-example/number"; import { label, type Row as Label } from "type-example/label"; const row: Row = { value: answer() }; const text: Label = { value: label() }; console.log(row.value, text.value);\n',
    "node_modules/type-example/package.json": JSON.stringify({ name: "type-example", version: "1.2.0", type: "module", exports: { "./number": "./index.js", "./label": "./label.js" } }),
    "node_modules/type-example/label.js": 'export function label() { return "native"; }\n',
    "node_modules/@types/type-example/number.d.ts": "export function answer(): number; export interface Row { value: number }\n",
    "node_modules/@types/type-example/label.d.ts": "export function label(): string; export interface Row { value: string }\n",
  });
  expect(inspect(root).diagnostics).toEqual([]);
  expect(inspect(root).npmStatic).toEqual([{ package: "type-example", status: "static" }]);
});

test("different declaration subpaths for the same runtime stay ambiguous", () => {
  const root = installed("1.2.0", "1.2.3", {
    "main.ts": 'import { answer, type Row } from "type-example/number"; import type { Row as Label } from "type-example/label"; const row: Row = { value: answer() }; const text: Label = { value: "native" }; console.log(row.value, text.value);\n',
    "node_modules/type-example/package.json": JSON.stringify({ name: "type-example", version: "1.2.0", type: "module", exports: { "./number": "./index.js", "./label": "./index.js" } }),
    "node_modules/@types/type-example/number.d.ts": "export function answer(): number; export interface Row { value: number }\n",
    "node_modules/@types/type-example/label.d.ts": "export interface Row { value: string }\n",
  });
  expect(inspect(root).npmStatic?.[0]?.status).toBe("fallback");
});

test("AUTO checks every reached installation before opting in a whole package name", () => {
  const root = installed("1.2.0", "1.2.3", {
    "main.ts": 'import { answer } from "type-example"; import { other } from "./nested/other.js"; console.log(answer(), other);\n',
    "nested/other.ts": 'import { answer } from "type-example"; export const other = answer();\n',
    "nested/node_modules/type-example/package.json": JSON.stringify({ name: "type-example", version: "2.0.0", type: "module", main: "index.js" }),
    "nested/node_modules/type-example/index.js": "export function answer() { return 43; }\n",
    "nested/node_modules/@types/type-example/package.json": JSON.stringify({ name: "@types/type-example", version: "1.2.3", types: "index.d.ts" }),
    "nested/node_modules/@types/type-example/index.d.ts": "export function answer(): number;\n",
  });
  expect(inspect(root).npmStatic).toEqual([{ package: "type-example", status: "fallback", detail: expect.stringContaining("version series") }]);
  writeFileSync(join(root, "nested/node_modules/@types/type-example/package.json"), JSON.stringify({ name: "@types/type-example", version: "2.0.1", types: "index.d.ts" }));
  expect(inspect(root).npmStatic).toEqual([{ package: "type-example", status: "static" }]);
  expect(inspect(root).diagnostics).toEqual([]);
});

test("declarations cannot admit an absent runtime subpath", () => {
  const root = installed("1.2.0", "1.2.3", {
    "main.ts": 'import { answer } from "type-example/absent"; console.log(answer());\n',
    "node_modules/type-example/package.json": JSON.stringify({ name: "type-example", version: "1.2.0", type: "module", exports: { ".": "./index.js" } }),
    "node_modules/@types/type-example/absent.d.ts": "export function answer(): number;\n",
  });
  const coverage = inspect(root);
  expect(coverage.npmStatic?.some(s => s.status === "static")).toBe(false);
  expect(coverage.diagnostics.length).toBeGreaterThan(0);
});

test("AUTO refreshes installed declaration versions between analyses", () => {
  const root = installed();
  expect(inspect(root).npmStatic).toEqual([{ package: "type-example", status: "static" }]);
  writeFileSync(join(root, "node_modules/@types/type-example/package.json"), JSON.stringify({ name: "@types/type-example", version: "2.0.0", types: "index.d.ts" }));
  expect(inspect(root).npmStatic?.[0]?.status).toBe("fallback");
});
