import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule, validateModule } from "../../index.js";

async function lower(source: string) {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-fresh-map-"));
  try {
    const entry = join(dir, "main.ts"), output = join(dir, "main.ir.json");
    await writeFile(entry, source);
    const result = await compile(entry, { outputKind: "ir", outDir: dir, outPath: output, allowEngine: false });
    if (result.ok) expect(validateModule(deserializeModule(await readFile(output, "utf8")))).toEqual([]);
    return result;
  } finally { await rm(dir, { recursive: true, force: true }); }
}

test("fresh empty fields adopt the destination in argument, local and return slots", async () => {
  const result = await lower(`
    function accept(rows: { names: string[]; id: number }[]): void { console.log(rows.length); }
    accept([1, 2].map(id => ({ id, names: [] })));
    const local: string[][] = [1].map(() => []);
    function returned(): string[][] { return [1].map(() => []); }
    console.log(local.length, returned().length);
  `);
  expect(result.ok, JSON.stringify(result)).toBe(true);
});

test("existing empty arrays and explicit callback return annotations are not retyped", async () => {
  for (const body of ['const held: never[] = []; const rows: string[][] = [1].map(() => held);',
    'const rows: string[][] = [1].map((): never[] => []);']) {
    const result = await lower(body + ' console.log(rows.length);');
    expect(result.ok, JSON.stringify(result)).toBe(false);
  }
});
