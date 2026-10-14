import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { runToExit } from "./run-to-exit.js";

test.each([0, 7])("captures completed processes with exit code %s", async code => {
  const outcome = await runToExit(process.execPath, ["-e", `process.stdout.write('out'); process.stderr.write('err'); process.exitCode = ${code}`]);
  expect(outcome).toEqual({ stdout: "out", stderr: "err", exitCode: code });
});

test.skipIf(process.platform === "win32").each(["SIGABRT", "SIGTERM"] as const)("preserves %s without inventing an exit code", async signal => {
  const outcome = await runToExit(process.execPath, ["-e", `const { writeSync } = require('node:fs'); writeSync(1, 'out'); writeSync(2, 'err'); process.kill(process.pid, '${signal}')`]);
  expect(outcome).toEqual({ stdout: "out", stderr: "err", exitCode: null, signal });
});

test("rejects a missing executable", async () => {
  await expect(runToExit(join(tmpdir(), randomUUID(), "missing"), [])).rejects.toMatchObject({ code: "ENOENT" });
});

test("rejects a harness timeout rather than treating its kill as program termination", async () => {
  await expect(runToExit(process.execPath, ["-e", "setInterval(() => {}, 1000)"], process.env, "", { timeout: 100 })).rejects.toMatchObject({ killed: true });
});

test("rejects truncated output", async () => {
  await expect(runToExit(process.execPath, ["-e", "process.stdout.write('x'.repeat(1024))"], process.env, "", { maxBuffer: 16 })).rejects.toMatchObject({ code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" });
});
