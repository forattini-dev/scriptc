import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

const execFileAsync = promisify(execFile);

test("Rust executables call a manifest-bound native f64 function", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-rust-ffi-scalar-"));
  const nativeSource = join(dir, "native.c");
  const nativeObject = join(dir, "native.o");
  const nativeArchive = join(dir, "libnative.a");
  const profilePath = join(dir, "profile.json");
  const entryPath = join(dir, "main.ts");
  const outPath = join(dir, "program");

  await writeFile(nativeSource, "double sf_scale(double value) { return value * 2.0; }\n");
  await execFileAsync("clang", ["-std=c11", "-O2", "-c", nativeSource, "-o", nativeObject]);
  await execFileAsync("ar", ["rcs", nativeArchive, nativeObject]);
  await writeFile(profilePath, JSON.stringify({
    ffi_format: 1,
    functions: [{
      name: "nativeScale",
      symbol: "sf_scale",
      params: ["f64"],
      returns: "f64",
    }],
    libraries: [nativeArchive],
    system_libraries: [],
  }));
  await writeFile(entryPath, [
    "declare function nativeScale(value: number): number;",
    "console.log(nativeScale(21));",
    "",
  ].join("\n"));

  const result = await compile(entryPath, {
    outDir: dir,
    outPath,
    backend: "rust",
    optimization: "dev",
    ffiProfilePath: profilePath,
  });
  expect(
    result.ok,
    result.ok ? undefined : result.diagnostics.map((diagnostic) => diagnostic.message).join("; "),
  ).toBe(true);
  if (!result.ok) return;

  expect(result.safetyProfile).toBe("rust+external-ffi");
  const run = await execFileAsync(result.binaryPath, [], { encoding: "utf8" });
  expect(run.stdout).toBe("42\n");
  expect(run.stderr).toBe("");
});
