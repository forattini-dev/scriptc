import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "vitest";
import { NODE_COMPAT_MATRIX } from "@scriptc/compiler";
import { oracleExecutableForTarget } from "./node-matrix.js";

test.for(["node24", "node26", "bun"] as const)("native BigInt vectors match %s", (target, { skip }) => {
  const root = resolve(import.meta.dirname, "../..");
  let executable: string;
  try { executable = oracleExecutableForTarget(target, NODE_COMPAT_MATRIX); }
  catch (error) { return skip(error instanceof Error ? error.message : String(error)); }
  const output = execFileSync(executable, [resolve(root, "scripts/bigint-oracle.mjs")], {
    encoding: "utf8", timeout: 20_000, maxBuffer: 8 * 1024 * 1024,
  });
  const suffix = target === "node24" ? "" : `-${target}`;
  expect(output).toBe(readFileSync(resolve(root, `packages/runtime-rust/src/tests/bigint-oracle${suffix}.tsv`), "utf8"));
});
