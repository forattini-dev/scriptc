import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../../index.js";

test("Rust emits native cwd spawn calls and other backends preserve a named refusal", async () => {
  const directory = await mkdtemp(join(tmpdir(), "scriptc-spawn-cwd-emission-"));
  try {
    const entry = join(directory, "main.ts");
    await writeFile(entry, `import { spawnSync } from "node:child_process"; const result = spawnSync("tool", [], { cwd: ".", encoding: "utf8", env: { MARK: "kept" } }); console.log(result.status);`);
    const output = join(directory, "main.rs");
    const rust = await compile(entry, { outputKind: "rust", outDir: directory, outPath: output, allowEngine: false });
    expect(rust.ok, JSON.stringify(rust)).toBe(true);
    expect(await readFile(output, "utf8")).toContain("runtime::child_spawn_sync_full");
    const c = await compile(entry, { outputKind: "c", outDir: directory, outPath: join(directory, "main.c") });
    expect(c.ok).toBe(false);
    if (!c.ok) expect(c.diagnostics.some(d => d.message.includes("spawnSync option 'cwd'"))).toBe(true);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
