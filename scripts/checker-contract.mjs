#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = fileURLToPath(new URL("..", import.meta.url));
const sha256 = file => createHash("sha256").update(readFileSync(file)).digest("hex");
const units = value => Array.from({ length: value.length }, (_, i) => value.charCodeAt(i));
const source = String.raw`import { identity as alias } from "./helper.js";
import { shadow } from "./shadow.js";
type Left = { kind: "left"; value: number };
type Wide = { kind: "left" | "right"; value: number };
type Optional = Left & { extra?: number };
type Required = Left & { extra: number };
type WideFn = (value: Wide) => number;
type LeftFn = (value: Left) => number;
type Empty = readonly [];
type Pair = readonly [string, number];
type Either = Empty | Pair;
class First { private token = 1; }
class Second { private token = 1; }
type FirstType = First;
type SecondType = Second;
export const chosen = alias("literal");
export const unicode = "a😀\uFEFF\uD800";
export const leadingBom = "\uFEFFx";
function isString(value: unknown): value is string { return typeof value === "string"; }
export const filtered = ([1, "x"] as (number | string)[]).filter(isString);
export function narrow(value: unknown) {
  if (typeof value === "string") { const narrowed = value; return narrowed; }
  return "";
}
export async function asyncRead(key: string): Promise<string> { return key; }
export const readSlot = ({} as { read?: (key: string) => Promise<string> }).read;
export const all = Promise.all([Promise.resolve("text"), Promise.resolve(7)] as const);
export async function readTrimmed(): Promise<string> {
  const trimmed = (await asyncRead(" text ")).trim(); return trimmed;
}
export function implicit(value) { return value; }
export const invalid: number = "text";
export const fromOverlay = shadow;
`;

export function validateCheckerMatrix(matrix, base) {
  if (matrix?.schemaVersion !== 1 || !/^[a-f0-9]{40}$/.test(matrix.upstream ?? "") ||
      !Array.isArray(matrix.checkers) || !matrix.checkers.length) throw new Error("invalid checker matrix or upstream pin");
  const names = new Set();
  return matrix.checkers.map(entry => {
    if (!/^[a-zA-Z0-9_-]+$/.test(entry.name ?? "") || names.has(entry.name)) throw new Error("invalid or duplicate checker name");
    names.add(entry.name);
    if (!["config", "snapshot", "direct"].includes(entry.mode)) throw new Error(`invalid checker mode: ${entry.name}`);
    if (typeof entry.client !== "string" || typeof entry.server !== "string" || !/^[a-f0-9]{64}$/.test(entry.sha256 ?? ""))
      throw new Error(`client, server and expected sha256 are required: ${entry.name}`);
    const client = resolve(base, entry.client), server = resolve(base, entry.server);
    const pkg = JSON.parse(readFileSync(join(client, "package.json"), "utf8"));
    if (pkg.gitHead !== matrix.upstream) throw new Error(`client pin mismatch: ${entry.name}`);
    if (sha256(server) !== entry.sha256) throw new Error(`server hash mismatch: ${entry.name}`);
    return { ...entry, client, server, upstream: matrix.upstream, clientVersion: pkg.version };
  });
}

export function compareCheckerContracts(results) {
  if (!results.length) throw new Error("no checker results");
  const baseline = results[0];
  const failures = [];
  const names = new Set();
  for (const result of results) {
    if (!result.name || names.has(result.name)) throw new Error("missing or duplicate checker result");
    names.add(result.name);
    if (!result.ok) { failures.push({ checker: result.name, reason: result.error ?? "worker failed" }); continue; }
    if (!result.cases || !Object.keys(result.cases).length) { failures.push({ checker: result.name, reason: "empty contract" }); continue; }
    if (!baseline.ok) continue;
    if (result.upstream !== baseline.upstream) throw new Error("checker results have different upstream pins");
    for (const name of new Set([...Object.keys(baseline.cases), ...Object.keys(result.cases)])) {
      if (JSON.stringify(baseline.cases[name]) !== JSON.stringify(result.cases[name]))
        failures.push({ checker: result.name, case: name, expected: baseline.cases[name], actual: result.cases[name] });
    }
  }
  return { schemaVersion: 1, verdict: failures.length ? "FAIL" : "PASS", baseline: baseline.name,
    upstream: baseline.upstream, caseNames: Object.keys(baseline.cases ?? {}), failures, results };
}

async function probe(config, directory) {
  const { API, SignatureKind } = await import(pathToFileURL(join(config.client, "dist/api/sync/api.js")).href);
  const { ScriptTarget, SyntaxKind } = await import(pathToFileURL(join(config.client, "dist/ast/index.js")).href);
  const { preserveTransportBoms } = await import(pathToFileURL(join(repo, "packages/compiler/dist/frontend/ts7/program-adapter.js")).href);
  const entry = join(directory, "main.ts"), shadow = join(directory, "shadow.ts");
  // The BOM is source syntax; the other Unicode units exercise the binary AST.
  writeFileSync(entry, "\uFEFF" + source);
  writeFileSync(join(directory, "helper.ts"), "export function identity<T>(value: T): T { return value; }\n");
  writeFileSync(shadow, 'export const shadow = "disk";\n');
  const { serverFS } = await import(pathToFileURL(join(config.client, "dist/api/fs.js")).href);
  // New clients require a complete callback set and distinguish a missing
  // file (undefined) from delegation to the server (serverFS.useOS).
  const fs = serverFS ? {
    directoryExists: serverFS.useOS, fileExists: serverFS.useOS,
    getAccessibleEntries: serverFS.useOS, realpath: serverFS.useOS,
    stat: serverFS.useOS, writeFile: serverFS.error, removeFile: serverFS.error,
    readFile: file => resolve(file) === shadow ? 'export const shadow = "overlay";\n' : serverFS.useOS,
  } : { readFile: file => resolve(file) === shadow ? 'export const shadow = "overlay";\n' : undefined };
  const api = new API({ cwd: directory, tsserverPath: config.server,
    fs });
  const opened = [];
  function open(strict) {
    if (config.mode === "direct") {
      const program = api.createProgram([entry], { strict, target: ScriptTarget.ESNext, noEmit: true, types: [] });
      opened.push(program);
      const project = program.getProject();
      preserveTransportBoms(project);
      return project;
    }
    const file = join(directory, strict ? "strict.json" : "relaxed.json");
    writeFileSync(file, JSON.stringify({ compilerOptions: { strict, target: "esnext", noEmit: true, types: [] }, files: [entry] }));
    const snapshot = config.mode === "config" ? api.updateSnapshot({ openProjects: [file] }) : api.createSnapshot({ openProjects: [file] });
    opened.push(snapshot);
    const project = snapshot.getProjects().find(project => project.configFileName !== undefined && resolve(project.configFileName) === resolve(file));
    if (!project) throw new Error("fixture project was not opened");
    preserveTransportBoms(project);
    return project;
  }
  try {
    const project = open(true), checker = project.checker, file = project.program.getSourceFile(entry);
    if (!file) throw new Error("fixture AST was not loaded");
    const named = new Map();
    const nodes = [];
    const declarations = new Set([SyntaxKind.VariableDeclaration, SyntaxKind.TypeAliasDeclaration, SyntaxKind.FunctionDeclaration, SyntaxKind.ClassDeclaration]);
    const visit = node => { nodes.push(node); if (node.name?.text && declarations.has(node.kind)) named.set(node.name.text, node); node.forEachChild(visit); };
    visit(file);
    const type = name => checker.getTypeFromTypeNode(named.get(name).type);
    const text = name => checker.typeToString(checker.getTypeAtLocation(named.get(name).name));
    const either = type("Either").getTypes();
    const signature = checker.getResolvedSignature(named.get("chosen").initializer);
    const predicate = checker.getTypePredicateOfSignature(checker.getSignatureFromDeclaration(named.get("isString")));
    const callback = checker.getSignaturesOfType(checker.getNonNullableType(checker.getTypeAtLocation(named.get("readSlot").name)), SignatureKind.Call)[0];
    const aliases = nodes.find(node => node.name?.text === "alias" && node.propertyName);
    const diagnostics = p => p.program.getSemanticDiagnostics().map(d => {
      if (typeof d.pos !== "number" || typeof d.end !== "number" || typeof d.text !== "string") throw new Error("diagnostic payload lost its span or text");
      return { code: d.code, category: d.category, file: d.fileName ? basename(d.fileName) : null, pos: d.pos, end: d.end, text: d.text };
    }).sort((a, b) => a.code - b.code);
    const strictDiagnostics = diagnostics(project);
    const relaxed = open(false);
    const cases = {
      "assignability.direction": [["Left", "Wide"], ["Wide", "Left"], ["Left", "Optional"], ["Optional", "Required"],
        ["Required", "Optional"], ["WideFn", "LeftFn"], ["LeftFn", "WideFn"], ["FirstType", "SecondType"]]
        .map(([from, to]) => checker.isTypeAssignableTo(type(from), type(to))),
      "tuples.empty-union": either.map(t => ({ tuple: checker.isTupleType(t), arguments: checker.getTypeArguments(t).length }))
        .sort((a, b) => a.arguments - b.arguments),
      "signature.generic-call": checker.typeToString(checker.getReturnTypeOfSignature(signature)),
      "alias.target": checker.getAliasedSymbol(checker.getSymbolAtLocation(aliases.name)).name,
      "narrowing.typeof": text("narrowed"),
      "narrowing.filter-predicate": text("filtered"),
      "predicate.signature": { parameter: predicate.parameterIndex, type: checker.typeToString(predicate.type) },
      "callback.optional-async": { parameter: checker.typeToString(checker.getParameterType(callback, 0)),
        result: checker.typeToString(checker.getReturnTypeOfSignature(callback)) },
      "promise.heterogeneous-tuple": text("all"),
      "await.string-method": text("trimmed"),
      "filesystem.overlay": text("fromOverlay"),
      "unicode.ast": units(named.get("unicode").initializer.text),
      "unicode.leading-bom": { ast: units(named.get("leadingBom").initializer.text),
        type: units(checker.getTypeAtLocation(named.get("leadingBom").name).value) },
      "unicode.positions": { name: named.get("unicode").name.pos, end: named.get("unicode").name.end,
        line: file.getLineAndCharacterOfPosition(named.get("unicode").name.end) },
      "snapshot.strict": strictDiagnostics,
      "snapshot.relaxed": diagnostics(relaxed),
      "snapshot.unchanged-sibling": diagnostics(project),
    };
    const expected = {
      "assignability.direction": [true, false, true, false, true, true, false, false],
      "tuples.empty-union": [{ tuple: true, arguments: 0 }, { tuple: true, arguments: 2 }],
      "signature.generic-call": '"literal"', "alias.target": "identity", "narrowing.typeof": "string",
      "narrowing.filter-predicate": "string[]", "predicate.signature": { parameter: 0, type: "string" },
      "filesystem.overlay": '"overlay"',
      "unicode.ast": [97, 55357, 56832, 65279, 55296],
      "unicode.leading-bom": { ast: [65279, 120], type: [65279, 120] },
      "callback.optional-async": { parameter: "string", result: "Promise<string>" },
      "promise.heterogeneous-tuple": "Promise<[string, number]>",
      "await.string-method": "string",
    };
    for (const [name, value] of Object.entries(expected)) {
      if (JSON.stringify(cases[name]) !== JSON.stringify(value)) throw new Error(`contract ${name}: ${JSON.stringify(cases[name])}`);
    }
    if (strictDiagnostics.map(d => d.code).join() !== "2322,7006" || cases["snapshot.relaxed"].map(d => d.code).join() !== "2322" ||
        JSON.stringify(cases["snapshot.unchanged-sibling"]) !== JSON.stringify(strictDiagnostics)) throw new Error("snapshot diagnostic isolation failed");
    return { name: config.name, upstream: config.upstream, clientVersion: config.clientVersion,
      serverSha256: config.sha256, mode: config.mode, ok: true, cases };
  } finally {
    try { for (const value of opened.reverse()) value.dispose(); } finally { api.close(); }
  }
}

async function runWorker(config, root) {
  const directory = join(root, config.name); mkdirSync(directory);
  const job = join(directory, "job.json"); writeFileSync(job, JSON.stringify(config));
  const args = [fileURLToPath(import.meta.url), "--worker", job];
  let command = process.execPath, argv = args;
  if (process.platform === "win32") {
    const discovered = process.env.SCRIPTC_RUST_WINDOWS_JOB_PYTHON ? undefined :
      spawnSync("mise", ["which", "python"], { encoding: "utf8", timeout: 30000, windowsHide: true });
    const python = process.env.SCRIPTC_RUST_WINDOWS_JOB_PYTHON ?? (discovered?.status === 0 ? discovered.stdout.trim() : undefined);
    if (!python) throw new Error("Windows checker contracts require SCRIPTC_RUST_WINDOWS_JOB_PYTHON for bounded process jobs");
    command = python;
    argv = [join(repo, "tests/harness/windows-job.py"), join(directory, "job-receipt.json"), "32", process.execPath, ...args];
  }
  const child = spawn(command, argv, { cwd: repo, detached: process.platform !== "win32",
    env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=2048" }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let stdout = "", stderr = "", timedOut = false;
  const kill = () => {
    try { if (process.platform === "win32") child.kill(); else process.kill(-child.pid, "SIGKILL"); }
    catch (error) { if (error.code !== "ESRCH") throw error; }
  };
  const timer = setTimeout(() => { timedOut = true; kill(); }, 60000);
  child.stdout.on("data", chunk => { if (stdout.length < 2_000_000) stdout += chunk; else kill(); });
  child.stderr.on("data", chunk => { if (stderr.length < 2_000_000) stderr += chunk; else kill(); });
  let exit;
  try { exit = await new Promise((ok, fail) => { child.on("error", fail); child.on("close", (code, signal) => ok({ code, signal })); }); }
  finally { clearTimeout(timer); kill(); }
  writeFileSync(join(directory, "stdout.log"), stdout); writeFileSync(join(directory, "stderr.log"), stderr);
  let result;
  try { result = JSON.parse(stdout); } catch { result = { name: config.name, upstream: config.upstream, ok: false, error: "worker did not return a contract" }; }
  if (exit.code !== 0 || exit.signal || timedOut || stderr) result = { ...result, ok: false, error: result.error ?? "worker failed or exceeded its process boundary" };
  return { ...result, exit, timedOut };
}

async function main(args) {
  if (args[0] === "--worker") {
    const config = JSON.parse(readFileSync(args[1], "utf8"));
    try { console.log(JSON.stringify(await probe(config, dirname(args[1])))); }
    catch (error) { console.log(JSON.stringify({ name: config.name, upstream: config.upstream, ok: false, error: String(error) })); process.exitCode = 1; }
    return;
  }
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!["--matrix", "--out-dir"].includes(args[i]) || !args[i + 1] || args[i + 1].startsWith("--") || options[args[i]]) throw new Error("usage: node scripts/checker-contract.mjs [--matrix FILE] --out-dir NEW_DIRECTORY");
    options[args[i]] = args[i + 1];
  }
  if (!options["--out-dir"]) throw new Error("--out-dir is required");
  const root = resolve(options["--out-dir"]);
  if (existsSync(root)) throw new Error("choose a new output directory to preserve contract evidence");
  let entries;
  if (options["--matrix"]) {
    const file = resolve(options["--matrix"]);
    entries = validateCheckerMatrix(JSON.parse(readFileSync(file, "utf8")), dirname(file));
  } else {
    const client = dirname(createRequire(join(repo, "packages/compiler/package.json")).resolve("typescript/package.json"));
    const { patchedCheckerPath } = await import(pathToFileURL(join(repo, "packages/compiler/dist/frontend/ts7/native-checker.js")).href);
    const server = patchedCheckerPath();
    if (!server) throw new Error("build the pinned native checker before running its contract");
    const manifest = JSON.parse(readFileSync(join(repo, "packages/compiler/native-checker/manifest.json"), "utf8"));
    entries = validateCheckerMatrix({ schemaVersion: 1, upstream: manifest.commit,
      checkers: [{ name: "current", client, server, sha256: sha256(server), mode: "config" }] }, repo);
  }
  mkdirSync(root, { recursive: true });
  const results = [];
  const provenance = { scriptSha256: sha256(fileURLToPath(import.meta.url)), node: process.version,
    platform: process.platform, sourceSha256: createHash("sha256").update("\uFEFF" + source).digest("hex") };
  for (const entry of entries) {
    results.push(await runWorker(entry, root));
    writeFileSync(join(root, "results.json"), JSON.stringify({ ...compareCheckerContracts(results), provenance }, null, 2) + "\n");
  }
  const report = compareCheckerContracts(results);
  console.log(JSON.stringify({ verdict: report.verdict, upstream: report.upstream, checkers: results.length, cases: report.caseNames.length, failures: report.failures, output: root }));
  process.exitCode = report.verdict === "PASS" ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 2; });
