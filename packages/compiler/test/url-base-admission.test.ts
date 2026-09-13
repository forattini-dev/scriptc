import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { expect, test } from "vitest";
import { analyze } from "../src/index.js";

test("fallback URL declarations admit native relative resolution", async () => {
  await setImmediate();
  const directory = mkdtempSync(join(tmpdir(), "scriptc-url-base-"));
  try {
    const entry = join(directory, "main.ts");
    writeFileSync(entry, 'console.log(new URL("../x", "https://example.test/a/b").href);\nconsole.log(URL.canParse("../x", "https://example.test/a/b"));\n');
    const { coverage } = analyze(entry, { backend: "rust", allowEngine: false });
    expect(coverage.diagnostics).toEqual([]);
    expect(coverage.execution?.engine).toBe("none");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
