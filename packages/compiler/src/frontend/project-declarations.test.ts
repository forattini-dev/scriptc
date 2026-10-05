import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { checkPreflightTypes } from "./preflight-types.js";
import { loadProgram } from "./program.js";

/* One Node type surface per program (ProjectDeclarations): a reached
 * project's tsconfig `types` closure never adds a second copy of
 * @types/node beside the entry project's. The stubs below stand in for
 * two installed copies — what matters to the rule is package identity
 * (name + installed directory), not the declarations inside. */

const CONFIG = JSON.stringify({
  compilerOptions: { strict: true, noEmit: true, allowImportingTsExtensions: true, types: ["node"] },
  include: ["**/*.ts"],
});

function stubNodeTypes(projectDir: string, version: string): string {
  const root = join(projectDir, "node_modules", "@types", "node");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "@types/node", version, types: "index.d.ts" }));
  writeFileSync(join(root, "index.d.ts"), `declare module "node:fixture-surface" { export const version: "${version}"; }\n`);
  return root;
}

function workspace(): { dir: string; app: string; lib: string; entry: string; libFile: string } {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-node-type-surface-"));
  const app = join(dir, "app");
  const lib = join(dir, "lib");
  mkdirSync(join(lib, "src"), { recursive: true });
  mkdirSync(app, { recursive: true });
  writeFileSync(join(app, "tsconfig.json"), CONFIG);
  writeFileSync(join(lib, "tsconfig.json"), CONFIG);
  const libFile = join(lib, "src", "label.ts");
  writeFileSync(libFile, "export function label(name: string): string { return `lib:${name}`; }\n");
  const entry = join(app, "main.ts");
  writeFileSync(entry, 'import { label } from "../lib/src/label.ts";\nexport const value = label("entry");\n');
  return { dir, app, lib, entry, libFile };
}

function nodeTypeRoots(fileNames: readonly string[]): string[] {
  return [...new Set(fileNames.filter((f) => f.includes("/node_modules/@types/node/")).map((f) => f.slice(0, f.indexOf("/node_modules/@types/node/"))))].sort();
}

test("the entry project's @types/node wins over a reached project's different copy", () => {
  const ws = workspace();
  try {
    stubNodeTypes(ws.app, "24.0.0-entry");
    stubNodeTypes(ws.lib, "26.0.0-reached");
    const load = loadProgram(ws.entry);
    try {
      expect(nodeTypeRoots(load.program.getSourceFileNames())).toEqual([ws.app]);
      expect(load.nodeTypeSurfaceStandDowns(ws.entry)).toEqual([]);
      expect(load.nodeTypeSurfaceStandDowns(ws.libFile)).toEqual([
        expect.objectContaining({
          config: join(ws.lib, "tsconfig.json"),
          package: "@types/node",
          dropped: expect.objectContaining({ version: "26.0.0-reached" }),
          kept: expect.objectContaining({ version: "24.0.0-entry" }),
        }),
      ]);
    } finally { load.dispose(); }
  } finally { rmSync(ws.dir, { recursive: true, force: true }); }
});

test("identical versions installed twice are still two copies: one stands down", () => {
  const ws = workspace();
  try {
    stubNodeTypes(ws.app, "24.0.0");
    stubNodeTypes(ws.lib, "24.0.0");
    const load = loadProgram(ws.entry);
    try {
      expect(nodeTypeRoots(load.program.getSourceFileNames())).toEqual([ws.app]);
      expect(load.nodeTypeSurfaceStandDowns(ws.libFile).map((entry) => entry.package)).toEqual(["@types/node"]);
    } finally { load.dispose(); }
  } finally { rmSync(ws.dir, { recursive: true, force: true }); }
});

test("a reached project linked to the same installed copy adds nothing and stands nothing down", () => {
  const ws = workspace();
  try {
    const shared = stubNodeTypes(ws.app, "24.0.0-shared");
    mkdirSync(join(ws.lib, "node_modules", "@types"), { recursive: true });
    symlinkSync(shared, join(ws.lib, "node_modules", "@types", "node"), "dir");
    const load = loadProgram(ws.entry);
    try {
      expect(nodeTypeRoots(load.program.getSourceFileNames())).toEqual([ws.app]);
      expect(load.nodeTypeSurfaceStandDowns(ws.libFile)).toEqual([]);
    } finally { load.dispose(); }
  } finally { rmSync(ws.dir, { recursive: true, force: true }); }
});

test("without an entry-side copy, the first reached project's copy is the surface", () => {
  const ws = workspace();
  try {
    stubNodeTypes(ws.lib, "26.0.0-reached");
    const load = loadProgram(ws.entry);
    try {
      expect(nodeTypeRoots(load.program.getSourceFileNames())).toEqual([ws.lib]);
      expect(load.nodeTypeSurfaceStandDowns(ws.libFile)).toEqual([]);
      // The real surface replaced the shipped fallback declarations.
      expect(load.program.getSourceFileNames().some((f) => f.endsWith("scriptc-node-fallback.d.ts"))).toBe(false);
    } finally { load.dispose(); }
  } finally { rmSync(ws.dir, { recursive: true, force: true }); }
});

test("a type error inside the stood-down project carries the hint naming both copies", () => {
  const ws = workspace();
  try {
    stubNodeTypes(ws.app, "24.0.0-entry");
    stubNodeTypes(ws.lib, "26.0.0-reached");
    writeFileSync(ws.libFile, 'export function label(name: string): string { const n: number = name; return `lib:${n}`; }\n');
    writeFileSync(ws.entry, 'import { label } from "../lib/src/label.ts";\nexport const value: number = label("entry");\n');
    const load = loadProgram(ws.entry);
    try {
      const errors = checkPreflightTypes(load).filter((d) => d.code === "SC0001");
      const inLib = errors.filter((d) => d.loc.file === ws.libFile);
      const inEntry = errors.filter((d) => d.loc.file === ws.entry);
      expect(inLib).toHaveLength(1);
      expect(inLib[0]!.hint).toContain("@types/node 26.0.0-reached");
      expect(inLib[0]!.hint).toContain("@types/node 24.0.0-entry");
      // The entry project is checked against its own surface: no hint.
      expect(inEntry).toHaveLength(1);
      expect(inEntry[0]!.hint).toBeUndefined();
    } finally { load.dispose(); }
  } finally { rmSync(ws.dir, { recursive: true, force: true }); }
});
