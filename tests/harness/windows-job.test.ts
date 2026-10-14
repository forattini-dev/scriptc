import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test, vi } from "vitest";
import { windowsJobInvocation } from "./windows-job.js";

const exec = promisify(execFile);
const windowsTest = test.skipIf(process.platform !== "win32");
afterEach(() => vi.unstubAllEnvs());

windowsTest("Windows job preserves byte streams, quoting and a nonzero exit code", async () => {
  const cache = mkdtempSync(join(tmpdir(), "scriptc-job-test-"));
  const args = ["a b", 'a"b', "é"];
  const code = "const chunks=[];process.stdin.on('data',c=>chunks.push(c));process.stdin.on('end',()=>{process.stdout.write(JSON.stringify(process.argv.slice(1))+'\\n');process.stdout.write(Buffer.concat(chunks));process.stderr.write(Buffer.from([0,255]));process.exitCode=7})";
  const invocation = windowsJobInvocation(process.execPath, ["-e", code, ...args], cache);
  const pending = exec(invocation.command, invocation.args, { encoding: "buffer" });
  const input = Buffer.from([0, 13, 10, 255]);
  pending.child.stdin?.end(input);
  const error = await pending.then(() => { throw new Error("expected exit 7"); }, error => error as { code: number; stdout: Buffer; stderr: Buffer });
  expect(error.code).toBe(7);
  expect(error.stdout).toEqual(Buffer.concat([Buffer.from(JSON.stringify(args) + "\n"), input]));
  expect(error.stderr).toEqual(Buffer.from([0, 255]));
  expect(invocation.verifyExit(7)?.activeAfterCleanup).toBe(0);
});

windowsTest("Windows job bounds child creation and leaves no descendants after parent exit", async () => {
  vi.stubEnv("SCRIPTC_RUST_JOB_PROCESS_LIMIT", "8");
  const cache = mkdtempSync(join(tmpdir(), "scriptc-job-test-"));
  const probe = windowsJobInvocation(process.execPath, ["-e", ""], cache);
  const python = probe.command;
  // Deliberately bounded even if the guard is broken: at most nine children.
  const code = "import subprocess,sys,json\npids=[]\ndenied=False\nfor _ in range(9):\n try:\n  pids.append(subprocess.Popen([sys.executable,'-c','import time;time.sleep(30)'],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).pid)\n except OSError:\n  denied=True\n  break\nprint(json.dumps({'pids':pids,'denied':denied}))";
  const invocation = windowsJobInvocation(python, ["-c", code], cache);
  const result = await exec(invocation.command, invocation.args, { encoding: "utf8", timeout: 10_000 });
  const children = JSON.parse(result.stdout) as { pids: number[]; denied: boolean };
  expect(children.denied).toBe(true);
  expect(children.pids).toHaveLength(7);
  expect(invocation.verifyExit(0)?.totalProcesses).toBe(8);
  expect(invocation.verifyExit(0)?.descendantsCleaned).toBe(7);
  for (const pid of children.pids) expect(() => process.kill(pid, 0)).toThrow();
});

windowsTest("killing the Windows job wrapper also terminates the child tree", async () => {
  const cache = mkdtempSync(join(tmpdir(), "scriptc-job-test-"));
  const code = "const c=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});console.log(c.pid);setInterval(()=>{},1000)";
  const invocation = windowsJobInvocation(process.execPath, ["-e", code], cache);
  const error = await exec(invocation.command, invocation.args, { encoding: "utf8", timeout: 2_000 }).then(() => { throw new Error("expected timeout"); }, error => error as { killed: boolean; stdout: string });
  expect(error.killed).toBe(true);
  if (!invocation.reportFile) throw new Error("expected a Windows job receipt");
  const started = JSON.parse(readFileSync(invocation.reportFile, "utf8")) as { state: string; pid: number };
  expect(started.state).toBe("started");
  const pids = [started.pid, Number(error.stdout.trim())];
  await vi.waitFor(() => { for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow(); });
});
