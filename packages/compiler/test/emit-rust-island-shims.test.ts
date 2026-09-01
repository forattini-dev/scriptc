/* The Rust island's Node builtin shims.
 *
 * The shims are ONE body of JavaScript (packages/runtime/src/island-js/),
 * embedded into the QuickJS island as a C string and into the Rust island
 * through packages/runtime-rust/src/island_bootstrap.js. This suite pins
 * that the boa island really runs them: an npm package requiring events,
 * util, querystring, buffer, string_decoder, punycode, path and assert
 * must print exactly what Node prints, byte for byte.
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
  const dir = await mkdtemp(join(tmpdir(), "scriptc-rust-island-shims-"));
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
describe.sequential("Rust island builtin shims", () => {
  test("the pure shims answer exactly what Node's own modules answer", async () => {
    const [node, rust] = [
      await execFileAsync(nodeOracleExecutable(), [join(fixtures, "builtin-shims.ts")]),
      await run(await build("builtin-shims.ts")),
    ];
    // Byte-level first: a difference that survives only the utf8 decode
    // would otherwise read as equal.
    expect(Buffer.from(rust.stdout).equals(Buffer.from(node.stdout))).toBe(true);
    // Every line is a different shim, so name them when one drifts.
    for (const [index, line] of node.stdout.split("\n").entries()) {
      expect(rust.stdout.split("\n")[index], line.split(" ")[0]).toBe(line);
    }
    expect(node.stdout.split("\n")).toHaveLength(8);
  });

  test("path delegates to the same implementation compiled code uses", async () => {
    // path's resolving half is host.path, so this pins the bridge, not
    // just the JavaScript: the island's path.resolve and a generated
    // path.resolve are one function.
    const rust = await run(await build("builtin-shims.ts"));
    const paths = rust.stdout.split("\n").find((line) => line.startsWith("path "));
    expect(paths).toBe(
      "path /a/c/d|/a/c|/a/c/|/a/b|c|.gz|falsetrue|../../d|" +
        '{"root":"/","dir":"/a/b","base":"c.txt","ext":".txt","name":"c"}|' +
        "/a/b/c.txt|x/yx\\y|/:",
    );
  });

  test("a builtin outside the island's manifest still throws at RUNTIME", async () => {
    // The fence the shims do not remove: node:os has no Rust host surface
    // yet, so requiring it is an honest throw, not a wrong answer.
    const failure = await run(await build("builtin-unshimmed.ts")).catch(
      (error: unknown) => error,
    );
    expect(failure).toHaveProperty("stderr");
    expect((failure as { stderr: string }).stderr).toContain(
      "the island does not provide the 'node:os' builtin",
    );
  });
});
