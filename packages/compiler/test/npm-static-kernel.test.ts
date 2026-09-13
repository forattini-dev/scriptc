import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setImmediate } from "node:timers/promises";
import { expect, test } from "vitest";
import { analyze, compile } from "../src/index.js";
import { nodeOracleExecutable } from "../../../tests/harness/oracle-environment.js";

async function fixture(run: (entry: string, directory: string) => Promise<void> | void): Promise<void> {
  await setImmediate();
  const directory = mkdtempSync(join(tmpdir(), "scriptc-npm-kernel-"));
  try {
    mkdirSync(join(directory, "node_modules"));
    symlinkSync(resolve(import.meta.dirname, "../../../node_modules/effect"), join(directory, "node_modules/effect"), "junction");
    writeFileSync(join(directory, "package.json"), JSON.stringify({ type: "module" }));
    const entry = join(directory, "main.ts");
    writeFileSync(entry, 'import { Effect } from "effect";\nconst value: Effect.Effect<number> = Effect.succeed(42);\nconsole.log(Effect.runSync(value));\n');
    await run(entry, directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test.each(["auto", "lib"] as const)("npm %s keeps native kernel declarations", async (npmStatic) => {
  await fixture((entry) => {
    const { coverage } = analyze(entry, { backend: "rust", allowEngine: false, npmStatic });
    expect(coverage.diagnostics).toEqual([]);
    expect(coverage.npmStatic ?? []).toEqual([]);
    expect(coverage.execution?.engine).toBe("none");
  });
});

test.each(["dynamic-auto", "explicit"])("kernel packages retain ordinary npm admission for %s", async (mode) => {
  await setImmediate();
  const directory = mkdtempSync(join(tmpdir(), "scriptc-npm-kernel-policy-"));
  try {
    const dependency = join(directory, "node_modules/effect");
    mkdirSync(dependency, { recursive: true });
    writeFileSync(join(directory, "package.json"), JSON.stringify({ type: "module" }));
    writeFileSync(join(dependency, "package.json"), JSON.stringify({ name: "effect", type: "module", main: "index.js", types: "index.d.ts" }));
    writeFileSync(join(dependency, "index.js"), "export const answer = 42;\n");
    writeFileSync(join(dependency, "index.d.ts"), "export declare const answer: number;\n");
    const entry = join(directory, "main.ts");
    writeFileSync(entry, 'import { answer } from "effect"; console.log(answer);\n');
    const { coverage } = analyze(entry, {
      backend: "rust", dynamic: mode === "dynamic-auto",
      npmStatic: mode === "dynamic-auto" ? "auto" : ["effect"],
    });
    expect(coverage.preflightFailed).toBe(false);
    expect(coverage.npmStatic).toEqual([{ package: "effect", status: "static" }]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("npm auto compiles Effect through the native Rust kernel with Node parity", async () => {
  await fixture(async (entry, directory) => {
    const result = await compile(entry, {
      backend: "rust", allowEngine: false, npmStatic: "auto", target: "node24",
      outDir: join(directory, "out"), outPath: join(directory, "out/program"),
    });
    expect(result.ok, result.ok ? undefined : JSON.stringify(result.diagnostics)).toBe(true);
    if (!result.ok) return;
    expect(result.artifact.backend).toBe("rust");
    expect(result.execution.engine).toBe("none");
    const node = spawnSync(nodeOracleExecutable(), [entry], { encoding: "utf8", timeout: 30_000 });
    const native = spawnSync(result.binaryPath, [], { encoding: "utf8", timeout: 30_000 });
    expect(node.error).toBeUndefined();
    expect(native.error).toBeUndefined();
    expect(node.status).toBe(0);
    expect(native.status).toBe(node.status);
    expect(native.signal).toBe(node.signal);
    expect(native.stdout).toBe(node.stdout);
    expect(native.stderr).toBe(node.stderr);
    expect(native.stdout).toBe("42\n");
  });
});
