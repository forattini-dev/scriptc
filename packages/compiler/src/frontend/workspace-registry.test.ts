import { expect, test } from "vitest";
import { npmPackageNameOf } from "./workspace-registry.js";

test("native and normalized paths attribute the innermost npm package identically", () => {
  for (const [path, name] of [
    ["C:/repo/node_modules/yaml/dist/public-api.js", "yaml"],
    ["C:/repo/node_modules/.pnpm/@scope+codec@1/node_modules/@scope/codec/dist/encode.js", "@scope/codec"],
    ["//server/share/node_modules/outer/node_modules/inner/index.js", "inner"],
  ] as const) {
    expect(npmPackageNameOf(path)).toBe(name);
    expect(npmPackageNameOf(path.replaceAll("/", "\\"))).toBe(name);
    expect(npmPackageNameOf(path.replace("/node_modules/", "\\node_modules\\"))).toBe(name);
  }
});
