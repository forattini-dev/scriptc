import { execFile, execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const testDir = import.meta.dirname;
const wasiRunner = `const fs=require("node:fs"),{WASI}=require("node:wasi");
const p=process.argv[1],w=new WASI({version:"preview1",args:[p],returnOnExit:true});
const i=new WebAssembly.Instance(new WebAssembly.Module(fs.readFileSync(p)),w.getImportObject());
process.exitCode=w.start(i);`;

function hasZig(): boolean {
  try {
    execFileSync("zig", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

for (const target of ["host", "wasi"] as const) {
  test.skipIf(target === "wasi" && !hasZig())(`stable island allocator on ${target}`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "scriptc-island-alloc-"));
    try {
      const bin = join(dir, target === "wasi" ? "probe.wasm" : "probe");
      await execFileAsync(target === "wasi" ? "zig" : "clang", [
        ...(target === "wasi" ? ["cc", "-target", "wasm32-wasi"] : ["-fsanitize=address,undefined"]),
        "-std=c11", "-O1", "-UNDEBUG", "-Wall", "-Wextra", "-Werror",
        join(testDir, "test_island_alloc.c"), "-o", bin,
      ]);
      const run = target === "wasi"
        ? await execFileAsync(process.execPath, ["--no-warnings", "-e", wasiRunner, bin])
        : await execFileAsync(bin);
      expect(run.stdout).toBe("stable allocator checks passed\n");
      expect(run.stderr).toBe("");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}
