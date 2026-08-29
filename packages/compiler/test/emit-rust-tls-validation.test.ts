import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { nodeOracleExecutable } from "../../../tests/harness/oracle-environment.js";
import { compile } from "../src/index.js";

const execFileAsync = promisify(execFile);

test("Rust TLS option validation ladders match Node byte-for-byte", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-rust-tls-validation-"));
  const entryPath = resolve("tests/corpus/2598-tls-arg-ladders.cjs");
  const result = await compile(entryPath, {
    outDir: dir,
    outPath: join(dir, "tls-validation"),
    backend: "rust",
    optimization: "dev",
  });
  expect(
    result.ok,
    result.ok ? undefined : result.diagnostics.map((diagnostic) => diagnostic.message).join("; "),
  ).toBe(true);
  if (!result.ok || result.backend !== "rust") return;
  expect(await readFile(result.sourcePath, "utf8")).not.toMatch(/\bunsafe\s*\{/);
  const [node, rust] = await Promise.all([
    execFileAsync(nodeOracleExecutable(), [entryPath]),
    execFileAsync(result.binaryPath, [], {
      env: { ...process.env, SCRIPTC_RUST_HEAP_AUDIT: "1" },
    }),
  ]);
  expect(rust.stdout).toBe(node.stdout);
  expect(rust.stderr).toBe(node.stderr);
}, 180_000);

test("Rust creates a real TLS SecureContext from a PEM pair", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-rust-secure-context-"));
  const certPath = resolve("tests/fixtures/server/certs/localhost.pem");
  const keyPath = resolve("tests/fixtures/server/certs/localhost-key.pem");
  const sources = [
    ["secure-context.ts", `
import { readFileSync } from "node:fs";
import { createSecureContext } from "node:tls";
const cert = readFileSync(${JSON.stringify(certPath)}, "utf8");
const key = readFileSync(${JSON.stringify(keyPath)}, "utf8");
createSecureContext({ cert, key });
console.log("created");
`],
    ["secure-context.cjs", `
const { readFileSync } = require("node:fs");
const { createSecureContext } = require("node:tls");
const cert = readFileSync(${JSON.stringify(certPath)}, "utf8");
const key = readFileSync(${JSON.stringify(keyPath)}, "utf8");
createSecureContext({ cert, key });
console.log("created");
`],
  ] as const;
  for (const [fileName, source] of sources) {
    const entryPath = join(dir, fileName);
    await writeFile(entryPath, source);
    const result = await compile(entryPath, {
      outDir: dir,
      outPath: join(dir, fileName.replace(/\.[^.]+$/u, "")),
      backend: "rust",
      optimization: "dev",
    });
    expect(
      result.ok,
      result.ok ? fileName : result.diagnostics.map((diagnostic) => diagnostic.message).join("; "),
    ).toBe(true);
    if (!result.ok || result.backend !== "rust") continue;
    const [node, rust] = await Promise.all([
      execFileAsync(nodeOracleExecutable(), [entryPath]),
      execFileAsync(result.binaryPath, [], {
        env: { ...process.env, SCRIPTC_RUST_HEAP_AUDIT: "1" },
      }),
    ]);
    expect(rust.stdout, fileName).toBe(node.stdout);
    expect(rust.stderr, fileName).toBe(node.stderr);
  }
}, 180_000);
