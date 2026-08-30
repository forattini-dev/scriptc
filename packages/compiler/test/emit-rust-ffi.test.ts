import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

const execFileAsync = promisify(execFile);

test("Rust executables call manifest-bound native value functions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-rust-ffi-scalar-"));
  const nativeSource = join(dir, "native.c");
  const nativeObject = join(dir, "native.o");
  const nativeArchive = join(dir, "libnative.a");
  const profilePath = join(dir, "profile.json");
  const entryPath = join(dir, "main.ts");
  const outPath = join(dir, "program");

  await writeFile(nativeSource, [
    "#include <stddef.h>",
    "double sf_scale(double value) { return value * 2.0; }",
    "unsigned char sf_invert(unsigned char value) { return value ? 0 : 1; }",
    "unsigned char sf_u8(unsigned char value) { return value; }",
    "unsigned int sf_u32(unsigned int value) { return value; }",
    "int sf_i32(int value) { return value; }",
    "static double last_note;",
    "void sf_note(double value) { last_note = value; }",
    "double sf_last_note(void) { return last_note; }",
    "double sf_text_sum(const unsigned char *data, size_t len) {",
    "  double sum = 0;",
    "  for (size_t i = 0; i < len; i++) sum += data[i];",
    "  return sum;",
    "}",
    "double sf_bytes_sum(const unsigned char *data, size_t len) {",
    "  double sum = 0;",
    "  for (size_t i = 0; i < len; i++) sum += data[i];",
    "  return sum;",
    "}",
    "typedef double (*sf_apply_cb)(double value);",
    "double sf_apply(sf_apply_cb callback, double value) { return callback(value); }",
    "typedef double (*sf_apply_ctx_cb)(double value, void *context);",
    "double sf_apply_ctx(sf_apply_ctx_cb callback, double value, void *context) {",
    "  return context == NULL ? -1 : callback(value, context);",
    "}",
    "",
  ].join("\n"));
  await execFileAsync("clang", ["-std=c11", "-O2", "-c", nativeSource, "-o", nativeObject]);
  await execFileAsync("ar", ["rcs", nativeArchive, nativeObject]);
  await writeFile(profilePath, JSON.stringify({
    ffi_format: 2,
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
    }, {
      name: "nativeTextSum",
      symbol: "sf_text_sum",
      params: ["string"],
      returns: "f64",
    }, {
      name: "nativeBytesSum",
      symbol: "sf_bytes_sum",
      params: ["bytes"],
      returns: "f64",
    }, {
      name: "nativeApply",
      symbol: "sf_apply",
      params: [{
        callback: {
          id: "apply",
          params: ["f64"],
          returns: "f64",
          lifetime: "call",
        },
      }, "f64"],
      returns: "f64",
    }, {
      name: "nativeApplyContext",
      symbol: "sf_apply_ctx",
      params: [{
        callback: {
          id: "applyContext",
          params: ["f64", { context: "applyContext" }],
          returns: "f64",
          lifetime: "call",
        },
      }, "f64", { context: "applyContext" }],
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
    "declare function nativeTextSum(value: string): number;",
    "declare function nativeBytesSum(value: Uint8Array): number;",
    "declare function nativeApply(callback: (value: number) => number, value: number): number;",
    "declare function nativeApplyContext(callback: (value: number) => number, value: number): number;",
    "console.log(nativeScale(21));",
    "console.log(nativeInvert(false), nativeInvert(true));",
    "console.log(nativeU8(258), nativeU32(-1), nativeI32(4294967295));",
    "nativeNote(12.5);",
    "console.log(nativeLastNote());",
    "console.log(nativeTextSum(\"A\\0é\"));",
    "console.log(nativeBytesSum(new Uint8Array([1, 0, 255, 3])));",
    "const offset = 7;",
    "console.log(nativeApply((value) => value + offset, 5));",
    "console.log(nativeApplyContext((value) => value * offset, 6));",
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
  expect(run.stdout).toBe("42\ntrue false\n2 4294967295 -1\n12.5\n429\n259\n12\n42\n");
  expect(run.stderr).toBe("");
});
