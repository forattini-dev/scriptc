import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { expect, test } from "vitest";
import { analyze } from "../src/index.js";

test("fallback declarations expose native global crypto UUID calls", async () => {
  await setImmediate();
  const directory = mkdtempSync(join(tmpdir(), "scriptc-global-crypto-"));
  try {
    const entry = join(directory, "main.ts");
    writeFileSync(entry, 'console.log(crypto.randomUUID().length, globalThis.crypto.randomUUID().length);\n');
    const { coverage } = analyze(entry, { backend: "rust", allowEngine: false });
    expect(coverage.diagnostics).toEqual([]);
    expect(coverage.execution?.engine).toBe("none");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
