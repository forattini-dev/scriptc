import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

const execFileAsync = promisify(execFile);

test("Rust executables call manifest-bound native scalar functions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-rust-ffi-scalar-"));
  const nativeSource = join(dir, "native.c");
  const nativeObject = join(dir, "native.o");
  const nativeArchive = join(dir, "libnative.a");
  const profilePath = join(dir, "profile.json");
  const entryPath = join(dir, "main.ts");
  const outPath = join(dir, "program");

  await writeFile(nativeSource, [
    "double sf_scale(double value) { return value * 2.0; }",
    "unsigned char sf_invert(unsigned char value) { return value ? 0 : 1; }",
    "unsigned char sf_u8(unsigned char value) { return value; }",
    "unsigned int sf_u32(unsigned int value) { return value; }",
    "int sf_i32(int value) { return value; }",
    "static double last_note;",
    "void sf_note(double value) { last_note = value; }",
    "double sf_last_note(void) { return last_note; }",
    "",
  ].join("\n"));
  await execFileAsync("clang", ["-std=c11", "-O2", "-c", nativeSource, "-o", nativeObject]);
  await execFileAsync("ar", ["rcs", nativeArchive, nativeObject]);
  await writeFile(profilePath, JSON.stringify({
    ffi_format: 1,
    functions: [{
      name: "nativeScale",
      symbol: "sf_scale",
      params: ["f64"],
      returns: "f64",
    }, {
      name: "nativeInvert",
      symbol: "sf_invert",
      params: ["bool"],
      returns: "bool",
    }, {
      name: "nativeU8",
      symbol: "sf_u8",
      params: ["u8"],
      returns: "u8",
    }, {
      name: "nativeU32",
      symbol: "sf_u32",
      params: ["u32"],
      returns: "u32",
    }, {
      name: "nativeI32",
      symbol: "sf_i32",
      params: ["i32"],
      returns: "i32",
    }, {
      name: "nativeNote",
      symbol: "sf_note",
      params: ["f64"],
      returns: "void",
    }, {
      name: "nativeLastNote",
      symbol: "sf_last_note",
      params: [],
      returns: "f64",
    }],
    libraries: [nativeArchive],
    system_libraries: [],
  }));
  await writeFile(entryPath, [
    "declare function nativeScale(value: number): number;",
    "declare function nativeInvert(value: boolean): boolean;",
    "declare function nativeU8(value: number): number;",
    "declare function nativeU32(value: number): number;",
    "declare function nativeI32(value: number): number;",
    "declare function nativeNote(value: number): void;",
    "declare function nativeLastNote(): number;",
    "console.log(nativeScale(21));",
    "console.log(nativeInvert(false), nativeInvert(true));",
    "console.log(nativeU8(258), nativeU32(-1), nativeI32(4294967295));",
    "nativeNote(12.5);",
    "console.log(nativeLastNote());",
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
  expect(run.stdout).toBe("42\ntrue false\n2 4294967295 -1\n12.5\n");
  expect(run.stderr).toBe("");
});
