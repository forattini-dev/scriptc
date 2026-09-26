import { join } from "node:path";
import { expect, test } from "vitest";
import { resolveImportMetaRuntime, runtimePathForTarget } from "./runtime-resolve.js";

test("WASI resolution metadata uses guest paths", () => {
  const source = join(process.cwd(), "tests", "program", "main.mjs");
  expect(runtimePathForTarget(source, "wasi")).toBe("/tests/program/main.mjs");
  expect(resolveImportMetaRuntime(source, "./asset with space.js", "wasi")).toEqual({
    ok: true,
    value: "file:///tests/program/asset%20with%20space.js",
  });
});

test("Windows resolution metadata uses target URL semantics on any host", () => {
  expect(resolveImportMetaRuntime("C:\\work\\main.mjs", "./asset.js", "win32")).toEqual({
    ok: true,
    value: "file:///C:/work/asset.js",
  });
});
