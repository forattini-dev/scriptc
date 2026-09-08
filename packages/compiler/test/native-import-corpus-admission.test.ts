import { globSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "vitest";
import { analyze } from "../src/index.js";

const root = resolve(import.meta.dirname, "../../..");
const entries = [
  ...globSync(`${root}/tests/corpus/304[1-9]-*/main.ts`),
  ...globSync(`${root}/tests/corpus/304[1-7]-*.ts`),
  ...globSync(`${root}/tests/corpus/3050-native-import-star-ambiguity/main.ts`),
].sort();

test.each(entries)("native import corpus prohibits the engine: %s", entry => {
  expect(readFileSync(entry, "utf8")).toContain("// @no-engine");
  const { coverage } = analyze(entry, { backend: "rust", allowEngine: false });
  expect(coverage.preflightFailed).toBe(false);
  expect(coverage.diagnostics).toEqual([]);
  expect(coverage.execution?.engine).toBe("none");
});
