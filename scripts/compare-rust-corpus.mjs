#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const statuses = new Set(["passed-native", "passed-engine", "passed-profile-missing", "failed", "skipped", "unrun"]);
const passes = row => row.status === "passed-native" || row.status === "passed-engine";

function indexMatrix(matrix, label) {
  if (matrix?.schemaVersion !== 1 || !Array.isArray(matrix.rows) ||
      matrix.inventoryCount !== matrix.rows.length || typeof matrix.complete !== "boolean") {
    throw new Error(`${label}: invalid Rust corpus matrix`);
  }
  const rows = new Map();
  for (const row of matrix.rows) {
    if (typeof row.program !== "string" || !row.program || !statuses.has(row.status))
      throw new Error(`${label}: invalid program or status`);
    if (rows.has(row.program)) throw new Error(`${label}: duplicate program ${row.program}`);
    if (row.status === "passed-native" && row.engine !== "none")
      throw new Error(`${label}: native pass without engine none: ${row.program}`);
    if (row.status === "passed-engine" && (!row.engine || row.engine === "none"))
      throw new Error(`${label}: engine pass without an engine: ${row.program}`);
    rows.set(row.program, row);
  }
  return rows;
}

/** Protect names and execution properties, rather than aggregate pass counts.
 * OS-specific baseline inventories stay explicit: no implicit rename or removal
 * exemptions can turn a missing protected program into a retained pass. */
export function compareMatrices(baseline, candidate) {
  const before = indexMatrix(baseline, "baseline"), after = indexMatrix(candidate, "candidate");
  if (!baseline.complete) throw new Error("baseline: incomplete inventory cannot protect a checkpoint");
  const protectedRows = [...before.values()].filter(passes);
  if (!protectedRows.length) throw new Error("baseline: no passing programs to protect");
  const retained = [], regressions = [], recovered = [], added = [];
  for (const row of protectedRows) {
    const next = after.get(row.program);
    const reasons = [];
    if (!next) reasons.push("absent");
    else if (!passes(next)) reasons.push(next.status);
    else {
      if (row.status === "passed-native" && next.status !== "passed-native") reasons.push("engine-regression");
      if (row.externalFfi === false && next.externalFfi !== false) reasons.push("external-ffi-regression");
      if (row.target !== next.target) reasons.push("target-changed");
      const oldFences = new Set((row.runtimeFences ?? []).map(fence => JSON.stringify(fence)));
      if ((next.runtimeFences ?? []).some(fence => !oldFences.has(JSON.stringify(fence)))) reasons.push("new-runtime-fence");
      if (!row.flaky && next.flaky) reasons.push("new-flaky-pass");
    }
    if (reasons.length) regressions.push({ program: row.program, previous: row.status, current: next?.status ?? "absent", reasons });
    else retained.push(row.program);
  }
  for (const [program, row] of after) {
    if (!before.has(program)) added.push({ program, status: row.status });
    else if (!passes(before.get(program)) && passes(row)) recovered.push(program);
  }
  return {
    schemaVersion: 1, complete: candidate.complete, protectedCount: protectedRows.length,
    retained, regressions, recovered, added,
    verdict: candidate.complete && regressions.length === 0 ? "PASS" : "FAIL",
    context: { baseline: baseline.metadata, candidate: candidate.metadata },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2), options = {};
    for (let i = 0; i < args.length; i += 2) {
      if (!["--baseline", "--candidate", "--out"].includes(args[i]) || !args[i + 1] || args[i + 1].startsWith("--") || options[args[i]])
        throw new Error("usage: node scripts/compare-rust-corpus.mjs --baseline MATRIX --candidate MATRIX [--out FILE]");
      options[args[i]] = args[i + 1];
    }
    if (!options["--baseline"] || !options["--candidate"]) throw new Error("--baseline and --candidate are required");
    const result = compareMatrices(...["--baseline", "--candidate"].map(key => JSON.parse(readFileSync(resolve(options[key]), "utf8"))));
    if (options["--out"]) writeFileSync(resolve(options["--out"]), JSON.stringify(result, null, 2) + "\n");
    console.log(JSON.stringify({ verdict: result.verdict, protected: result.protectedCount, retained: result.retained.length, regressions: result.regressions, added: result.added.length, recovered: result.recovered.length }));
    process.exitCode = result.verdict === "PASS" ? 0 : 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}
