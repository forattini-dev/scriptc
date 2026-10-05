import { join } from "node:path";
import { expect, test } from "vitest";
import { analyze } from "../src/index.js";
import { fixture } from "../src/type-acquisition/fixtures.js";

test("AUTO discovers npm imports from relative lazy modules in admitted packages", () => {
  const root = fixture({
    "main.ts": "import { run } from 'outer'; console.log(await run());\n",
    "node_modules/outer/package.json": '{"name":"outer","type":"module","main":"index.js"}',
    "node_modules/outer/index.js": "export async function run() {\n const module = await import('./lazy.js');\n return module.answer();\n}\n",
    "node_modules/outer/lazy.js": "import { answer } from 'inner';\nexport { answer };\n",
    "node_modules/inner/package.json": '{"name":"inner","type":"module","main":"index.js"}',
    "node_modules/inner/index.js": "export function answer() {\n return 42;\n}\n",
  });
  const explicit = analyze(join(root, "main.ts"), { backend: "rust", allowEngine: false, npmStatic: ["outer", "inner"] }).coverage;
  expect(explicit.diagnostics).toEqual([]);
  expect(explicit.stats.statementsFailed).toBe(0);
  const { coverage } = analyze(join(root, "main.ts"), { backend: "rust", allowEngine: false, npmStatic: "auto" });
  expect(coverage.npmStatic).toEqual(expect.arrayContaining([
    { package: "outer", status: "static" }, { package: "inner", status: "static" },
  ]));
  expect(coverage.diagnostics).toEqual([]);
  expect(coverage.stats.statementsFailed).toBe(0);
});

test("AUTO does not admit npm packages referenced only by JSDoc", () => {
  const root = fixture({
    "main.ts": "import { answer } from 'outer'; console.log(answer());\n",
    "node_modules/outer/package.json": '{"name":"outer","type":"module","main":"index.js"}',
    "node_modules/outer/index.js": "/** @typedef {import('unused').Shape} Shape */\nexport function answer() {\n return 42;\n}\n",
    "node_modules/unused/package.json": '{"name":"unused","type":"module","main":"index.js"}',
    "node_modules/unused/index.js": "/** @typedef {{value: number}} Shape */\nexport const marker = 7;\n",
  });
  const { coverage } = analyze(join(root, "main.ts"), { backend: "rust", allowEngine: false, npmStatic: "auto" });
  expect(coverage.npmStatic).toEqual([{ package: "outer", status: "static" }]);
  expect(coverage.diagnostics).toEqual([]);
  expect(coverage.stats.statementsFailed).toBe(0);
});
