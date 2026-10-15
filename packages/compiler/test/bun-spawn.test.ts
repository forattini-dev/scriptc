import { mkdtemp, mkdir, readFile, rm, writeFile, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

test("Bun.spawn preserves handle aliases and refuses unsupported forms without an engine", async () => {
  const root = await mkdtemp(join(tmpdir(), "scriptc-bun-spawn-"));
  try {
    await mkdir(join(root, "node_modules"));
    await cp(resolve("tests/corpus/rust-bun-spawn/node_modules/bun-types"), join(root, "node_modules/bun-types"), { recursive: true });
    await writeFile(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, types: ["bun-types"], target: "ES2022", module: "ESNext" }, files: ["main.ts"] }));
    const entry = join(root, "main.ts"), output = join(root, "main.rs");
    for (const source of [
      'const p = Bun.spawn(["x"]); const stream = p.stdout; console.log(await new Response(stream).text(), await p.exited); export {};',
      'const p = Bun.spawn(["x"], { stdout: "pipe", stderr: "pipe" }); const out = new Response(p.stdout).text(); const err = new Response(p.stderr).text(); console.log(await out, await err); export {};',
      'function read(stream: ReadableStream<Uint8Array>): Promise<string> { return new Response(stream).text(); } const p = Bun.spawn(["x"], {}); console.log(await read(p.stdout)); export {};',
      'const p = Bun.spawn(["x"], { stdout: "ignore" }); const alias = p; console.log(await alias.exited, p.pid, p.exitCode, p.killed); if (p.exitCode !== null) console.log(p.exitCode + 1); export {};',
      'async function run(argv: readonly string[], env: Record<string, string | undefined>): Promise<number> { return await Bun.spawn(argv, { env, cwd: ".", stdout: "ignore", stderr: "inherit" }).exited; } console.log(await run(["x"], { FLAG: "value" })); export {};',
      'const Bun = { spawn: (argv: string[]) => ({ exited: Promise.resolve(argv.length) }) }; console.log(await Bun.spawn(["x"]).exited); export {};',
      'interface Subprocess { exited: Promise<number> }; const p: Subprocess = { exited: Promise.resolve(7) }; console.log(await p.exited); export {};',
    ]) {
      await writeFile(entry, source);
      const result = await compile(entry, { backend: "rust", outputKind: "rust", allowEngine: false, target: "bun", outPath: output, outDir: root });
      expect(result.ok, JSON.stringify(result)).toBe(true);
      if (result.ok) expect((await readFile(output, "utf8")).includes("runtime::bun_spawn")).toBe(source.startsWith("const p = Bun.spawn") || source.startsWith("function read") || source.includes('stdout: "ignore"'));
    }
    for (const source of [
      'Bun.spawn({ cmd: ["x"] });',
      'Bun.spawn(["x"], { stdin: "pipe" });', 'Bun.spawn(["x"], { stdout: "ignore", timeout: 10 });',
      'Bun.spawn(["x"], { stdout: "ignore", ...{} });', 'Bun.spawn(["x"], { get stdout() { return "ignore" as const; } });',
      'const options = { stdout: "ignore" as const }; Bun.spawn(["x"], options);',
      'const p = Bun.spawn(["x"], { stdout: "ignore" }); p.kill();',

    ]) {
      await writeFile(entry, source);
      const result = await compile(entry, { backend: "rust", outputKind: "rust", allowEngine: false, target: "bun", outPath: output, outDir: root });
      expect(result.ok, source).toBe(false);
      if (!result.ok) expect(result.diagnostics.some(d => d.code === "SC1090" || d.code === "SC2020"), source + JSON.stringify(result)).toBe(true);
    }
    await writeFile(entry, 'Bun.spawn(["x"], { stdout: "ignore" });');
    expect((await compile(entry, { backend: "rust", outputKind: "rust", allowEngine: false, target: "node24", outPath: output, outDir: root })).ok).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
