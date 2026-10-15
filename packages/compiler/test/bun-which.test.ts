import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

test("Bun.which keeps target, declaration provenance, and data-options boundaries", async () => {
  const root = await mkdtemp(join(tmpdir(), "scriptc-bun-which-contract-"));
  try {
    const types = join(root, "node_modules/bun-types");
    await mkdir(types, { recursive: true });
    await writeFile(join(types, "package.json"), JSON.stringify({ name: "bun-types", types: "index.d.ts" }));
    await writeFile(join(types, "index.d.ts"), '/// <reference path="./bun.d.ts" />\n/// <reference path="./bun.ns.d.ts" />\n');
    await writeFile(join(types, "bun.ns.d.ts"), 'import * as BunModule from "bun"; declare global { export import Bun = BunModule; }\n');
    await writeFile(join(types, "bun.d.ts"), `declare module "bun" {
      interface WhichOptions { PATH?: string; cwd?: string; }
      function which(command: string, options?: WhichOptions): string | null;
    }`);
    await writeFile(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, types: ["bun-types"], target: "ES2022" }, files: ["main.ts"] }));
    const entry = join(root, "main.ts"), output = join(root, "main.rs");
    for (const item of [
      { source: 'const locate = Bun.which; console.log(locate("missing"));', target: "bun" as const, native: true },
      { source: 'const Bun = { which: (x: string) => "user:" + x }; console.log(Bun.which("x")); export {};', target: "bun" as const, native: false },
    ]) {
      await writeFile(entry, item.source);
      const result = await compile(entry, { backend: "rust", outputKind: "rust", allowEngine: false, target: item.target, outPath: output, outDir: root });
      expect(result.ok, JSON.stringify(result)).toBe(true);
      if (!result.ok) continue;
      const source = await readFile(output, "utf8");
      expect(source.includes("runtime::bun_which")).toBe(item.native);
    }
    for (const item of [
      { source: 'Bun.which("missing");', target: "node24" as const },
      { source: 'Bun.which("missing", { get PATH() { return "/bad"; } });', target: "bun" as const },
    ]) {
      await writeFile(entry, item.source);
      const result = await compile(entry, { backend: "rust", outputKind: "rust", allowEngine: false, target: item.target, outPath: output, outDir: root });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.diagnostics.some(diagnostic => diagnostic.code === "SC2020" || diagnostic.code === "SC1090")).toBe(true);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
