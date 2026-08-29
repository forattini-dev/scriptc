import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { expect, test } from "vitest";
import { NpmGraphBuilder } from "./npm.js";

test("embedded npm resolves package imports with Node conditions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-npm-imports-"));
  try {
    const pkg = join(dir, "node_modules", "fixture");
    await mkdir(pkg, { recursive: true });
    await Promise.all([
      writeFile(join(dir, "main.ts"), 'import "fixture";\n'),
      writeFile(join(pkg, "package.json"), JSON.stringify({
        name: "fixture",
        type: "module",
        exports: "./index.js",
        imports: {
          "#crypto": {
            node: "./crypto-node.js",
            default: "./crypto-native.js",
          },
        },
      })),
      writeFile(join(pkg, "index.js"), 'import { marker } from "#crypto"; export { marker };\n'),
      writeFile(join(pkg, "crypto-node.js"), 'export const marker = "node";\n'),
      writeFile(join(pkg, "crypto-native.js"), 'export const marker = "native";\n'),
    ]);

    const builder = new NpmGraphBuilder();
    builder.addImport(join(dir, "main.ts"), "fixture");
    const graph = builder.finish();

    expect(graph.errors).toEqual([]);
    expect(graph.modules.map((module) => basename(module.key)).sort()).toEqual([
      "crypto-node.js",
      "index.js",
    ]);
    expect(graph.edges).toContainEqual(expect.objectContaining({
      specifier: "#crypto",
      to: join(pkg, "crypto-node.js"),
      kind: "import",
    }));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
