#!/usr/bin/env node
// Compile original consumer sources and retain evidence before running their
// existing contracts. No bundling, source rewriting or island fallback.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { analyze, compile, isRuntimeTargetId } from "../packages/compiler/dist/index.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    entry: { type: "string" },
    target: { type: "string", default: "node24" },
    out: { type: "string" },
    cwd: { type: "string" },
    "binary-env": { type: "string", default: "SCRIPTC_NATIVE_BINARY" },
    "npm-static": { type: "string", multiple: true },
  },
});
if (!values.entry || !values.out || !isRuntimeTargetId(values.target)) {
  throw new Error("usage: pnpm build && node scripts/native-acceptance.mjs --entry entry.ts --out output-directory [--target bun] [--cwd consumer-directory] [--binary-env NAME] -- command args...");
}
if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(values["binary-env"])) throw new Error("invalid binary environment variable");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const entry = resolve(values.entry);
const output = resolve(values.out);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
function treeHash(directory) {
  const hash = createHash("sha256");
  function walk(path, prefix) {
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(join(path, entry.name), name);
      else if (entry.isFile()) hash.update(name).update("\0").update(digest(readFileSync(join(path, entry.name))));
    }
  }
  walk(directory, "");
  return hash.digest("hex");
}
function revision(cwd) {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" });
  const status = spawnSync("git", ["status", "--porcelain=v1"], { cwd, encoding: "utf8" });
  return { commit: result.status === 0 ? result.stdout.trim() : null, dirty: status.status === 0 ? status.stdout.length > 0 : null };
}
const options = {
  backend: "rust", allowEngine: false, target: values.target,
  ...(values["npm-static"] ? { npmStatic: values["npm-static"] } : {}),
};
mkdirSync(output, { recursive: true });
const reportPath = join(output, "acceptance.json");
const report = {
  schema: 1, createdAt: new Date().toISOString(), entry, options,
  compiler: {
    ...revision(root),
    distSha256: treeHash(join(root, "packages/compiler/dist")),
    runtimeSourceSha256: treeHash(join(root, "packages/runtime-rust/src")),
    runtimeLockSha256: digest(readFileSync(join(root, "packages/runtime-rust/Cargo.lock"))),
    node: process.version,
    rustc: spawnSync("rustc", ["--version"], { encoding: "utf8" }).stdout?.trim() ?? null,
  },
  consumer: revision(dirname(entry)),
  analysis: null, build: null, contract: null,
};
const save = () => writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
try {
  const analysis = analyze(entry, options);
  const sources = [...analysis.sourceTexts].sort(([a], [b]) => a.localeCompare(b));
  report.analysis = {
    preflightFailed: analysis.coverage.preflightFailed,
    diagnostics: analysis.coverage.diagnostics,
    runtimeFences: analysis.coverage.runtimeFences ?? [],
    execution: analysis.coverage.execution ?? null,
    sources: sources.map(([file, text]) => ({ file, sha256: digest(text) })),
  };
  save();
  if (report.analysis.preflightFailed || report.analysis.diagnostics.length > 0) {
    throw new Error(`native analysis refused the program; see ${reportPath}`);
  }
  const started = performance.now();
  const result = await compile(entry, { ...options, outDir: output, outPath: join(output, "program") });
  report.build = result.ok ? {
    ok: true, milliseconds: performance.now() - started,
    execution: result.execution, runtimeFences: result.runtimeFences,
    binary: result.binaryPath, binarySha256: digest(readFileSync(result.binaryPath)),
    generatedSourceSha256: digest(readFileSync(result.sourcePath)),
  } : { ok: false, diagnostics: result.diagnostics };
  save();
  if (!result.ok || result.execution.engine !== "none" || result.runtimeFences.length !== 0) {
    throw new Error(`native build did not meet admission requirements; see ${reportPath}`);
  }
  if (positionals.length > 0) {
    const cwd = resolve(values.cwd ?? dirname(entry));
    const contract = spawnSync(positionals[0], positionals.slice(1), {
      cwd, env: { ...process.env, [values["binary-env"]]: result.binaryPath },
      timeout: 300_000, maxBuffer: 16 * 1024 * 1024,
    });
    writeFileSync(join(output, "contract.stdout"), contract.stdout ?? "");
    writeFileSync(join(output, "contract.stderr"), contract.stderr ?? "");
    report.contract = { command: positionals, cwd, exitCode: contract.status, signal: contract.signal, error: contract.error?.message ?? null };
    save();
    if (contract.error || contract.status !== 0) throw new Error(`consumer contracts failed; see ${output}/contract.stderr`);
  }
  console.log(reportPath);
} catch (error) {
  report.error = error.message;
  save();
  console.error(error.message);
  process.exitCode = 1;
}
