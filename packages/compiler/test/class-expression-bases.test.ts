import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { analyze } from "../src/index.js";

function inspect(source: string) {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-class-base-"));
  const entry = join(dir, "main.mjs");
  writeFileSync(entry, source);
  try {
    return analyze(entry, { backend: "rust", allowEngine: false }).coverage;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test.each(["const", "let", "var"])("a stable %s class-expression base lowers without an engine", (binding) => {
  const coverage = inspect(`
    ${binding} Base = class extends Error {};
    var Derived = class extends Base {};
    console.log(new Derived("message").message);
  `);
  expect(coverage.preflightFailed).toBe(false);
  expect(coverage.diagnostics).toEqual([]);
  expect(coverage.stats.statementsFailed).toBe(0);
  expect(coverage.stats.statementsIsland).toBe(0);
});

test.each([
  ["plain assignment", "Base = Replacement;"],
  ["assignment in a closure", "function change() { Base = Replacement; } change();"],
  ["destructuring assignment", "[Base] = [Replacement];"],
  ["object destructuring assignment", "({ value: Base } = { value: Replacement });"],
  ["loop assignment", "for (Base of [Replacement]) {}"],
  ["redeclaration", "var Base = Replacement;"],
])("a class base with %s retains the native refusal", (_, write) => {
  const coverage = inspect(`
    var Base = class extends Error {};
    var Replacement = class extends Error {};
    ${write}
    var Derived = class extends Base {};
    console.log(new Derived("message").message);
  `);
  expect(coverage.preflightFailed).toBe(false);
  expect(coverage.diagnostics.some((d) => d.message.includes("extending classes not declared"))).toBe(true);
  expect(coverage.stats.statementsFailed).toBeGreaterThan(0);
  expect(coverage.stats.statementsIsland).toBe(0);
});

test("a class expression cannot extend a var initialized later", () => {
  const coverage = inspect(`
    var Derived = class extends Base {};
    var Base = class extends Error {};
    console.log(new Derived("message").message);
  `);
  expect(coverage.diagnostics.length).toBeGreaterThan(0);
  expect(coverage.stats.statementsIsland).toBe(0);
});

test("a mutable alias to a declared class retains the general class-value boundary", () => {
  const coverage = inspect(`
    class Base { static count = 1; }
    class Child extends Base {}
    let Alias = Base;
    Alias.count = 2;
  `);
  expect(coverage.diagnostics.some((d) => d.message.includes("assigning the static 'count' through a class value"))).toBe(true);
});

test("static reads shadowed by a subclass retain their existing refusal", () => {
  const coverage = inspect(`
    var Base = class { static count = 1; };
    var Child = class extends Base { static count = 2; };
    console.log(Base.count, Child.count);
  `);
  expect(coverage.diagnostics.some((d) => d.message.includes("reading the static member 'count' through a class value"))).toBe(true);
});
