import { resolve } from "node:path";
import { expect, test } from "vitest";
import { analyze } from "../src/index.js";

const fixture = resolve("packages/compiler/test/fixtures/runtime-target/src/sqlite.ts");

/* The builtin-module table follows the --target: `bun:*` is a trapped
 * runtime module only where the binary reproduces Bun; a Node target has
 * no such module and says so at the import, naming the target that
 * would. */
test("bun:sqlite traps at use under --target bun", () => {
  // --dynamic: the ambient class maps to an island handle, so the use
  // sites are the trap's (a static build fences the value instead).
  const { coverage } = analyze(fixture, { target: "bun", dynamic: true });
  expect(coverage.preflightFailed).toBe(false);
  expect(coverage.diagnostics.filter((d) => d.code === "SC1010")).toEqual([]);
  expect((coverage.runtimeFences ?? []).map((d) => d.message).join("\n")).toContain("bun:sqlite");
});

test.each(["node24", "node26"] as const)("bun:sqlite is fenced at the import under --target %s", (target) => {
  const { coverage } = analyze(fixture, { target });
  const fence = coverage.diagnostics.find((d) => d.code === "SC1010");
  expect(fence?.message).toContain("'bun:sqlite' module (a Bun runtime module — compile with --target bun");
});
