import { expect, test } from "vitest";
import {
  diffHeadline,
  familyOf,
  foldDiagnostics,
  foldInstantiation,
  foldPreflight,
  foldQuotedNames,
  headline,
  isCascade,
  isFenceMirror,
  packageOfPath,
  quotedNames,
  renderLedger,
  summarizeEntry,
} from "../../scripts/lib/dogfood-ledger-summary.mjs";

const diag = (code: string, message: string, file = "/w/app/src/main.ts", start = 0) => ({ code, message, loc: { file, start, end: start + 1 } });
const stats = (total: number, failed: number, functionsSkipped = 0) => ({ statementsTotal: total, statementsFailed: failed, statementsIsland: 0, functionsSkipped });
const options = { backend: "rust", allowEngine: false, npmStatic: "auto", target: "node26", optimization: "dev" };

test("package attribution takes the last node_modules segment, scoped names whole", () => {
  expect(packageOfPath("/w/x/node_modules/lodash-es/lodash.js")).toBe("lodash-es");
  expect(packageOfPath("/w/x/node_modules/@smithy/core/dist-cjs/index.js")).toBe("@smithy/core");
  expect(packageOfPath("/w/x/node_modules/.pnpm/@octokit+plugin-retry@8.1.1_@octokit+core@7.0.7/node_modules/@octokit/plugin-retry/dist-bundle/index.js")).toBe("@octokit/plugin-retry");
  expect(packageOfPath("/w/x/node_modules/recker/node_modules/undici/index.js")).toBe("undici");
  expect(packageOfPath("/w/red-skills/packages/github/surface.ts")).toBe("<program>");
  expect(packageOfPath("C:\\w\\node_modules\\pino\\pino.js")).toBe("pino");
});

test("quoted names normalise, nested quotes included, apostrophes untouched", () => {
  expect(foldQuotedNames("uses of 'entry' inherit the blocker on its declaration")).toBe("uses of '_' inherit the blocker on its declaration");
  expect(foldQuotedNames("'new RegExp with a 'RegExp' pattern' is part of the standard library types but has no scriptc lowering yet"))
    .toBe("'_' is part of the standard library types but has no scriptc lowering yet");
  expect(foldQuotedNames("union types must match exactly: expected '(number | { httpHeader: string })[] | (number | { httpQuery: string })[]', got 'number[]' (a union re-tags)"))
    .toBe("union types must match exactly: expected '_', got '_' (a union re-tags)");
  expect(foldQuotedNames("require() with bindings outside the module's top level (move it to the top of the file)"))
    .toBe("require() with bindings outside the module's top level (move it to the top of the file)");
  expect(foldQuotedNames("the '+' operator on 'any'-typed values runs in the embedded dynamic engine")).toBe("the '_' operator on '_'-typed values runs in the embedded dynamic engine");
  expect(quotedNames("Property 'on' does not exist on type 'ChildProcess'.")).toEqual(["on", "ChildProcess"]);
  expect(quotedNames("'clearTimeout of 'unknown' handles' is part of the standard library types")).toEqual(["clearTimeout of 'unknown' handles"]);
});

test("the instantiation suffix folds and the family drops the not-supported tail", () => {
  expect(foldInstantiation("assignment to non-variables are not supported yet (instantiating 'reqSerializer' with (unknown))"))
    .toEqual({ message: "assignment to non-variables are not supported yet", instantiated: true });
  expect(foldInstantiation("spread arguments are not supported yet")).toEqual({ message: "spread arguments are not supported yet", instantiated: false });
  expect(familyOf(diag("SC1090", "Math methods as values (call 'max' directly) are not supported yet (instantiating 'f' with <number>)")))
    .toEqual({ code: "SC1090", family: "Math methods as values (call '_' directly)", instantiated: true });
  expect(familyOf(diag("SC2020", "'ReadableStream.push' is typed by @types/node but has no scriptc lowering yet (instantiating 'getAwsChunkedEncodingStream' with (unknown, unknown))")))
    .toEqual({ code: "SC2020", family: "'_' is typed by @types/node but has no scriptc lowering yet", instantiated: true });
});

test("fence mirrors and cascades are recognised", () => {
  expect(isFenceMirror(diag("SC3003", "--no-engine refuses deferred unsupported functionality: [SC1090] spread arguments are not supported yet"))).toBe(true);
  expect(isFenceMirror(diag("SC3003", "--no-engine forbids the island; this program requires a JavaScript engine"))).toBe(false);
  expect(isCascade(diag("SC2004", "uses of 'task' inherit the blocker on its declaration"))).toBe(true);
  expect(isCascade(diag("SC1090", "uses of 'task' inherit the blocker on its declaration"))).toBe(false);
});

test("fences fold by code, package, site and root family with cascades apart", () => {
  const nm = (pkg: string, file: string) => `/w/app/node_modules/${pkg}/${file}`;
  const fences = [
    diag("SC1090", "extending computed expressions are not supported yet", nm("@aws-sdk/client-s3", "a.js"), 1),
    diag("SC1090", "extending computed expressions are not supported yet", nm("@aws-sdk/client-s3", "a.js"), 2),
    diag("SC1090", "extending computed expressions are not supported yet", nm("@smithy/core", "b.js"), 3),
    diag("SC2004", "uses of 'entry' inherit the blocker on its declaration", nm("lodash-es", "c.js"), 4),
    diag("SC2004", "uses of 'entry' inherit the blocker on its declaration", nm("lodash-es", "c.js"), 5),
    diag("SC2004", "uses of 'task' inherit the blocker on its declaration", nm("lodash-es", "d.js"), 6),
    diag("SC2020", "'RegExpConstructor' is part of the standard library types but has no scriptc lowering yet (instantiating 'f' with (unknown))", "/w/app/src/x.js", 7),
    diag("SC2020", "'ObjectConstructor' is part of the standard library types but has no scriptc lowering yet", "/w/app/src/x.js", 8),
  ];
  const sites = ["module-init", "module-init", "module-init", "function", "function", "module-init", "function", "declaration"];
  const folded = foldDiagnostics(fences, { sites });
  expect(folded.total).toBe(8);
  expect(folded.direct).toBe(5);
  expect(folded.cascades).toEqual({ total: 3, distinctBindings: 2, bySite: { moduleInit: 1, function: 2, declaration: 0 } });
  expect(folded.instantiated).toBe(1);
  expect(folded.byCode).toEqual({ SC1090: 3, SC2004: 3, SC2020: 2 });
  expect(folded.byPackage).toEqual({ "@aws-sdk/client-s3": 2, "lodash-es": 3, "<program>": 2, "@smithy/core": 1 });
  expect(folded.firstParty).toBe(2);
  expect(folded.thirdParty).toBe(6);
  expect(folded.bySite).toEqual({ moduleInit: 4, function: 3, declaration: 1 });
  expect(folded.familyCount).toBe(2);
  expect(folded.families[0]).toEqual({
    code: "SC1090",
    family: "extending computed expressions",
    count: 3,
    sites: { moduleInit: 3, function: 0, declaration: 0 },
    packages: { "@aws-sdk/client-s3": 2, "@smithy/core": 1 },
  });
  expect(folded.families[1]).toEqual({
    code: "SC2020",
    family: "'_' is part of the standard library types but has no scriptc lowering yet",
    count: 2,
    sites: { moduleInit: 0, function: 1, declaration: 1 },
    packages: { "<program>": 2 },
  });
  // Without a site array the breakdown is absent, never fabricated.
  expect(foldDiagnostics(fences).bySite).toBeUndefined();
});

test("preflight errors group into message families with their name variants", () => {
  const rows = [
    diag("SC0001", "Property 'on' does not exist on type 'ChildProcess'.", "/w/app/src/a.ts"),
    diag("SC0001", "Property 'once' does not exist on type 'ChildProcess'.", "/w/app/src/b.ts"),
    diag("SC0001", "Property 'once' does not exist on type 'Server'.", "/w/app/src/b.ts"),
    diag("SC0001", "Parameter 'code' implicitly has an 'any' type.", "/w/app/src/a.ts"),
    diag("SC0001", "Cannot find module 'tuiuiu.js/red-dev' or its corresponding type declarations.", "/w/app/src/ui.ts"),
  ];
  const folded = foldPreflight(rows);
  expect(folded.total).toBe(5);
  expect(folded.familyCount).toBe(3);
  expect(folded.families[0]).toEqual({
    code: "SC0001",
    pattern: "Property '_' does not exist on type '_'.",
    count: 3,
    files: 2,
    variants: { "once · ChildProcess": 1, "once · Server": 1, "on · ChildProcess": 1 },
  });
  expect(folded.byPackage).toEqual({ "<program>": 5 });
});

function fencedCoverage() {
  return {
    file: "/w/app/src/main.ts",
    dynamic: false,
    preflightFailed: false,
    backend: "rust",
    execution: { engine: "none", externalFfi: false },
    stats: stats(100, 10),
    diagnostics: [
      diag("SC3003", "--no-engine refuses deferred unsupported functionality: [SC1090] spread arguments are not supported yet", "/w/app/node_modules/pino/p.js"),
      diag("SC3003", "--no-engine refuses deferred unsupported functionality: [SC2004] uses of 'x' inherit the blocker on its declaration", "/w/app/node_modules/pino/p.js"),
      diag("SC9001", "internal compiler error: in %m6.splitStream: call to undeclared function \"%m6.isReadableStream\" — please report this", "/w/app/node_modules/@smithy/core/index.js"),
    ],
    runtimeFences: [
      diag("SC1090", "spread arguments are not supported yet", "/w/app/node_modules/pino/p.js", 1),
      diag("SC2004", "uses of 'x' inherit the blocker on its declaration", "/w/app/node_modules/pino/p.js", 2),
    ],
    runtimeFenceSites: ["module-init", "function"],
    unreached: {
      stats: stats(40, 5, 3),
      diagnostics: [diag("SC1050", "'break outer' targeting this statement form is not supported yet")],
      runtimeFences: [diag("SC2020", "'Object.setPrototypeOf' is part of the standard library types but has no scriptc lowering yet", "/w/app/node_modules/pino/q.js", 3)],
      runtimeFenceSites: ["function"],
    },
    npmStatic: [
      { package: "pino", status: "static" },
      { package: "he", status: "fallback", detail: "auto: the program does not typecheck against its inferred surface" },
    ],
  };
}

test("a fenced entry counts blockers as lowering diagnostics plus reached fences, mirrors excluded", () => {
  const record = summarizeEntry({
    name: "sample",
    entry: "/w/app/src/main.ts",
    options,
    relativize: (s: string) => s.replace("/w/app", "${app}"),
    analysis: { coverage: fencedCoverage(), sources: 12, elapsedMs: 1234, peakRssKiB: 4096 },
  });
  expect(record.stage).toBe("fenced");
  expect(record.entry).toBe("${app}/src/main.ts");
  expect(record.blockers).toMatchObject({ total: 2, loweringDiagnostics: 0, reachedFences: 2, fenceMirrors: 2, postLoweringDiagnostics: 1 });
  expect(record.diagnostics.postLowering.byCode).toEqual({ SC9001: 1 });
  expect(record.diagnostics.engineRequired).toBe(false);
  expect(record.fences.total).toBe(2);
  expect(record.fences.cascades.total).toBe(1);
  expect(record.fences.bySite).toEqual({ moduleInit: 1, function: 1, declaration: 0 });
  expect(record.statements).toEqual({ total: 100, failed: 10, island: 0, passingPct: 90, functionsSkipped: 0 });
  expect(record.unreached).toMatchObject({ statements: 40, failed: 5, functionsSkipped: 3 });
  expect(record.unreached.fences.total).toBe(1);
  expect(record.unreached.diagnostics.total).toBe(1);
  expect(record.npmStatic).toEqual({ static: 1, fallbackCount: 1, fallback: [{ package: "he", reason: "auto: the program does not typecheck against its inferred surface" }] });
  expect(record.sources).toBe(12);
  expect(record.elapsedMs).toBe(1234);
  expect(JSON.stringify(record)).not.toContain("/w/app");
});

test("stages follow the pipeline: frontier, rejected, clean, preflight-failed, unavailable, crashed", () => {
  const base = { name: "s", entry: "/e.ts", options };
  const frontier = summarizeEntry({ ...base, analysis: { coverage: { ...fencedCoverage(), execution: undefined, diagnostics: [diag("SC2013", "importing 'he' requires the embedded dynamic engine, which this build does not include")], runtimeFences: [diag("SC1090", "spread arguments are not supported yet")], runtimeFenceSites: ["function"] } } });
  expect(frontier.stage).toBe("frontier");
  expect(frontier.blockers).toMatchObject({ total: 2, loweringDiagnostics: 1, reachedFences: 1, postLoweringDiagnostics: 0 });
  expect(frontier.diagnostics.lowering.families[0]).toMatchObject({ code: "SC2013", family: "importing '_' requires the embedded dynamic engine, which this build does not include", count: 1 });

  const rejected = summarizeEntry({ ...base, analysis: { coverage: { ...fencedCoverage(), diagnostics: [diag("SC3001", "the Rust backend has no lowering for this construct yet")], runtimeFences: undefined, runtimeFenceSites: undefined } } });
  expect(rejected.stage).toBe("rejected");
  expect(rejected.fences.bySite).toEqual({ moduleInit: 0, function: 0, declaration: 0 });

  const engine = summarizeEntry({ ...base, analysis: { coverage: { ...fencedCoverage(), execution: { engine: "boa", externalFfi: false }, diagnostics: [diag("SC3003", "--no-engine forbids island imports; this program requires a JavaScript engine")], runtimeFences: undefined, runtimeFenceSites: undefined } } });
  expect(engine.stage).toBe("rejected");
  expect(engine.diagnostics.engineRequired).toBe(true);

  const clean = summarizeEntry({ ...base, analysis: { coverage: { ...fencedCoverage(), diagnostics: [], runtimeFences: undefined, runtimeFenceSites: undefined, unreached: undefined } } });
  expect(clean.stage).toBe("clean");
  expect(clean.blockers.total).toBe(0);
  expect(clean.unreached).toBeNull();

  const preflight = summarizeEntry({ ...base, analysis: { coverage: { file: "/e.ts", dynamic: false, preflightFailed: true, stats: stats(0, 0), diagnostics: [diag("SC0001", "Property 'on' does not exist on type 'Server'.")] } } });
  expect(preflight.stage).toBe("preflight-failed");
  expect(preflight.blockers.total).toBeNull();
  expect(preflight.preflight.families[0].pattern).toBe("Property '_' does not exist on type '_'.");

  const unavailable = summarizeEntry({ ...base, unavailable: "missing on this machine: /e.ts" });
  expect(unavailable.stage).toBe("unavailable");
  expect(unavailable.unavailable).toBe("missing on this machine: /e.ts");

  const crashed = summarizeEntry({ ...base, crashed: { name: "InternalCompilerError", message: "lowerer bug: no active function context" }, analysis: { elapsedMs: 10 } });
  expect(crashed.stage).toBe("crashed");
  expect(crashed.crashed).toEqual({ name: "InternalCompilerError", message: "lowerer bug: no active function context" });
  expect(crashed.elapsedMs).toBe(10);
});

test("headline deltas name every changed metric and ignore wall time", () => {
  const before = summarizeEntry({ name: "s", entry: "/e.ts", options, analysis: { coverage: fencedCoverage(), sources: 12, elapsedMs: 100 } });
  const after = summarizeEntry({
    name: "s",
    entry: "/e.ts",
    options,
    analysis: {
      coverage: { ...fencedCoverage(), runtimeFences: [diag("SC1090", "spread arguments are not supported yet", "/w/app/node_modules/pino/p.js", 1)], runtimeFenceSites: ["module-init"], stats: stats(100, 9) },
      sources: 12,
      elapsedMs: 900,
    },
  });
  expect(headline(before).blockers).toBe(2);
  const delta = diffHeadline(before, after);
  expect(delta.map((d) => d.metric)).toEqual(["blockers", "fences", "fencesCascades", "fencesThirdParty", "fencesFunction", "statementsFailed", "passingPct"]);
  expect(delta.find((d) => d.metric === "blockers")).toEqual({ metric: "blockers", before: 2, after: 1, delta: -1 });
  expect(diffHeadline(before, before)).toEqual([]);
  expect(diffHeadline(undefined, after).find((d) => d.metric === "stage")).toEqual({ metric: "stage", before: null, after: "fenced", delta: null });
});

test("the table renders one row per entry, preflight families, and deltas", () => {
  const fenced = summarizeEntry({ name: "fenced-entry", entry: "/e.ts", options, analysis: { coverage: fencedCoverage(), sources: 12, elapsedMs: 100 } });
  const preflight = summarizeEntry({ name: "preflight-entry", entry: "/p.ts", options, analysis: { coverage: { file: "/p.ts", dynamic: false, preflightFailed: true, stats: stats(0, 0), diagnostics: [diag("SC0001", "Property 'on' does not exist on type 'Server'."), diag("SC0001", "Property 'off' does not exist on type 'Server'.")] }, sources: 3, elapsedMs: 5 } });
  const missing = summarizeEntry({ name: "missing-entry", entry: "/m.ts", options, unavailable: "missing on this machine: /m.ts" });
  const previous = summarizeEntry({ name: "fenced-entry", entry: "/e.ts", options, generatedAt: "2026-10-01T00:00:00.000Z", analysis: { coverage: { ...fencedCoverage(), stats: stats(100, 12) }, sources: 12, elapsedMs: 100 } });
  const out = renderLedger([fenced, preflight, missing], new Map([["fenced-entry", previous]]));
  expect(out).toContain("entry");
  expect(out).toMatch(/fenced-entry\s+fenced\s+2\s+0\s+1\s+2\s+1\s+1\s+0\/2\s+100\s+10\s+90/);
  expect(out).toMatch(/preflight-entry\s+preflight-failed\s+-\s+2 TS/);
  expect(out).toContain("missing-entry: unavailable — missing on this machine: /m.ts");
  expect(out).toContain("×2    Property '_' does not exist on type '_'.  [SC0001] (off · Server ×1, on · Server ×1)");
  expect(out).toContain("fenced-entry: vs committed record (2026-10-01T00:00:00.000Z):");
  expect(out).toContain("-2  statementsFailed  (12 → 10)");
  expect(out).toContain("no committed record yet for preflight-entry, missing-entry");
  expect(out).toContain("blockers = lowering diagnostics + reached runtime fences");
});
