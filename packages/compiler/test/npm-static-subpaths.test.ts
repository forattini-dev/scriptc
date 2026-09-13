import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";
import { nodeOracleExecutable } from "../../../tests/harness/oracle-environment.js";

test.each(["installed-js", "workspace-ts"])("npm auto compiles star reexports from a subpath-only %s package in Rust", async (kind) => {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-npm-subpath-"));
  const installed = join(directory, "node_modules", "@fixture", "subpath");
  const source = kind === "workspace-ts" ? join(directory, "workspace") : installed;
  mkdirSync(source, { recursive: true });
  mkdirSync(join(directory, "node_modules", "@fixture"), { recursive: true });
  const put = (path: string, text: string): void => writeFileSync(path, text);
  put(join(directory, "package.json"), JSON.stringify({ type: "module" }));
  put(join(directory, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext" } }));
  put(join(source, "package.json"), JSON.stringify({
    name: "@fixture/subpath", type: "module",
    exports: { "./value": kind === "workspace-ts" ? "./value.ts" : { types: "./value.d.ts", default: "./value.js" } },
  }));
  if (kind === "workspace-ts") {
    put(join(source, "value.ts"), "console.log('dependency'); export const answer: number = 42;\n");
    symlinkSync(source, installed, process.platform === "win32" ? "junction" : "dir");
  } else {
    put(join(source, "value.js"), "console.log('dependency'); export const answer = 42;\n");
    put(join(source, "value.d.ts"), "export declare const answer: number;\n");
  }
  put(join(directory, "facade.ts"), 'export * from "@fixture/subpath/value";\n');
  const entry = join(directory, "main.ts");
  put(entry, 'import { answer } from "./facade.ts"; console.log(answer);\n');
  try {
    const result = await compile(entry, {
      backend: "rust", allowEngine: false, npmStatic: "auto", target: "node24",
      outDir: join(directory, "out"), outPath: join(directory, "out", "program"),
    });
    expect(result.ok, result.ok ? undefined : JSON.stringify(result.diagnostics)).toBe(true);
    if (!result.ok) return;
    expect(result.artifact.backend).toBe("rust");
    expect(result.execution.engine).toBe("none");
    const node = spawnSync(nodeOracleExecutable(), [entry], { encoding: "utf8" });
    const native = spawnSync(result.binaryPath, [], { encoding: "utf8" });
    expect(node.error).toBeUndefined();
    expect(native.error).toBeUndefined();
    expect(node.status).toBe(0);
    expect(native.status).toBe(node.status);
    expect(native.signal).toBe(node.signal);
    expect(native.stdout).toBe(node.stdout);
    expect(native.stderr).toBe(node.stderr);
    expect(native.stdout).toBe("dependency\n42\n");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
