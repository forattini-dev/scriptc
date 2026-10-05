import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { runFileStdio } from "../../../tests/harness/file-stdio.js";
import { primaryOracleExecutable } from "../../../tests/harness/node-matrix.js";
import { analyze, compile, NODE_COMPAT_MATRIX } from "../src/index.js";

const cases = [
  ["3371-js-object-rest-super.js", "demo source 201 kept\nbucket,statusCode,extra,shared\nkept changed\ntrue\n"],
  ["3372-js-object-rest-order.js", "No such key: k [bucket:b] 409 false kept\nPlugin: p 409 kept\nNo such key: k [bucket:b] undefined false kept\nPlugin: p 500 kept\nNo such key: k [bucket:b] null false kept\nPlugin: p 500 kept\n2,10,renamed,tail,nested,absent,added\nb keep default during-default\ntrue false false\nchanged last 2 true\n"],
  ["3373-js-object-rest-nullish.js", "TypeError Cannot destructure 'source' as it is undefined.\nTypeError Cannot destructure property 'item' of 'source' as it is undefined.\nTypeError Cannot destructure 'source' as it is null.\nTypeError Cannot destructure property 'item' of 'source' as it is null.\n"],
] as const;

const differentialCases: Array<{ backend: "rust" | "llvm" | "c"; file: string; stdout: string }> = (["rust", "llvm", "c"] as const).flatMap(backend => cases.map(([file, stdout]) => ({ backend, file, stdout })));
differentialCases.push({ backend: "rust", file: "3374-js-object-rest-symbol.js", stdout: "secret undefined\nvisible\n" });
test.each(differentialCases)("$backend: $file matches Node with fresh shallow rest", async ({ backend, file, stdout }) => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-js-object-rest-"));
  try {
    const entry = resolve("tests/corpus", file);
    const result = await compile(entry, {
      backend, allowEngine: false, optimization: "dev",
      sanitize: backend !== "rust" && process.env["SCRIPTC_SAN"] === "1",
      outDir: dir, outPath: join(dir, "program"),
    });
    expect(result.ok, result.ok ? undefined : JSON.stringify(result.diagnostics)).toBe(true);
    if (!result.ok) return;
    expect(result.execution).toEqual({ engine: "none", externalFfi: false });
    expect(result.runtimeFences).toEqual([]);
    const [node, native] = await Promise.all([
      runFileStdio(primaryOracleExecutable(NODE_COMPAT_MATRIX), [entry]),
      runFileStdio(result.binaryPath, [], { ...process.env, SCRIPTC_RUST_HEAP_AUDIT: "1" }),
    ]);
    expect(node.code).toBe(0);
    expect(node.signal).toBe(null);
    expect(native.code, native.stderr.toString("utf8")).toBe(node.code);
    expect(native.signal).toBe(null);
    expect(node.stdout.toString("utf8")).toBe(stdout);
    expect(native.stdout.toString("utf8")).toBe(stdout);
    expect(native.stdout).toEqual(node.stdout);
    expect(native.stderr).toEqual(node.stderr);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test.each([
  { backend: "rust", file: "source-boundary.js" },
  { backend: "rust", file: "descriptor-boundary.js" },
  { backend: "rust", file: "class-boundary.js" },
  { backend: "llvm", file: "source-boundary.js" },
  { backend: "c", file: "source-boundary.js" },
] as const)("$backend: $file retains a named refusal outside ordinary data objects", async ({ backend, file }) => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-js-object-rest-boundary-"));
  try {
    const result = await compile(resolve("tests/fixtures/checked-dynamic-object-rest", file), {
      backend, allowEngine: false, optimization: "dev", outDir: dir, outPath: join(dir, "program"),
      sanitize: backend !== "rust" && process.env["SCRIPTC_SAN"] === "1",
    });
    expect(result.ok, result.ok ? undefined : JSON.stringify(result.diagnostics)).toBe(true);
    if (!result.ok) return;
    const native = await runFileStdio(result.binaryPath, [], { ...process.env, SCRIPTC_RUST_HEAP_AUDIT: "1" });
    expect(native.code, native.stderr.toString("utf8")).toBe(0);
    expect(native.signal).toBe(null);
    const line = "SC1031 scriptc SC1031: checked-dynamic object rest requires an ordinary object without descriptor-defined properties\n";
    expect(native.stdout.toString("utf8")).toBe(line.repeat(file === "source-boundary.js" ? 5 : 1));
    expect(native.stderr.toString("utf8")).toBe("");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test.each(["llvm", "c"] as const)("%s: descriptor-defined modules retain a compiler refusal for object rest", async backend => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-js-object-rest-descriptor-"));
  try {
    const entry = resolve("tests/fixtures/checked-dynamic-object-rest/descriptor-boundary.js");
    const diagnostic = expect.objectContaining({ code: "SC3001", message: expect.stringContaining("object rest in a module with dyn.defineProps") });
    expect(analyze(entry, { backend, allowEngine: false }).coverage.diagnostics).toEqual(expect.arrayContaining([diagnostic]));
    for (const outputKind of ["native", backend] as const) {
      const result = await compile(entry, { backend, outputKind, allowEngine: false, optimization: "dev", outDir: dir, outPath: join(dir, outputKind) });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.diagnostics).toEqual(expect.arrayContaining([diagnostic]));
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
