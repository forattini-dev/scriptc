import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

test.each(["2976-json-stringify-no-arguments.js", "3321-json-stringify-no-arguments.js", "3322-json-stringify-optional-roots.ts"])("Rust emits %s without an engine", async fixture => {
  const directory = await mkdtemp(join(tmpdir(), "scriptc-json-roots-"));
  try {
    const result = await compile(resolve("tests/corpus", fixture), {
      backend: "rust", allowEngine: false, outputKind: "rust", outDir: directory, outPath: join(directory, "program.rs"),
    });
    expect(result.ok, result.ok ? undefined : result.diagnostics.map(d => `${d.code}: ${d.message}`).join("\n")).toBe(true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Rust refuses unmodeled extra JSON.stringify argument effects", async () => {
  const directory = await mkdtemp(join(tmpdir(), "scriptc-json-extra-"));
  try {
    const entry = join(directory, "main.js");
    await writeFile(entry, "console.log(JSON.stringify(undefined, null, 2, console.log('extra')));\n");
    const result = await compile(entry, {
      backend: "rust", allowEngine: false, outputKind: "rust", outDir: directory, outPath: join(directory, "program.rs"),
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unmodeled extra argument effects unexpectedly admitted");
    expect(result.diagnostics.some(d => d.message.includes("more than three arguments"))).toBe(true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test.each(["c", "llvm"] as const)("%s keeps its existing JSON root refusal", async backend => {
  const directory = await mkdtemp(join(tmpdir(), "scriptc-json-roots-refusal-"));
  try {
    const result = await compile(resolve("tests/corpus/3321-json-stringify-no-arguments.js"), {
      backend, allowEngine: false, outputKind: backend, outDir: directory, outPath: join(directory, "program.source"),
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unsupported JSON roots unexpectedly admitted");
    expect(result.diagnostics.some(d => d.message.includes("JSON.stringify"))).toBe(true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
