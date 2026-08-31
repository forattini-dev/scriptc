import { spawn } from "node:child_process";
import { createSocket } from "node:dgram";
import { mkdtemp } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { nodeOracleExecutable } from "../../../tests/harness/oracle-environment.js";
import { compile } from "../src/index.js";

async function reserveUdpPort(): Promise<number> {
  const socket = createSocket("udp4");
  await new Promise<void>((resolveBind, rejectBind) => {
    socket.once("error", rejectBind);
    socket.bind(0, "127.0.0.1", resolveBind);
  });
  const port = socket.address().port;
  await new Promise<void>((resolveClose) => socket.close(() => resolveClose()));
  return port;
}

async function runWithTcpAndDelayedUdp(
  file: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ stdout: string; stderr: string }> {
  const udpPort = await reserveUdpPort();
  const accepted = new Set<Socket>();
  const server = createServer((socket) => {
    accepted.add(socket);
    socket.on("close", () => accepted.delete(socket));
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("TCP server has no port");

  try {
    return await new Promise((resolveRun, rejectRun) => {
      const child = spawn(file, [...args, String(address.port), String(udpPort)], {
        env,
        stdio: ["ignore", "pipe", "pipe"],
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
            sender.send("unified", udpPort, "127.0.0.1", (error) => {
              sender.close();
              if (error !== null) rejectRun(error);
            });
          }, 750);
        }
      });
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.on("error", rejectRun);
      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
        rejectRun(new Error(`${file} did not exit after combined I/O became ready`));
      }, 10_000);
      child.on("close", (code) => {
        if (sendTimer !== undefined) clearTimeout(sendTimer);
        clearTimeout(timeout);
        if (code === 0) resolveRun({ stdout, stderr });
        else rejectRun(new Error(`${file} exited with code ${String(code)}: ${stderr}`));
      });
    });
  } finally {
    for (const socket of accepted) socket.destroy();
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  }
}

test("Rust waits on TCP and UDP descriptors together: 2811-net-dgram-unified-poll.ts", async () => {
  const fixture = resolve("tests/corpus/2811-net-dgram-unified-poll.ts");
  const dir = await mkdtemp(join(tmpdir(), "scriptc-rust-io-poll-"));
  const result = await compile(fixture, {
    outDir: dir,
    outPath: join(dir, "net-dgram-unified-poll"),
    backend: "rust",
    optimization: "dev",
  });
  expect(
    result.ok,
    result.ok ? fixture : result.diagnostics.map((diagnostic) => diagnostic.message).join("; "),
  ).toBe(true);
  if (!result.ok) return;

  const node = await runWithTcpAndDelayedUdp(nodeOracleExecutable(), [fixture], process.env);
  const rust = await runWithTcpAndDelayedUdp(result.binaryPath, [], {
    ...process.env,
    SCRIPTC_RUST_HEAP_AUDIT: "1",
  });
  expect(node.stdout).toBe("ready\nunified true\n");
  expect(rust.stdout).toBe(node.stdout);
  expect(rust.stderr).toBe(node.stderr);
});
