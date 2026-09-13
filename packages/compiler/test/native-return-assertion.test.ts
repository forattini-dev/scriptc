import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { analyze, compile } from "../src/index.js";

const viewType = `type View<T> = { [K in keyof T as T[K] extends number ? K : never]: T[K] };`;

function fixture(body: string) {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-return-assertion-"));
  const entry = join(dir, "main.ts");
  writeFileSync(entry, `${viewType}\n${body}\nexport {};\n`);
  return { dir, entry, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test.each(["value as View<T>", "((value as View<T>))"])("direct generic return assertion %s uses its resolved mapped result", async assertion => {
  const f = fixture(`function view<T>(value: unknown, sample: T) { return ${assertion}; }
const value = view({ answer: 7 }, { answer: 0, hidden: '' }); console.log(value.answer);`);
  try {
    const result = await compile(f.entry, { backend: "rust", allowEngine: false, outputKind: "rust", outDir: f.dir, outPath: join(f.dir, "program.rs") });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  } finally { f.cleanup(); }
});

test.each([
  `function view<T>(value: unknown, sample: T) { const picked = value as View<T>; return picked; }
const value = view({ answer: 7 }, { answer: 0, hidden: '' }); console.log(value.answer);`,
  `function view<T>(value: unknown, sample: T): View<T> | string { return value as View<T>; }
const value = view('wrong', { answer: 0, hidden: '' }); console.log(typeof value);`,
  `function view<T>(value: unknown, sample: T) { if (typeof value === 'string') return value; return value as View<T>; }
const value = view({ answer: 7 }, { answer: 0, hidden: '' }); console.log(typeof value);`,
])("unresolved assertions do not adopt an unrelated enclosing return slot", body => {
  const f = fixture(body);
  try {
    const { coverage } = analyze(f.entry, { backend: "rust", allowEngine: false });
    expect(coverage.preflightFailed).toBe(false);
    expect(coverage.diagnostics[0]).toEqual(expect.objectContaining({ code: "SC2001", message: expect.stringContaining("View<T>") }));
    expect(coverage.diagnostics.slice(1).every(diagnostic => diagnostic.code === "SC2004")).toBe(true);
  } finally { f.cleanup(); }
});
