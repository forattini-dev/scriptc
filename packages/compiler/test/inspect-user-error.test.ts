import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

/* The STACKLESS inspect of USER Error subclasses — the form Node renders
 * when the stack is empty (compiled binaries carry no stack; the
 * divergence is SEMANTICS.md's). The goldens below are Node's own
 * `Error.stackTraceLimit = 0` output, byte-for-byte: the bracket from
 * the live name/message slots (improveStack's declaration-name styling),
 * the own-property block from the static field types, the depth-gated
 * bare constructor name, and dispatch over base-typed values. */

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

const GOLDENS: Record<string, string> = {
  "rendering.ts": `[AppError: boom] { code: 'EAPP' }
[ 1, [AppError: boom] { code: 'EAPP' } ]
[DeepError: nested] { code: 'EDEEP', at: 'fs' }
[ [DeepError: nested] { code: 'EDEEP', at: 'fs' } ]
[Bare [Error]: plain]
[AppError: multi
line] {
  code: 'EML'
}
`,
  "dispatch.ts": `[AppError: boom] { code: 'EAPP' }
[DeepError: nested] { code: 'EDEEP', at: 'fs' }
[TypeError: native]
[Error: plain]
{ wrap: [Array] }
{ wrap: [ [DeepError] ] }
[AppError: boom] { code: 'EAPP' }
[ 1, [ 2, [AppError: boom] { code: 'EAPP' } ] ]
`,
};

test.each([
  ["rust", "rendering.ts"],
  ["rust", "dispatch.ts"],
  ["c", "rendering.ts"],
  ["c", "dispatch.ts"],
])("%s backend renders stackless user Error subclasses like Node: %s", async (backend, fixtureName) => {
  const fixture = resolve("packages/compiler/test/fixtures/inspect-user-error", fixtureName);
  const dir = await mkdtemp(join(tmpdir(), `scriptc-${backend}-inspect-user-error-`));
  const result = await compile(fixture, {
    outDir: dir,
    outPath: join(dir, "program"),
    backend,
    optimization: "dev",
  } as Parameters<typeof compile>[1]);
  expect(
    result.ok,
    result.ok ? fixture : result.diagnostics.map((diagnostic) => diagnostic.message).join("; "),
  ).toBe(true);
  if (!result.ok) return;
  const binary = await runToExit(result.binaryPath, [], { ...process.env, SCRIPTC_RUST_HEAP_AUDIT: "1" });
  expect(binary.exitCode).toBe(0);
  expect(binary.stdout).toBe(GOLDENS[fixtureName]);
});
