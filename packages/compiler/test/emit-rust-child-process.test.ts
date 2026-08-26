import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

const execFileAsync = promisify(execFile);

function runToExit(file: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ stdout: string; exitCode: number }> {
  return new Promise((resolveRun) => {
    execFile(file, args, { encoding: "utf8", env }, (error, stdout) => {
      resolveRun({
        stdout,
        exitCode: error && typeof error.code === "number" ? error.code : 0,
      });
    });
  });
}

test.each([
  "1361-spawn-events.ts",
  "1362-spawn-timers.ts",
  "1466-child-containers.ts",
  "1470-child-lifecycle.ts",
  "1471-child-unref.ts",
  "1523-spawn-options.ts",
  "1525-child-exit-signal.ts",
  "1562-spawn-conditional-spread.ts",
  "1570-child-unref-kill-reffed.ts",
])("Rust async child event corpus matches Node: %s", async (fixtureName) => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-rust-child-async-"));
  const fixture = resolve("tests/corpus", fixtureName);
  const result = await compile(fixture, {
    outDir: dir,
    outPath: join(dir, fixtureName.slice(0, -3)),
    backend: "rust",
    optimization: "dev",
  });
  expect(
    result.ok,
    result.ok ? fixture : result.diagnostics.map((diag) => diag.message).join("; "),
  ).toBe(true);
  if (!result.ok) return;

  const [node, rust] = await Promise.all([
    execFileAsync(process.execPath, [fixture]),
    execFileAsync(result.binaryPath, [], {
      env: { ...process.env, SCRIPTC_RUST_HEAP_AUDIT: "1" },
    }),
  ]);
  expect(rust.stdout, fixtureName).toBe(node.stdout);
  expect(rust.stderr, fixtureName).toBe(node.stderr);
});

test("Rust unhandled child error preserves corpus 1363 exit behavior", async () => {
  const fixture = resolve("tests/corpus/1363-spawn-unhandled-error.ts");
  const dir = await mkdtemp(join(tmpdir(), "scriptc-rust-child-unhandled-"));
  const result = await compile(fixture, {
    outDir: dir,
    outPath: join(dir, "spawn-unhandled"),
    backend: "rust",
    optimization: "dev",
  });
  expect(
    result.ok,
    result.ok ? fixture : result.diagnostics.map((diag) => diag.message).join("; "),
  ).toBe(true);
  if (!result.ok) return;

  const [node, rust] = await Promise.all([
    runToExit(process.execPath, [fixture], process.env),
    runToExit(result.binaryPath, [], { ...process.env, SCRIPTC_RUST_HEAP_AUDIT: "1" }),
  ]);
  expect(rust).toEqual(node);
});

test("Rust detached spawn preserves deferred ENOENT errors", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-rust-child-detached-error-"));
  const entry = join(dir, "detached-error.ts");
  await writeFile(entry, `
import { spawn } from "node:child_process";
const child = spawn("scriptc-rust-definitely-missing", [], { stdio: "ignore", detached: true });
child.on("error", (error) => console.log(error.message, (error as NodeJS.ErrnoException).code));
child.on("exit", () => console.log("unexpected exit"));
console.log("spawn returned");
`);
  const result = await compile(entry, {
    outDir: dir,
    outPath: join(dir, "detached-error"),
    backend: "rust",
    optimization: "dev",
  });
  expect(
    result.ok,
    result.ok ? entry : result.diagnostics.map((diag) => diag.message).join("; "),
  ).toBe(true);
  if (!result.ok) return;

  const [node, rust] = await Promise.all([
    execFileAsync(process.execPath, [entry]),
    execFileAsync(result.binaryPath, [], {
      env: { ...process.env, SCRIPTC_RUST_HEAP_AUDIT: "1" },
    }),
  ]);
  expect(rust.stdout).toBe(node.stdout);
  expect(rust.stderr).toBe(node.stderr);
});
