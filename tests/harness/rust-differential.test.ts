/* The Rust differential: STRICT full-corpus parity, auto-discovered. Unlike
 * the LLVM lane (a tier whose membership is discovered and whose refusals
 * are tolerated into a histogram), the Rust backend already claims the
 * whole corpus, so this suite runs every corpus program under an explicit
 * `backend: "rust"` pin and requires it to compile AND match the Node
 * oracle — stdout (always), stderr (exit-0 programs), exit code. A refusal
 * (SC3001) is a regression here, reported with its unsupported-construct
 * kind. New corpus programs join this lane automatically; nothing is
 * hand-listed.
 *
 * The Rust backend refuses sanitizers, so the SCRIPTC_SAN=1 flavor skips
 * this suite entirely (the C/LLVM lanes carry the sanitized sweep).
 * Binaries run with SCRIPTC_RUST_HEAP_AUDIT=1: a leaked heap object makes
 * the runtime print "Rust heap object(s) still live" on stderr, which the
 * exit-0 stderr parity catches directly and the nonzero-exit branch
 * asserts against explicitly.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { globSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterAll, describe, expect, test } from "vitest";
import ts5 from "typescript";
import { NODE_COMPAT_MATRIX, compile } from "@scriptc/compiler";
import { shardSelect, shardSuffix } from "./shard.js";
import { DRIVER_FIXTURES } from "./driver-fixtures.js";
import { nodeTransformTypesArgs } from "./oracle-environment.js";
import { primaryOracleExecutable } from "./node-matrix.js";

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, "../..");
const corpusDir = join(repoRoot, "tests/corpus");
const cacheDir = join(repoRoot, "node_modules/.cache/scriptc-tests");
// The SEMANTIC oracle pins to the compat matrix's primary, not the host —
// see the note in differential.test.ts.
const oracleExecutable = primaryOracleExecutable(NODE_COMPAT_MATRIX);

// Same corpus, same SCRIPTC_TEST_SHARD slice as differential.test.ts (the
// three lanes split identically, so a shard's oracle work serves them all).
const ENTRY_EXTS = ["ts", "js", "mjs", "cjs"];
const files = shardSelect(
  ENTRY_EXTS.flatMap((ext) => [
    ...globSync(join(corpusDir, `*.${ext}`)),
    ...globSync(join(corpusDir, `*/main.${ext}`)),
  ])
    .filter((f) => !DRIVER_FIXTURES.has(f.slice(corpusDir.length + 1)))
    .sort(),
  (f) => f.slice(corpusDir.length + 1),
);
const sanitize = process.env["SCRIPTC_SAN"] === "1";

// Same known-env contract as the main differential suite.
process.env["SCRIPTC_TEST_ENV"] = "from-harness";

/** Programs that read stdin during the run (the corpus twin of
 * emit-rust.test.ts's readline case); everything else gets stdin closed
 * immediately, same as the other lanes. */
const STDIN_FIXTURES: Record<string, string> = {
  "2794-readline-async-iterator.mjs": "alpha\r\n\nomega",
};

interface RunResult {
  stdout: Buffer;
  stderr: Buffer;
  exitCode: number;
}

/** First FOUR lines — @dynamic may sit under a directive stack (the widest
 * window any suite reads; emit-rust.test.ts reads 4 for the same reason). */
function directiveHead(file: string): string[] {
  return readFileSync(file, "utf8").split("\n", 4);
}

function expectedExitCode(file: string): number {
  for (const line of directiveHead(file)) {
    const m = /^\/\/ @exit:\s*(\d+)\s*$/.exec(line);
    if (m) return Number(m[1]);
  }
  return 0;
}

function wantsDynamic(file: string): boolean {
  return directiveHead(file).some((l) => /^\/\/ @dynamic\s*$/.test(l));
}

async function runBinary(cmd: string, args: string[], stdin: string): Promise<RunResult> {
  // Same transient-ETXTBSY retry as llvm-differential.test.ts: a sibling
  // worker's fork can hold the freshly-linked binary's write fd open
  // across its own spawn window.
  for (let attempt = 0; ; attempt++) {
    const pending = execFileAsync(cmd, args, {
      encoding: "buffer",
      env: { ...process.env, SCRIPTC_RUST_HEAP_AUDIT: "1" },
    });
    // A short-lived program may exit before the input pipe closes; only a
    // non-EPIPE writer failure is a harness bug (runToExit's stance).
    let stdinError: NodeJS.ErrnoException | undefined;
    pending.child.stdin?.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE") stdinError = error;
    });
    pending.child.stdin?.end(stdin);
    try {
      const { stdout, stderr } = await pending;
      if (stdinError !== undefined) throw stdinError;
      return { stdout, stderr, exitCode: 0 };
    } catch (err) {
      const e = err as { code?: unknown; stdout?: Buffer; stderr?: Buffer };
      if (e.code === "ETXTBSY" && attempt < 10) {
        await new Promise((r) => setTimeout(r, 50));
        continue;
      }
      if (typeof e.code !== "number" || !Buffer.isBuffer(e.stdout) || !Buffer.isBuffer(e.stderr)) {
        throw err;
      }
      return { stdout: e.stdout, stderr: e.stderr, exitCode: e.code };
    }
  }
}

const comptimeShim = pathToFileURL(join(import.meta.dirname, "comptime-shim.mjs")).href;
const islandShim = pathToFileURL(join(import.meta.dirname, "island-shim.mjs")).href;
const transformTypesHook = pathToFileURL(join(import.meta.dirname, "transform-types-hook.mjs")).href;

function wantsTransformTypes(file: string): boolean {
  if (directiveHead(file).some((l) => /^\/\/ @transform-types\s*$/.test(l))) return true;
  return programInputs(file).some((f) => /\benum\s+[A-Za-z_$]/.test(readFileSync(f, "utf8")));
}

function wantsTscDecorators(file: string): boolean {
  return directiveHead(file).some((l) => /^\/\/ @tsc-decorators\s*$/.test(l));
}

function nodeOracleFile(file: string): string {
  if (!wantsTscDecorators(file)) return file;
  const src = readFileSync(file, "utf8");
  const out = ts5.transpileModule(src, {
    compilerOptions: { target: ts5.ScriptTarget.ES2022, module: ts5.ModuleKind.ESNext },
    fileName: file,
  }).outputText;
  const key = createHash("sha256").update(ts5.version).update("\0").update(src).digest("hex").slice(0, 16);
  const path = join(cacheDir, `dec-oracle-${key}.mjs`);
  mkdirSync(cacheDir, { recursive: true });
  // Atomic publish: the other lanes write this same content-keyed path.
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, out);
  renameSync(tmp, path);
  return path;
}

function wantsNoDeprecation(file: string): boolean {
  return directiveHead(file).some((l) => /^\/\/ @no-deprecation\s*$/.test(l));
}

function nodeOracleArgs(file: string): string[] {
  const transform = wantsTransformTypes(file)
    ? nodeTransformTypesArgs(oracleExecutable, transformTypesHook)
    : [];
  const nodep = wantsNoDeprecation(file) ? ["--no-deprecation"] : [];
  return [...transform, ...nodep, "--import", comptimeShim, "--import", islandShim, nodeOracleFile(file)];
}

function programInputs(file: string): string[] {
  if (!/\/main\.(ts|js|mjs|cjs)$/.test(file)) return [file];
  return [
    ...ENTRY_EXTS.flatMap((ext) => globSync(join(file, `../**/*.${ext}`))),
    ...globSync(join(file, "../**/tsconfig.json")),
    ...globSync(join(file, "../**/package.json")),
  ].sort();
}

async function build(file: string) {
  const hash = createHash("sha256");
  for (const f of programInputs(file)) hash.update(f).update(readFileSync(f));
  const key = hash
    .update(wantsDynamic(file) ? "dyn" : "")
    .update("rust")
    .digest("hex")
    .slice(0, 16);
  const outDir = join(cacheDir, key);
  mkdirSync(outDir, { recursive: true });
  // Unique binary BASENAME per lane: fs-corpus programs derive scratch
  // paths from tail(process.argv[1]), and this lane's binary can run
  // concurrently with the C/LLVM lanes' binaries for the same fixture
  // (llvm-differential.test.ts documents the observed corruption).
  return compile(file, {
    outPath: join(outDir, "program-rust"),
    outDir,
    backend: "rust",
    optimization: "dev",
    dynamic: wantsDynamic(file),
  });
}

// Parity ledger, summarized after the run. Refusals fail their test, but
// still land in the histogram so a batch of regressions reads as one
// summary line instead of N stack traces.
const claimed = new Set<string>();
const refusalKinds = new Map<string, number>();
const refusalPrograms = new Map<string, Set<string>>();

function refusalKind(message: string): string {
  return /^rust backend does not support (.+?) yet$/.exec(message)?.[1] ?? message;
}

describe.skipIf(sanitize)(`rust differential corpus (${files.length} programs${shardSuffix()})`, () => {
  // retry absorbs ORACLE-side nondeterminism under box load, the same
  // stance as differential.test.ts — a deterministic mismatch fails both
  // attempts.
  test.for(files.map((f) => [f.slice(corpusDir.length + 1), f] as const))(
    "%s",
    { retry: 1 },
    async ([rel, file]) => {
      const res = await build(file);
      if (!res.ok) {
        for (const d of res.diagnostics.filter((d) => d.code === "SC3001")) {
          const kind = refusalKind(d.message);
          const programs = refusalPrograms.get(kind) ?? new Set<string>();
          programs.add(rel);
          refusalPrograms.set(kind, programs);
          refusalKinds.set(kind, programs.size);
        }
        throw new Error(
          `rust backend regressed out of full-corpus parity on ${rel}: ` +
            res.diagnostics.map((d) => `${d.code} ${d.message}`).join("; "),
        );
      }
      expect(res.backend).toBe("rust");

      const stdin = STDIN_FIXTURES[rel] ?? "";
      const [rust, node] = await Promise.all([
        runBinary(res.binaryPath, [], stdin),
        runBinary(oracleExecutable, nodeOracleArgs(file), stdin),
      ]);

      // stdout: byte parity.
      if (!rust.stdout.equals(node.stdout)) {
        expect(rust.stdout.toString("utf8")).toBe(node.stdout.toString("utf8"));
        expect.unreachable("rust-vs-node stdout differed at byte level but not after utf8 decode");
      }
      const expectedExit = expectedExitCode(file);
      if (expectedExit === 0) {
        // stderr parity also proves the heap audit stayed silent.
        if (!rust.stderr.equals(node.stderr)) {
          expect(rust.stderr.toString("utf8")).toBe(node.stderr.toString("utf8"));
        }
      } else {
        // Nonzero exits diverge on uncaught-error formatting; the audit
        // marker is the one stderr fact that must still hold.
        expect(rust.stderr.toString("utf8")).not.toContain("Rust heap object(s) still live");
      }
      expect(rust.exitCode).toBe(expectedExit);
      expect(node.exitCode).toBe(expectedExit);
      claimed.add(rel);
    },
  );

  afterAll(() => {
    const hist = [...refusalKinds].sort((a, b) => b[1] - a[1]);
    console.info(
      `rust parity: ${claimed.size}/${files.length} corpus programs claimed` +
        (hist.length === 0
          ? ""
          : `; REGRESSED kinds: ${hist.map(([k, n]) => `${k}×${n}`).join(", ")}`),
    );
    if (process.env["SCRIPTC_RUST_REFUSALS"] === "1") {
      for (const [kind] of hist) {
        const programs = refusalPrograms.get(kind);
        if (programs) console.info(`  ${kind}: ${[...programs].join(" ")}`);
      }
    }
  });
});
