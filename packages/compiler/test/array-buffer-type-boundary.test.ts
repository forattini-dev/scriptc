import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { analyze } from "../src/index.js";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

test("static ArrayBuffer construction keeps its unsupported standard-library diagnostic", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-array-buffer-static-"));
  dirs.push(dir);
  const entry = join(dir, "main.ts");
  await writeFile(entry, "const buffer = new ArrayBuffer(8);\nconsole.log(buffer.byteLength);\n");

  const result = analyze(entry);

  expect(result.coverage.diagnostics.map((diagnostic) => diagnostic.code)).toContain("SC2020");
  expect(result.coverage.diagnostics.map((diagnostic) => diagnostic.code)).not.toContain("SC2011");
});
