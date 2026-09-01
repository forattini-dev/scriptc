/* The C runtime's dynamic dispatcher (packages/runtime/src/scr_dyn_invoke.c)
 * against Node, over the same corpus programs the Rust dispatcher pins in
 * its emit-rust-dynamic-* siblings.
 *
 * Why this file exists: scr_dyn_invoke.c and the generated Rust dispatcher
 * are two independent implementations of one contract, and the Rust side is
 * where dynamic-method work usually lands. The C half's only coverage was
 * the differential corpus — the suite CI shards and a landing rarely runs
 * whole — so a run of Rust-only fixes (2b4491a1, 7dca8d6e, 740f553e,
 * f4555f00, 92fd6166, af20fcb6, 6058fc7a) added corpus programs EVERY lane
 * runs while teaching only one lane to pass them, and the C and LLVM lanes
 * (both link this runtime) went red unnoticed. These cases are cheap and
 * unsharded: a Rust-only dynamic fix fails here immediately. */
import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { nodeOracleExecutable } from "../../../tests/harness/oracle-environment.js";
import { compile } from "../src/index.js";

const execFileAsync = promisify(execFile);

async function expectCToMatchNode(fixtureName: string, expectedStdout: string): Promise<void> {
  const fixture = resolve(`tests/corpus/${fixtureName}`);
  const dir = await mkdtemp(join(tmpdir(), "scriptc-c-dyn-invoke-"));
  const result = await compile(fixture, {
    outDir: dir,
    outPath: join(dir, "program"),
    backend: "c",
    dynamic: true,
    optimization: "dev",
  });
  expect(
    result.ok,
    result.ok ? fixture : result.diagnostics.map((diagnostic) => diagnostic.message).join("; "),
  ).toBe(true);
  if (!result.ok) return;

  const [node, native] = await Promise.all([
    execFileAsync(nodeOracleExecutable(), [fixture]),
    execFileAsync(result.binaryPath, []),
  ]);
  // Node IS the expectation; the literal pins what that expectation is, so
  // a Node upgrade that moved it would fail loudly instead of silently
  // re-baselining both sides.
  expect(node.stdout).toBe(expectedStdout);
  expect(native.stdout).toBe(node.stdout);
  expect(native.stderr).toBe(node.stderr);
}

test("C dynamic String.prototype.indexOf honors position", async () => {
  await expectCToMatchNode("2817-dyn-string-indexof-position.cjs", "6\n");
});

test("C dynamic String.prototype.indexOf coerces its search value", async () => {
  await expectCToMatchNode("2818-dyn-string-indexof-coercion.cjs", "6\n");
});

test("C dynamic String.prototype.includes honors position", async () => {
  await expectCToMatchNode("2819-dyn-string-includes-position.cjs", "false\n");
});

test("C dynamic String.prototype.includes coerces its search value", async () => {
  await expectCToMatchNode("2820-dyn-string-includes-search-coercion.cjs", "true\n");
});

test("C dynamic String.prototype.includes treats a missing search as undefined", async () => {
  await expectCToMatchNode("2821-dyn-string-includes-missing-search.cjs", "true\n");
});

test("C dynamic String.prototype.lastIndexOf honors position", async () => {
  await expectCToMatchNode("2822-dyn-string-last-index-of-position.cjs", "2\n");
});

test("C dynamic String.prototype.lastIndexOf coerces its search value", async () => {
  await expectCToMatchNode("2823-dyn-string-last-index-of-search-coercion.cjs", "2\n");
});

// A missing position must read as +Infinity, not as the 0 every other
// index argument answers for a missing/NaN value.
test("C dynamic String.prototype.lastIndexOf treats a missing search as undefined", async () => {
  await expectCToMatchNode("2824-dyn-string-last-index-of-missing-search.cjs", "16\n");
});

test("C dynamic Array.prototype.toString joins with commas", async () => {
  await expectCToMatchNode("2814-dyn-array-tostring.cjs", "1,x,,2,3,\n");
});

test("C dynamic Array.prototype.toLocaleString localizes each element", async () => {
  await expectCToMatchNode("2816-dyn-array-tolocalestring.cjs", "1,000,x,true,,2,000,false\n");
});

test("C dynamic Number.prototype.toLocaleString formats en-US", async () => {
  await expectCToMatchNode("2815-dyn-number-tolocalestring.cjs", "1,234,567.891 -0\n");
});
