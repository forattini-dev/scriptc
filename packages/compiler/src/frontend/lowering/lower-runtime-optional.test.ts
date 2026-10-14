import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule, validateModule } from "../../index.js";

test("constructed fallbacks keep optional array and record results present", async () => {
  const directory = await mkdtemp(join(tmpdir(), "scriptc-constructed-fallback-"));
  try {
    const entry = join(directory, "main.ts"), output = join(directory, "main.ir.json");
    await writeFile(entry, `
      function words(flag: boolean): string[] | undefined { return flag ? ["yes"] : undefined; }
      function record(flag: boolean): { name: string } | undefined { return flag ? { name: "yes" } : undefined; }
      for (const flag of [false, true]) {
        const nullish = words(flag) ?? [];
        const truthy = words(flag) || [];
        const object = record(flag) ?? { name: "fallback" };
        nullish.push("tail");
        console.log(nullish.join(","), truthy.length, object.name);
      }
    `);
    const result = await compile(entry, { outputKind: "ir", outDir: directory, outPath: output, allowEngine: false });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(validateModule(deserializeModule(await readFile(output, "utf8")))).toEqual([]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
