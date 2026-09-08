import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { analyze } from "../src/index.js";

test.each([
  ["runtime export-star", 'export * from "./leaf.ts";'],
  ["type-only export-star", 'export type * from "./leaf.ts";'],
  ["named re-exports", 'export { value, bump } from "./leaf.ts";'],
] as const)("native namespace admission preserves %s semantics", (_name, reexport) => {
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
    expect(coverage.diagnostics).toEqual([]);
    expect(coverage.execution?.engine).toBe("none");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("star exports preserve the refusal for mutable composite identities", () => {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-native-star-identity-"));
  try {
    const entry = join(directory, "main.ts");
    writeFileSync(entry, 'async function main() { await import("./barrel.ts"); } main();');
    writeFileSync(join(directory, "barrel.ts"), 'export * from "./leaf.ts";');
    writeFileSync(join(directory, "leaf.ts"), 'export const state = { count: 1 };');
    const { coverage } = analyze(entry, { backend: "rust", allowEngine: false });
    expect(coverage.preflightFailed).toBe(false);
    expect(coverage.diagnostics).toEqual([
      expect.objectContaining({ code: "SC1090", message: expect.stringContaining("export 'state'") }),
    ]);
    expect(coverage.diagnostics[0]?.message).toContain("identity");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test.each([
  ["direct", 'export * from "./outer.ts";'],
  ["after a previously visited star", 'export * from "./left.ts";\n// @ts-ignore\nexport * from "./outer.ts";'],
  ["hidden by an explicit root export", 'export { conflict } from "./left.ts"; export * from "./outer.ts";'],
])("an ambiguous named re-export stays refused when %s", (_name, root) => {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-native-star-conflict-"));
  try {
    const entry = join(directory, "main.ts");
    writeFileSync(entry, 'async function main() { await import("./root.ts"); } main();');
    writeFileSync(join(directory, "root.ts"), root);
    writeFileSync(join(directory, "outer.ts"), 'export { conflict } from "./barrel.ts";');
    writeFileSync(join(directory, "barrel.ts"), [
      'export * from "./left.ts";',
      '// @ts-ignore -- exercise native linking after the checker diagnostic is suppressed',
      'export * from "./right.ts";',
    ].join("\n"));
    writeFileSync(join(directory, "left.ts"), 'export const conflict = "left";');
    writeFileSync(join(directory, "right.ts"), 'export const conflict = "right";');
    const { coverage } = analyze(entry, { backend: "rust", allowEngine: false });
    expect(coverage.preflightFailed).toBe(false);
    expect(coverage.diagnostics).toEqual([
      expect.objectContaining({ code: "SC1090", message: expect.stringContaining("conflicting wildcard bindings") }),
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
