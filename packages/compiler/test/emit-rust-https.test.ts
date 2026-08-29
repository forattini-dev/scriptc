import { execFile, spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { nodeOracleExecutable } from "../../../tests/harness/oracle-environment.js";
import { compile } from "../src/index.js";

const execFileAsync = promisify(execFile);

interface HttpsFixtureOutcome {
  stdout: Buffer;
  exitCode: number;
  driverStdout: string;
}

function runHttpsFixture(program: string, args: string[], driver: string): Promise<HttpsFixtureOutcome> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(program, args, {
      env: { ...process.env, SCRIPTC_RUST_HEAP_AUDIT: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    let stderr = "";
    let driverStdout = "";
    let driverStarted = false;
    let driverDone: Promise<void> = Promise.resolve();
    let driverProcess: ReturnType<typeof spawn> | null = null;
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      driverProcess?.kill("SIGKILL");
      rejectRun(new Error(`HTTPS fixture timed out\nstderr:\n${stderr}`));
    }, 60_000);
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      if (driverStarted) return;
      const port = /^PORT (\d+)$/mu.exec(stderr)?.[1];
      if (port === undefined) return;
      driverStarted = true;
      driverDone = new Promise((resolveDriver, rejectDriver) => {
        driverProcess = spawn("node", [driver, port], { stdio: ["ignore", "pipe", "inherit"] });
        driverProcess.stdout.on("data", (output: Buffer) => (driverStdout += output.toString("utf8")));
        driverProcess.on("close", (code) => {
          if (code === 0) resolveDriver();
          else rejectDriver(new Error(`HTTPS driver exited ${code}`));
        });
      });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      if (signal !== null) {
        rejectRun(new Error(`HTTPS fixture died to ${signal}\nstderr:\n${stderr}`));
        return;
      }
      if (!driverStarted) {
        rejectRun(new Error(`HTTPS fixture exited without a PORT line\nstderr:\n${stderr}`));
        return;
      }
      driverDone.then(
        () => resolveRun({ stdout: Buffer.concat(stdout), exitCode: code ?? 0, driverStdout }),
        rejectRun,
      );
    });
  });
}

test.each([
  "https-client-basic",
  "https-client-selfsigned",
  "https-client-chain",
  "https-client-url",
  "https-ca-default",
  "tls-client-connect",
  "tls-echo",
  "https-hello",
])("Rust TLS/HTTPS fixture matches Node: %s", async (fixture) => {
  const fixtureRoot = resolve("tests/fixtures/server/cases", fixture);
  const entry = join(fixtureRoot, "main.ts");
  const driver = join(fixtureRoot, "driver.mjs");
  const output = await mkdtemp(join(tmpdir(), `scriptc-rust-${fixture}-`));
  const compiled = await compile(entry, {
    backend: "rust",
    optimization: "dev",
    outDir: output,
    outPath: join(output, "program"),
  });
  expect(
    compiled.ok,
    compiled.ok ? fixture : compiled.diagnostics.map((diagnostic) => diagnostic.message).join("; "),
  ).toBe(true);
  if (!compiled.ok) return;
  const node = await runHttpsFixture(nodeOracleExecutable(), [entry], driver);
  const rust = await runHttpsFixture(compiled.binaryPath, [], driver);
  expect(rust.stdout.toString("utf8")).toBe(node.stdout.toString("utf8"));
  expect(rust.stdout.equals(node.stdout)).toBe(true);
  expect(rust.exitCode).toBe(node.exitCode);
  expect(rust.driverStdout).toBe(node.driverStdout);
}, 180_000);

test("Rust TLS clients and servers interoperate in one event loop", async () => {
  const entry = resolve("tests/fixtures/server/cases/tls-connect-basic/main.ts");
  const output = await mkdtemp(join(tmpdir(), "scriptc-rust-tls-roundtrip-"));
  const compiled = await compile(entry, {
    backend: "rust",
    optimization: "dev",
    outDir: output,
    outPath: join(output, "program"),
  });
  expect(
    compiled.ok,
    compiled.ok ? entry : compiled.diagnostics.map((diagnostic) => diagnostic.message).join("; "),
  ).toBe(true);
  if (!compiled.ok) return;
  const node = await execFileAsync(nodeOracleExecutable(), ["--no-warnings", entry]);
  const rust = await execFileAsync(compiled.binaryPath, [], {
    env: { ...process.env, SCRIPTC_RUST_HEAP_AUDIT: "1" },
  });
  expect(rust.stdout).toBe(node.stdout);
  expect(rust.stderr).toBe(node.stderr);
}, 180_000);

test.each([
  "2330-tls-server-runtime-options.cjs",
  "2331-tls-server-options-typed.ts",
  "2690-https-server-timeout-option.ts",
])("Rust TLS server options corpus matches Node: %s", async (fixture) => {
  const entry = resolve("tests/corpus", fixture);
  const output = await mkdtemp(join(tmpdir(), "scriptc-rust-tls-options-"));
  const compiled = await compile(entry, {
    backend: "rust",
    optimization: "dev",
    outDir: output,
    outPath: join(output, "program"),
  });
  expect(
    compiled.ok,
    compiled.ok ? fixture : compiled.diagnostics.map((diagnostic) => diagnostic.message).join("; "),
  ).toBe(true);
  if (!compiled.ok) return;
  const node = await execFileAsync(nodeOracleExecutable(), ["--no-warnings", entry]);
  const rust = await execFileAsync(compiled.binaryPath, [], {
    env: { ...process.env, SCRIPTC_RUST_HEAP_AUDIT: "1" },
  });
  expect(rust.stdout).toBe(node.stdout);
  expect(rust.stderr).toBe(node.stderr);
}, 180_000);
