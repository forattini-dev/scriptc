import { execFile, spawn } from "node:child_process";
import { createSocket } from "node:dgram";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { nodeOracleExecutable } from "../../../tests/harness/oracle-environment.js";
import { compile } from "../src/index.js";

const execFileAsync = promisify(execFile);

async function reserveUdpPort(): Promise<number> {
  const socket = createSocket("udp4");
  await new Promise<void>((resolveBind, rejectBind) => {
    socket.once("error", rejectBind);
    socket.bind(0, "127.0.0.1", resolveBind);
  });
  const address = socket.address();
  await new Promise<void>((resolveClose) => socket.close(() => resolveClose()));
  return address.port;
}

async function runWithDelayedDatagram(
  file: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  delayMs = 0,
): Promise<{ stdout: string; stderr: string; elapsedMs: number }> {
  const port = await reserveUdpPort();
  return await new Promise((resolveRun, rejectRun) => {
    const startedAt = Date.now();
    const child = spawn(file, [...args, String(port)], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let sent = false;
    let sendTimer: ReturnType<typeof setTimeout> | undefined;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (!sent && stdout.includes("ready\n")) {
        sent = true;
        sendTimer = setTimeout(() => {
          const sender = createSocket("udp4");
          sender.send("dgram", port, "127.0.0.1", (error) => {
            sender.close();
            if (error !== null) rejectRun(error);
          });
        }, delayMs);
      }
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
      if (sendTimer !== undefined) clearTimeout(sendTimer);
      clearTimeout(timeout);
      if (code === 0) resolveRun({ stdout, stderr, elapsedMs: Date.now() - startedAt });
      else rejectRun(new Error(`${file} exited with code ${String(code)}: ${stderr}`));
    });
  });
}

test("Rust dgram send validation and connected state match Node byte-for-byte", async () => {
  const fixture = resolve("tests/corpus/2597-dgram-send-ladders.cjs");
  const dir = await mkdtemp(join(tmpdir(), "scriptc-rust-dgram-"));
  const result = await compile(fixture, {
    outDir: dir,
    outPath: join(dir, "program"),
    backend: "rust",
    optimization: "dev",
  });
  expect(
    result.ok,
    result.ok ? fixture : result.diagnostics.map((diagnostic) => diagnostic.message).join("; "),
  ).toBe(true);
  if (!result.ok) return;

  const [node, rust] = await Promise.all([
    execFileAsync(nodeOracleExecutable(), [fixture]),
    execFileAsync(result.binaryPath, [], {
      env: { ...process.env, SCRIPTC_RUST_HEAP_AUDIT: "1" },
    }),
  ]);
  expect(rust.stdout).toBe(node.stdout);
  expect(rust.stderr).toBe(node.stderr);
});

test("Rust UDP sockets exchange datagrams and preserve close ordering", async () => {
  const fixture = resolve("tests/fixtures/dgram/cases/udp-loopback-pair/main.ts");
  const dir = await mkdtemp(join(tmpdir(), "scriptc-rust-dgram-roundtrip-"));
  const result = await compile(fixture, {
    outDir: dir,
    outPath: join(dir, "program"),
    backend: "rust",
    optimization: "dev",
  });
  expect(
    result.ok,
    result.ok ? fixture : result.diagnostics.map((diagnostic) => diagnostic.message).join("; "),
  ).toBe(true);
  if (!result.ok) return;

  const options = { timeout: 10_000 };
  const [node, rust] = await Promise.all([
    execFileAsync(nodeOracleExecutable(), ["--no-warnings", fixture], options),
    execFileAsync(result.binaryPath, [], {
      ...options,
      env: { ...process.env, SCRIPTC_RUST_HEAP_AUDIT: "1" },
    }),
  ]);
  expect(rust.stdout).toBe(node.stdout);
  expect(rust.stderr).toBe(node.stderr);
});

test("Rust UDP corpus matches Node with open stdin: 2808-event-loop-stdin-dgram-fairness.ts", async () => {
  const fixture = resolve("tests/corpus/2808-event-loop-stdin-dgram-fairness.ts");
  const dir = await mkdtemp(join(tmpdir(), "scriptc-rust-dgram-stdin-"));
  const result = await compile(fixture, {
    outDir: dir,
    outPath: join(dir, "event-loop-stdin-dgram-fairness"),
    backend: "rust",
    optimization: "dev",
  });
  expect(
    result.ok,
    result.ok ? fixture : result.diagnostics.map((diagnostic) => diagnostic.message).join("; "),
  ).toBe(true);
  if (!result.ok) return;

  const node = await runWithDelayedDatagram(nodeOracleExecutable(), [fixture], process.env);
  const rust = await runWithDelayedDatagram(result.binaryPath, [], {
    ...process.env,
    SCRIPTC_RUST_HEAP_AUDIT: "1",
  });
  expect(node.stdout).toBe("ready\ndgram\n");
  expect(node.elapsedMs).toBeLessThan(1_500);
  expect(rust.elapsedMs).toBeLessThan(1_500);
  expect(rust.stdout).toBe(node.stdout);
  expect(rust.stderr).toBe(node.stderr);
});

test("Rust UDP waits use descriptor polling: 2810-dgram-poll-context-switches.ts", async () => {
  const fixture = resolve("tests/corpus/2810-dgram-poll-context-switches.ts");
  const dir = await mkdtemp(join(tmpdir(), "scriptc-rust-dgram-poll-"));
  const result = await compile(fixture, {
    outDir: dir,
    outPath: join(dir, "dgram-poll-context-switches"),
    backend: "rust",
    optimization: "dev",
  });
  expect(
    result.ok,
    result.ok ? fixture : result.diagnostics.map((diagnostic) => diagnostic.message).join("; "),
  ).toBe(true);
  if (!result.ok) return;

  const node = await runWithDelayedDatagram(nodeOracleExecutable(), [fixture], process.env, 750);
  const rust = await runWithDelayedDatagram(result.binaryPath, [], {
    ...process.env,
    SCRIPTC_RUST_HEAP_AUDIT: "1",
  }, 750);
  expect(node.stdout).toBe("ready\ndgram true\n");
  expect(rust.stdout).toBe(node.stdout);
  expect(rust.stderr).toBe(node.stderr);
});
