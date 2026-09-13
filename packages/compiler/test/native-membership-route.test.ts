import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

async function rustSource(source: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "scriptc-native-membership-"));
  try {
    const entry = join(directory, "main.ts"), outPath = join(directory, "main.rs");
    await writeFile(entry, source + "\nexport {};\n");
    const result = await compile(entry, { backend: "rust", allowEngine: false, outputKind: "rust", outDir: directory, outPath });
    expect(result.ok, result.ok ? undefined : JSON.stringify(result.diagnostics)).toBe(true);
    if (!result.ok) return "";
    return await readFile(outPath, "utf8");
  } finally { await rm(directory, { recursive: true, force: true }); }
}

function expectSharedMembership(source: string): void {
  expect(source).toMatch(/fn sc_f__x25_rec_hasIn_\d+\([^\n]*sc_dyn_has_key\(&sc_value, &sc_key\)/);
  expect(source).toMatch(/fn sc_f__x25_obj_hasOwn_\d+\([^\n]*sc_dyn_has_own\(&sc_value, &sc_key\)/);
}

test("shared membership consults live keys without reading optional fields", async () => {
  const source = await rustSource(`
const raw: unknown = { x: 1, optional: undefined };
const view = raw as { x: number; optional?: number };
console.log("x" in view, "optional" in view, "missing" in view);
console.log(Object.hasOwn(view, "optional"));
console.log(Object.prototype.hasOwnProperty.call(view, "optional"));
`);
  expectSharedMembership(source);
});

test("typed Proxy membership reaches explicit refusals instead of folds or Get", async () => {
  const source = await rustSource(`
const proxy = new Proxy({}, { get() { return 1; } });
const view = proxy as { x: number; optional?: number };
console.log("x" in view, "optional" in view, "missing" in view);
console.log(Object.hasOwn(view, "x"));
`);
  expectSharedMembership(source);
  expect(source).toContain('sc_dyn_proxy_unsupported("property membership")');
  expect(source).toContain('sc_dyn_proxy_unsupported("own property membership")');
});

test("static record membership keeps typed storage", async () => {
  const source = await rustSource(`
const view: { x: number; optional?: number } = { x: 1 };
console.log("x" in view, "optional" in view, "missing" in view);
console.log(Object.hasOwn(view, "x"));
`);
  expect(source).toContain("sc_f__x25_rec_hasIn_");
  expect(source).toContain("sc_f__x25_obj_hasOwn_");
  expect(source).not.toContain("ScShared_");
});

test("shared union membership cannot fold fields present in every arm", async () => {
  const source = await rustSource(`
type View = { kind: "one"; x: number } | { kind: "two"; x: number; y: string };
const raw: unknown = { kind: "one", x: 1 };
const view = raw as View;
console.log("x" in view, "y" in view);
`);
  expect(source).toMatch(/fn sc_f__x25_rec_hasInUnion_\d+\([^\n]*sc_dyn_has_key\(&sc_value, &sc_key\)/);
});

test("computed shared index membership consults the original object", async () => {
  const source = await rustSource(`
const raw: unknown = { x: 1, extra: undefined };
const view = raw as { x: number; [key: string]: unknown };
function has(key: string): boolean { return key in view; }
console.log(has("x"), has("extra"), has("missing"));
`);
  expect(source).toMatch(/fn sc_f__x25_rec_haskey_\d+\([^\n]*sc_dyn_has_key\(&sc_value, &sc_key\)/);
});
