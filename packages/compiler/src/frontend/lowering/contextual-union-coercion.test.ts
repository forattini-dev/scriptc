import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { compile, deserializeModule, validateModule } from "../../index.js";
import { CheckerFacade } from "../ts7/checker.js";

async function lower(source: string, outputKind: "ir" | "rust" = "ir") {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-contextual-coercion-"));
  try {
    const entry = join(dir, "main.ts"), output = join(dir, outputKind === "ir" ? "main.ir.json" : "main.rs");
    await writeFile(entry, source);
    const result = await compile(entry, { outputKind, ...(outputKind === "rust" ? { backend: "rust", allowEngine: false } as const : {}), outDir: dir, outPath: output });
    if (result.ok && outputKind === "ir") expect(validateModule(deserializeModule(await readFile(output, "utf8")))).toEqual([]);
    return result;
  } finally { await rm(dir, { recursive: true, force: true }); }
}

test("literal discriminants resolve ambiguous record widths at variable, argument and return slots", async () => {
  const query = vi.spyOn(CheckerFacade.prototype, "isTypeAssignableTo");
  try {
    const source = `
    type A = { kind: "a"; value: number };
    type B = { kind: "b"; value: number; extra?: number };
    type AB = A | B;
    function a(): { kind: "a"; value: number; spare: number } {
      return { kind: "a", value: 1, spare: 2 };
    }
    function b(): { kind: "b"; value: number; extra: number; spare: number } {
      return { kind: "b", value: 3, extra: 4, spare: 5 };
    }
    function receive(value: AB): number { return value.value; }
    function returned(): AB { return b(); }
    const value: AB = a();
    console.log(receive(value), receive(b()), receive(returned()));
  `;
    const result = await lower(source);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(query.mock.results.some((result) => result.value === true)).toBe(true);
    expect(query.mock.results.some((result) => result.value === false)).toBe(true);
    // A mechanically valid conversion without assignability evidence must
    // keep its diagnostic, rather than selecting the first matching shape.
    query.mockReturnValue(false);
    const unproven = await lower(source);
    expect(unproven.ok).toBe(false);
    expect(!unproven.ok && unproven.diagnostics.some((d) => d.code === "SC2003")).toBe(true);
  } finally { query.mockRestore(); }
});

test("multiple assignable arms keep the ambiguity diagnostic", async () => {
  const result = await lower(`
    type A = { a: number };
    type B = { b: number; optional?: number };
    function both(): { a: number; b: number; spare: number } {
      return { a: 1, b: 2, spare: 3 };
    }
    const value: A | B = both();
    console.log(value);
  `);
  expect(result.ok).toBe(false);
  expect(!result.ok && result.diagnostics.some((d) => d.code === "SC2003")).toBe(true);
});

test("TypeScript-incompatible literal arms still fail preflight", async () => {
  const result = await lower(`
    type A = { kind: "a"; value: number };
    type B = { kind: "b"; value: number; extra?: number };
    function other(): { kind: "c"; value: number; spare: number } {
      return { kind: "c", value: 1, spare: 2 };
    }
    const value: A | B = other();
    console.log(value);
  `);
  expect(result.ok).toBe(false);
  expect(!result.ok && result.diagnostics.some((d) => d.code === "SC0001")).toBe(true);
});

test("an assignable union arm still respects Rust's shared source layout refusal", async () => {
  const result = await lower(`
    type A = { kind: "a"; value: number };
    type B = { kind: "b"; value: number; optional?: number };
    function source(): { kind: "a"; value: number; extra: Map<string, number> } {
      return { kind: "a", value: 1, extra: new Map<string, number>() };
    }
    function read<T>(service: T, key: string): unknown { return service[key as keyof T]; }
    const value: A | B = source();
    console.log(read(value, "extra"));
  `, "rust");
  expect(result.ok).toBe(false);
  expect(!result.ok && result.diagnostics).toEqual([
    expect.objectContaining({ code: "SC3001", message: expect.stringContaining("shared record projection from an unsupported source layout") }),
  ]);
});
