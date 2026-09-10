/* npm imports under --dynamic: every fixture program under
 * tests/fixtures/npm/cases (plus the commander acceptance fixture) runs
 * under Node AND as a scriptc-compiled binary; stdout and stderr must match
 * byte-for-byte and exit codes must agree — the differential contract,
 * extended with argv (CLI packages parse process.argv).
 * Intentional link errors and unhandled rejections pin the exact native fatal
 * diagnostic, since Node prints source/stack/version for these errors.
 *
 * The fixture node_modules are COMMITTED TEST DATA (hand-made minimal
 * packages exercising ESM/CJS/dual/scoped/JSON resolution, and a pinned
 * real commander for the acceptance CLI). Binaries embed the package
 * sources at build time — nothing here reads node_modules at runtime.
 *
 * SCRIPTC_SAN=1 rebuilds everything with ASan + the runtime RC audit; the
 * island's counting allocator asserts zero live engine allocations at
 * teardown.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { globSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import { NODE_COMPAT_MATRIX, compile } from "@scriptc/compiler";
import { npmCases, npmOracleFlags } from "./npm-cases.js";
import { primaryOracleExecutable } from "./node-matrix.js";
import { shardSelect, shardSuffix } from "./shard.js";
import { discardPassedBinary } from "./passed-binary.js";

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, "../..");
const fixturesRoot = join(repoRoot, "tests/fixtures");
const cacheDir = join(repoRoot, "node_modules/.cache/scriptc-tests");
const sanitize = process.env["SCRIPTC_SAN"] === "1";
// Use vitest.config.ts's shared native-build timeout. The former 120s
// overrides expired while compiling the Rust Commander fixture under the
// resource limiter, before an executable existed; its runtime cases complete.
// SEMANTIC oracle (differential.test.ts's rationale, node-matrix.ts's
// header): stdout must match ONE Node's fixed behavior, so this pins to
// the compat matrix primary rather than whichever `node` the PATH happens
// to resolve — a bare "node" spawn would silently compare against
// whatever major is running the suite.
const oracleExecutable = primaryOracleExecutable(NODE_COMPAT_MATRIX);
/* The primary plain lane uses Rust. Sanitized runs explicitly select C;
 * SCRIPTC_TEST_BACKEND can select another comparison lane. */
const backend = (process.env["SCRIPTC_TEST_BACKEND"] as "c" | "llvm" | "rust" | undefined)
  ?? (sanitize ? "c" : "rust");

// The case table lives in npm-cases.ts: the Linux lane runs the identical
// cases (same entries, same argv lists) inside its container. The shard
// split (SCRIPTC_TEST_SHARD, CI's matrix) is applied HERE, not in the
// table, so that lane keeps its full list.
const cases = shardSelect(npmCases(fixturesRoot, backend), (c) => c.name);

// The ESM fixture scope declares its module type to avoid Node's
// MODULE_TYPELESS_PACKAGE_JSON configuration warning on stderr. The two
// import()-only script fixtures retain explicit CommonJS scopes.

interface RunResult {
  stdout: Buffer;
  stderr: Buffer;
  exitCode: number;
}

async function runBinary(cmd: string, args: string[]): Promise<RunResult> {
  // Linux ASan emits this exact advisory on the first fiber switch (the
  // existing island/error harnesses exclude it too). Preserve all other
  // bytes, including actual sanitizer errors, and never filter Node output.
  const stderrForProgram = (stderr: Buffer): Buffer => sanitize && cmd !== oracleExecutable
    ? Buffer.from(stderr.toString("latin1").replace(
        /^==\d+==WARNING: ASan doesn't fully support makecontext\/swapcontext functions and may produce false positives in some cases!\n/gm,
        "",
      ), "latin1")
    : stderr;
  try {
    // stdin closes immediately (differential.test.ts's contract): fixture
    // programs may read fd 0 to EOF (process.stdin is a real Readable in
    // the island now), and a default open pipe would hang both lanes.
    const pending = execFileAsync(cmd, args, { encoding: "buffer" });
    pending.child.stdin?.end();
    const { stdout, stderr } = await pending;
    return { stdout, stderr: stderrForProgram(stderr), exitCode: 0 };
  } catch (err) {
    const e = err as { code?: unknown; stdout?: Buffer; stderr?: Buffer };
    if (typeof e.code !== "number" || !Buffer.isBuffer(e.stdout) || !Buffer.isBuffer(e.stderr)) throw err;
    return { stdout: e.stdout, stderr: stderrForProgram(e.stderr), exitCode: e.code };
  }
}

/** Compile once per (entry, lane); the cache key hashes the program AND
 * the fixture packages so edits to either rebuild. */
async function build(entry: string): Promise<string> {
  const hash = createHash("sha256");
  const fixtureDir = join(entry, "../..");
  const inputs = [
    entry,
    ...globSync(join(fixtureDir, "**/node_modules/**/*.{js,mjs,cjs,json,d.ts,node}")).sort(),
  ];
  for (const f of inputs) hash.update(f).update(readFileSync(f));
  const key = hash
    .update(sanitize ? "san" : "plain")
    .update(backend ?? "default")
    .digest("hex")
    .slice(0, 16);
  const outDir = join(cacheDir, `npm-${key}`);
  mkdirSync(outDir, { recursive: true });
  const result = await compile(entry, {
    outPath: join(outDir, "program"),
    outDir,
    sanitize,
    dynamic: true,
    ...(backend === undefined ? {} : { backend }),
  });
  if (!result.ok) {
    throw new Error(
      "npm fixture failed to compile:\n" +
        result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"),
    );
  }
  return result.binaryPath;
}

describe(`typed-callback boundary (scriptc-only${sanitize ? ", sanitized" : ""})`, () => {
  test("an orphaned native-to-engine promise reports once after the checkpoint", async () => {
    const entry = join(fixturesRoot, "npm/divergent/orphan-promise.mts");
    const binary = await build(entry);
    const prefix = backend === "rust" ? "UnhandledPromiseRejection: " : "Unhandled promise rejection: ";
    for (const mode of ["orphan", "primitive", "engine", "multiple", "multiple-pending", "mixed", "caught", "caught-string", "caught-number", "caught-bool", "microtask", "tick"]) {
      const node = await runBinary(oracleExecutable, [entry, mode]);
      const native = await runBinary(binary, [mode]);
      const handled = mode.startsWith("caught") || ["microtask", "tick"].includes(mode);
      expect(native.stdout, mode).toEqual(node.stdout);
      expect(node.exitCode, mode).toBe(handled ? 0 : 1);
      expect(native.exitCode, mode).toBe(node.exitCode);
      const reason = mode === "primitive" ? "plain reason"
        : mode === "engine" ? "TypeError: engine orphan"
        : mode === "mixed" ? "Error: static first" : "RangeError: native orphan";
      // Fatal exit while another callback is parked cannot unwind C's
      // ucontext stacks. Pin its existing audit-skipped diagnostic here;
      // never filter audit failures from ordinary runs or from Rust.
      const audit = sanitize && backend !== "rust" && mode === "multiple-pending"
        ? "scriptc RC audit skipped: 2 fiber(s) never resumed\n" : "";
      expect(native.stderr, mode).toEqual(Buffer.from(handled ? "" : `${prefix}${reason}\n${audit}`));
      if (handled) expect(node.stderr).toEqual(Buffer.alloc(0));
    }
    discardPassedBinary(cacheDir, binary, "orphaned native-to-engine promise");
  });

  // The one deliberate DIVERGENCE at the typed-callback boundary: a package
  // argument the declared param type refuses becomes a TypeError thrown
  // back into the island before the body runs (Node would run the body
  // with the lie) — so this program is asserted directly, never
  // differentially. SEMANTICS.md documents it with the dyn→static edges.
  test("a lying engine argument throws a TypeError into the package", async () => {
    const binary = await build(join(fixturesRoot, "npm/divergent/main.ts"));
    const res = await runBinary(binary, []);
    // Rust's checked scalar bridge includes the root path; the C/LLVM
    // primitive bridge omits it. Both must reject before the body runs.
    const primitiveError = backend === "rust"
      ? "expected number at $, got string"
      : "expected number, got string";
    expect(res.stdout.toString("utf8")).toBe(
      `caught:true:${primitiveError}\n` +
        "caught:true:expected object at $, got number\n",
    );
    expect(res.stderr).toEqual(Buffer.alloc(0));
    expect(res.exitCode).toBe(0);
  });

  // The lazy-builtin trap (the divergent third of the lazy edge semantics
  // lazy-traps pins differentially): a require() of an unshimmed Node
  // BUILTIN — esbundled's __require("node:_http_agent") — builds fine (the lazy edge
  // embeds pointing at the refused node: key) and throws the island's own
  // error AT THE CALL. Node would LOAD core _http_agent here, so this program
  // is asserted directly, never differentially.
  test("require of an unshimmed builtin throws the island's lazy error at the call", async () => {
    const binary = await build(join(fixturesRoot, "npm/divergent/lazybuiltin.ts"));
    const res = await runBinary(binary, []);
    expect(res.stdout.toString("utf8")).toBe(
      "the island does not provide the 'node:_http_agent' builtin\n",
    );
    expect(res.exitCode).toBe(0);
  });

  // The native-addon trap (the .node sibling of the lazy-builtin trap):
  // a napi-style package's require of its .node binding embeds a throwing
  // ERR_DLOPEN_FAILED stub, never the addon's machine code. Node dlopens
  // the garbage fixture and fails with a PLATFORM-worded message, so the
  // shape probes would agree differentially but the message probe cannot —
  // asserted directly. Pins: the code, the retry (a throwing module leaves
  // no cache entry), ".node" in the require extension candidates, and the
  // island's exact message.
  test("require of a .node native addon throws ERR_DLOPEN_FAILED at the call", async () => {
    const binary = await build(join(fixturesRoot, "npm/divergent/nativeaddon.ts"));
    const res = await runBinary(binary, []);
    const addonKey = realpathSync(join(fixturesRoot, "npm/node_modules/nativezoo/addon.node"));
    expect(res.stdout.toString("utf8")).toBe(
      "caught:true:ERR_DLOPEN_FAILED\n" +
        "caught:true:ERR_DLOPEN_FAILED\n" +
        "caught:true:ERR_DLOPEN_FAILED\n" +
        `Cannot load native addon '${addonKey}': scriptc binaries cannot load .node addons (the island has no process.dlopen)\n`,
    );
    expect(res.exitCode).toBe(0);
  });

  // The island's WebAssembly is a THROWING STUB (SEMANTICS.md): Node has a
  // real wasm engine, so this surface is asserted directly, never
  // differentially. The promise-shaped members REJECT with the clear
  // message (the real API's shape — invalid bytes reject, never throw
  // synchronously — so top-level `WebAssembly.compile(...)` module
  // evaluation stays lazy exactly as under Node: es-module-lexer's
  // `export const init`, undici's lazyllhttp), the error classes are real
  // Error subclasses (Emscripten's abort path constructs a working
  // RuntimeError), and validate() answers false.
  test("WebAssembly is a rejecting stub with real error classes", async () => {
    const binary = await build(join(fixturesRoot, "npm/divergent/wasm.ts"));
    const res = await runBinary(binary, []);
    expect(res.stdout.toString("utf8")).toBe(
      "WebAssembly.instantiate is not supported in scriptc binaries (the embedded engine has no wasm runtime)\n" +
        "true|RuntimeError|Aborted(Error: boom)\n" +
        "false\n" +
        "compile:true|instantiate:true|compileStreaming:true|instantiateStreaming:true|" +
        "Module:true|Instance:true|Memory:true|Table:true|Global:true|" +
        "RuntimeError:true|CompileError:true|LinkError:true|valid:false\n",
    );
    expect(res.exitCode).toBe(0);
  });
});

describe(`workspace package resolution (scriptc-only${sanitize ? ", sanitized" : ""})`, () => {
  test("TypeScript sources resolve relative .js and extensionless specifiers", async () => {
    const binary = await build(join(fixturesRoot, "npm/scriptc-only/workspace-js-specifiers/main.ts"));
    const res = await runBinary(binary, []);
    expect(res.stdout.toString("utf8")).toBe(
      "workspace .js specifier workspace extensionless specifier\n",
    );
    expect(res.exitCode).toBe(0);
  });
});

describe(`npm differential (${cases.length} programs${sanitize ? ", sanitized" : ""}${shardSuffix()})`, () => {
  test.for(cases.map((c) => [c.name, c] as const))("%s", async ([, c]) => {
    const binary = await build(c.entry);
    for (const argv of c.argvs ?? [[]]) {
      const [nodeRes, nativeRes] = await Promise.all([
        runBinary(oracleExecutable, [...npmOracleFlags(c.entry), c.entry, ...argv]),
        runBinary(binary, argv),
      ]);
      const label = argv.join(" ");
      // These two fixtures deliberately leave rejections unhandled. Keep
      // their exit status and cause strict; Node's uncaught stack rendering
      // is not the native runtime's documented one-line diagnostic.
      const rejection = c.name === "promise-bridge-unhandled" ? "TypeError: dropped"
        : c.name === "commander-calc" && argv.length === 2 && argv[0] === "fail" && argv[1] === "flat tire"
          ? "Error: cannot compute: flat tire" : undefined;
      for (const stream of ["stdout", "stderr"] as const) {
        if (stream === "stderr" && c.fatalLink !== undefined) {
          expect(nodeRes.exitCode, label).toBe(1);
          expect(nodeRes.stdout, label).toEqual(Buffer.alloc(0));
          expect(nodeRes.stderr.toString("utf8").split("\n"), label).toContain(c.fatalLink);
          expect(nativeRes.stderr, label).toEqual(Buffer.from(`Uncaught ${c.fatalLink}\n`));
          continue;
        }
        if (stream === "stderr" && rejection !== undefined) {
          const prefix = backend === "rust" ? "UnhandledPromiseRejection: " : "Unhandled promise rejection: ";
          expect(nodeRes.exitCode, label).toBe(1);
          expect(nodeRes.stderr.toString("utf8"), label).toContain(rejection);
          expect(nativeRes.stderr, label).toEqual(Buffer.from(`${prefix}${rejection}\n`));
          continue;
        }
        if (!nodeRes[stream].equals(nativeRes[stream])) {
          expect(nativeRes[stream].toString("utf8"), `${label} ${stream}`).toBe(nodeRes[stream].toString("utf8"));
          expect.unreachable(`${stream} differed at byte level but not after utf8 decode`);
        }
      }
      expect(nativeRes.exitCode, label).toBe(nodeRes.exitCode);
    }
    discardPassedBinary(cacheDir, binary, c.name);
  });
});
