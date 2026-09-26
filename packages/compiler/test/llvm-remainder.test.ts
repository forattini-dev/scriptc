import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule } from "../src/index.js";
import { emitCModule } from "../src/backend/c/c-emitter.js";
import { emitLlvmModule } from "../src/backend/llvm/emitter.js";

test("numeric remainder emits strict LLVM frem and keeps exponentiation on pow", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-llvm-remainder-"));
  try {
    const entry = join(dir, "main.ts");
    const outPath = join(dir, "main.ir.json");
    await writeFile(entry, `
function remainder(x: number, y: number): number { return x % y; }
function constants(x: number): number {
  let value = x % 8;
  value %= 3;
  return value;
}
function power(x: number, y: number): number { return x ** y; }
console.log(remainder(-9.5, 8), constants(17.25), power(2, 3));
`);
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
    if (!result.ok) throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    const mod = deserializeModule(await readFile(outPath, "utf8"));
    const ll = emitLlvmModule(mod);
    expect(ll.match(/ = frem double /g)).toHaveLength(3);
    expect(ll).not.toContain("@fmod");
    expect(ll).toContain("call double @pow(");
    // The C backend remains on libm with the same operand expressions.
    expect(emitCModule(mod).match(/fmod\(/g)).toHaveLength(3);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
