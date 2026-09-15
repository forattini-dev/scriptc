import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

/* Static bun:sqlite under --target bun: Database and Statement are native
 * handles over the runtime's SQLite engine (no embedded engine), covering
 * the shapes Redcode's database layer uses — options objects, db.run with
 * an array of bindings, cached query() statements, prepare(), positional,
 * named and spread bindings, get/all/values, safeIntegers, serialize,
 * SQLiteError, and idempotent close. The golden is Bun 1.4.1's output for
 * the same program. */
test("--target bun lowers bun:sqlite statically (rust)", async () => {
  const fixture = resolve("packages/compiler/test/fixtures/bun-sqlite-static/src/main.ts");
  const dir = await mkdtemp(join(tmpdir(), "scriptc-bun-sqlite-static-"));
  const result = await compile(fixture, {
    outDir: dir,
    outPath: join(dir, "program"),
    backend: "rust",
    target: "bun",
    optimization: "dev",
  });
  expect(
    result.ok,
    result.ok ? fixture : result.diagnostics.map((diagnostic) => `${diagnostic.code} ${diagnostic.message}`).join("; "),
  ).toBe(true);
  if (!result.ok) return;
  const run = await new Promise<{ stdout: string; stderr: string; code: number }>((done) => {
    execFile(result.binaryPath, { encoding: "utf8", env: { ...process.env, SCRIPTC_RUST_HEAP_AUDIT: "1" } }, (error, stdout, stderr) => {
      done({ stdout, stderr, code: error && typeof error.code === "number" ? error.code : 0 });
    });
  });
  expect(run.stderr).toBe("");
  expect(run.code).toBe(0);
  expect(run.stdout).toBe(
    [
      "0 0",
      "1 1",
      "1 2",
      '[{"id":1,"name":"a","n":1.5},{"id":2,"name":"b","n":2}]',
      '[[1,"a"],[2,"b"]]',
      '{"name":"b"}',
      "true",
      '{"name":"a"}',
      '[{"id":2}]',
      "bigint",
      "number",
      "true",
      "SQLiteError UNIQUE constraint failed: t.id",
      "closed",
      "",
    ].join("\n"),
  );
});
