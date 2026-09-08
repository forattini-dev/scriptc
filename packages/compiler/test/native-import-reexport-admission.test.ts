import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { analyze } from "../src/index.js";

test.each([
  ["runtime export-star", 'export * from "./leaf.ts";', true],
  ["type-only export-star", 'export type * from "./leaf.ts";', false],
  ["named re-exports", 'export { value, bump } from "./leaf.ts";', false],
] as const)("native namespace admission preserves %s semantics", (_name, reexport, refused) => {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-native-reexports-"));
  try {
    const entry = join(directory, "main.ts");
    writeFileSync(entry, `
      async function main(): Promise<void> {
        const namespace = await import("./module.ts");
        console.log(Object.keys(namespace).join(","));
      }
      main();
    `);
    writeFileSync(join(directory, "module.ts"), `${reexport}\nexport const local = 1;\n`);
    writeFileSync(join(directory, "leaf.ts"), `
      export type Count = number;
      export let value = 1;
      export function bump(): void { value++; }
    `);
    const { coverage } = analyze(entry, { backend: "rust", allowEngine: false });
    expect(coverage.preflightFailed).toBe(false);
    if (refused) {
      expect(coverage.diagnostics).toEqual([
        expect.objectContaining({ code: "SC1090", message: expect.stringContaining("runtime 'export *'") }),
      ]);
    } else {
      expect(coverage.diagnostics).toEqual([]);
      expect(coverage.execution?.engine).toBe("none");
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
