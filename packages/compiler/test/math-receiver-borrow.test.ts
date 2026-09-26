import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule } from "../src/index.js";
import { emitCModule } from "../src/backend/c/c-emitter.js";
import { emitLlvmModule } from "../src/backend/llvm/emitter.js";

test("numeric Math operands borrow stable receivers but preserve snapshots across replacement and calls", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-math-borrow-"));
  try {
    const entry = join(dir, "main.ts");
    const outPath = join(dir, "main.ir.json");
    await writeFile(entry, `
function safe(bytes: Uint8Array, value: number): number {
  bytes[Math.floor(0)] = Math.min(255, Math.max(0, Math.floor(value)));
  return bytes[Math.ceil(0)];
}
function unsafe(value: number): number { return Math.floor(value); }
function owned(bytes: Uint8Array, value: number): void { bytes[0] = Math.floor(unsafe(value)); }
function replaced(bytes: Uint8Array, other: Uint8Array): void {
  bytes[0] = Math.floor((bytes = other) ? 7.9 : 0);
}
function readArray(values: number[]): number { return values[Math.floor(0)] * 2; }
const buffer = new Uint8Array(1);
console.log(safe(buffer, 17.9), readArray([4]));
owned(buffer, 8.9);
replaced(buffer, new Uint8Array(1));
`);
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
    if (!result.ok) throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    const mod = deserializeModule(await readFile(outPath, "utf8"));
    const c = emitCModule(mod);
    const ll = emitLlvmModule(mod);
    const cBody = (name: string): string => {
      const match = c.match(new RegExp(`static [^\\n]+ sc_f_${name}\\([^\\n]*\\) \\{([\\s\\S]*?)\\n\\}`));
      expect(match, `${name} C function`).not.toBeNull();
      return match![1]!;
    };
    const llBody = (name: string): string => {
      const match = ll.match(new RegExp(`define internal [^\\n]+ @sc_f_${name}\\([^\\n]*\\) #0 \\{([\\s\\S]*?)\\n\\}`));
      expect(match, `${name} LLVM function`).not.toBeNull();
      return match![1]!;
    };
    expect(cBody("safe")).not.toContain("scr_bytes_retain(");
    expect(llBody("safe")).not.toContain("@scr_bytes_retain_v(");
    // The incoming parameter still owns the buffer until function cleanup.
    expect(cBody("safe").match(/scr_bytes_release\(/g)).toHaveLength(1);
    expect(llBody("safe").match(/call void @scr_bytes_release\(/g)).toHaveLength(1);
    expect(cBody("safe")).toContain("floor(");
    expect(llBody("safe")).toContain("@llvm.floor.f64(");
    for (const name of ["owned", "replaced"]) {
      expect(cBody(name)).toContain("scr_bytes_retain(");
      expect(llBody(name)).toContain("@scr_bytes_retain_v(");
    }
    expect(cBody("readArray")).not.toContain("scr_arr_retain(");
    expect(llBody("readArray")).not.toContain("@scr_arr_retain_v(");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
