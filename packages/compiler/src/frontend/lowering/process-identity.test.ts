import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { compile, deserializeModule, validateModule } from "../../index.js";

test.for(["x86_64-pc-windows-msvc", "x86_64-unknown-linux-gnu"])("process identity lowering follows the target %s", async (target) => {
  const directory = await mkdtemp(join(tmpdir(), "scriptc-process-identity-"));
  vi.stubEnv("SCRIPTC_TARGET", target);
  try {
    const entry = join(directory, "main.ts"), output = join(directory, "main.ir.json");
    await writeFile(entry, `
      console.log(typeof process.getuid, typeof process.getgid);
      console.log(process.getuid?.() ?? -1, process.getgid?.() ?? -1);
      try { process.getuid!(); } catch (error) { console.log(error instanceof TypeError); }
      try { process.getgid!(); } catch (error) { console.log(error instanceof TypeError); }
    `);
    const result = await compile(entry, { outputKind: "ir", outDir: directory, outPath: output });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    const module = deserializeModule(await readFile(output, "utf8"));
    expect(validateModule(module)).toEqual([]);
    const ir = JSON.stringify(module);
    if (target.includes("windows")) {
      expect(ir).toContain("process.getuid is not a function");
      expect(ir).toContain("process.getgid is not a function");
      expect(ir).not.toContain('"fn":"process.getuid"');
    } else {
      expect(ir).toContain('"fn":"process.getuid"');
      expect(ir).toContain('"fn":"process.getgid"');
    }
  } finally {
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  }
});
