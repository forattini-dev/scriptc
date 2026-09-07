import { mkdtempSync, mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { checkPreflight, loadProgram } from "../src/frontend/program.js";
import { FrontendInputTracker, frontendInputsStillMatch } from "../src/frontend/input-tracker.js";

function fixture(run: (dir: string, pkg: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-type-exports-"));
  const pkg = join(dir, "node_modules", "type-exports");
  mkdirSync(join(pkg, "src"), { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({
    name: "type-exports", type: "module", main: "src/index.js", types: "index.d.ts",
    exports: { ".": { import: "./src/index.js", types: "./index.d.ts" } },
  }));
  writeFileSync(join(pkg, "src/index.js"), "export function run() { return 7; }\n");
  writeFileSync(join(pkg, "index.d.ts"), `
    export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
    export interface JsonObject { [key: string]: JsonValue }
    export interface Shape { value: number }
    export interface Extended extends Shape { label: string }
    export function run(): string;
  `);
  try { run(dir, pkg); } finally { rmSync(dir, { recursive: true, force: true }); }
}

function preflight(dir: string, source: string, selected = true): string[] {
  const entry = join(dir, "main.ts");
  writeFileSync(entry, source);
  const loaded = loadProgram(entry, { npmStatic: selected ? ["type-exports"] : [] });
  try { return checkPreflight(loaded).map((d) => d.message); } finally { loaded.dispose(); }
}

test("static JS keeps declared type-only exports while inferring executable signatures", () => {
  fixture((dir) => {
    expect(preflight(dir, `
      import { run, type JsonValue, type JsonObject, type Extended } from "type-exports";
      const n: number = run();
      const shape: Extended = { value: n, label: "native" };
      const object: JsonObject = { nested: [shape.value, null, true] };
      const value: JsonValue = object;
      console.log(shape.label);
    `)).toEqual([]);
  });
});

test("declared value signatures still cannot override JS inference", () => {
  fixture((dir) => {
    expect(preflight(dir, 'import { run } from "type-exports"; const s: string = run();'))
      .toContain("Type 'number' is not assignable to type 'string'.");
  });
});

test("type-only bridge state does not affect a later flagless load", () => {
  fixture((dir) => {
    expect(preflight(dir, 'import { run } from "type-exports"; const n: number = run();')).toEqual([]);
    expect(preflight(dir, 'import { run } from "type-exports"; const n: number = run();', false))
      .toContain("Type 'string' is not assignable to type 'number'.");
  });
});

test("edits to hidden declarations invalidate tracked inputs and refresh the next load", () => {
  fixture((dir, pkg) => {
    const source = 'import type { Shape } from "type-exports"; const s: Shape = { value: 7 };';
    const tracker = new FrontendInputTracker();
    expect(tracker.run(() => preflight(dir, source))).toEqual([]);
    const snapshot = tracker.snapshot();
    expect(frontendInputsStillMatch(snapshot)).toBe(true);
    writeFileSync(join(pkg, "index.d.ts"), "export interface Shape { value: string }");
    expect(frontendInputsStillMatch(snapshot)).toBe(false);
    expect(preflight(dir, source)).toContain("Type 'number' is not assignable to type 'string'.");
  });
});

test("exact package subpaths bridge their own type surface", () => {
  fixture((dir, pkg) => {
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "type-exports", type: "module",
      exports: { "./node": { import: "./src/index.js", types: "./index.d.ts" } },
    }));
    expect(preflight(dir, 'import { run, type Shape } from "type-exports/node"; const s: Shape = { value: run() };'))
      .toEqual([]);
  });
});

test("legacy main/types mappings preserve type exports", () => {
  fixture((dir, pkg) => {
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "type-exports", type: "module",
      main: "src/index.js", types: "index.d.ts",
    }));
    expect(preflight(dir, 'import { run, type Shape } from "type-exports"; const s: Shape = { value: run() };'))
      .toEqual([]);
  });
});

test("declaration-only values never become executable exports", () => {
  fixture((dir, pkg) => {
    writeFileSync(join(pkg, "index.d.ts"), `
      export interface Shape { value: number }
      export declare function imaginary(): number;
      export declare class Ghost { value: number }
      export declare const secret: number;
    `);
    const messages = preflight(dir, 'import { imaginary, Ghost, secret, type Shape } from "type-exports";');
    for (const name of ["imaginary", "Ghost", "secret"]) {
      expect(messages).toContain(`Module '\"type-exports\"' has no exported member '${name}'.`);
    }
    expect(messages.some((m) => m.includes("'Shape'"))).toBe(false);
  });
});

test("declaration interfaces cannot shadow runtime class inference", () => {
  fixture((dir, pkg) => {
    writeFileSync(join(pkg, "src/index.js"), 'export class Shape { value = "runtime"; }\n');
    expect(preflight(dir, 'import { Shape } from "type-exports"; const s: string = new Shape().value;')).toEqual([]);
  });
});

test("dependent declarations stay unsupported instead of introducing unresolved type aliases", () => {
  fixture((dir, pkg) => {
    writeFileSync(join(pkg, "index.d.ts"), 'import type { Inner } from "./inner.js"; export type Shape = Inner;');
    writeFileSync(join(pkg, "inner.d.ts"), "export interface Inner { value: number }");
    expect(preflight(dir, 'import type { Shape } from "type-exports";')).toContain(
      "Module '\"type-exports\"' has no exported member 'Shape'.",
    );
  });
});

test("workspace symlinks retain the bridge at runtime source realpaths", () => {
  fixture((dir, pkg) => {
    const workspace = join(dir, "workspace-package");
    renameSync(pkg, workspace);
    symlinkSync(workspace, pkg, process.platform === "win32" ? "junction" : "dir");
    expect(preflight(dir, 'import { run, type Shape } from "type-exports"; const s: Shape = { value: run() };'))
      .toEqual([]);
  });
});

test("internal mjs modules bridge sibling declarations", () => {
  fixture((dir, pkg) => {
    writeFileSync(join(pkg, "src/internal.mjs"), "export function nested() { return 8; }\n");
    writeFileSync(join(pkg, "src/internal.d.mts"), "export interface Item { value: number }");
    writeFileSync(join(pkg, "src/index.js"), `
      export { nested } from "./internal.mjs";
      export function run() { return 7; }
    `);
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "type-exports", type: "module",
      main: "src/index.js", types: "index.d.ts",
    }));
    expect(preflight(dir, 'import { nested, type Item } from "type-exports/src/internal.mjs"; const s: Item = { value: nested() };'))
      .toEqual([]);
  });
});

test("merged interfaces generate one alias and retain every member", () => {
  fixture((dir, pkg) => {
    writeFileSync(join(pkg, "index.d.ts"), "export interface Shape { value: number } export interface Shape { label: string }");
    expect(preflight(dir, 'import type { Shape } from "type-exports"; const s: Shape = { value: 7 };'))
      .toContain("Property 'label' is missing in type '{ value: number; }' but required in type 'Shape'.");
  });
});

test("two declaration surfaces for one runtime entry remain ambiguous", () => {
  fixture((dir, pkg) => {
    writeFileSync(join(pkg, "other.d.ts"), "export interface Shape { value: string }");
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "type-exports", type: "module",
      exports: {
        ".": { import: "./src/index.js", types: "./index.d.ts" },
        "./other": { import: "./src/index.js", types: "./other.d.ts" },
      },
    }));
    expect(preflight(dir, 'import type { Shape } from "type-exports";'))
      .toContain("Module '\"type-exports\"' has no exported member 'Shape'.");
  });
});
