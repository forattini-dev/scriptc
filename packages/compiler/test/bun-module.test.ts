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
