import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

interface Outcome {
  stdout: string;
  exitCode: number;
}

function runToExit(file: string, env: NodeJS.ProcessEnv = process.env): Promise<Outcome> {
  return new Promise((resolveRun) => {
    execFile(file, { encoding: "utf8", env }, (error, stdout) => {
      resolveRun({ stdout, exitCode: error && typeof error.code === "number" ? error.code : 0 });
    });
  });
}
import { compile } from "../src/index.js";

/* The "bun" module's node:url re-exports (bun-types' ambient): the
 * redcode authoring imports `pathToFileURL` from "bun" — a named-only
 * import whose every binding sits in the alias table lowers exactly like
 * the node:url import, no edge and no load (Node refuses the bare
 * specifier at its own resolution, so the compiled binary must never
 * emit one). Other "bun" surface keeps its fence. Node has no oracle for
 * the "bun" specifier — the goldens are the program's own semantics
 * (cross-checked against node:url's answers). */

test.each(["rust", "c"] as const)("bun module url re-exports lower as node:url (%s)", async (backend) => {
  const fixture = resolve("packages/compiler/test/fixtures/bun-module/src/main.ts");
  const dir = await mkdtemp(join(tmpdir(), `scriptc-bun-module-${backend}-`));
  const result = await compile(fixture, {
    outDir: dir,
    outPath: join(dir, "program"),
    backend,
    optimization: "dev",
  });
  expect(
    result.ok,
    result.ok ? fixture : result.diagnostics.map((diagnostic) => diagnostic.message).join("; "),
  ).toBe(true);
  if (!result.ok) return;
  const binary = await runToExit(result.binaryPath, [], { ...process.env, SCRIPTC_RUST_HEAP_AUDIT: "1" });
  expect(binary.exitCode).toBe(0);
  expect(binary.stdout).toBe("true true\ntrue\ntrue\n");
});

/* Other "bun" members are Bun runtime APIs with no compiled counterpart
 * (redcode's TUI runtime imports `plugin`, a module-loader hook). Under
 * --target bun they trap at their use sites like bun:sqlite/bun:ffi, so
 * the program builds and a mixed import keeps its url re-exports native;
 * any other target keeps the import-level fence. */
test("--target bun traps other bun module members at their use sites (rust)", async () => {
  const fixture = resolve("packages/compiler/test/fixtures/bun-module/src/trap.ts");
  const dir = await mkdtemp(join(tmpdir(), "scriptc-bun-module-trap-"));
  const result = await compile(fixture, {
    outDir: dir,
    outPath: join(dir, "program"),
    backend: "rust",
    target: "bun",
    optimization: "dev",
  });
  expect(
    result.ok,
    result.ok ? fixture : result.diagnostics.map((diagnostic) => diagnostic.message).join("; "),
  ).toBe(true);
  if (!result.ok) return;
  const binary = await runToExit(result.binaryPath);
  expect(binary.exitCode).toBe(0);
  expect(binary.stdout).toBe(
    "true\nthe 'plugin' of 'bun' is not available in a compiled binary (requires the Bun runtime)\nafter\n",
  );
});

test("a Node target keeps the bun module fence for non-url members", async () => {
  const fixture = resolve("packages/compiler/test/fixtures/bun-module/src/trap.ts");
  const dir = await mkdtemp(join(tmpdir(), "scriptc-bun-module-node-"));
  const result = await compile(fixture, {
    outDir: dir,
    outPath: join(dir, "program"),
    backend: "rust",
    target: "node24",
    optimization: "dev",
  });
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(
    result.diagnostics.some((diagnostic) => diagnostic.code === "SC1010" && diagnostic.message.includes("--target bun")),
    result.diagnostics.map((diagnostic) => `${diagnostic.code} ${diagnostic.message}`).join("; "),
  ).toBe(true);
});
