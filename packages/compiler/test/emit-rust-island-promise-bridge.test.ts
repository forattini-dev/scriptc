/* The island → static promise bridge on the Rust backend.
 *
 * `jsBridgePromise` adopts the realm's promise LAZILY: the call site
 * answers a native promise that is still pending, and the realm's own
 * then/catch reactions settle it later, from the loop. The blocking
 * adoption it replaced awaited the engine promise where the bridge stood,
 * which cost all three properties pinned here — ordering, an observable
 * rejection, and a pending promise that stays pending.
 *
 * The fixture package under tests/fixtures/island-modules/node_modules is
 * COMMITTED TEST DATA; the binary embeds its source at build time.
 * The runtime-side unit tests live in runtime-rust's island_modules.rs. */
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
  const dir = await mkdtemp(join(tmpdir(), "scriptc-rust-island-promise-"));
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

/** Both lanes of one fixture: Node's own answer, then the binary's. */
async function differential(fixtureName: string): Promise<{ node: string; rust: string }> {
  const binary = await build(fixtureName);
  const [node, rust] = [
    await execFileAsync(nodeOracleExecutable(), [join(fixtures, fixtureName)]),
    await execFileAsync(binary, [], { env: { ...process.env, SCRIPTC_RUST_HEAP_AUDIT: "1" } }),
  ];
  return { node: node.stdout, rust: rust.stdout };
}

describe.sequential("Rust island promise bridge", () => {
  // The engine timer settling the bridged promise is armed at the CALL,
  // on the same native heap the static setTimeout uses, so the 0 ms
  // static timer wins. Draining it at the bridge instead would fire it
  // before the loop starts and reverse the last two lines.
  test("an adopted promise settles through the loop, not at the call site", async () => {
    const { node, rust } = await differential("promise-bridge-order.ts");
    expect(rust).toBe(node);
    expect(rust).toBe("main done\nstatic tick\nisland: 40\n");
  });

  // The rejection crosses as a REJECTION: the static handler runs, and
  // the marshaled error keeps the class `instanceof` narrows on.
  test("an engine rejection is observed by a static .catch", async () => {
    const { node, rust } = await differential("promise-bridge-catch.ts");
    expect(rust).toBe(node);
    expect(rust).toBe("after the call\ncaught: TypeError\nmessage: boom\n");
  });

  // Nothing can settle it and it arms no work, so the loop exhausts and
  // the process exits 0 with the abandoned fiber still parked.
  test("a promise nothing can settle parks the fiber and exits cleanly", async () => {
    const { node, rust } = await differential("promise-bridge-abandoned.ts");
    expect(rust).toBe(node);
    expect(rust).toBe("main done\nsettled: 6\n");
  });
});
