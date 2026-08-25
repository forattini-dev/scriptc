import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { emitRustModule, RustUnsupportedError } from "../packages/compiler/dist/backend/rust/emitter.js";
import { lowerToIr } from "../packages/compiler/dist/frontend/lowering/lowerer.js";
import { checkPreflight, loadProgram } from "../packages/compiler/dist/frontend/program.js";
import { validateModule } from "../packages/compiler/dist/ir/validate.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const corpusRoot = path.join(root, "tests", "corpus");
const offset = integerArg("--offset", 0);
const limit = integerArg("--limit", Number.POSITIVE_INFINITY);
const sampleLimit = integerArg("--samples", 5);
const match = stringArg("--match");
const fixturePattern = match === null ? null : new RegExp(match, "u");

const entries = (await readdir(corpusRoot, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && /\.(?:[cm]?js|ts)$/.test(entry.name))
  .map((entry) => entry.name)
  .filter((entry) => fixturePattern?.test(entry) ?? true)
  .sort((left, right) => left.localeCompare(right, "en"))
  .slice(offset, Number.isFinite(limit) ? offset + limit : undefined);

const results = new Map();
const started = performance.now();
for (const [index, fixture] of entries.entries()) {
  const entryPath = path.join(corpusRoot, fixture);
  const outcome = probe(entryPath);
  const bucket = results.get(outcome.key) ?? { count: 0, samples: [] };
  bucket.count += 1;
  if (bucket.samples.length < sampleLimit) bucket.samples.push(fixture);
  results.set(outcome.key, bucket);
  if ((index + 1) % 50 === 0) {
    process.stderr.write(`probed ${index + 1}/${entries.length}\n`);
  }
}

const ordered = [...results]
  .map(([key, value]) => ({ key, ...value }))
  .sort((left, right) => right.count - left.count || left.key.localeCompare(right.key, "en"));
process.stdout.write(`${JSON.stringify({
  offset,
  match,
  count: entries.length,
  elapsedMs: Math.round(performance.now() - started),
  outcomes: ordered,
}, null, 2)}\n`);

function probe(entryPath) {
  let load;
  try {
    load = loadProgram(entryPath);
    const preflight = checkPreflight(load);
    if (preflight.length > 0) return { key: `preflight:${preflight[0].code}` };
    const lowered = lowerToIr(load.program, load.entry, load.moduleOrder, {
      startupCrash: load.startupCrash ?? null,
      externalTypes: load.externalTypes,
      externalTypeSpecifiersByFile: load.externalTypeSpecifiersByFile,
    });
    if (lowered.module === null) {
      return { key: `lower:${lowered.diagnostics[0]?.code ?? "unknown"}` };
    }
    const validation = validateModule(lowered.module);
    if (validation.length > 0) return { key: "validate:invalid" };
    try {
      emitRustModule(lowered.module);
      return { key: "emit:success" };
    } catch (error) {
      if (error instanceof RustUnsupportedError) return { key: `emit:${error.kind}` };
      throw error;
    }
  } catch (error) {
    const name = error instanceof Error ? error.name : "unknown";
    return { key: `crash:${name}` };
  } finally {
    load?.dispose();
  }
}

function integerArg(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const raw = process.argv[index + 1];
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(`${name} expects a non-negative integer`);
  }
  return value;
}

function stringArg(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  const value = process.argv[index + 1];
  if (value === undefined) throw new TypeError(`${name} expects a value`);
  return value;
}
