import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { findSingleNpmSurfaceOffender } from "./npm-static-auto.js";
import { CheckerFacade } from "./ts7/checker.js";

test("npm type attribution does not prepare discarded programs for lowering", () => {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-npm-type-probe-"));
  const dependency = (name: string, source: string, declaration: string): void => {
    const root = join(dir, "node_modules", name);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ name, type: "module", main: "index.js", types: "index.d.ts" }));
    writeFileSync(join(root, "index.js"), source);
    writeFileSync(join(root, "index.d.ts"), declaration);
  };
  const prefetch = vi.spyOn(CheckerFacade.prototype, "prefetchSourceFileStructures");
  try {
    writeFileSync(join(dir, "package.json"), '{"type":"module"}');
    dependency("safe", "export const value = 42;", "export declare const value: number;");
    dependency("guard", "export function isText(value) { return Boolean(value); }",
      "export declare function isText(value: unknown): value is string;");
    const entry = join(dir, "main.ts");
    writeFileSync(entry, `import { value } from "safe"; import { isText } from "guard";
      function render(input: unknown): string { return isText(input) ? input.toUpperCase() : ""; }
      console.log(value, render("text"));`);
    expect(findSingleNpmSurfaceOffender(entry, new Set(["safe", "guard"]))).toBe("guard");
    expect(prefetch).not.toHaveBeenCalled();
  } finally {
    prefetch.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  }
});
