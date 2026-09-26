import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule } from "../src/index.js";
import { emitCModule } from "../src/backend/c/c-emitter.js";
import { emitLlvmModule } from "../src/backend/llvm/emitter.js";
import { findConstantNumericTables } from "../src/ir/constant-tables.js";

test("both backends use guarded native constants and retain array initialization", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-constant-tables-"));
  try {
    const entry = join(dir, "main.ts");
    const outPath = join(dir, "main.ir.json");
    await writeFile(entry, `
const table = [3, -0, Infinity];
function lookup(i: number): number { return table[i] * 1; }
const mutated = [4, 5];
mutated[0] = 6;
console.log(lookup(1), mutated[0] * 1);
`);
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
    if (!result.ok) throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    const mod = deserializeModule(await readFile(outPath, "utf8"));
    expect([...findConstantNumericTables(mod).values()].map((t) => t.values)).toEqual([[3, -0, Infinity]]);
    const c = emitCModule(mod);
    const llvm = emitLlvmModule(mod);
    expect(c).toContain("static const double sc_const_numbers_0[] = { 3.0, -0.0, INFINITY }");
    expect(c).toContain("if (a != NULL && i >= 0.0 && i < 3.0)");
    expect(c).toContain("if ((double)index == i)");
    expect(c).toMatch(/= sc_const_numbers_0_get\(/);
    expect(c).toContain("return scr_arr_get_number(a, i)");
    expect(c).toContain("scr_arr_push_f64(");
    expect(llvm).toContain("@sc_const_numbers_0 = private constant [3 x double]");
    expect(llvm).toContain("%initialized = icmp ne ptr %a, null");
    expect(llvm).toContain("br i1 %safe, label %convert, label %fallback");
    expect(llvm).toContain("br i1 %integer, label %read, label %fallback");
    expect(llvm).toMatch(/call double @sc_const_numbers_0_get\(/);
    expect(llvm).toContain("call double @scr_arr_get_number(ptr %a, double %i)");
    expect(llvm).toContain("call double @scr_arr_push_f64(");
    const wasm = emitLlvmModule(mod, { pointerBits: 32, wasi: true });
    expect(wasm).toContain("%index = fptoui double %i to i32");
    expect(wasm).toContain("ptr @sc_const_numbers_0, i32 0, i32 %index");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test.each([
  ["2970-constant-numeric-tables.ts", "2.0, -0.0, 1.5, INFINITY, -INFINITY, 8.0, NAN"],
  ["2971-constant-table-modules/main.ts", "2.0, 5.0, 11.0"],
])("%s exercises specialization and rejects its mutated/escaping tables", async (fixture, expected) => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-constant-tables-"));
  try {
    const outPath = join(dir, "main.c");
    const entry = join(import.meta.dirname, "../../../tests/corpus", fixture);
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "c" });
    if (!result.ok) throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    const c = await readFile(outPath, "utf8");
    expect(c.match(/static const double sc_const_numbers_/g)).toHaveLength(1);
    expect(c).toContain(`static const double sc_const_numbers_0[] = { ${expected} };`);
    expect(c).toMatch(/= sc_const_numbers_0_get\(/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
