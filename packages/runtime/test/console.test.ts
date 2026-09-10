import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const testDir = import.meta.dirname;

// The scheduling probe uses POSIX threads; the library harness also covers
// the actual emitted C/LLVM archives without formatter instrumentation.
test.skipIf(process.platform === "win32")("thread instances submit complete console lines", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-console-threads-"));
  try {
    const bin = join(dir, "probe");
    await execFileAsync("clang", [
      "-std=c11", "-O1", "-Wall", "-Wextra", "-pthread",
      "-DSCR_LIB", "-DSCR_THREAD_INSTANCES",
      ...(process.platform === "linux" ? ["-D_GNU_SOURCE"] : []),
      ...(process.env["SCRIPTC_SAN"] === "1" ? ["-fsanitize=address,undefined"] : []),
      "-o", bin, join(testDir, "test_console.c"),
      join(testDir, "../src/scr_number.c"), "-lm",
    ]);
    const { stdout, stderr } = await execFileAsync(bin, { timeout: 10_000 });
    const expected = Array.from({ length: 4 }, (_, id) =>
      Array.from({ length: 128 }, (_, i) => `${id} ${i} true -0`),
    ).flat().sort();
    for (const output of [stdout, stderr]) {
      expect(output.endsWith("\n")).toBe(true);
      expect(output.slice(0, -1).split("\n").sort()).toEqual(expected);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
