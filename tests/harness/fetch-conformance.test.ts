/**
 * Generated, matrix conformance for the engine-free fetch slice.
 *
 * The compatibility profile is compiler input, not test-only metadata: its
 * member allowlists drive lowering and its entries project into the shipped
 * surface manifest. The reflected inventory supplies the denominator. This
 * suite selects the profile target the running runtime IS — this is the one
 * profile whose census genuinely differs across the matrix, so a row that
 * exists on Node 26 alone is compared only against Node 26 — and checks
 * that the host is a declared target at all, that every
 * profile row names differential evidence, and the generated
 * WebIDL/state-machine program agrees through both native backends.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { beforeAll, describe, expect, test } from "vitest";
import {
  compatTargetFor,
  compatTargetList,
  compatRowOnTarget,
  compile,
  NODE24_FETCH_COMPAT_PROFILE,
  renderAll,
  type FetchCompatEvidence,
} from "@scriptc/compiler";
import {
  FETCH_CONFORMANCE_SCENARIOS,
  FETCH_CONFORMANCE_SEED,
  generateFetchConformanceProgram,
  generatedScenarioIds,
} from "./fetch-conformance-program.js";
import { primaryOracleExecutable } from "./node-matrix.js";

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, "../..");
const fixturesRoot = join(repoRoot, "tests/fixtures/fetch");
const sanitize = process.env["SCRIPTC_SAN"] === "1";
const profile = NODE24_FETCH_COMPAT_PROFILE;
/** The matrix target this run IS — selected from the running runtime
 * rather than demanded of it, so the suite is green under every declared
 * Node and red only on one the profile does not declare at all. */
const target = compatTargetFor(profile.targets, process.versions.node);
/** The census rows that exist on the active target: unqualified rows plus
 * the rows that name it (Node 26's Request/Response.textStream). */
const targetEntries = target === null
  ? profile.inventory.entries
  : profile.inventory.entries.filter((entry) => compatRowOnTarget(entry, target.id));
/** The Node the generated differential compares native output against —
 * the matrix primary, not the host. See tests/harness/node-matrix.ts. */
const oracleExecutable = primaryOracleExecutable(profile.targets);
function configuredInteger(
  name: string,
  fallback: number,
  maximum: number,
): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > maximum) {
    throw new Error(`${name} must be an integer between 0 and ${maximum}`);
  }
  return value;
}

const conformanceSeed = configuredInteger(
  "SCRIPTC_FETCH_CONFORMANCE_SEED",
  FETCH_CONFORMANCE_SEED,
  0xffff_ffff,
);
const conformanceTraceCount = configuredInteger(
  "SCRIPTC_FETCH_CONFORMANCE_TRACES",
  12,
  100,
);
const generatedSource = generateFetchConformanceProgram(profile, {
  seed: conformanceSeed,
  traceCount: conformanceTraceCount,
});
const sourceHash = createHash("sha256")
  .update(generatedSource)
  .digest("hex")
  .slice(0, 16);
const workRoot = mkdtempSync(join(tmpdir(), "scriptc-fetch-conformance-"));
const entry = join(workRoot, "main.js");

interface RunResult {
  stdout: Buffer;
  stderr: Buffer;
  exitCode: number;
}

function normalizedStderr(result: RunResult): string {
  const stderr = result.stderr.toString("utf8");
  if (!sanitize) return stderr;
  // Linux ASan prints this once per process at the runtime's first fiber
  // context switch. It has no suppression switch and is harness noise, not
  // program stderr; retain every other byte so real sanitizer reports fail.
  return stderr.replace(
    /^==\d+==WARNING: ASan doesn't fully support makecontext\/swapcontext.*\n/gm,
    "",
  );
}

async function run(command: string, args: string[]): Promise<RunResult> {
  try {
    const result = await execFileAsync(command, args, {
      encoding: "buffer",
      env: process.env,
      timeout: 30_000,
    });
    return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
  } catch (error) {
    const failure = error as {
      code?: unknown;
      stdout?: Buffer;
      stderr?: Buffer;
    };
    if (
      typeof failure.code !== "number" ||
      !Buffer.isBuffer(failure.stdout) ||
      !Buffer.isBuffer(failure.stderr)
    ) {
      throw error;
    }
    return {
      stdout: failure.stdout,
      stderr: failure.stderr,
      exitCode: failure.code,
    };
  }
}

async function build(backend: "c" | "llvm"): Promise<string> {
  const outDir = join(
    workRoot,
    `${sourceHash}-${backend}-${sanitize ? "san" : "plain"}`,
  );
  mkdirSync(outDir, { recursive: true });
  const result = await compile(entry, {
    outDir,
    outPath: join(outDir, "program"),
    backend,
    sanitize,
  });
  if (!result.ok) {
    expect.unreachable(
      `generated fetch conformance program failed to compile (${backend}):\n` +
        renderAll(result.diagnostics, result.sourceTexts, { color: false }) +
        `\ngenerated source: ${entry}`,
    );
  }
  return result.binaryPath;
}

function evidenceKey(evidence: FetchCompatEvidence): string {
  if (evidence.generated !== undefined && evidence.fixture === undefined) {
    return `generated:${evidence.generated}`;
  }
  if (evidence.fixture !== undefined && evidence.generated === undefined) {
    return `fixture:${evidence.fixture}`;
  }
  throw new Error("fetch profile evidence must name exactly one source");
}

interface RuntimeInterfaceSurface {
  statics: string[];
  prototype: string[];
  inherited: string[];
  symbols: string[];
}

const publicWellKnownSymbols = new Map<symbol, string>();
for (const name of Object.getOwnPropertyNames(Symbol)) {
  const value = (Symbol as unknown as Record<string, unknown>)[name];
  if (typeof value === "symbol") {
    publicWellKnownSymbols.set(value, `[Symbol.${name}]`);
  }
}

function publicSymbolName(symbol: symbol): string | null {
  const publicName = publicWellKnownSymbols.get(symbol);
  if (publicName !== undefined) return publicName;
  // Node-private transfer/inspection symbols are implementation details,
  // not the public WebIDL surface this profile promises to classify.
  return null;
}

function runtimeInterfaceSurface(name: string): RuntimeInterfaceSurface {
  const value = (globalThis as unknown as Record<string, unknown>)[name];
  expect(typeof value, `${name} must be a global constructor object`).toBe("function");
  const ctor = value as Function & { prototype: object };
  const prototype = ctor.prototype;
  const ownNames = Object.getOwnPropertyNames(prototype)
    .filter((member) => member !== "constructor");
  const inherited: string[] = [];
  const visibleNames = new Set(ownNames);
  const symbols: string[] = [];
  const visibleSymbols = new Set<symbol>();

  for (let current: object | null = prototype;
    current !== null && current !== Object.prototype;
    current = Object.getPrototypeOf(current) as object | null) {
    if (current !== prototype) {
      for (const member of Object.getOwnPropertyNames(current)) {
        if (member === "constructor" || visibleNames.has(member)) continue;
        visibleNames.add(member);
        inherited.push(member);
      }
    }
    for (const symbol of Object.getOwnPropertySymbols(current)) {
      if (visibleSymbols.has(symbol)) continue;
      visibleSymbols.add(symbol);
      const member = publicSymbolName(symbol);
      if (member !== null) symbols.push(member);
    }
  }

  return {
    statics: Object.getOwnPropertyNames(ctor)
      .filter((member) => !["length", "name", "prototype"].includes(member)),
    prototype: ownNames,
    inherited,
    symbols,
  };
}

function dictionaryReads(construct: (init: object) => unknown): string[] {
  const reads: string[] = [];
  const init = new Proxy({}, {
    get(_target, key) {
      reads.push(String(key));
      return undefined;
    },
  });
  construct(init);
  return [...new Set(reads)];
}

beforeAll(() => {
  writeFileSync(entry, generatedSource);
});

describe("fetch compatibility profile", () => {
  test("the running runtime is one of the declared matrix targets", () => {
    // The primary is what .node-version pins; the candidates are equally
    // supported runtimes, each with its own reflected census.
    const pinnedNode = readFileSync(join(repoRoot, ".node-version"), "utf8").trim();
    expect(profile.targets.primary.node).toBe(pinnedNode);
    expect(profile.targets.candidates.length).toBeGreaterThan(0);

    // Selection, not equality: the only failure this can produce is a host
    // outside the whole matrix. Running on any declared target is green.
    const declared = compatTargetList(profile.targets);
    expect(
      target,
      `Node ${process.versions.node} is not a declared target of the fetch profile ` +
        `(declared: ${declared.map((row) => row.node).join(", ")}) — add it to the ` +
        `matrix with its own reflected census, or run the suite under one of them`,
    ).not.toBeNull();

    // Undici is the profile's second observable component, so the target
    // that claims to be this runtime must agree about it too. A Node build
    // carrying an unexpected Undici is a real census divergence.
    expect(target!.components?.["undici"]).toBe(process.versions.undici);
  });

  test("the inventory classifies every supported row and every gap", () => {
    const supported = [...profile.operations, ...profile.requestInit, ...profile.responseInit]
      .map((row) => row.id)
      .sort();
    const entries = targetEntries;
    const ids = profile.inventory.entries.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(
      entries.filter((entry) => entry.status === "static").map((entry) => entry.id).sort(),
    ).toEqual(supported);

    // Row SHAPE is validated across the whole matrix, not just the active
    // target: a malformed Node 26 row must fail on Node 24 too.
    for (const entry of profile.inventory.entries) {
      if (entry.status === "static") {
        expect(entry.code, `${entry.id}: static rows have no refusal code`).toBeUndefined();
        expect(entry.reason, `${entry.id}: static rows are explained by evidence`).toBeUndefined();
      } else if (entry.status === "dynamic-only" || entry.status === "unsupported") {
        expect(entry.code, `${entry.id}: non-static rows use the stdlib fence`).toBe("SC2020");
        expect(entry.reason?.length, `${entry.id}: missing gap rationale`).toBeGreaterThan(0);
      } else {
        expect(entry.code, `${entry.id}: exclusions are not refusal claims`).toBeUndefined();
        expect(entry.reason?.length, `${entry.id}: missing scope rationale`).toBeGreaterThan(0);
      }
    }

    const all = profile.inventory.entries;
    expect(all.some((entry) => entry.status === "dynamic-only")).toBe(true);
    expect(all.some((entry) => entry.status === "unsupported")).toBe(true);
    expect(all.some((entry) => entry.status === "out-of-scope")).toBe(true);
    expect(profile.inventory.excludedInterfaces.length).toBeGreaterThan(0);
    for (const exclusion of profile.inventory.excludedInterfaces) {
      expect(exclusion.name.length).toBeGreaterThan(0);
      expect(exclusion.reason.length).toBeGreaterThan(0);
    }
  });

  test("the selected runtime interfaces match the complete public census", () => {
    const entries = targetEntries;
    const expected = (owner: string, placement: string): string[] =>
      entries
        .filter((entry) => entry.owner === owner && entry.placement === placement)
        .map((entry) => entry.member)
        .sort();

    for (const owner of profile.inventory.interfaces) {
      expect(
        entries.filter((entry) =>
          entry.owner === owner && entry.placement === "constructor"
        ).length,
        `${owner}: constructor classification`,
      ).toBe(1);
      const actual = runtimeInterfaceSurface(owner);
      expect(actual.statics.sort(), `${owner}: static members`).toEqual(expected(owner, "static"));
      expect(actual.prototype.sort(), `${owner}: own prototype members`).toEqual(
        expected(owner, "prototype"),
      );
      expect(actual.inherited.sort(), `${owner}: inherited prototype members`).toEqual(
        expected(owner, "prototype-inherited"),
      );
      expect(actual.symbols.sort(), `${owner}: public symbol members`).toEqual(
        expected(owner, "prototype-symbol"),
      );
    }
    expect(typeof globalThis.fetch).toBe("function");
  });

  test("the public-symbol classifier covers every well-known symbol", () => {
    expect(publicWellKnownSymbols.size).toBeGreaterThan(0);
    for (const [symbol, name] of publicWellKnownSymbols) {
      expect(publicSymbolName(symbol)).toBe(name);
    }
    expect(publicSymbolName(Symbol("nodejs.private"))).toBeNull();
  });

  test("the WebIDL dictionary census matches Node's conversion reads", () => {
    const expected = (owner: string): string[] =>
      targetEntries
        .filter((entry) => entry.owner === owner && entry.placement === "dictionary")
        .map((entry) => entry.member);
    expect(dictionaryReads((init) =>
      new Request("http://example.com", init as RequestInit)
    )).toEqual(expected("RequestInit"));
    expect(dictionaryReads((init) =>
      new Response(null, init as ResponseInit)
    )).toEqual(expected("ResponseInit"));
  });

  test("every row has unique ids and resolvable differential evidence", () => {
    expect(profile.schemaVersion).toBe(1);
    const rows = [...profile.operations, ...profile.requestInit, ...profile.responseInit];
    const ids = rows.map((row) => row.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(profile.operations.length).toBeGreaterThanOrEqual(35);

    for (const row of rows) {
      expect(row.evidence.length, `${row.id}: missing differential evidence`).toBeGreaterThan(0);
      for (const evidence of row.evidence) {
        const key = evidenceKey(evidence);
        if (evidence.generated !== undefined) {
          expect(
            FETCH_CONFORMANCE_SCENARIOS,
            `${row.id}: unknown generated scenario ${key}`,
          ).toContain(evidence.generated);
        } else {
          const root = join(fixturesRoot, evidence.fixture!);
          expect(
            existsSync(join(root, "main.js")) || existsSync(join(root, "main.mts")),
            `${row.id}: missing ${key}`,
          ).toBe(true);
        }
      }
    }
  });

  test("the profile member allowlists have matching operation rows", () => {
    for (const member of [
      ...profile.members.responseReads,
      ...profile.members.responseCalls,
    ]) {
      expect(
        profile.operations.some((operation) =>
          operation.name === `Response.${member}`
        ),
        `Response.${member} has no compatibility row`,
      ).toBe(true);
    }
    for (const member of [
      ...profile.members.readableStreamReads,
      ...profile.members.readableStreamCalls,
    ]) {
      expect(
        profile.operations.some((operation) =>
          operation.name === `ReadableStream.${member}`
        ),
        `ReadableStream.${member} has no compatibility row`,
      ).toBe(true);
    }
  });

  test("generation is deterministic and covers every registered scenario", () => {
    expect(generateFetchConformanceProgram(profile, {
      seed: conformanceSeed,
      traceCount: conformanceTraceCount,
    })).toBe(generatedSource);
    expect(generatedScenarioIds(profile)).toEqual(
      [...FETCH_CONFORMANCE_SCENARIOS].sort(),
    );
    for (const scenario of FETCH_CONFORMANCE_SCENARIOS) {
      expect(generatedSource).toContain(`// scenario: ${scenario}`);
    }
  });
});

describe(
  `generated fetch conformance (seed=${conformanceSeed}, traces=${conformanceTraceCount}` +
    `${sanitize ? ", sanitized" : ""})`,
  () => {
    test.for(["c", "llvm"] as const)(
      "%s backend matches the pinned Node oracle",
      async (backend) => {
        const binary = await build(backend);
        // NOT process.execPath: the census above follows the host, but a
        // compiled binary reproduces ONE Node's observable behavior, so
        // the differential compares against the matrix primary (or an
        // explicit SCRIPTC_NODE_ORACLE). Node 26 rewords error messages
        // Node 24 emits — AbortSignal.any's ERR_INVALID_ARG_TYPE is
        // "cannot" there and "can not" here — and comparing against
        // whichever Node happened to launch vitest would red on spelling
        // while saying nothing about either backend.
        const [nodeResult, nativeResult] = await Promise.all([
          run(oracleExecutable, [entry]),
          run(binary, []),
        ]);
        if (!nativeResult.stdout.equals(nodeResult.stdout)) {
          expect(nativeResult.stdout.toString("utf8")).toBe(
            nodeResult.stdout.toString("utf8"),
          );
          expect.unreachable("stdout differed at byte level but not after UTF-8 decoding");
        }
        expect(normalizedStderr(nativeResult)).toBe(
          nodeResult.stderr.toString("utf8"),
        );
        expect(nativeResult.exitCode).toBe(nodeResult.exitCode);
      },
      120_000,
    );
  },
);
