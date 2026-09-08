import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { analyze } from "../src/index.js";

test("static function property aliases remain an explicit native-import boundary", () => {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-native-function-boundary-"));
  try {
    const entry = join(directory, "main.ts");
    writeFileSync(join(directory, "module.ts"), "export function exportedFn(): number { return 1; }\n");
    writeFileSync(entry, `
      import { exportedFn } from "./module.ts";
      async function main(): Promise<void> {
        const staticFunction: any = exportedFn;
        staticFunction.label = "kept";
        const namespace = await import("./module.ts");
        const importedFunction: any = namespace.exportedFn;
        console.log(importedFunction.label as string);
      }
      void main();
    `);
    // This static function alias does not yet enter checked-dynamic property
    // storage. Do not mistake its refusal for namespace identity support.
    const { coverage } = analyze(entry, { backend: "rust", allowEngine: false });
    expect(coverage.preflightFailed).toBe(false);
    expect(coverage.diagnostics).toContainEqual(expect.objectContaining({
      code: "SC1090",
      message: "assignment to non-variables are not supported yet",
    }));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
