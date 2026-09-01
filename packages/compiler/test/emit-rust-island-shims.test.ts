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
    // The fence the shims do not remove: node:net needs an event loop
    // inside the island, which the Rust bridge does not carry, so its
    // part stays out of the manifest and requiring it is an honest
    // throw rather than a wrong answer.
    const failure = await run(await build("builtin-unshimmed.ts")).catch(
      (error: unknown) => error,
    );
    expect(failure).toHaveProperty("stderr");
    expect((failure as { stderr: string }).stderr).toContain(
      "the island does not provide the 'node:net' builtin",
    );
  });

  // The I/O shims are the half that reaches the operating system, so the
  // question they answer is not "does the JavaScript run" but "does it
  // reach the SAME runtime unit the static lane does". Node is the
  // oracle: fs, crypto, zlib and os must all agree with it byte for byte.
  test("the I/O shims answer exactly what Node's own modules answer", async () => {
    const [node, rust] = [
      await execFileAsync(nodeOracleExecutable(), [join(fixtures, "io-shims.ts")]),
      await run(await build("io-shims.ts")),
    ];
    expect(Buffer.from(rust.stdout).equals(Buffer.from(node.stdout))).toBe(true);
    // Every line is a different operation, so name the one that drifts.
    for (const [index, line] of node.stdout.split("\n").entries()) {
      expect(rust.stdout.split("\n")[index], line.split(" ")[0]).toBe(line);
    }
  });

  test("each I/O module is really bridged, not silently absent", async () => {
    // A guard against the whole suite passing because both lanes threw
    // the same way: the report must actually carry every module's rows.
    const rust = await run(await build("io-shims.ts"));
    for (const prefix of ["fs:read ", "hash:sha256 ", "zlib:gzip ", "os:platform ", "promises:read "]) {
      expect(rust.stdout, prefix).toContain(prefix);
    }
    // fs errors have to cross the bridge Node-shaped, code and all —
    // that is what fs.existsSync's catch and statSync's throwIfNoEntry
    // escape hatch are written against.
    expect(rust.stdout).toContain("fs:enoent ENOENT");
    expect(rust.stdout).toContain("fs:stat-missing undefined");
  });
});
