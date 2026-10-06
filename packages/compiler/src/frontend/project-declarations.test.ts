import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { checkPreflightTypes } from "./preflight-types.js";
import { compareSurfaceVersions } from "./project-declarations.js";
import { checkPreflightTs7, loadProgram, type LoadResult } from "./program.js";
import { Ts7Host } from "./ts7/program-adapter.js";

/* One copy of each ambient Node type package per program
 * (ProjectDeclarations): the newest copy any reached project resolves wins,
 * the first discovered copy winning a tie, and every other copy stands down:
 * its files leave the roots and are served empty. The stubs below stand in
 * for installed copies. What matters to the rule is package identity (the
 * package.json name and the installed directory) and version, not the
 * declarations inside, except where a test needs a declaration that differs
 * between copies. */

const config = (extra: Record<string, unknown> = {}): string => JSON.stringify({
  compilerOptions: { strict: true, noEmit: true, allowImportingTsExtensions: true, types: ["node"], ...extra },
  include: ["**/*.ts"],
});

/** An installed @types/node stand-in: `node:fixture-surface` carries its
 * version, a member only some copies declare, and an `undici-types` import
 * that resolves from the install's own location. */
function stubNodeTypes(projectDir: string, version: string, members = ""): string {
  const root = join(projectDir, "node_modules", "@types", "node");
  writeSurface(root, "@types/node", version,
    `declare module "node:fixture-surface" {\n  import type { Agent } from "undici-types";\n  export const version: "${version}";\n  export const agent: Agent;\n${members}}\n`);
  writeUndici(projectDir, version);
  return root;
}

function stubBunTypes(projectDir: string, version: string): string {
  const root = join(projectDir, "node_modules", "bun-types");
  writeSurface(root, "bun-types", version,
    `declare module "bun:fixture-surface" {\n  import type { Agent } from "undici-types";\n  export const version: "${version}";\n  export const agent: Agent;\n}\n`);
  writeUndici(projectDir, version);
  return root;
}

function writeSurface(root: string, name: string, version: string, declarations: string): void {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name, version, types: "index.d.ts" }));
  writeFileSync(join(root, "index.d.ts"), declarations);
}

function writeUndici(projectDir: string, tag: string): void {
  const root = join(projectDir, "node_modules", "undici-types");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "undici-types", version: `0.0.0-${tag}`, types: "index.d.ts" }));
  writeFileSync(join(root, "index.d.ts"), `export interface Agent { readonly tag: "${tag}"; }\n`);
}

interface Workspace { dir: string; app: string; lib: string; entry: string; libFile: string }

function workspace(): Workspace {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-node-type-surface-"));
  const app = join(dir, "app");
  const lib = join(dir, "lib");
  mkdirSync(join(lib, "src"), { recursive: true });
  mkdirSync(app, { recursive: true });
  writeFileSync(join(app, "tsconfig.json"), config());
  writeFileSync(join(lib, "tsconfig.json"), config());
  const libFile = join(lib, "src", "label.ts");
  writeFileSync(libFile, "export function label(name: string): string { return `lib:${name}`; }\n");
  const entry = join(app, "main.ts");
  writeFileSync(entry, 'import { label } from "../lib/src/label.ts";\nexport const value = label("entry");\n');
  return { dir, app, lib, entry, libFile };
}

function withWorkspace(body: (ws: Workspace) => void): void {
  const ws = workspace();
  try { body(ws); } finally { rmSync(ws.dir, { recursive: true, force: true }); }
}

/** The install directories of `pkg` copies whose files the program carries
 * WITH CONTENT: a stood-down copy that is still reached (a type directive
 * resolves into it) is in the program, but served empty. */
function carried(load: LoadResult, pkg = "@types/node"): string[] {
  const marker = `/node_modules/${pkg}/`;
  const roots = new Set<string>();
  for (const name of load.program.getSourceFileNames()) {
    const at = name.lastIndexOf(marker);
    // A file of a package nested inside this one belongs to that package.
    if (at < 0 || name.slice(at + marker.length - 1).includes("/node_modules/")) continue;
    if ((load.program.getSourceFile(name)?.text ?? "") === "") continue;
    roots.add(name.slice(0, at));
  }
  return [...roots].sort();
}

test("the newest copy wins over the entry's: the entry's copy stands down, the reached project's is carried", () => {
  withWorkspace((ws) => {
    stubNodeTypes(ws.app, "24.0.0-entry");
    stubNodeTypes(ws.lib, "26.0.0-reached");
    const load = loadProgram(ws.entry);
    try {
      expect(carried(load)).toEqual([ws.lib]);
      expect(load.nodeTypeSurfaceStandDowns(ws.libFile)).toEqual([]);
      expect(load.nodeTypeSurfaceStandDowns(ws.entry)).toEqual([
        expect.objectContaining({
          config: join(ws.app, "tsconfig.json"),
          package: "@types/node",
          dropped: expect.objectContaining({ version: "24.0.0-entry" }),
          kept: expect.objectContaining({ version: "26.0.0-reached" }),
        }),
      ]);
    } finally { load.dispose(); }
  });
});

test("an older reached copy stands down beside the entry's newer one", () => {
  withWorkspace((ws) => {
    stubNodeTypes(ws.app, "26.0.0-entry");
    stubNodeTypes(ws.lib, "24.0.0-reached");
    const load = loadProgram(ws.entry);
    try {
      expect(carried(load)).toEqual([ws.app]);
      expect(load.nodeTypeSurfaceStandDowns(ws.entry)).toEqual([]);
      expect(load.nodeTypeSurfaceStandDowns(ws.libFile)).toEqual([
        expect.objectContaining({
          package: "@types/node",
          dropped: expect.objectContaining({ version: "24.0.0-reached" }),
          kept: expect.objectContaining({ version: "26.0.0-entry" }),
        }),
      ]);
    } finally { load.dispose(); }
  });
});

test("the undici-types a stood-down @types/node resolved with goes with it; the winner's stays", () => {
  withWorkspace((ws) => {
    stubNodeTypes(ws.app, "24.0.0-entry");
    stubNodeTypes(ws.lib, "26.0.0-reached");
    const load = loadProgram(ws.entry);
    try {
      const undici = load.program.getSourceFileNames().filter((name) => name.includes("/node_modules/undici-types/"));
      expect(undici).toEqual([join(ws.lib, "node_modules", "undici-types", "index.d.ts")]);
      // undici-types is module-shaped, not an elected package: no record names it.
      expect(load.nodeTypeSurfaceStandDowns(ws.entry).map((entry) => entry.package)).toEqual(["@types/node"]);
    } finally { load.dispose(); }
  });
});

test("identical versions installed twice: the first discovered copy (the entry's) wins", () => {
  withWorkspace((ws) => {
    stubNodeTypes(ws.app, "24.0.0");
    stubNodeTypes(ws.lib, "24.0.0");
    const load = loadProgram(ws.entry);
    try {
      expect(carried(load)).toEqual([ws.app]);
      expect(load.nodeTypeSurfaceStandDowns(ws.libFile).map((entry) => entry.package)).toEqual(["@types/node"]);
      expect(load.nodeTypeSurfaceStandDowns(ws.entry)).toEqual([]);
    } finally { load.dispose(); }
  });
});

test("a reached project linked to the same installed copy adds nothing and stands nothing down", () => {
  withWorkspace((ws) => {
    const shared = stubNodeTypes(ws.app, "24.0.0-shared");
    mkdirSync(join(ws.lib, "node_modules", "@types"), { recursive: true });
    symlinkSync(shared, join(ws.lib, "node_modules", "@types", "node"), "dir");
    const load = loadProgram(ws.entry);
    try {
      expect(carried(load)).toEqual([ws.app]);
      expect(load.nodeTypeSurfaceStandDowns(ws.libFile)).toEqual([]);
      expect(load.nodeTypeSurfaceStandDowns(ws.entry)).toEqual([]);
    } finally { load.dispose(); }
  });
});

test("without an entry-side copy, the newest reached copy is the surface whatever the import order", () => {
  for (const [first, second] of [["24.0.0-first", "26.0.0-second"], ["26.0.0-first", "24.0.0-second"]] as const) {
    withWorkspace((ws) => {
      const lib2 = join(ws.dir, "lib2");
      mkdirSync(join(lib2, "src"), { recursive: true });
      writeFileSync(join(lib2, "tsconfig.json"), config());
      writeFileSync(join(lib2, "src", "other.ts"), "export const other = 1;\n");
      writeFileSync(ws.entry, 'import { label } from "../lib/src/label.ts";\nimport { other } from "../lib2/src/other.ts";\nexport const value = label("entry") + other;\n');
      stubNodeTypes(ws.lib, first);
      stubNodeTypes(lib2, second);
      const load = loadProgram(ws.entry);
      try {
        expect(carried(load)).toEqual([first.startsWith("26") ? ws.lib : lib2]);
        // The real surface replaced the shipped fallback declarations.
        expect(load.program.getSourceFileNames().some((f) => f.endsWith("scriptc-node-fallback.d.ts"))).toBe(false);
      } finally { load.dispose(); }
    });
  }
});

test("a type directive in a reached project's declaration file does not bring a stood-down copy back", () => {
  withWorkspace((ws) => {
    stubNodeTypes(ws.app, "24.0.0-entry");
    stubNodeTypes(ws.lib, "26.0.0-reached");
    // tsgo resolves `/// <reference types="node" />` on its own, through the
    // entry directory's node_modules/@types: the entry's (older) copy.
    writeFileSync(join(ws.lib, "env.d.ts"), '/// <reference types="node" />\nexport {};\n');
    const load = loadProgram(ws.entry);
    try {
      expect(carried(load)).toEqual([ws.lib]);
      // The directive did reach the entry's copy; it is served empty.
      const appIndex = join(ws.app, "node_modules", "@types", "node", "index.d.ts");
      expect(load.program.getSourceFileNames()).toContain(appIndex);
      expect(load.program.getSourceFile(appIndex)?.text).toBe("");
    } finally { load.dispose(); }
  });
});

test("a copy only a type directive reaches joins the election, and wins when it is the newest", () => {
  withWorkspace((ws) => {
    // The entry directory has no @types/node of its own: lib's env.d.ts
    // directive resolves into lib2's nested copy, which no configuration's
    // types closure selects (`types: []`).
    const lib2 = join(ws.dir, "lib2");
    mkdirSync(join(lib2, "src"), { recursive: true });
    writeFileSync(join(lib2, "tsconfig.json"), config({ types: [] }));
    writeFileSync(join(lib2, "env.d.ts"), '/// <reference types="node" />\nexport {};\n');
    writeFileSync(join(lib2, "src", "other.ts"), "export const other = 1;\n");
    stubNodeTypes(ws.lib, "24.0.0-selected");
    stubNodeTypes(lib2, "26.0.0-directive-only");
    writeFileSync(ws.entry, 'import { label } from "../lib/src/label.ts";\nimport { other } from "../lib2/src/other.ts";\nexport const value = label("entry") + other;\n');
    const load = loadProgram(ws.entry);
    try {
      expect(carried(load)).toEqual([lib2]);
      expect(load.nodeTypeSurfaceStandDowns(ws.libFile).map((entry) => [entry.dropped.version, entry.kept.version])).toEqual([["24.0.0-selected", "26.0.0-directive-only"]]);
    } finally { load.dispose(); }
  });
});

test("a copy a referenced project's configuration selects joins the election", () => {
  withWorkspace((ws) => {
    writeFileSync(join(ws.app, "tsconfig.json"), JSON.stringify({
      compilerOptions: { strict: true, noEmit: true, allowImportingTsExtensions: true, types: ["node"] },
      include: ["**/*.ts"],
      references: [{ path: "../lib" }],
    }));
    writeFileSync(ws.entry, "export const value = 1;\n");
    stubNodeTypes(ws.app, "24.0.0-entry");
    stubNodeTypes(ws.lib, "26.0.0-referenced");
    const load = loadProgram(ws.entry);
    try {
      expect(carried(load)).toEqual([ws.lib]);
      expect(load.nodeTypeSurfaceStandDowns(ws.entry).map((entry) => entry.dropped.version)).toEqual(["24.0.0-entry"]);
    } finally { load.dispose(); }
  });
});

test("a copy vendored outside node_modules, named by tsconfig typeRoots, is a copy by its package.json name", () => {
  withWorkspace((ws) => {
    const vendor = join(ws.app, "vendor", "node");
    writeSurface(vendor, "@types/node", "25.0.0-vendored",
      'declare module "node:fixture-surface" {\n  export const version: "25.0.0-vendored";\n}\n');
    writeFileSync(join(ws.app, "tsconfig.json"), config({ typeRoots: ["./vendor"] }));
    writeFileSync(ws.entry, "export const value = 1;\n");
    // An older copy sits in an ancestor node_modules, where a plain walk would find it.
    stubNodeTypes(ws.dir, "22.0.0-ancestor");
    const load = loadProgram(ws.entry);
    try {
      const names = load.program.getSourceFileNames();
      expect(load.program.getSourceFile(join(vendor, "index.d.ts"))?.text).toContain("25.0.0-vendored");
      expect(carried(load)).toEqual([]);
      expect(names.some((f) => f.endsWith("scriptc-node-fallback.d.ts"))).toBe(false);
      expect(load.nodeTypeSurfaceStandDowns(ws.entry)).toEqual([]);
    } finally { load.dispose(); }
  });
});

test("bun-types copies compete by version; undici-types is not elected and both installs stay", () => {
  withWorkspace((ws) => {
    writeFileSync(join(ws.app, "tsconfig.json"), config({ types: ["bun-types"] }));
    writeFileSync(join(ws.lib, "tsconfig.json"), config({ types: ["bun-types"] }));
    stubBunTypes(ws.app, "1.0.0");
    stubBunTypes(ws.lib, "1.1.0");
    const load = loadProgram(ws.entry);
    try {
      expect(carried(load, "bun-types")).toEqual([ws.lib]);
      expect(load.nodeTypeSurfaceStandDowns(ws.entry).map((entry) => [entry.package, entry.dropped.version, entry.kept.version])).toEqual([["bun-types", "1.0.0", "1.1.0"]]);
      // Each bun-types install imports the undici-types beside it: a module,
      // declaring nothing twice, so neither copy is dropped or recorded.
      const undici = load.program.getSourceFileNames().filter((name) => name.includes("/node_modules/undici-types/")).sort();
      expect(undici).toEqual([join(ws.app, "node_modules", "undici-types", "index.d.ts"), join(ws.lib, "node_modules", "undici-types", "index.d.ts")].sort());
    } finally { load.dispose(); }
  });
});

test("a copy reached only through a stood-down package's directive stays in the program as a root", () => {
  withWorkspace((ws) => {
    // The Bun shape: @types/bun chains bun-types, which carries its own
    // @types/node and pulls it in with a type directive. The entry's
    // @types/bun is adopted by the ancestor walk (its config lists no types,
    // so no closure names the nested copy); lib's newer bun-types wins, the
    // entry's stands down, and with it the only file that reached the nested
    // @types/node.
    writeFileSync(join(ws.app, "tsconfig.json"), config({ types: [] }));
    writeFileSync(join(ws.lib, "tsconfig.json"), config({ types: ["bun-types"] }));
    writeSurface(join(ws.app, "node_modules", "@types", "bun"), "@types/bun", "1.0.0", '/// <reference types="bun-types" />\n');
    const bun = stubBunTypes(ws.app, "1.0.0");
    writeFileSync(join(bun, "index.d.ts"), `/// <reference types="node" />\n${readFileSync(join(bun, "index.d.ts"), "utf8")}`);
    stubNodeTypes(bun, "26.0.0-nested");
    stubBunTypes(ws.lib, "1.1.0");
    const load = loadProgram(ws.entry);
    try {
      expect(carried(load, "bun-types")).toEqual([ws.lib]);
      expect(carried(load)).toEqual([bun]);
      // The stood-down bun-types has no content left in the program.
      expect(load.program.getSourceFile(join(bun, "index.d.ts"))?.text ?? "").toBe("");
    } finally { load.dispose(); }
  });
});

test("the declarations of the carried copy are the ones every project is checked against", () => {
  withWorkspace((ws) => {
    stubNodeTypes(ws.app, "24.0.0-entry", "  export const legacyOnly: 1;\n");
    stubNodeTypes(ws.lib, "26.0.0-reached");
    writeFileSync(ws.entry, [
      'import { legacyOnly } from "node:fixture-surface";',
      'import { label } from "../lib/src/label.ts";',
      'export const value = label("entry") + legacyOnly;',
      "",
    ].join("\n"));
    const load = loadProgram(ws.entry);
    try {
      const errors = checkPreflightTypes(load).filter((d) => d.code === "SC0001");
      expect(errors.map((d) => d.message)).toEqual(['Module \'"node:fixture-surface"\' has no exported member \'legacyOnly\'.']);
    } finally { load.dispose(); }
  });
});

test("a declaration-shaped error inside the stood-down project carries the hint naming both copies; other errors do not", () => {
  withWorkspace((ws) => {
    stubNodeTypes(ws.app, "24.0.0-entry", "  export const legacyOnly: 1;\n");
    stubNodeTypes(ws.lib, "26.0.0-reached");
    writeFileSync(ws.entry, [
      'import { legacyOnly } from "node:fixture-surface";',
      'import { label } from "../lib/src/label.ts";',
      "export const missing = legacyOnly;",
      'export const wrong: number = label("entry");',
      "",
    ].join("\n"));
    writeFileSync(ws.libFile, 'export function label(name: string): string { const n: number = name; return `lib:${n}`; }\n');
    const load = loadProgram(ws.entry);
    try {
      const errors = checkPreflightTypes(load).filter((d) => d.code === "SC0001");
      const declaration = errors.filter((d) => d.loc.file === ws.entry && d.message.includes("legacyOnly"));
      const unrelated = errors.filter((d) => d.loc.file === ws.entry && d.message.includes("not assignable"));
      const inLib = errors.filter((d) => d.loc.file === ws.libFile);
      expect(declaration).toHaveLength(1);
      expect(declaration[0]!.hint).toContain("@types/node 24.0.0-entry");
      expect(declaration[0]!.hint).toContain("@types/node 26.0.0-reached");
      // A type mismatch the Node declarations cannot explain carries no hint.
      expect(unrelated).toHaveLength(1);
      expect(unrelated[0]!.hint).toBeUndefined();
      // The reached project's copy is the one carried: nothing stood down for it.
      expect(inLib).toHaveLength(1);
      expect(inLib[0]!.hint).toBeUndefined();
    } finally { load.dispose(); }
  });
});

test("a host shared with a later load serves the real copies again: a load gives its shadows back", () => {
  withWorkspace((ws) => {
    stubNodeTypes(ws.app, "24.0.0-entry");
    stubNodeTypes(ws.lib, "26.0.0-reached");
    const solo = join(ws.app, "solo.ts");
    writeFileSync(solo, 'import { version } from "node:fixture-surface";\nexport const v: string = version;\n');
    const host = new Ts7Host({ cwd: ws.dir });
    try {
      // The first load elects lib's copy and serves the app's empty...
      const typeErrors = (entry: string): string[] => checkPreflightTs7(entry, host).diags.filter((d) => d.code === "SC0001").map((d) => d.message);
      expect(typeErrors(ws.entry)).toEqual([]);
      // ...the second load reaches only the app's copy, which must be whole.
      expect(typeErrors(solo)).toEqual([]);
    } finally { host.close(); }
  });
});

test("versions order newest first: prereleases below their release, unparseable versions last", () => {
  expect(compareSurfaceVersions("26.1.2", "25.9.5")).toBeGreaterThan(0);
  expect(compareSurfaceVersions("22.20.1", "24.13.3")).toBeLessThan(0);
  expect(compareSurfaceVersions("24.13.3", "24.13.3")).toBe(0);
  expect(compareSurfaceVersions("26.0.0", "26.0.0-fixture")).toBeGreaterThan(0);
  expect(compareSurfaceVersions("26.0.0-fixture", "24.99.99")).toBeGreaterThan(0);
  expect(compareSurfaceVersions("1.0.0", null)).toBeGreaterThan(0);
  expect(compareSurfaceVersions("not-a-version", "0.0.1")).toBeLessThan(0);
  expect(compareSurfaceVersions(null, null)).toBe(0);
});
