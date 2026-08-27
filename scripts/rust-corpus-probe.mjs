import { spawn } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(scriptPath), "..");
const corpusRoot = path.join(root, "tests", "corpus");
const internalEntry = stringArg("--internal-entry");

if (internalEntry !== null) {
  const outcome = await probe(internalEntry);
  process.stdout.write(`${JSON.stringify(outcome)}\n`);
  process.exit(0);
}

const offset = integerArg("--offset", 0);
const limit = integerArg("--limit", Number.POSITIVE_INFINITY);
const sampleLimit = integerArg("--samples", 5);
const timeoutMs = integerArg("--timeout-ms", 60_000);
const match = stringArg("--match");
const fixturePattern = match === null ? null : new RegExp(match, "u");
const entryPattern = /\.(?:[cm]?js|ts)$/u;

const discovered = (await Promise.all(
  (await readdir(corpusRoot, { withFileTypes: true })).map(async (entry) => {
    if (entry.isFile() && entryPattern.test(entry.name)) {
      return { fixture: entry.name, entryPath: path.join(corpusRoot, entry.name) };
    }
    if (!entry.isDirectory()) return null;
    const main = (await readdir(path.join(corpusRoot, entry.name), { withFileTypes: true }))
      .find((child) => child.isFile() && /^main\.(?:[cm]?js|ts)$/u.test(child.name));
    return main === undefined
      ? null
      : { fixture: entry.name, entryPath: path.join(corpusRoot, entry.name, main.name) };
  }),
)).filter((entry) => entry !== null)
  .filter((entry) => fixturePattern?.test(entry.fixture) ?? true)
  .sort((left, right) => left.fixture.localeCompare(right.fixture, "en"));
const entries = discovered
  .slice(offset, Number.isFinite(limit) ? offset + limit : undefined);

const results = new Map();
const started = performance.now();
for (const [index, { fixture, entryPath }] of entries.entries()) {
  const outcome = await runIsolatedProbe(entryPath, timeoutMs);
  const bucket = results.get(outcome.key) ?? { count: 0, samples: [] };
  bucket.count += 1;
  if (bucket.samples.length < sampleLimit) bucket.samples.push(fixture);
  results.set(outcome.key, bucket);
  if ((index + 1) % 25 === 0) {
    process.stderr.write(`probed ${index + 1}/${entries.length}\n`);
  }
}

const ordered = [...results]
  .map(([key, value]) => ({ key, ...value }))
  .sort((left, right) => right.count - left.count || left.key.localeCompare(right.key, "en"));
process.stdout.write(`${JSON.stringify({
  scope: "frontend-lower-validate-rust-emit",
  offset,
  match,
  available: discovered.length,
  count: entries.length,
  elapsedMs: Math.round(performance.now() - started),
  outcomes: ordered,
}, null, 2)}\n`);

async function probe(entryPath) {
  const [rust, lowerer, program, validator] = await Promise.all([
    import("../packages/compiler/dist/backend/rust/emitter.js"),
    import("../packages/compiler/dist/frontend/lowering/lowerer.js"),
    import("../packages/compiler/dist/frontend/program.js"),
    import("../packages/compiler/dist/ir/validate.js"),
  ]);
  let load;
  try {
    const directiveHead = (await readFile(entryPath, "utf8")).split(/\r?\n/u, 2).join("\n");
    const dynamic = /^\s*\/\/\s*@dynamic\s*$/mu.test(directiveHead);
    load = program.loadProgram(entryPath);
    const preflight = program.checkPreflight(load);
    if (preflight.length > 0) return { key: `preflight:${preflight[0].code}` };
    const lowered = lowerer.lowerToIr(load.program, load.entry, load.moduleOrder, {
      dynamic,
      startupCrash: load.startupCrash ?? null,
      externalTypes: load.externalTypes,
      externalTypeSpecifiersByFile: load.externalTypeSpecifiersByFile,
    });
    if (lowered.module === null) {
      return { key: `lower:${lowered.diagnostics[0]?.code ?? "unknown"}` };
    }
    const validation = validator.validateModule(lowered.module);
    if (validation.length > 0) return { key: "validate:invalid" };
    try {
      rust.emitRustModule(lowered.module);
      return { key: "emit:success" };
    } catch (error) {
      if (error instanceof rust.RustUnsupportedError) return { key: `emit:${error.kind}` };
      throw error;
    }
  } catch (error) {
    const name = error instanceof Error ? error.name : "unknown";
    return { key: `crash:${name}` };
  } finally {
    load?.dispose();
  }
}

function runIsolatedProbe(entryPath, timeout) {
  return new Promise((resolve) => {
    const detached = process.platform !== "win32";
    const child = spawn(process.execPath, [scriptPath, "--internal-entry", entryPath], {
      cwd: root,
      detached,
      env: { ...process.env, GOMAXPROCS: process.env.GOMAXPROCS ?? "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let timedOut = false;
    let oversized = false;
    const maxOutput = 256 * 1024;
    const killTree = () => {
      try {
        if (detached && child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        // The isolated process group already exited.
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killTree();
    }, timeout);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      if (stdout.length > maxOutput) {
        oversized = true;
        killTree();
      }
    });
    child.stderr.resume();
    child.on("error", () => {
      clearTimeout(timer);
      killTree();
      resolve({ key: "probe:spawn-error" });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      killTree();
      if (timedOut) return resolve({ key: "probe:timeout" });
      if (oversized) return resolve({ key: "probe:output-limit" });
      if (code !== 0 || signal !== null) return resolve({ key: "probe:process-exit" });
      try {
        const outcome = JSON.parse(stdout);
        if (typeof outcome?.key === "string") return resolve(outcome);
      } catch {
        // Report malformed child output below without echoing compiler dumps.
      }
      return resolve({ key: "probe:invalid-output" });
    });
  });
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
