import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { analyze, compile } from "../src/index.js";

function fixture(source: string) {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-native-proxy-admission-"));
  const entry = join(dir, "main.ts");
  writeFileSync(entry, source + "\nexport {};\n");
  return { dir, entry, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test.each(["Proxy", "globalThis.Proxy", "(Proxy)"])("%s admits native get traps with contextual property keys and receivers", constructor => {
  const f = fixture(`
const target = { value: 7 };
const proxy = new ${constructor}(target, {
  get(value, key, receiver) {
    console.log(typeof key, receiver === proxy);
    return value[key as keyof typeof value];
  }
});
console.log(proxy.value);
`);
  try {
    const { coverage } = analyze(f.entry, { backend: "rust", allowEngine: false });
    expect(coverage.preflightFailed).toBe(false);
    expect(coverage.diagnostics).toEqual([]);
    expect(coverage.runtimeFences ?? []).toEqual([]);
  } finally { f.cleanup(); }
});

test("a locally declared Proxy remains an ordinary class", async () => {
  const f = fixture(`class Proxy { value: number; constructor(value: number) { this.value = value; } }
console.log(new Proxy(7).value);`);
  try {
    const outDir = join(f.dir, "out");
    const result = await compile(f.entry, { backend: "rust", allowEngine: false, outputKind: "rust", outDir, outPath: join(outDir, "program.rs") });
    expect(result.ok).toBe(true);
  } finally { f.cleanup(); }
});

test.each(["global", "local"])("inferred %s Proxy bindings can form lazy callable views", scope => {
  const code = `const access = new Proxy({}, { get: (_target, key) => key === 'work' ? () => 7 : undefined });
const view = access as { work: () => number }; console.log(view.work());`;
  const f = fixture(scope === "global" ? code : `function run() { ${code} } run();`);
  try {
    const { coverage } = analyze(f.entry, { backend: "rust", allowEngine: false });
    expect(coverage.preflightFailed).toBe(false);
    expect(coverage.diagnostics).toEqual([]);
    expect(coverage.runtimeFences ?? []).toEqual([]);
  } finally { f.cleanup(); }
});

test.each(["c", "llvm"] as const)("%s refuses native Proxy construction before producing output", async backend => {
  const f = fixture(`const proxy = new Proxy({ value: 7 }, {}); console.log(proxy.value);`);
  try {
    const outDir = join(f.dir, "out");
    const result = await compile(f.entry, { backend, allowEngine: false, outDir, outPath: join(outDir, "program") });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: "SC3001", message: expect.stringContaining("native Proxy references") }),
    ]);
    expect(existsSync(outDir)).toBe(false);
  } finally { f.cleanup(); }
});

test.each([
  `const target = { rows: [{ x: 1 }] }; const proxy = new Proxy(target, {}); target.rows.push({ x: 2 }); console.log(proxy.rows.length);`,
  `const rows = [{ x: 1 }]; const proxy = new Proxy({ rows }, {}); rows.push({ x: 2 }); console.log(proxy.rows.length);`,
  `const state = { rows: [{ x: 1 }] }; const handler = { state, get: (_target: { value: number }, _key: string | symbol) => 7 }; const proxy = new Proxy({ value: 1 }, handler); console.log(proxy.value);`,
  `const rows = [{ x: 1 }]; const proxy = new Proxy({}, { ...{ rows }, get: () => 7 }); console.log(typeof proxy);`,
  `const rows = [{ x: 1 }]; const proxy = new Proxy({ value: 0 }, { get: () => rows }); console.log(typeof proxy.value);`,
  `const proxy = new Proxy({}, { get: () => (rows: { x: number }[]) => rows.length }); console.log(typeof proxy);`,
])("Proxy construction refuses composite transport that would snapshot aliases", async source => {
  const f = fixture(source);
  try {
    const outDir = join(f.dir, "out");
    const result = await compile(f.entry, { backend: "rust", allowEngine: false, outputKind: "rust", outDir, outPath: join(outDir, "program.rs") });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics[0]).toEqual(expect.objectContaining({ code: "SC1101", message: expect.stringContaining("identity-preserving dynamic transport") }));
      expect(result.diagnostics.slice(1).every(diagnostic => diagnostic.code === "SC2004")).toBe(true);
    }
    expect(existsSync(outDir)).toBe(false);
  } finally { f.cleanup(); }
});

test("Proxy targets retain supported scalar array and nested record views", () => {
  const f = fixture(`const target = { rows: [1], nested: { x: 7 } }; const proxy = new Proxy(target, {});
target.rows.push(2); target.nested.x = 9; console.log(proxy.rows.length, proxy.nested.x);`);
  try {
    const { coverage } = analyze(f.entry, { backend: "rust", allowEngine: false });
    expect(coverage.preflightFailed).toBe(false);
    expect(coverage.diagnostics).toEqual([]);
    expect(coverage.runtimeFences ?? []).toEqual([]);
  } finally { f.cleanup(); }
});

test.each([
  `const rows = [1]; const proxy = new Proxy({ value: rows }, { get: () => rows }); rows.push(2); console.log(proxy.value.length);`,
  `const value = { nested: { x: 7 }, rows: [1] }; const proxy = new Proxy({ value }, { get: () => value }); console.log(proxy.value.nested.x);`,
  `const proxy = new Proxy({}, { get: (_target, key) => key === 'work' ? (...args: unknown[]) => args.length : undefined });
const view = proxy as { work: (name: string, count: number) => number }; console.log(view.work('a', 2));`,
])("trap signatures preserve supported shared returns and callable adapters", async source => {
  const f = fixture(source);
  try {
    const result = await compile(f.entry, { backend: "rust", allowEngine: false, outputKind: "rust", outDir: f.dir, outPath: join(f.dir, "program.rs") });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  } finally { f.cleanup(); }
});
