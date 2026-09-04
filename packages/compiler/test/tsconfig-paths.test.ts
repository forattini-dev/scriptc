import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

/* tsconfig "paths" aliases: the project's compile-time alias surface —
 * Bun resolves them at runtime, Node does not. The lowering rewrites the
 * aliased edge to the target FILE (the bundler stance), so the compiled
 * binary runs without any alias knowledge and the goldens below assert the
 * full surface: wildcard patterns, exact keys, target fallback lists, and
 * the module-order wiring (the aliased module's %init runs before the
 * importer reads its globals). Node has no oracle here — the goldens are
 * the program's own semantics. */

interface Outcome {
  stdout: string;
  exitCode: number;
}

function runToExit(file: string, args: string[], env: NodeJS.ProcessEnv = process.env): Promise<Outcome> {
  return new Promise((resolveRun) => {
    execFile(file, args, { encoding: "utf8", env }, (error, stdout) => {
      resolveRun({
        stdout,
        exitCode: error && typeof error.code === "number" ? error.code : 0,
      });
    });
  });
}

const GOLDEN = "hello paths exact-key 11\n";

test.each(["rust", "c"] as const)("tsconfig paths aliases lower as ordinary modules (%s)", async (backend) => {
  const fixture = resolve("packages/compiler/test/fixtures/tsconfig-paths/src/main.ts");
  const dir = await mkdtemp(join(tmpdir(), `scriptc-tsconfig-paths-${backend}-`));
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
  expect(binary.stdout).toBe(GOLDEN);
});

test("tsconfig paths with no answer keeps the honest refusal", async () => {
  const fixture = resolve("packages/compiler/test/fixtures/tsconfig-paths-refusal/src/main.ts");
  const result = await compile(fixture, {
    outDir: await mkdtemp(join(tmpdir(), "scriptc-tsconfig-paths-refusal-")),
    outPath: join(await mkdtemp(join(tmpdir(), "scriptc-tsconfig-paths-refusal-out-")), "program"),
    backend: "rust",
    optimization: "dev",
  });
  expect(result.ok).toBe(false);
  if (result.ok) return;
  const messages = result.diagnostics.map((diagnostic) => diagnostic.message).join("; ");
  expect(messages).toContain("nothing installed resolves it");
});