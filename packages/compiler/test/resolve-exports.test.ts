import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  NPM_STATIC_EXPORT_CONDITIONS,
  clearResolveCaches,
  resolveBareModule,
  resolveExports,
  resolveRelativeModule,
} from "../src/frontend/resolve.js";
import { npmStaticTransformPkgJson, setNpmStaticPackages } from "../src/frontend/npm-static.js";

describe("npm-static export conditions", () => {
  it("selects a package's scriptc entry before its normal import entry", () => {
    const exports = {
      ".": {
        types: "./dist/index.d.ts",
        scriptc: "./dist/portable.js",
        import: "./dist/index.js",
        default: "./dist/index.js",
      },
    };

    expect(resolveExports(exports, ".", NPM_STATIC_EXPORT_CONDITIONS))
      .toBe("./dist/portable.js");
  });

  it("falls back to import when a package has no scriptc entry", () => {
    const exports = {
      ".": {
        import: "./dist/index.js",
        default: "./dist/index.js",
      },
    };

    expect(resolveExports(exports, ".", NPM_STATIC_EXPORT_CONDITIONS))
      .toBe("./dist/index.js");
  });

  it("exposes the scriptc entry to the TypeScript import condition", () => {
    const pkg = {
      exports: {
        ".": {
          types: "./dist/index.d.ts",
          scriptc: "./dist/portable.js",
          import: "./dist/index.js",
          default: "./dist/index.js",
        },
      },
    };

    npmStaticTransformPkgJson(pkg);

    expect(pkg.exports["."]).toEqual({
      import: "./dist/portable.js",
      require: "./dist/portable.js",
      default: "./dist/index.js",
    });
  });

  it("resolves an explicit TypeScript scriptc entry as runtime source", async () => {
    const root = await mkdtemp(join(tmpdir(), "scriptc-export-condition-"));
    try {
      const packageDir = join(root, "node_modules", "portable-package");
      await mkdir(join(packageDir, "src"), { recursive: true });
      await writeFile(
        join(packageDir, "src", "portable.ts"),
        'export { value } from "./value.js";\n',
      );
      await writeFile(join(packageDir, "src", "value.ts"), "export const value = 1;\n");
      await writeFile(join(packageDir, "dist.js"), "export const value = 2;\n");
      await writeFile(join(root, "main.ts"), 'import { value } from "portable-package";\n');
      await writeFile(
        join(packageDir, "package.json"),
        JSON.stringify({
          name: "portable-package",
          version: "1.0.0",
          exports: {
            ".": {
              scriptc: "./src/portable.ts",
              import: "./dist.js",
            },
          },
        }),
      );
      clearResolveCaches();

      const resolved = resolveBareModule(join(root, "main.ts"), "portable-package", "js-only");

      expect(resolved?.typesFile).toBe(join(packageDir, "src", "portable.ts"));
      setNpmStaticPackages(["portable-package"]);
      expect(resolveRelativeModule(join(packageDir, "src", "portable.ts"), "./value.js"))
        .toBe(join(packageDir, "src", "value.ts"));
    } finally {
      setNpmStaticPackages([]);
      clearResolveCaches();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not accept a declaration file as a scriptc runtime entry", async () => {
    const root = await mkdtemp(join(tmpdir(), "scriptc-declaration-condition-"));
    try {
      const packageDir = join(root, "node_modules", "types-only-package");
      await mkdir(packageDir, { recursive: true });
      await writeFile(join(packageDir, "portable.d.ts"), "export declare const value: number;\n");
      await writeFile(join(packageDir, "dist.js"), "export const value = 2;\n");
      await writeFile(
        join(packageDir, "package.json"),
        JSON.stringify({
          name: "types-only-package",
          version: "1.0.0",
          exports: {
            ".": {
              scriptc: "./portable.d.ts",
              import: "./dist.js",
            },
          },
        }),
      );
      clearResolveCaches();

      expect(resolveBareModule(join(root, "main.ts"), "types-only-package", "js-only"))
        .toBeNull();
    } finally {
      clearResolveCaches();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("resolves JS-suffixed wildcard subpaths to their declaration twins", async () => {
    const root = await mkdtemp(join(tmpdir(), "scriptc-export-wildcard-types-"));
    try {
      const importer = join(root, "packages", "consumer", "src", "index.ts");
      const packageDir = join(root, "packages", "consumer", "node_modules", "typed-sdk");
      const clientDir = join(packageDir, "dist", "esm", "client");
      await mkdir(clientDir, { recursive: true });
      await mkdir(join(root, "packages", "consumer", "src"), { recursive: true });
      await writeFile(importer, 'import { Client } from "typed-sdk/client/index.js";\n');
      await writeFile(join(clientDir, "index.d.ts"), "export declare class Client {}\n");
      await writeFile(join(clientDir, "index.js"), "export class Client {}\n");
      await writeFile(
        join(packageDir, "package.json"),
        JSON.stringify({
          name: "typed-sdk",
          version: "1.0.0",
          exports: {
            "./*": {
              types: "./dist/esm/*.d.ts",
              import: "./dist/esm/*",
            },
          },
        }),
      );
      clearResolveCaches();

      expect(resolveBareModule(importer, "typed-sdk/client/index.js")?.typesFile)
        .toBe(join(clientDir, "index.d.ts"));
    } finally {
      clearResolveCaches();
      await rm(root, { recursive: true, force: true });
    }
  });
});
