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

  // The four island operations the Rust backend used to refuse outright
  // (SC3001), each against the Node oracle that defines them.

  test("`new` on a package class constructs inside the realm", async () => {
    // The instance never leaves the realm, so the method calls and the
    // field read after it all ride the same handle.
    const [node, rust] = [
      await execFileAsync(nodeOracleExecutable(), [join(fixtures, "class-construct.ts")]),
      await run(await build("class-construct.ts")),
    ];
    expect(rust.stdout).toBe(node.stdout);
    expect(rust.stdout).toBe("5:9:9\n");
  });

  test("`instanceof` answers across the boundary", async () => {
    // True for the realm's own instance, false for an unrelated one —
    // and the false arm proves the operands cross INTO the realm rather
    // than being compared by some second, native rule.
    const [node, rust] = [
      await execFileAsync(nodeOracleExecutable(), [join(fixtures, "class-instanceof.ts")]),
      await run(await build("class-instanceof.ts")),
    ];
    expect(rust.stdout).toBe(node.stdout);
    expect(rust.stdout).toBe("true:false\n");
  });

  test("an optional method call skips the absent member", async () => {
    // `o.m?.()` — the present method calls with `this = o`, the missing
    // one answers undefined instead of throwing.
    const [node, rust] = [
      await execFileAsync(nodeOracleExecutable(), [join(fixtures, "opt-call-method.ts")]),
      await run(await build("opt-call-method.ts")),
    ];
    expect(rust.stdout).toBe(node.stdout);
    expect(rust.stdout).toBe("go:undefined\n");
  });

  test("a static RegExp argument arrives as a real realm RegExp", async () => {
    // The frontend rebuilds the value as `new RegExp(source, flags)`,
    // which on this lane lands as a NATIVE regex; the argument marshal
    // then has to hand the realm an engine RegExp built from the same
    // text rather than refusing the call (SC3001). The `instanceof
    // RegExp` column is what proves a realm object arrived, not a
    // stringified stand-in, and the trailing line pins that the host
    // value survives the crossing intact.
    const [node, rust] = [
      await execFileAsync(nodeOracleExecutable(), [join(fixtures, "regexp-argument.ts")]),
      await run(await build("regexp-argument.ts")),
    ];
    expect(rust.stdout).toBe(node.stdout);
    expect(rust.stdout).toBe(
      "true:^a+$::true\ntrue:b:i:true\ntrue:z\\s:gimsu:true\n" +
        "true:c\\d+::true\nc\\d+::true\n",
    );
  });

  test("globalThis.crypto backs the node:crypto randomness surface", async () => {
    // The realm's web prelude installs `crypto` over the host CSPRNG
    // before the module bootstrap runs, because node:crypto's shim
    // captures the global ONCE at shim-factory time. Shape-only, so the
    // Node oracle agrees byte for byte.
    const [node, rust] = [
      await execFileAsync(nodeOracleExecutable(), [join(fixtures, "web-crypto.ts")]),
      await run(await build("web-crypto.ts")),
    ];
    expect(rust.stdout).toBe(node.stdout);
    expect(rust.stdout).toBe(
      "bytes:16:0|uuid:true|uuid-global:true|grv:true:4|grv-global:true|" +
        "grv-offset:0,0,0,0|int:true\n",
    );
  });

  test("events.on iterates an emitter's buffered events", async () => {
    // The named export the builtin table announced but the shim never
    // defined. Everything is emitted before the loop, so the iterator
    // only drains its own buffer — no timer source is involved, and the
    // three exits (break, options.close, an 'error' behind a buffered
    // event) all resolve synchronously against the job queue.
    const [node, rust] = [
      await execFileAsync(nodeOracleExecutable(), [join(fixtures, "events-on.ts")]),
      await run(await build("events-on.ts")),
    ];
    expect(rust.stdout).toBe(node.stdout);
    expect(rust.stdout).toBe(
      "types:function:function|break:1,2|close:xy|error:kept:boom|once:7,8\n",
    );
  });

  test("dynamic import() answers the embedded module's namespace", async () => {
    // The realm's promise of the whole namespace, bridged to the static
    // promise the await parks on.
    const [node, rust] = [
      await execFileAsync(nodeOracleExecutable(), [join(fixtures, "dynamic-import.ts")]),
      await run(await build("dynamic-import.ts")),
    ];
    expect(rust.stdout).toBe(node.stdout);
    expect(rust.stdout).toBe("armed:idle\n");
  });

  test("Object.keys follows the runtime shape of a package-returned record", async () => {
    const fixture = join(fixtures, "object-keys-package-record.ts");
    const [node, rust] = [
      await execFileAsync(nodeOracleExecutable(), [fixture]),
      await run(await build("object-keys-package-record.ts")),
    ];
    expect(rust.stdout).toBe(node.stdout);
    expect(rust.stdout).toBe("alpha:one\nbeta:true\n");
  });
});
