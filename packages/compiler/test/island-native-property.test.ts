import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";
import { deserializeModule } from "../src/ir/serialize.js";

const execFileAsync = promisify(execFile);

function field(value: unknown, key: string): unknown {
  return value !== null && typeof value === "object" ? Reflect.get(value, key) : undefined;
}

test("native property reads keep the checked byte exit without marshaling its copy back", async () => {
  const entry = resolve(import.meta.dirname, "../../../tests/corpus/3155-island-native-property-reads/main.ts");
  const directory = await mkdtemp(join(tmpdir(), "scriptc-island-native-property-"));
  try {
    const result = await compile(entry, {
      outDir: directory, outPath: join(directory, "program"),
      backend: "rust", dynamic: true, optimization: "dev", emitIr: true,
    });
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
    if (!result.irPath) throw new Error("expected compiler IR output");
    const module = deserializeModule(await readFile(result.irPath, "utf8"));
    let directByteReads = 0;
    let copiedBytesSentBack = 0;
    const visit = (value: unknown): void => {
      if (value === null || typeof value !== "object") return;
      if (field(value, "kind") === "bytesIntrinsic" &&
          field(field(value, "receiver"), "kind") === "jsExit") directByteReads++;
      if (field(value, "kind") === "jsMarshal" &&
          field(field(value, "value"), "kind") === "jsExit" &&
          field(field(field(value, "value"), "type"), "kind") === "bytes") copiedBytesSentBack++;
      for (const child of Object.values(value)) visit(child);
    };
    visit(module);
    expect(directByteReads).toBeGreaterThanOrEqual(4);
    expect(copiedBytesSentBack).toBe(0);
    // The optimization must retain the typed boundary's validation even
    // when only length is read from a package's lying Uint8Array declaration.
    await expect(execFileAsync(result.binaryPath, ["--lie"], { encoding: "utf8" })).rejects.toMatchObject({
      code: 1,
      stdout: "",
      stderr: expect.stringContaining("Uncaught TypeError: expected Uint8Array"),
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
