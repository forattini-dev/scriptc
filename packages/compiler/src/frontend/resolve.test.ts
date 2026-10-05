import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { clearResolveCaches, projectDtsRuntimeSibling, resolveProjectModule, resolveTypeDirective, resolveWorkspaceSourceModule, setProjectPathMappings, setProjectRealm } from "./resolve.js";

const fixturesRoot = join(import.meta.dirname, "../../../..", "tests/fixtures");

test("resolver reset clears the active project package realm", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-resolve-reset-"));
  try {
    const src = join(dir, "src");
    const declaration = join(src, "value.d.ts");
    const runtime = join(src, "value.js");
    await mkdir(src);
    await Promise.all([
      writeFile(join(dir, "package.json"), '{"type":"module"}\n'),
      writeFile(declaration, "export declare const value: number;\n"),
      writeFile(runtime, "export const value = 1;\n"),
    ]);

    clearResolveCaches();
    setProjectRealm(join(src, "main.ts"));
    expect(projectDtsRuntimeSibling(declaration)).toBe(runtime);
    setProjectPathMappings({ "@app/value": [join(src, "value")] });
    expect(resolveProjectModule(join(src, "main.ts"), "@app/value")).toBe(runtime);

    clearResolveCaches();
    expect(projectDtsRuntimeSibling(declaration)).toBeNull();
    expect(resolveProjectModule(join(src, "main.ts"), "@app/value")).toBeNull();
  } finally {
    clearResolveCaches();
    await rm(dir, { recursive: true, force: true });
  }
});

test("source-only workspace packages are project modules while JavaScript packages stay external", () => {
  const sourceEntry = join(fixturesRoot, "workspace-source/main.ts");
  const sourceDir = realpathSync(join(fixturesRoot, "workspace-source/node_modules/wssource"));
  const sourceModule = join(sourceDir, "index.ts");
  const sourceMember = join(sourceDir, "describe.ts");
  const jsEntry = join(fixturesRoot, "npm/cases/workspace-linked/main.ts");

  clearResolveCaches();
  try {
    expect(resolveWorkspaceSourceModule(sourceEntry, "wssource")?.typesFile).toBe(sourceModule);
    expect(resolveProjectModule(sourceEntry, "wssource")).toBe(sourceModule);
    expect(resolveProjectModule(sourceModule, "./describe.js")).toBe(sourceMember);
    expect(resolveWorkspaceSourceModule(jsEntry, "wslinked")).toBeNull();
    expect(resolveProjectModule(jsEntry, "wslinked")).toBeNull();
  } finally {
    clearResolveCaches();
  }
});

test("a type directive resolves through the project's typeRoots before the node_modules walk", async () => {
  const dir = realpathSync(await mkdtemp(join(tmpdir(), "scriptc-type-directive-")));
  try {
    const ancestor = join(dir, "node_modules", "@types", "node");
    const vendored = join(dir, "app", "vendor", "node");
    await Promise.all([ancestor, vendored].map((root) => mkdir(root, { recursive: true })));
    await Promise.all([ancestor, vendored].flatMap((root) => [
      writeFile(join(root, "package.json"), '{"name":"@types/node","types":"index.d.ts"}\n'),
      writeFile(join(root, "index.d.ts"), "export {};\n"),
    ]));
    const entry = join(dir, "app", "main.ts");
    clearResolveCaches();
    // Without typeRoots only the ancestor walk answers; with them the
    // named root does, and a root that lacks the package falls through.
    expect(resolveTypeDirective("node", entry)).toBe(join(ancestor, "index.d.ts"));
    expect(resolveTypeDirective("node", entry, [join(dir, "app", "vendor")])).toBe(join(vendored, "index.d.ts"));
    expect(resolveTypeDirective("node", entry, [join(dir, "app", "elsewhere")])).toBe(join(ancestor, "index.d.ts"));
  } finally {
    clearResolveCaches();
    await rm(dir, { recursive: true, force: true });
  }
});
