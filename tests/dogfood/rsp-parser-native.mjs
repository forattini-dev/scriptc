// Compile adapters importing the consumer's original installed package.
// Usage, after pnpm build:
// pnpm limit -- node tests/dogfood/rsp-parser-native.mjs /path/to/red-skills
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { compile } from "../../packages/compiler/dist/index.js";

assert(process.argv[2], "Pass the red-skills checkout path as the first argument");
const consumerRoot = realpathSync(resolve(process.argv[2]));
const packageRoot = realpathSync(join(consumerRoot, "packages/shared/node_modules/cli-args-parser"));
const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
const directory = mkdtempSync(join(tmpdir(), "scriptc-rsp-parser-native-"));
mkdirSync(join(directory, "node_modules"));
symlinkSync(packageRoot, join(directory, "node_modules/cli-args-parser"), "dir");
const evidencePath = join(directory, "evidence.json");
const evidence = {
  consumerRoot,
  consumerRevision: execFileSync("git", ["-C", consumerRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  package: { name: manifest.name, version: manifest.version, path: packageRoot },
  node: process.version,
  cases: [],
};
console.log(`Artifacts: ${directory}`);

function run(command, args) {
  const result = spawnSync(command, args, { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
  return {
    status: result.status, signal: result.signal,
    stdout: (result.stdout ?? Buffer.alloc(0)).toString("base64"),
    stderr: (result.stderr ?? Buffer.alloc(0)).toString("base64"),
    error: result.error?.message ?? null,
  };
}

try {
  for (const [name, contracts] of [["values", 8], ["errors", 7]]) {
    const entry = join(directory, `${name}.ts`);
    copyFileSync(join(import.meta.dirname, "rsp-parser", `${name}.ts`), entry);
    const result = await compile(entry, {
      backend: "rust", npmStatic: "auto", allowEngine: false, optimization: "dev",
      outDir: join(directory, name), outPath: join(directory, name, "program"),
    });
    const record = { name, contracts, result };
    evidence.cases.push(record);
    assert(result.ok, `${name}: ${JSON.stringify(result.diagnostics)}`);
    assert.equal(result.backend, "rust");
    assert.equal(result.safetyProfile, "rust-only");
    assert.deepEqual(result.execution, { engine: "none", externalFfi: false });
    assert.deepEqual(result.runtimeFences, []);
    record.node = run(process.execPath, [entry]);
    record.native = run(result.binaryPath, []);
    assert.equal(record.node.error, null);
    assert.equal(record.node.signal, null);
    assert.equal(record.node.status, 0);
    assert.deepEqual(record.native, record.node, `${name}: Node/native byte parity`);
    record.matches = true;
    console.log(`${name}: ${contracts} cases, Node/native stdout, stderr and exit status match`);
  }
} finally {
  writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + "\n");
  console.log(`Evidence: ${evidencePath}`);
}
