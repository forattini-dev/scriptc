import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule, validateModule } from "../../index.js";

test("literal undefined and null array stores keep unit values out of locals", async () => {
  const directory = await mkdtemp(join(tmpdir(), "scriptc-array-unit-store-"));
  try {
    const entry = join(directory, "main.ts");
    const output = join(directory, "main.ir.json");
    await writeFile(entry, `
      const values: (number | null | undefined)[] = [];
      values[2] = undefined;
      values[4] = null;
      values[6] = 7;
      console.log(values.length, values[2], values[4], values[6]);
    `);
    const result = await compile(entry, { outputKind: "ir", outDir: directory, outPath: output });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(validateModule(deserializeModule(await readFile(output, "utf8")))).toEqual([]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
