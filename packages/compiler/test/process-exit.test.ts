import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { BACKEND_LIB_CALLS, compile } from "../src/index.js";

test.each(["c", "llvm"] as const)("%s refuses Rust-only exitCode reads before emission", async backend => {
  const directory = await mkdtemp(join(tmpdir(), "scriptc-process-exit-read-"));
  try {
    const result = await compile(resolve("tests/corpus/3300-process-exit-code-read.ts"), {
      backend, allowEngine: false, outputKind: backend, outDir: directory, outPath: join(directory, "program.source"),
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("exitCode read unexpectedly admitted");
    expect(result.diagnostics.some(d => d.message.includes("exitCode"))).toBe(true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test.each(["c", "llvm", "rust"] as const)("%s scopes omitted exit arguments to its runtime capability", async backend => {
  const directory = await mkdtemp(join(tmpdir(), "scriptc-process-exit-"));
  try {
    const outPath = join(directory, "program.source");
    const result = await compile(resolve("tests/corpus/2942-process-exit-code-override.ts"), {
      backend, allowEngine: false, outputKind: backend, outDir: directory, outPath,
    });
    if (!result.ok) throw new Error(result.diagnostics.map(d => `${d.code}: ${d.message}`).join("\n"));
    const source = await readFile(outPath, "utf8");
    if (backend === "rust") {
      expect(source).toContain("runtime::process_exit_default()");
    } else {
      expect(source).toContain("scr_process_exit");
      expect(source).not.toContain("process_exit_default");
    }
    expect(BACKEND_LIB_CALLS["process.exitDefault"]).toEqual(["rust"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
