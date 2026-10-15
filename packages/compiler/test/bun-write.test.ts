import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";
import { deserializeModule } from "../src/ir/serialize.js";
import { moduleLibNondeterministicSurface } from "../src/ir/ir.js";
import { evaluateLibraryFences, resolveLibraryFences } from "../src/library/fence-eval.js";

test("Bun.write admits typed text and byte inputs with ambient provenance and explicit overload fences", async () => {
  const root = await mkdtemp(join(tmpdir(), "scriptc-bun-write-contract-"));
  try {
    const types = join(root, "node_modules/bun-types");
    await mkdir(types, { recursive: true });
    await writeFile(join(types, "package.json"), JSON.stringify({ name: "bun-types", types: "index.d.ts" }));
    await writeFile(join(types, "index.d.ts"), '/// <reference path="./bun.d.ts" />\n/// <reference path="./bun.ns.d.ts" />\n');
    await writeFile(join(types, "bun.ns.d.ts"), 'import * as BunModule from "bun"; declare global { export import Bun = BunModule; }\n');
    await writeFile(join(types, "bun.d.ts"), `declare class Blob { constructor(parts?: string[]); readonly size: number; }
    declare module "bun" {
      interface BunFile { text(): Promise<string>; }
      function file(path: string): BunFile;
      function write(path: string | URL | number | BunFile, data: string | Uint8Array | ArrayBuffer | Blob, options?: { createPath?: boolean; mode?: number }): Promise<number>;
    }`);
    await writeFile(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, types: ["bun-types"], target: "ES2022", module: "ESNext" }, files: ["main.ts"] }));
    const entry = join(root, "main.ts"), output = join(root, "main.rs");
    for (const item of [
      { source: 'console.log(await Bun.write("x", "ação")); export {};', runtime: "bun_write_text" },
      { source: 'console.log(await globalThis.Bun.write("x", new Uint8Array([0, 255]))); export {};', runtime: "bun_write_bytes" },
      { source: 'const Bun = { write: async (path: string, text: string) => path.length + text.length }; console.log(await Bun.write("x", "data")); export {};', runtime: null },
    ]) {
      await writeFile(entry, item.source);
      const result = await compile(entry, { backend: "rust", outputKind: "rust", allowEngine: false, target: "bun", outPath: output, outDir: root });
      expect(result.ok, JSON.stringify(result)).toBe(true);
      if (!result.ok) continue;
      const source = await readFile(output, "utf8");
      if (item.runtime) expect(source).toContain(`runtime::${item.runtime}`);
      else expect(source).not.toContain("runtime::bun_write_");
      // Write must carry its own fence witness, never borrow Bun.file.text's.
      expect(source).not.toContain("runtime::bun_file_path");
      const irOutput = output + ".json";
      const lowered = await compile(entry, { outputKind: "ir", allowEngine: false, target: "bun", outPath: irOutput, outDir: root });
      expect(lowered.ok, JSON.stringify(lowered)).toBe(true);
      if (!lowered.ok) continue;
      const mod = deserializeModule(await readFile(irOutput, "utf8"));
      const fences = resolveLibraryFences([{ path: "write", id: "stdlib.Bun.write" }, { path: "read", id: "stdlib.Bun.file.text" }]);
      expect(fences.ok).toBe(true);
      if (!fences.ok) continue;
      const denied = evaluateLibraryFences(mod, { name: "writes", teachings: {}, fences: fences.fences });
      expect(denied).toHaveLength(item.runtime ? 1 : 0);
      if (item.runtime) expect(denied[0]?.message).toContain("stdlib.Bun.write");
      expect(moduleLibNondeterministicSurface(mod)).toBe(item.runtime ? "file writes" : null);
    }
    for (const item of [
      { source: 'await Bun.write("x", "data"); export {};', target: "node24" as const },
      ...[
        'await Bun.write("x", "data", { createPath: false });',
        'await Bun.write("x", "data", { mode: 0o600 });',
        'await Bun.write(new URL("file:///x"), "data");',
        'await Bun.write(1, "data");',
        'await Bun.write(Bun.file("x"), "data");',
        'await Bun.write("x", new ArrayBuffer(3));',
        'await Bun.write("x", new Blob(["data"]));',
        'const write = Bun.write; await write("x", "data");',
        ...["errno", "syscall", "path"].map(field => `try { await Bun.write("x", "data"); } catch (error) { if (error instanceof Error) console.log((error as Error & { ${field}?: string }).${field}); }`),
      ].map(source => ({ source: source + " export {};", target: "bun" as const })),
    ]) {
      await writeFile(entry, item.source);
      const result = await compile(entry, { backend: "rust", outputKind: "rust", allowEngine: false, target: item.target, outPath: output, outDir: root });
      expect(result.ok, item.source).toBe(false);
      if (!result.ok) expect(result.diagnostics.some(diagnostic => ["SC2020", "SC1090"].includes(diagnostic.code)), JSON.stringify(result)).toBe(true);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
