import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { runFileStdio } from "../../../tests/harness/file-stdio.js";
import { primaryOracleExecutable } from "../../../tests/harness/node-matrix.js";
import { compile, NODE_COMPAT_MATRIX } from "../src/index.js";

for (const optimization of ["dev", "release"] as const) test.each([
  ["3424-ts-class-factory-capture.ts", "first:base:7 second:base:9\nchanged changed:base:7\ntrue false true\n"],
  ["3425-ts-class-factory-order.ts", "first:base:7 second:base:9\ntrue true true\nfalse true false true\nchanged static:first second static:second\nreplaced:base:7 replaced:base:8 second:base:9 changed\nreplaced:base:7\nargument,unused:first,static:first,argument,unused:second,static:second,base,ctor:first,base,ctor:first,base,ctor:second\n"],
  ["3426-js-class-factory-capture.mjs", "local:first:base:7 other:second:base:9\nchanged changed:first:base:7\ntrue false true\nbase,base\n"],
  ["3427-ts-class-factory-callbacks.ts", "8 9 18 11 20\n10 11 18 13 20\nfalse true true false\nplain 42 \n"],
  ["3428-ts-mixin-statics-distinct.ts", "1 2 false 2\n9 2\n"],
  ["3429-ts-class-factory-constructor-errors.ts", "RangeError negative\n7 first true\nbase,base,first\n"],
  ["3430-js-class-factory-modules/main.mjs", "first:base:7 second:base:9\nchanged changed:base:7\ntrue false true\nbase,base\n"],
  ["3431-js-class-builder-capture.mjs", "first second 7\ntrue true\nfalse true false\nCommandRef false\ntrue false\n"],
  ["3432-js-class-builder-order.mjs", "true false\nchanged second\nreplaced second\ntrue false CommandRef\nargument:first,unused:first,builder:first,unused:second,builder:second,base:7,command:first,base:8,command:first,base:9,command:second,self,self,self,self,self\n"],
  ["3433-ts-class-builder-capture.ts", "first:7 second:9\nchanged:7 second true false\nfirst second builder:first,static:first,builder:second,static:second\n"],
  ["3434-js-class-builder-modules/main.mjs", "first:7 second:9 false\nchanged:7 second:9 CommandRef\n"],
])(`Rust ${optimization} preserves class factory captures: %s`, async (fixture, stdout) => {
  const entry = resolve("tests/corpus", fixture);
  const directory = await mkdtemp(join(tmpdir(), "scriptc-class-factory-"));
  try {
    const node = await runFileStdio(primaryOracleExecutable(NODE_COMPAT_MATRIX), [entry]);
    expect(node.code, node.stderr.toString()).toBe(0);
    expect(node.signal).toBeNull();
    expect(node.stdout.toString()).toBe(stdout);
    expect(node.stderr.toString()).toBe("");
    const result = await compile(entry, {
      backend: "rust", allowEngine: false, optimization,
      outDir: directory, outPath: join(directory, "program"),
    });
    expect(result.ok, result.ok ? undefined : JSON.stringify(result.diagnostics)).toBe(true);
    if (!result.ok) return;
    expect(result.execution).toEqual({ engine: "none", externalFfi: false });
    expect(result.runtimeFences).toEqual([]);
    const native = await runFileStdio(result.binaryPath, [], { ...process.env, SCRIPTC_RUST_HEAP_AUDIT: "1" });
    expect(native.code, native.stderr.toString()).toBe(node.code);
    expect(native.signal).toBe(node.signal);
    expect(native.stdout, native.stdout.toString()).toEqual(node.stdout);
    expect(native.stderr).toEqual(node.stderr);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test.each([
  ["repeated-call.ts", "class factory calls inside functions"],
  ["default-argument.ts", "class factories with default"],
  ["multi-declarator.ts", "class factories outside a single top-level"],
  ["base-tdz.mjs", "base class initializes"],
  ["reloadable/main.cjs", "reloadable CommonJS modules"],
  ["builder-tdz.mjs", "builder class initializes"],
  ["builder-repeat.mjs", "class factory calls inside functions"],
  ["builder-self-static.mjs", "self-referencing class factories with static initializers"],
  ["builder-effects.mjs", "extending computed expressions"],
  ["builder-frame.mjs", "extending computed expressions"],
])("retains an explicit class factory boundary: %s", async (fixture, message) => {
  const result = await compile(resolve("tests/fixtures/class-factory", fixture), {
    backend: "rust", allowEngine: false,
  });
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.diagnostics.some(diagnostic =>
    (diagnostic.code === "SC1090" || (diagnostic.code === "SC3003" && diagnostic.message.includes("[SC1090]"))) &&
    diagnostic.message.includes(message)),
    JSON.stringify(result.diagnostics)).toBe(true);
  expect(result.diagnostics.some(diagnostic => diagnostic.code === "SC9001")).toBe(false);
});
