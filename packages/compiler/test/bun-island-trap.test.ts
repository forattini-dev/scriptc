import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { analyze, compile } from "../src/index.js";

const entry = resolve("packages/compiler/test/fixtures/bun-island/src/main.ts");

/* Embedded npm code importing Bun runtime modules: under --target bun the
 * build proceeds (the island answers the modules with trap tables; only a
 * use throws, naming the member and the runtime); under a Node target the
 * island honestly cannot embed the package. */
test("--target bun embeds bun:* imports as runtime traps (rust)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-bun-island-"));
  const result = await compile(entry, {
    outDir: dir,
    outPath: join(dir, "program"),
    backend: "rust",
    optimization: "dev",
    dynamic: true,
    target: "bun",
  });
  expect(result.ok, result.ok ? "" : result.diagnostics.map((d) => `${d.code} ${d.message}`).join("; ")).toBe(true);
  if (!result.ok) return;
  const run = await new Promise<{ stdout: string; stderr: string; code: number }>((done) => {
    execFile(result.binaryPath, { encoding: "utf8", env: { ...process.env, SCRIPTC_RUST_HEAP_AUDIT: "1" } }, (error, stdout, stderr) => {
      done({ stdout, stderr, code: error && typeof error.code === "number" ? error.code : 0 });
    });
  });
  expect(run.stderr).toBe("");
  expect(run.code).toBe(0);
  expect(run.stdout).toBe(
    "function function\n" +
      "the 'Database' of 'bun:sqlite' is not available in a compiled binary (requires the Bun runtime)\n",
  );
});

test("a Node target cannot embed a package that links against bun:*", () => {
  const { coverage } = analyze(entry, { dynamic: true, target: "node24" });
  expect(coverage.diagnostics.some((d) => d.code === "SC2030" && d.message.includes("bun:sqlite"))).toBe(true);
});

test("the bun target lists the trapped modules in the island inventory", () => {
  const { coverage } = analyze(entry, { dynamic: true, target: "bun" });
  expect(coverage.diagnostics).toEqual([]);
  expect((coverage.npmLazyTraps ?? []).filter((t) => t.bunTrap).map((t) => t.specifier)).toEqual(["bun:ffi", "bun:sqlite"]);
});
