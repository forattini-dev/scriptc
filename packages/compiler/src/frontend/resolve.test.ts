import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { clearResolveCaches, projectDtsRuntimeSibling, resolveProjectModule, setProjectPathMappings, setProjectRealm } from "./resolve.js";

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
