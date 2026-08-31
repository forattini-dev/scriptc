import { execFile, spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { nodeOracleExecutable } from "../../../tests/harness/oracle-environment.js";
import { compile } from "../src/index.js";

const execFileAsync = promisify(execFile);

function runWithOpenStdin(
  file: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ stdout: string; stderr: string; elapsedMs: number }> {
  return new Promise((resolveRun, rejectRun) => {
    const startedAt = Date.now();
    const child = spawn(file, args, { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.stdin.on("error", () => {});
    child.on("error", rejectRun);
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      rejectRun(new Error(`${file} did not exit with open stdin`));
    }, 10_000);
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolveRun({ stdout, stderr, elapsedMs: Date.now() - startedAt });
      else rejectRun(new Error(`${file} exited with code ${String(code)}: ${stderr}`));
    });
  });
}

async function runWithDelayedNetwork(
  file: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  delayMs = 50,
): Promise<{ stdout: string; stderr: string; elapsedMs: number }> {
  const server = createServer((socket) => {
    setTimeout(() => socket.end("network"), delayMs);
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("TCP server has no port");
  try {
    return await runWithOpenStdin(file, [...args, String(address.port)], env);
  } finally {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  }
}

test.each([
  "1567-server-close-override.ts",
  "1797-dyn-handle-socket.cjs",
  "2596-net-arg-ladders.cjs",
  "2640-net-dyn-socket-compat.cjs",
  "2695-net-typed-roundtrip.ts",
])("Rust TCP corpus matches Node: %s", async (fixtureName) => {
  const fixture = resolve("tests/corpus", fixtureName);
  const dir = await mkdtemp(join(tmpdir(), "scriptc-rust-net-server-"));
  const result = await compile(fixture, {
    outDir: dir,
    outPath: join(dir, fixtureName.slice(0, -3)),
    backend: "rust",
    optimization: "dev",
  });
  expect(
    result.ok,
    result.ok ? fixture : result.diagnostics.map((diagnostic) => diagnostic.message).join("; "),
  ).toBe(true);
  if (!result.ok) return;

  const node = await execFileAsync(nodeOracleExecutable(), [fixture]);
  const rust = await execFileAsync(result.binaryPath, [], {
    env: { ...process.env, SCRIPTC_RUST_HEAP_AUDIT: "1" },
  });
  expect(rust.stdout).toBe(node.stdout);
  expect(rust.stderr).toBe(node.stderr);
});

test("Rust TCP corpus matches Node with open stdin: 2807-event-loop-stdin-network-fairness.ts", async () => {
  const fixture = resolve("tests/corpus/2807-event-loop-stdin-network-fairness.ts");
  const dir = await mkdtemp(join(tmpdir(), "scriptc-rust-net-stdin-"));
  const result = await compile(fixture, {
    outDir: dir,
    outPath: join(dir, "event-loop-stdin-network-fairness"),
    backend: "rust",
    optimization: "dev",
  });
  expect(
    result.ok,
    result.ok ? fixture : result.diagnostics.map((diagnostic) => diagnostic.message).join("; "),
  ).toBe(true);
  if (!result.ok) return;

  const node = await runWithDelayedNetwork(nodeOracleExecutable(), [fixture], process.env);
  const rust = await runWithDelayedNetwork(result.binaryPath, [], {
    ...process.env,
    SCRIPTC_RUST_HEAP_AUDIT: "1",
  });
  expect(node.stdout).toBe("network\n");
  expect(node.elapsedMs).toBeLessThan(1_500);
  expect(rust.elapsedMs).toBeLessThan(1_500);
  expect(rust.stdout).toBe(node.stdout);
  expect(rust.stderr).toBe(node.stderr);
});

test("Rust TCP waits use descriptor polling: 2809-net-poll-context-switches.ts", async () => {
  const fixture = resolve("tests/corpus/2809-net-poll-context-switches.ts");
  const dir = await mkdtemp(join(tmpdir(), "scriptc-rust-net-poll-"));
  const result = await compile(fixture, {
    outDir: dir,
    outPath: join(dir, "net-poll-context-switches"),
    backend: "rust",
    optimization: "dev",
  });
  expect(
    result.ok,
    result.ok ? fixture : result.diagnostics.map((diagnostic) => diagnostic.message).join("; "),
  ).toBe(true);
  if (!result.ok) return;

  const node = await runWithDelayedNetwork(nodeOracleExecutable(), [fixture], process.env, 750);
  const rust = await runWithDelayedNetwork(result.binaryPath, [], {
    ...process.env,
    SCRIPTC_RUST_HEAP_AUDIT: "1",
  }, 750);
  expect(node.stdout).toBe("network true\n");
  expect(rust.stdout).toBe(node.stdout);
  expect(rust.stderr).toBe(node.stderr);
});
