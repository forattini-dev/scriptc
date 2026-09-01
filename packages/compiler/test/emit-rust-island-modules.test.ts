/* The Rust island's embedded module system: the edge table, the CommonJS
 * require shim over it, the synthetic ESM wrapper a `node:` specifier
 * takes, and the widened host-call marshaling. The shims those wrappers
 * reach are pinned in emit-rust-island-shims.test.ts.
 *
 * The fixture node_modules under tests/fixtures/island-modules are
 * COMMITTED TEST DATA — minimal hand-made packages; the binaries embed
 * their sources at build time and never read node_modules at runtime. */
import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import { nodeOracleExecutable } from "../../../tests/harness/oracle-environment.js";
import { compile } from "../src/index.js";

const execFileAsync = promisify(execFile);
const fixtures = resolve("tests/fixtures/island-modules");

async function build(fixtureName: string): Promise<string> {
  const fixture = join(fixtures, fixtureName);
  const dir = await mkdtemp(join(tmpdir(), "scriptc-rust-island-modules-"));
  const result = await compile(fixture, {
    outDir: dir,
    outPath: join(dir, "program"),
    backend: "rust",
    dynamic: true,
    optimization: "dev",
  });
  expect(
    result.ok,
    result.ok ? fixture : result.diagnostics.map((diagnostic) => diagnostic.message).join("; "),
  ).toBe(true);
  if (!result.ok) throw new Error("unreachable: compile refused");
  return result.binaryPath;
}

function run(binary: string): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(binary, [], {
    env: { ...process.env, SCRIPTC_RUST_HEAP_AUDIT: "1" },
  });
}

// Each case links a fresh binary against the island-enabled runtime.
describe.sequential("Rust island module system", () => {
  test("relative CommonJS require edges resolve like Node", async () => {
    const [node, rust] = [
      await execFileAsync(nodeOracleExecutable(), [join(fixtures, "relative-require.ts")]),
      await run(await build("relative-require.ts")),
    ];
    expect(rust.stdout).toBe(node.stdout);
    expect(rust.stdout).toBe("relcjs:5:object\n");
  });

  test("a REQUIRED builtin reaches the shim through the same require shim", async () => {
    const [node, rust] = [
      await execFileAsync(nodeOracleExecutable(), [join(fixtures, "builtin-require.ts")]),
      await run(await build("builtin-require.ts")),
    ];
    expect(rust.stdout).toBe(node.stdout);
    expect(rust.stdout).toBe("EventEmitter\n");
  });

  test("an IMPORTED builtin takes the synthesized node: wrapper", async () => {
    // The wrapper destructures the builtin's named exports, so this LINKS
    // against the export table both islands share, then evaluates the
    // shim behind __scr_require.
    const [node, rust] = [
      await execFileAsync(nodeOracleExecutable(), [join(fixtures, "builtin-import.ts")]),
      await run(await build("builtin-import.ts")),
    ];
    expect(rust.stdout).toBe(node.stdout);
    expect(rust.stdout).toBe("EventEmitter\n");
  });

  test("a closure with mixed primitive parameters crosses as a host function", async () => {
    const [node, rust] = [
      await execFileAsync(nodeOracleExecutable(), [join(fixtures, "closure-mixed.ts")]),
      await run(await build("closure-mixed.ts")),
    ];
    expect(rust.stdout).toBe(node.stdout);
    expect(rust.stdout).toBe("2:3|3.5:0\n");
  });
});
