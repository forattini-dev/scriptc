import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

/* The adopted tsconfig "jsx"/"jsxImportSource" widens what RESOLVES and
 * TYPES: .tsx modules join the program graph and typecheck against the
 * project's own JSX surface. The element tree itself keeps its lowering
 * fence (SC1090, named). Two goldens: the JSX-free .tsx module lowers as
 * an ordinary module (rust + c byte-par), and a JSX element fences with
 * the named feature instead of the generic syntax fence. Node has no
 * oracle for .tsx imports (its strip-types lane refuses the extension) —
 * the goldens are the program's own semantics. */

interface Outcome {
  stdout: string;
  exitCode: number;
}

function runToExit(file: string, args: string[], env: NodeJS.ProcessEnv = process.env): Promise<Outcome> {
  return new Promise((resolveRun) => {
    execFile(file, args, { encoding: "utf8", env }, (error, stdout) => {
      resolveRun({
        stdout,
        exitCode: error && typeof error.code === "number" ? error.code : 0,
      });
    });
  });
}

test.each(["rust", "c"] as const)("adopted jsx config lowers JSX-free .tsx modules (%s)", async (backend) => {
  const fixture = resolve("packages/compiler/test/fixtures/jsx-adopts/src/main.ts");
  const dir = await mkdtemp(join(tmpdir(), `scriptc-jsx-adopts-${backend}-`));
  const result = await compile(fixture, {
    outDir: dir,
    outPath: join(dir, "program"),
    backend,
    optimization: "dev",
  });
  expect(
    result.ok,
    result.ok ? fixture : result.diagnostics.map((diagnostic) => diagnostic.message).join("; "),
  ).toBe(true);
  if (!result.ok) return;
  const binary = await runToExit(result.binaryPath, [], { ...process.env, SCRIPTC_RUST_HEAP_AUDIT: "1" });
  expect(binary.exitCode).toBe(0);
  expect(binary.stdout).toBe("a x1, b x2\nc x3\n");
});

test("JSX elements fence with the named feature", async () => {
  const fixture = resolve("packages/compiler/test/fixtures/jsx-element-fence/src/main.tsx");
  const result = await compile(fixture, {
    outDir: await mkdtemp(join(tmpdir(), "scriptc-jsx-fence-")),
    outPath: join(await mkdtemp(join(tmpdir(), "scriptc-jsx-fence-out-")), "program"),
    backend: "rust",
    optimization: "dev",
  });
  expect(result.ok).toBe(false);
  if (result.ok) return;
  const messages = result.diagnostics.map((diagnostic) => diagnostic.message).join("; ");
  expect(messages).toContain("JSX elements");
});