import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule, validateModule } from "../../index.js";
import type { IrType } from "../../ir/ir.js";

async function maps(source: string, extension: "js" | "ts"): Promise<IrType[]> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-contextual-map-"));
  try {
    const entry = join(dir, `main.${extension}`), output = join(dir, "main.ir.json");
    await writeFile(entry, source);
    const result = await compile(entry, { outputKind: "ir", outDir: dir, outPath: output });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    const module = deserializeModule(await readFile(output, "utf8"));
    expect(validateModule(module)).toEqual([]);
    const types: IrType[] = [];
    JSON.stringify(module, (_key, value) => {
      if (value?.kind === "mapNew") types.push(value.type);
      return value;
    });
    return types;
  } finally { await rm(dir, { recursive: true, force: true }); }
}

test("JSDoc casts and declaration annotations give empty Map constructors their K/V types", async () => {
  const types = await maps(`
    const cast = /** @type {Map<string, number>} */ (new Map());
    /** @type {Map<number, string>} */
    const annotated = new Map();
    cast.set("a", 2); annotated.set(3, "b");
    console.log(cast.get("a"), annotated.get(3));
  `, "js");
  expect(types).toContainEqual({ kind: "map", key: { kind: "string" }, value: { kind: "f64" } });
  expect(types).toContainEqual({ kind: "map", key: { kind: "f64" }, value: { kind: "string" } });
});

test("explicitly typed and populated Map constructors retain their own element types", async () => {
  const types = await maps(`
    const explicit = new Map<string, number>();
    const seeded = new Map<string, number>([["a", 1]]);
    const contextual: Map<string, number> = new Map();
    explicit.set("b", 2);
    console.log(explicit.size, seeded.get("a"), contextual.size);
  `, "ts");
  expect(types.length).toBeGreaterThanOrEqual(3);
  expect(types.every(type => type.kind === "map" && type.key.kind === "string" && type.value.kind === "f64")).toBe(true);
});

test("Rust constructs the JSDoc map directly instead of deferring an unknown-map cast failure", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-jsdoc-rust-map-"));
  try {
    const entry = join(dir, "main.js"), output = join(dir, "main.rs");
    await writeFile(entry, `
      const values = /** @type {Map<string, number>} */ (new Map());
      values.set("a", 42);
      console.log(values.get("a"), values.size);
    `);
    const result = await compile(entry, { backend: "rust", allowEngine: false, outputKind: "rust", outDir: dir, outPath: output });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    const source = await readFile(output, "utf8");
    expect(source).not.toContain("Map<unknown, unknown>");
    expect(source).not.toContain("SC1090");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
