import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { nodeOracleExecutable } from "../../../tests/harness/oracle-environment.js";
import { compile } from "../src/index.js";

const execFileAsync = promisify(execFile);

test("static backends honor String.prototype.startsWith position", async () => {
  const fixture = resolve("tests/corpus/2826-string-starts-with-position.ts");
  const node = await execFileAsync(nodeOracleExecutable(), [fixture]);
  expect(node.stdout).toBe("true\n");

  for (const backend of ["c", "llvm", "rust"] as const) {
    const dir = await mkdtemp(join(tmpdir(), `scriptc-${backend}-string-starts-with-`));
    const result = await compile(fixture, {
      outDir: dir,
      outPath: join(dir, "program"),
      backend,
      optimization: "dev",
    });
    expect(
      result.ok,
      result.ok ? backend : result.diagnostics.map((diagnostic) => diagnostic.message).join("; "),
    ).toBe(true);
    if (!result.ok) continue;
    const native = await execFileAsync(result.binaryPath, [], {
      env: { ...process.env, SCRIPTC_RUST_HEAP_AUDIT: "1" },
    });
    expect(native.stdout, backend).toBe(node.stdout);
    expect(native.stderr, backend).toBe(node.stderr);
  }
});
