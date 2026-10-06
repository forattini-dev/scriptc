import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { isNodeTypesPath, nodeTypeSurfacePackageOf, resetNodeTypesPathCache } from "./dts-paths.js";

function install(root: string, name: string): string {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name, version: "1.0.0" }));
  const file = join(root, "index.d.ts");
  writeFileSync(file, "export {};\n");
  return file;
}

test("an ambient surface copy is named by its package.json, wherever it is installed", () => {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-dts-paths-"));
  try {
    const nested = join(dir, "node_modules", "bun-types", "node_modules", "@types", "node");
    const installed = install(nested, "@types/node");
    const vendored = install(join(dir, "app", "vendor", "node"), "@types/node");
    const bun = install(join(dir, "node_modules", "bun-types"), "bun-types");
    const undici = install(join(dir, "node_modules", "undici-types"), "undici-types");
    const other = install(join(dir, "node_modules", "left-pad"), "left-pad");
    const own = install(join(dir, "app"), "app");
    mkdirSync(join(nested, "assert"), { recursive: true });
    const deep = join(nested, "assert", "strict.d.ts");
    writeFileSync(deep, "export {};\n");

    expect(nodeTypeSurfacePackageOf(installed)).toEqual({ name: "@types/node", root: nested });
    expect(nodeTypeSurfacePackageOf(deep)).toEqual({ name: "@types/node", root: nested });
    expect(nodeTypeSurfacePackageOf(vendored)).toEqual({ name: "@types/node", root: join(dir, "app", "vendor", "node") });
    expect(nodeTypeSurfacePackageOf(bun)?.name).toBe("bun-types");
    // undici-types is module-shaped: not an ambient copy, never elected.
    expect(nodeTypeSurfacePackageOf(undici)).toBeNull();
    expect(nodeTypeSurfacePackageOf(other)).toBeNull();
    expect(nodeTypeSurfacePackageOf(own)).toBeNull();
    // Only declaration files are surface files.
    expect(nodeTypeSurfacePackageOf(join(nested, "index.js"))).toBeNull();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("lowering provenance recognizes the Node types by package name even outside node_modules", () => {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-dts-paths-"));
  try {
    resetNodeTypesPathCache();
    const vendored = install(join(dir, "app", "vendor", "node"), "@types/node");
    const own = install(join(dir, "app", "types"), "app-types");
    expect(isNodeTypesPath(vendored)).toBe(true);
    expect(isNodeTypesPath(own)).toBe(false);
    // node_modules paths keep answering by package name, undici-types included.
    expect(isNodeTypesPath(join(dir, "node_modules", "undici-types", "index.d.ts"))).toBe(true);
    expect(isNodeTypesPath(join(dir, "node_modules", "left-pad", "index.d.ts"))).toBe(false);
  } finally {
    resetNodeTypesPathCache();
    rmSync(dir, { recursive: true, force: true });
  }
});
