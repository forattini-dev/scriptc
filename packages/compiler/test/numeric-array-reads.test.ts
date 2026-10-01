import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule, validateModule } from "../src/index.js";
import { emitCModule } from "../src/backend/c/c-emitter.js";
import { emitLlvmModule } from "../src/backend/llvm/emitter.js";
import { checkPreflight, loadProgram } from "../src/frontend/program.js";
import { lowerToIr } from "../src/frontend/lowering/lowerer.js";

test("ordinary numeric-array arithmetic uses one lookup per read without boxing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-numeric-array-reads-"));
  try {
    const entry = join(dir, "main.ts");
    await writeFile(entry, [
      "function blend(a: number[], i: number, j: number): number {",
      "  return a[i] + (a[j] - a[i]) * 0.5;",
      "}",
      "console.log(blend([1, 3], 0, 1));",
      "",
    ].join("\n"));
    // Exercise the C/LLVM read contract explicitly: --emit=ir uses the
    // default Rust capabilities and cannot select a different backend.
    const loaded = loadProgram(entry);
    const mod = (() => {
      try {
        expect(checkPreflight(loaded)).toEqual([]);
        const lowered = lowerToIr(loaded.program, loaded.entry, loaded.moduleOrder, { nativeDenseArrays: false });
        expect(lowered.diagnostics).toEqual([]);
        if (!lowered.module) throw new Error("missing numeric-array IR module");
        return lowered.module;
      } finally {
        loaded.dispose();
      }
    })();
    expect(validateModule(mod)).toEqual([]);
    const visited = new Set<string>();
    let arrayReads = 0;
    function visit(value: unknown): void {
      if (value === null || typeof value !== "object") return;
      if (Array.isArray(value)) { value.forEach(visit); return; }
      const node = value as { kind?: string; callee?: string; method?: string };
      expect(node.kind).not.toBe("unionWrap");
      expect(node.kind).not.toBe("arrayState");
      expect(node.kind).not.toBe("arrayGet");
      if (node.kind === "arrIntrinsic" && node.method === "getNumber") arrayReads++;
      if (node.kind === "call" && node.callee) visitFunction(node.callee);
      Object.values(value).forEach(visit);
    }
    function visitFunction(name: string): void {
      if (visited.has(name)) return;
      visited.add(name);
      const fn = mod.functions.find((f) => f.name === name);
      expect(fn, `missing function ${name}`).toBeDefined();
      visit(fn!.body);
    }
    visitFunction(mod.entry);
    expect(arrayReads).toBe(3);
    const reachable = { ...mod, functions: mod.functions.filter((fn) => visited.has(fn.name)) };
    const c = emitCModule(reachable);
    const llvm = emitLlvmModule(reachable);
    expect(c.match(/scr_arr_get_number\(/g)).toHaveLength(3);
    expect(llvm.match(/call double @scr_arr_get_number\(/g)).toHaveLength(3);
    expect(c).not.toContain("scr_arr_state(");
    expect(llvm).not.toContain("@scr_arr_state(");
    expect(c).not.toContain("scr_arr_retain(");
    expect(llvm).not.toContain("@scr_arr_retain_v");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Rust JSON root analysis preserves dense numeric-array reads", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-rust-json-array-reads-"));
  try {
    const entry = join(dir, "main.ts");
    const outPath = join(dir, "main.ir.json");
    await writeFile(entry, [
      "function blend(a: number[], i: number, j: number): number {",
      "  return a[i] + (a[j] - a[i]) * 0.5;",
      "}",
      "console.log(JSON.stringify(blend([1, 3], 0, 1)));",
    ].join("\n"));
    const result = await compile(entry, { allowEngine: false, outDir: dir, outPath, outputKind: "ir" });
    if (!result.ok) throw new Error(result.diagnostics.map(d => `${d.code}: ${d.message}`).join("\n"));
    const mod = deserializeModule(await readFile(outPath, "utf8"));
    expect(validateModule(mod)).toEqual([]);
    const blend = mod.functions.find(fn => fn.name === "blend");
    expect(blend).toBeDefined();
    if (!blend) throw new Error("missing blend function");
    expect(blend.returnType).toEqual({ kind: "f64" });
    let reads = 0;
    function visit(value: unknown): void {
      if (value === null || typeof value !== "object") return;
      const node = value as { kind?: string; type?: unknown };
      expect(node.kind).not.toBe("unionWrap");
      expect(node.kind).not.toBe("arrayState");
      if (node.kind === "arrayGet") {
        expect(node.type).toEqual({ kind: "f64" });
        reads++;
      }
      Object.values(value).forEach(visit);
    }
    visit(blend.body);
    expect(reads).toBe(3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
