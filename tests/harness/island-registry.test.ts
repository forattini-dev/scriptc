import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "vitest";

test("C ESM wrappers retain every builtin registered by the C bootstrap", () => {
  const partsDir = resolve("packages/runtime/src/island-js");
  const manifest = JSON.parse(readFileSync(resolve(partsDir, "manifest.json"), "utf8")) as { c: string[] };
  const registered = new Set<string>();
  for (const file of manifest.c) {
    const source = readFileSync(resolve(partsDir, file), "utf8");
    for (const match of source.matchAll(/\bbuiltins(?:\.([\w]+)|\['([^']+)'\])\s*=\s*memo\(/g)) {
      registered.add(`node:${match[1] ?? match[2]}`);
    }
  }
  const header = readFileSync(resolve("packages/runtime/src/scr_island_manifest.h"), "utf8");
  const wrappers = new Set([...header.matchAll(/\{"(node:[^"]+)"/g)].map((match) => match[1]));
  expect(registered.size).toBeGreaterThan(0);
  expect([...wrappers].sort()).toEqual([...registered].sort());
});
