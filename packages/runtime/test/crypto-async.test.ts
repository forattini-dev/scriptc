import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";

const execFileAsync = promisify(execFile);

test("callback crypto unit compiles against the shared runtime header", async () => {
  const srcDir = join(import.meta.dirname, "../src");
  const { stdout, stderr } = await execFileAsync("clang", [
    "-std=c11", "-fsyntax-only",
    "-Werror=implicit-function-declaration", "-Werror=int-conversion",
    ...(process.platform === "linux" ? ["-D_GNU_SOURCE"] : []),
    "-I", srcDir, join(srcDir, "scr_crypto_async.c"),
  ]);
  expect(stdout).toBe("");
  expect(stderr).toBe("");
});
