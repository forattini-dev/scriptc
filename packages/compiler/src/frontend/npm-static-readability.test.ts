import { expect, test } from "vitest";
import { looksUnminified } from "./npm-static-readability.js";

const compact = Array.from({ length: 80 }, (_, i) => `sink(value${i});`).join("");
test.each([
  ["template chunk before compact code", `const text = \`head\${value}tail\`;\nfunction run() {${compact}}\n`, false],
  ["nested template substitutions", `const text = \`head\${\`middle\${(() => {${compact}})()}tail\`}end\`;\n`, false],
  ["data chunks around a small substitution", `const text = \`${"x".repeat(4000)}\${value}${"y".repeat(4000)}\`;\nexport default text;\n`, true],
  ["computed keys keep calls", `const data = {[(() => {${compact}})()]: 1};\nexport default data;\n`, false],
  ["spread keeps calls", `const data = {...(() => {${compact}})()};\nexport default data;\n`, false],
  ["string data cannot hide following code", `const data = '${"x".repeat(4000)}';\nfunction run() {${compact}}\n`, false],
  ["regex syntax is not a comment", `const pattern = /https?:\\/\\/host(?:${"a|".repeat(1000)}z)/;\nexport function test(value) {\n return pattern.test(value);\n}\n`, true],
  ["blank lines do not dilute code", `${"\n".repeat(200)}function run() {${compact}}\n`, false],
  ["malformed literal cannot qualify", "const data = {broken: 'unterminated};\n", false],
] as const)("source readability: %s", (_name, source, expected) => {
  expect(looksUnminified(source, "entry.js")).toBe(expected);
});

test("executable TypeScript is parsed in its own source kind", () => {
  expect(looksUnminified("export function answer(value: number): number {\n return value + 1;\n}\n", "entry.ts")).toBe(true);
});
