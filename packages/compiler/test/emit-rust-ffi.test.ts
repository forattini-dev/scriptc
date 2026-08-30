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
    "#include <stdint.h>",
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
    "double sf_combine(sf_apply_cb left, sf_apply_cb right, double value) {",
    "  return left(value) + right(value);",
    "}",
    "typedef double (*sf_apply_ctx_cb)(double value, void *context);",
    "double sf_apply_ctx(sf_apply_ctx_cb callback, double value, void *context) {",
    "  return context == NULL ? -1 : callback(value, context);",
    "}",
    "typedef uint32_t (*sf_mix_cb)(uint8_t truth, uint8_t byte, uint32_t wide,",
    "                              int32_t signed_value, double fraction, void *context);",
    "uint32_t sf_mix(sf_mix_cb callback, void *context) {",
    "  return context == NULL ? 0 : callback(2, 255, 4000000000u, -7, 0.5, context);",
    "}",
    "typedef void (*sf_spans_cb)(const uint8_t *text, size_t text_len,",
    "                            const uint8_t *bytes, size_t bytes_len, void *context);",
    "void sf_spans(sf_spans_cb callback, void *context) {",
    "  uint8_t text[] = {'A', 0, 'B', 0xc3, 0xa9};",
    "  uint8_t bytes[] = {0, 255, 1};",
    "  callback(text, sizeof text, bytes, sizeof bytes, context);",
    "  for (size_t i = 0; i < sizeof text; i++) text[i] = 'x';",
    "  for (size_t i = 0; i < sizeof bytes; i++) bytes[i] = 42;",
    "  callback(NULL, 0, NULL, 0, context);",
    "}",
    "typedef void (*sf_cstring_cb)(const char *value, void *context);",
    "void sf_cstring_throw(sf_cstring_cb callback, void *context) {",
    "  callback(\"materialized\", context);",
    "  callback(\"skipped\", context);",
    "}",
    "typedef void (*sf_retained_cb)(double value, void *context);",
    "static sf_retained_cb retained_callback;",
    "static void *retained_context;",
    "void sf_retained_add(sf_retained_cb callback, void *context) {",
    "  retained_callback = callback; retained_context = context;",
    "}",
    "void sf_retained_pump(double value) {",
    "  if (retained_callback != NULL) retained_callback(value, retained_context);",
    "}",
    "void sf_retained_remove(sf_retained_cb callback, void *context) {",
    "  if (retained_callback == callback && retained_context == context) {",
    "    retained_callback = NULL; retained_context = NULL;",
    "  }",
    "}",
    "typedef void (*sf_retained_raw_cb)(double value);",
    "static sf_retained_raw_cb retained_raw_callback;",
    "void sf_retained_raw_set(sf_retained_raw_cb callback) { retained_raw_callback = callback; }",
    "void sf_retained_raw_pump(double value) {",
    "  if (retained_raw_callback != NULL) retained_raw_callback(value);",
    "}",
    "void sf_retained_raw_remove(sf_retained_raw_cb callback) {",
    "  if (retained_raw_callback == callback) retained_raw_callback = NULL;",
    "}",
    "void sf_retained_raw_set_flush(sf_retained_raw_cb callback) {",
    "  if (retained_raw_callback != NULL) retained_raw_callback(-1);",
    "  retained_raw_callback = callback;",
    "}",
    "void sf_retained_raw_flush_remove(sf_retained_raw_cb callback) {",
    "  sf_retained_raw_remove(callback);",
    "}",
    "",
  ].join("\n"));
  await execFileAsync("clang", ["-std=c11", "-O2", "-c", nativeSource, "-o", nativeObject]);
  await execFileAsync("ar", ["rcs", nativeArchive, nativeObject]);
  await writeFile(profilePath, JSON.stringify({
    ffi_format: 4,
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
      name: "nativeCombine",
      symbol: "sf_combine",
      params: [{
        callback: { id: "left", params: ["f64"], returns: "f64", lifetime: "call" },
      }, {
        callback: { id: "right", params: ["f64"], returns: "f64", lifetime: "call" },
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
    }, {
      name: "nativeCallbackMix",
      symbol: "sf_mix",
      params: [{
        callback: {
          id: "mix",
          params: ["bool", "u8", "u32", "i32", "f64", { context: "mix" }],
          returns: "u32",
          lifetime: "call",
        },
      }, { context: "mix" }],
      returns: "u32",
    }, {
      name: "nativeCallbackSpans",
      symbol: "sf_spans",
      params: [{
        callback: {
          id: "spans",
          params: ["string", "bytes", { context: "spans" }],
          returns: "void",
          lifetime: "call",
        },
      }, { context: "spans" }],
      returns: "void",
    }, {
      name: "nativeCallbackStringThrow",
      symbol: "sf_cstring_throw",
      params: [{
        callback: {
          id: "cstringThrow",
          params: ["cstring", { context: "cstringThrow" }],
          returns: "void",
          lifetime: "call",
        },
      }, { context: "cstringThrow" }],
      returns: "void",
    }, {
      name: "nativeRetainedAdd",
      symbol: "sf_retained_add",
      params: [{
        callback: {
          id: "tick",
          params: ["f64", { context: "tick" }],
          returns: "void",
          lifetime: "retained",
        },
      }, { context: "tick" }],
      returns: "void",
    }, {
      name: "nativeRetainedPump",
      symbol: "sf_retained_pump",
      params: ["f64"],
      returns: "void",
    }, {
      name: "nativeRetainedRemove",
      symbol: "sf_retained_remove",
      params: [{
        callback: { release: "nativeRetainedAdd:tick" },
      }, { context: "nativeRetainedAdd:tick" }],
      returns: "void",
    }, {
      name: "nativeRetainedRawSet",
      symbol: "sf_retained_raw_set",
      params: [{
        callback: {
          id: "raw",
          params: ["f64"],
          returns: "void",
          lifetime: "retained",
        },
      }],
      returns: "void",
    }, {
      name: "nativeRetainedRawPump",
      symbol: "sf_retained_raw_pump",
      params: ["f64"],
      returns: "void",
    }, {
      name: "nativeRetainedRawRemove",
      symbol: "sf_retained_raw_remove",
      params: [{ callback: { release: "nativeRetainedRawSet:raw" } }],
      returns: "void",
    }, {
      name: "nativeRetainedRawSetFlush",
      symbol: "sf_retained_raw_set_flush",
      params: [{
        callback: {
          id: "raw",
          params: ["f64"],
          returns: "void",
          lifetime: "retained",
        },
      }],
      returns: "void",
    }, {
      name: "nativeRetainedRawFlushRemove",
      symbol: "sf_retained_raw_flush_remove",
      params: [{ callback: { release: "nativeRetainedRawSetFlush:raw" } }],
      returns: "void",
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
    "declare function nativeCombine(left: (value: number) => number, right: (value: number) => number, value: number): number;",
    "declare function nativeApplyContext(callback: (value: number) => number, value: number): number;",
    "declare function nativeCallbackMix(callback: (truth: boolean, byte: number, wide: number, signed: number, fraction: number) => number): number;",
    "declare function nativeCallbackSpans(callback: (text: string, bytes: Uint8Array) => void): void;",
    "declare function nativeCallbackStringThrow(callback: (value: string) => void): void;",
    "declare function nativeRetainedAdd(callback: (value: number) => void): void;",
    "declare function nativeRetainedPump(value: number): void;",
    "declare function nativeRetainedRemove(callback: (value: number) => void): void;",
    "declare function nativeRetainedRawSet(callback: (value: number) => void): void;",
    "declare function nativeRetainedRawPump(value: number): void;",
    "declare function nativeRetainedRawRemove(callback: (value: number) => void): void;",
    "declare function nativeRetainedRawSetFlush(callback: (value: number) => void): void;",
    "declare function nativeRetainedRawFlushRemove(callback: (value: number) => void): void;",
    "console.log(nativeScale(21));",
    "console.log(nativeInvert(false), nativeInvert(true));",
    "console.log(nativeU8(258), nativeU32(-1), nativeI32(4294967295));",
    "nativeNote(12.5);",
    "console.log(nativeLastNote());",
    "console.log(nativeTextSum(\"A\\0é\"));",
    "console.log(nativeBytesSum(new Uint8Array([1, 0, 255, 3])));",
    "const offset = 7;",
    "console.log(nativeApply((value) => value + offset, 5));",
    "console.log(nativeCombine((value) => value + 3, (value) => value * 4, 5));",
    "console.log(nativeApplyContext((value) => value * offset, 6));",
    "try {",
    "  nativeApply(() => { throw new Error('ffi callback boom'); }, 1);",
    "} catch (error) {",
    "  console.log('caught', (error as Error).message);",
    "}",
    "const retainedOffset = 10;",
    "const retainedCallback = (value: number) => {",
    "  console.log('retained', value + retainedOffset);",
    "  throw new Error(`retained boom ${value}`);",
    "};",
    "nativeRetainedAdd(retainedCallback);",
    "try { nativeRetainedPump(2); }",
    "catch (error) { console.log('caught', (error as Error).message); }",
    "nativeRetainedRemove(retainedCallback);",
    "nativeRetainedPump(3);",
    "console.log('retained released');",
    "const rawOffset = 5;",
    "const rawCallback = (value: number) => console.log('raw', value + rawOffset);",
    "nativeRetainedRawSet(rawCallback);",
    "nativeRetainedRawPump(1);",
    "nativeRetainedRawRemove(rawCallback);",
    "nativeRetainedRawPump(2);",
    "console.log('raw released');",
    "const flushEvents: string[] = [];",
    "const installFlush = (callback: (value: number) => void) => nativeRetainedRawSetFlush(callback);",
    "const flushFirst = (value: number) => { flushEvents.push(`first:${value}`); };",
    "const flushSecond = (value: number) => { flushEvents.push(`second:${value}`); };",
    "installFlush(flushFirst);",
    "nativeRetainedRawPump(11);",
    "installFlush(flushSecond);",
    "nativeRetainedRawPump(12);",
    "try { nativeRetainedRawFlushRemove(flushFirst); }",
    "catch { console.log('caught stale raw'); }",
    "nativeRetainedRawPump(13);",
    "nativeRetainedRawFlushRemove(flushSecond);",
    "console.log(flushEvents.join('|'));",
    "console.log(nativeCallbackMix((truth, byte, wide, signed, fraction) => {",
    "  console.log(truth, byte, wide, signed, fraction);",
    "  return -1;",
    "}));",
    "let copiedText = '';",
    "let copiedBytes: Uint8Array = new Uint8Array(0);",
    "nativeCallbackSpans((text, bytes) => {",
    "  if (text.length === 0) console.log('empty', text.length, bytes.length);",
    "  else { copiedText = text; copiedBytes = bytes; }",
    "});",
    "console.log(copiedText.length, copiedText.charCodeAt(1), copiedText.slice(2), copiedBytes.join(','));",
    "try {",
    "  nativeCallbackStringThrow((value) => { throw new Error(`cstring ${value}`); });",
    "} catch (error) {",
    "  console.log('caught', (error as Error).message);",
    "}",
    "try {",
    "  nativeApplyContext(() => { throw new Error('ffi context boom'); }, 1);",
    "} catch (error) {",
    "  console.log('caught', (error as Error).message);",
    "}",
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
  expect(run.stdout).toBe("42\ntrue false\n2 4294967295 -1\n12.5\n429\n259\n12\n28\n42\ncaught ffi callback boom\nretained 12\ncaught retained boom 2\nretained released\nraw 6\nraw released\ncaught stale raw\nfirst:11|first:-1|second:12|second:13\ntrue 255 4000000000 -7 0.5\n4294967295\nempty 0 0\n4 0 Bé 0,255,1\ncaught cstring materialized\ncaught ffi context boom\n");
  expect(run.stderr).toBe("");
});
