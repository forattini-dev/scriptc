import { join } from "node:path";
import { expect, test } from "vitest";
import { fixture } from "../src/type-acquisition/fixtures.js";
import { analyze } from "../src/index.js";

function diagnostics(source: string, entry: string) {
  const root = fixture({
    "main.ts": entry,
    "node_modules/alias-example/package.json": '{"name":"alias-example","version":"1.0.0","type":"module","main":"index.js"}',
    "node_modules/alias-example/index.js": source,
  });
  return analyze(join(root, "main.ts"), { backend: "rust", allowEngine: false, npmStatic: "auto" }).coverage;
}

test("implicit JS aliases cannot specialize against a binding that gets reassigned", () => {
  const coverage = diagnostics(`
function first(value) { return String(value); }
function second(value) { return "second:" + value; }
let alias = first;
alias = second;
export { alias };
`, "import { alias } from 'alias-example'; console.log(alias(7));");
  expect(coverage.diagnostics.some(d => d.message.includes("reassigned bindings"))).toBe(true);
});

test("a JSDoc function annotation keeps its concrete argument contract", () => {
  const coverage = diagnostics(`
function identity(value) { return value; }
/** @type {(value: string) => string} */
export const pinned = identity;
`, "import { pinned } from 'alias-example'; console.log(pinned(7));");
  expect(coverage.preflightFailed).toBe(true);
  expect(coverage.diagnostics.some(d => d.code === "SC0001")).toBe(true);
});
