import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { runFileStdio } from "../../../tests/harness/file-stdio.js";
import { primaryOracleExecutable } from "../../../tests/harness/node-matrix.js";
import { analyze, compile, NODE_COMPAT_MATRIX } from "../src/index.js";

for (const optimization of ["dev", "release"] as const) test.each([
  ["3435-js-async-method-lifecycle.mjs", "handler:start\nafter-call false false\nhandler:closed\nstop-pool\nlisteners\nafter-await true false\n"],
  ["3436-js-async-method-inherited.mjs", "before 0 0\nchild:1 base:1\nchild:2\n"],
  ["3437-js-async-method-rejections.mjs", "fail:start\nafter-call 1\nError closed\ndone 2\npromise-created\nError immediate\n"],
  ["3438-js-async-method-implicit.mjs", "42\ntext\ntrue\n3\n"],
  ["3439-js-async-method-deferred-family.mjs", "base child\nunrelated\nexact-base\n"],
  ["3440-js-async-method-modules/main.mjs", "before false 1 false\nafter true 1 false\n"],
])(`Rust ${optimization} preserves JavaScript async instance methods: %s`, async (fixture, stdout) => {
  const entry = resolve("tests/corpus", fixture);
  const directory = await mkdtemp(join(tmpdir(), "scriptc-js-async-method-"));
  try {
    const node = await runFileStdio(primaryOracleExecutable(NODE_COMPAT_MATRIX), [entry]);
    expect(node.code).toBe(0);
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
    expect(native.stdout).toEqual(node.stdout);
    expect(native.stderr).toEqual(node.stderr);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("JavaScript async generator methods retain their deferred call boundary", async () => {
  const directory = await mkdtemp(join(tmpdir(), "scriptc-js-async-generator-"));
  try {
    const entry = join(directory, "main.mjs");
    await writeFile(entry, "class Resource { async *read() { yield 1; } }\nnew Resource().read();\n");
    const { coverage } = analyze(entry, { backend: "rust", allowEngine: false });
    expect(coverage.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "SC3003", message: expect.stringContaining("method calls") }),
    ]));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test.each([
  ["async override", "async value() { return 1; }", "async value() { return 2; }"],
  ["sync override of async", "async value() { return 1; }", "value() { return 2; }"],
  ["async override of sync", "value() { return 1; }", "async value() { return 2; }"],
])("JavaScript async instance methods retain the %s refusal", async (_, base, derived) => {
  const directory = await mkdtemp(join(tmpdir(), "scriptc-js-async-override-"));
  try {
    const entry = join(directory, "main.mjs");
    await writeFile(entry, `// @ts-nocheck\nclass Base { ${base} }\nclass Derived extends Base { ${derived} }\nconst value = new Derived();\nawait value.value();\nawait new Base().value();\n`);
    const { coverage } = analyze(entry, { backend: "rust", allowEngine: false });
    expect(coverage.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "SC3003", message: expect.stringContaining("method calls") }),
    ]));
    expect(coverage.diagnostics.some(diagnostic => diagnostic.code === "SC9001")).toBe(false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("a reached unsupported async body still refuses rather than disappearing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "scriptc-js-async-reached-"));
  try {
    const entry = join(directory, "main.mjs");
    await writeFile(entry, 'class Resource { async unused() { eval("unsupported"); } }\nawait new Resource().unused();\n');
    const { coverage } = analyze(entry, { backend: "rust", allowEngine: false });
    expect(coverage.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "SC3003", message: expect.stringContaining("[SC2009]") }),
    ]));
    expect(coverage.diagnostics.some(diagnostic => diagnostic.code === "SC9001")).toBe(false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("a non-exact receiver cannot dispatch to a deferred async descendant", async () => {
  const directory = await mkdtemp(join(tmpdir(), "scriptc-js-async-virtual-"));
  try {
    const entry = join(directory, "main.mjs");
    await writeFile(entry, `class Base { value() { return Promise.resolve(1); } }
class Derived extends Base { async value() { return 2; } }
/** @param {Base} resource */
function read(resource) { return resource.value(); }
console.log(await read(new Derived()));
`);
    const { coverage } = analyze(entry, { backend: "rust", allowEngine: false });
    expect(coverage.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "SC3003", message: expect.stringContaining("deferred async override") }),
    ]));
    expect(coverage.diagnostics.some(diagnostic => diagnostic.code === "SC9001")).toBe(false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
