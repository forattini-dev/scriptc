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
