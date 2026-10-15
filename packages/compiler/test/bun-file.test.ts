import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

test("Bun.file text preserves ambient provenance and refuses unsupported BunFile forms", async () => {
  const root = await mkdtemp(join(tmpdir(), "scriptc-bun-file-contract-"));
  try {
    const types = join(root, "node_modules/bun-types");
    await mkdir(types, { recursive: true });
    await writeFile(join(types, "package.json"), JSON.stringify({ name: "bun-types", types: "index.d.ts" }));
    await writeFile(join(types, "index.d.ts"), '/// <reference path="./bun.d.ts" />\n/// <reference path="./bun.ns.d.ts" />\n');
    await writeFile(join(types, "bun.ns.d.ts"), 'import * as BunModule from "bun"; declare global { export import Bun = BunModule; }\n');
    await writeFile(join(types, "bun.d.ts"), `declare module "bun" {
      interface BunFile { text(...args: unknown[]): Promise<string>; exists(): Promise<boolean>; }
      function file(path: string | URL | number, options?: { type?: string }): BunFile;
    }`);
    await writeFile(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, types: ["bun-types"], target: "ES2022", module: "ESNext" }, files: ["main.ts"] }));
    const entry = join(root, "main.ts"), output = join(root, "main.rs");
    for (const item of [
      { source: 'console.log(await Bun.file("x").text()); export {};', native: true },
      { source: 'console.log(await globalThis.Bun.file("x").text()); export {};', native: true },
      { source: 'const Bun = { file: (x: string) => ({ text: async () => x }) }; console.log(await Bun.file("x").text()); export {};', native: false },
    ]) {
      await writeFile(entry, item.source);
      const result = await compile(entry, { backend: "rust", outputKind: "rust", allowEngine: false, target: "bun", outPath: output, outDir: root });
      expect(result.ok, JSON.stringify(result)).toBe(true);
      if (!result.ok) continue;
      const source = await readFile(output, "utf8");
      expect(source.includes("runtime::bun_file_text")).toBe(item.native);
      if (item.native) expect(source).toContain("runtime::bun_file_path");
    }
    for (const item of [
      { source: 'await Bun.file("x").text(); export {};', target: "node24" as const },
      { source: 'await Bun.file("x", { type: "text/plain" }).text(); export {};', target: "bun" as const },
      { source: 'await Bun.file(new URL("file:///x")).text(); export {};', target: "bun" as const },
      { source: 'await Bun.file(0).text(); export {};', target: "bun" as const },
      { source: 'await Bun.file("x").text("extra"); export {};', target: "bun" as const },
      { source: 'await Bun.file("x").exists(); export {};', target: "bun" as const },
      { source: 'const file = Bun.file("x"); await file.text(); export {};', target: "bun" as const },
      { source: 'const file = Bun.file; await file("x").text(); export {};', target: "bun" as const },
      ...["errno", "syscall", "path"].map(field => ({
        source: `try { await Bun.file("x").text(); } catch (error) { if (error instanceof Error) console.log((error as Error & { ${field}?: string }).${field}); } export {};`,
        target: "bun" as const,
      })),
    ]) {
      await writeFile(entry, item.source);
      const result = await compile(entry, { backend: "rust", outputKind: "rust", allowEngine: false, target: item.target, outPath: output, outDir: root });
      expect(result.ok, item.source).toBe(false);
      if (!result.ok) expect(result.diagnostics.some(diagnostic => diagnostic.code === "SC2020" || diagnostic.code === "SC1090"), JSON.stringify(result)).toBe(true);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
