import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "vitest";
import { npmStaticIneligibleReason } from "./npm-static.js";
import { loadProgram } from "./program.js";

test.each(["js", "cjs", "mjs"])("non-admitted %s implementations do not replace unreachable declarations with inferred types", async (extension) => {
  const dir = await mkdtemp("/tmp/scriptc-npm-static-isolation-");
  const entry = join(dir, "entry.ts");
  const selected = join(dir, "node_modules", "selected");
  const opaque = join(dir, "node_modules", "opaque");
  try {
    await mkdir(join(opaque, "types"), { recursive: true });
    await mkdir(selected, { recursive: true });
    await writeFile(join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: {
      strict: true, module: "ESNext", moduleResolution: "Bundler", target: "ES2025",
    } }));
    await writeFile(join(selected, "package.json"), JSON.stringify({ name: "selected", type: "module",
      exports: { types: "./index.d.ts", default: "./index.js" },
    }));
    await writeFile(join(selected, "index.js"), "export function run() { return 7; }");
    await writeFile(join(selected, "index.d.ts"), "export declare function run(): number;");
    const metadata = { name: "opaque", type: "module", types: "types/index.d.ts",
      exports: { default: `./index.${extension}` },
    };
    await writeFile(join(opaque, "package.json"), JSON.stringify(metadata));
    await writeFile(join(opaque, `index.${extension}`), extension === "cjs"
      ? 'exports.broken = () => "text";' : 'export function broken() { return "text"; }');
    await writeFile(join(opaque, "types/index.d.ts"), "export declare function broken(): number;");
    await writeFile(entry, `import { run } from "selected";
// @ts-ignore This runtime-only export has no reachable declaration.
import { broken } from "opaque";
const answer: number = broken(); console.log(run(), answer);
`);
    const diagnostics = (packages: string[]) => {
      const load = loadProgram(entry, { npmStatic: packages });
      try { return load.program.getSemanticDiagnostics(load.program.getSourceFile(entry)); }
      finally { load.dispose(); }
    };
    expect(diagnostics([])).toEqual([]);
    expect(diagnostics(["selected"])).toEqual([]);
    expect(diagnostics(["selected", "opaque"]).some((d) => d.code === 2322 && d.text.includes("string"))).toBe(true);
    // A reachable declaration still types a non-admitted package normally.
    await writeFile(join(opaque, "package.json"), JSON.stringify({ ...metadata,
      exports: { types: "./types/index.d.ts", ...metadata.exports },
    }));
    await writeFile(join(opaque, "types/index.d.ts"), "export declare function broken(): boolean;");
    expect(diagnostics(["selected"]).some((d) => d.code === 2322 && d.text.includes("boolean"))).toBe(true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("an unreadable runtime entry is an eligibility refusal", async () => {
  const dir = await mkdtemp("/tmp/scriptc-npm-static-unreadable-");
  try {
    const root = join(dir, "node_modules", "example");
    expect(npmStaticIneligibleReason("example", `${root}/index.d.ts`, `${root}/index.js`)).toBe(
      `its runtime entry ${root}/index.js cannot be read`,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test.each(["js", "mjs", "cjs"])("runtime inference admits readable %s only for executable AUTO", async (extension) => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-npm-static-inference-"));
  try {
    const root = join(dir, "node_modules", "example");
    await mkdir(root, { recursive: true });
    const entry = join(root, `index.${extension}`);
    await writeFile(entry, "exports.answer = 42;\n");
    expect(npmStaticIneligibleReason("example", entry, entry, true)).toBeNull();
    expect(npmStaticIneligibleReason("example", entry, entry)).toBe("it ships no own .d.ts declaration surface");
    expect(npmStaticIneligibleReason("example", entry, null, true)).toBe("no runtime JS entry resolves");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test.each([
  ["exports.answer = 42;", "its shipped JS looks minified"],
  ["const loader = __webpack_require__;\nexports.answer = loader(0);\n", "its shipped JS carries build-transform markers (bundled/transpiled dist)"],
] as const)("runtime inference preserves source refusal: %s", async (source, reason) => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-npm-static-inference-refusal-"));
  try {
    const root = join(dir, "node_modules", "example");
    await mkdir(root, { recursive: true });
    const entry = join(root, "index.js");
    await writeFile(entry, source);
    expect(npmStaticIneligibleReason("example", entry, entry, true)).toBe(reason);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

const literalTable = `{${Array.from({ length: 180 }, (_, i) => `'entity${i}':'value${i}'`).join(",")}}`;
const compactBody = Array.from({ length: 80 }, (_, i) => `sink(value${i});`).join("");
test.each([
  ["literal table", `const table = ${literalTable};\nexport function read() {\n  return table.entity7;\n}\n`, null],
  ["regex literal", `const pattern = /${"(?:alpha|beta)".repeat(180)}/g;\nexport function test(value) {\n  return pattern.test(value);\n}\n`, null],
  ["nested data", `const data = [${Array.from({ length: 180 }, (_, i) => `[${i}, {text:'${"x".repeat(20)}'}]`).join(",")}];\nexport function first() {\n  return data[0][0];\n}\n`, null],
  ["plain template", `const text = \`${"abc/".repeat(1000)}\`;\nexport function read() {\n  return text;\n}\n`, null],
  ["division is code", `export function read(value) {${Array.from({ length: 80 }, (_, i) => `value=value/divisor${i};`).join("")}}\n`, "its shipped JS looks minified"],
  ["compact executable body", `export function run() {${compactBody}}\n`, "its shipped JS looks minified"],
  ["methods are executable", `const data = {run() {${compactBody}}};\nexport default data;\n`, "its shipped JS looks minified"],
  ["getters are executable", `const data = {get value() {${compactBody}}};\nexport default data;\n`, "its shipped JS looks minified"],
  ["calls are executable", `const data = [${Array.from({ length: 180 }, (_, i) => `compute(value${i})`).join(",")}];\nexport default data;\n`, "its shipped JS looks minified"],
  ["template expressions are executable", `const text = \`prefix\${(() => {${compactBody}})()}suffix\`;\nexport default text;\n`, "its shipped JS looks minified"],
  ["comments do not dilute compact code", `/*${"documentation\n".repeat(40)}*/\nexport function run() {${compactBody}}\n`, "its shipped JS looks minified"],
  ["single-line data stays refused", `const table = ${literalTable}; export default table;`, "its shipped JS looks minified"],
  ["bundler marker stays refused", `const table = ${literalTable};\nconst loader = __webpack_require__;\nexport default table;\n`, "its shipped JS carries build-transform markers (bundled/transpiled dist)"],
] as const)("AUTO readability distinguishes data from code: %s", async (_name, source, reason) => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-npm-static-data-"));
  try {
    const root = join(dir, "node_modules", "example");
    await mkdir(root, { recursive: true });
    const entry = join(root, "index.js");
    await writeFile(entry, source);
    expect(npmStaticIneligibleReason("example", entry, entry, true)).toBe(reason);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
