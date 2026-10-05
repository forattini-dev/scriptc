/* The gate's advisory lock (scripts/gate-rust-lock.mjs), which it shares
 * with the full-suite lock of tests/harness/suite-lock.mjs, and the orphan
 * guard in the streaming reporter that keeps shard processes from outliving
 * a gate that was killed without a chance to clean up. */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { LOCK_FILE_NAME, acquireLock, lockPath } from "../../scripts/gate-rust-lock.mjs";
import { pidAlive } from "../../scripts/gate-rust-reporter.mjs";

const repoRoot = join(import.meta.dirname, "../..");

describe("advisory lock shared with the full suite", () => {
  const scratch = () => mkdtempSync(join(tmpdir(), "scriptc-gate-lock-"));

  test("the lock file name is the one tests/harness/suite-lock.mjs uses, so a gate and a full suite queue behind each other", () => {
    const suiteLock = readFileSync(join(repoRoot, "tests/harness/suite-lock.mjs"), "utf8");
    expect(suiteLock).toContain(`join(tmpdir(), "${LOCK_FILE_NAME}")`);
    expect(lockPath("/x")).toBe(`/x/${LOCK_FILE_NAME}`);
  });

  test("acquire, hold against a second taker, release, and steal a dead holder's lock", async () => {
    const dir = scratch();
    try {
      const path = lockPath(dir);
      const first = await acquireLock({ path, pid: 111, alive: () => true, waitMs: 0 });
      expect(first.acquired).toBe(true);
      expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ pid: 111, tool: "gate-rust" });
      const second = await acquireLock({ path, pid: 222, alive: () => true, waitMs: 0 });
      expect(second).toMatchObject({ acquired: false, holder: { pid: 111 } });
      if (first.acquired) first.release();
      expect(existsSync(path)).toBe(false);
      writeFileSync(path, JSON.stringify({ pid: 333 }));
      const stolen = await acquireLock({ path, pid: 444, alive: (pid: number) => pid !== 333, waitMs: 0 });
      expect(stolen.acquired).toBe(true);
      if (stolen.acquired) stolen.release();
      expect(existsSync(path)).toBe(false);
      // An unreadable record has no live holder either.
      writeFileSync(path, "not json");
      expect((await acquireLock({ path, pid: 555, alive: () => true, waitMs: 0 })).acquired).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a waiter announces itself, polls, and gets the lock when the holder lets go; a release by a non-holder leaves the lock", async () => {
    const dir = scratch();
    try {
      const path = lockPath(dir);
      writeFileSync(path, JSON.stringify({ pid: 111, tool: "full suite" }));
      let clock = 0;
      const waits: number[] = [];
      const polls: number[] = [];
      const taker = await acquireLock({
        path, pid: 222, alive: () => true, waitMs: 10 * 60_000, pollMs: 1000,
        now: () => clock,
        onWait: (holder: { pid: number }) => waits.push(holder.pid),
        sleep: async (ms: number) => {
          polls.push(ms);
          clock += ms;
          if (polls.length === 3) rmSync(path, { force: true });
        },
      });
      expect(taker.acquired).toBe(true);
      expect(waits).toEqual([111]);
      expect(polls).toEqual([1000, 1000, 1000]);
      writeFileSync(path, JSON.stringify({ pid: 999 }));
      if (taker.acquired) taker.release();
      expect(JSON.parse(readFileSync(path, "utf8")).pid).toBe(999);
      let timeoutClock = 0;
      const timedOut = await acquireLock({ path, pid: 222, alive: () => true, waitMs: 3000, pollMs: 1000, now: () => timeoutClock, sleep: async (ms: number) => { timeoutClock += ms; } });
      expect(timedOut).toMatchObject({ acquired: false, holder: { pid: 999 } });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an unusable lock directory is an error, not a busy loop", async () => {
    await expect(acquireLock({ path: join(tmpdir(), "scriptc-gate-no-such-dir", LOCK_FILE_NAME), waitMs: 0 })).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("the orphan guard in the streaming reporter", () => {
  const reporter = join(repoRoot, "scripts/gate-rust-reporter.mjs");
  /** Alive and not a zombie awaiting a reaper (Linux; elsewhere plain liveness). */
  const running = (pid: number) => {
    if (!pidAlive(pid)) return false;
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) !== "Z";
    } catch {
      return true;
    }
  };

  test("when the gate dies uncleanly, the reporter's process group follows it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scriptc-gate-orphan-"));
    const childScript = join(dir, "child.mjs");
    const gateScript = join(dir, "gate.mjs");
    try {
      writeFileSync(childScript, `import Reporter from ${JSON.stringify(reporter)};\nnew Reporter();\nconsole.log('child ' + process.pid);\nsetInterval(() => {}, 1000);\n`);
      writeFileSync(gateScript, `import { spawn } from 'node:child_process';\nconst child = spawn(process.execPath, [${JSON.stringify(childScript)}], { detached: true, stdio: ['ignore', 'inherit', 'inherit'], env: { ...process.env, SCRIPTC_GATE_RESULTS: ${JSON.stringify(join(dir, "r.jsonl"))}, SCRIPTC_GATE_PARENT_PID: String(process.pid), SCRIPTC_GATE_PARENT_POLL_MS: '200' } });\nsetInterval(() => {}, 1000);\n`);
      const gate = spawn(process.execPath, [gateScript], { stdio: ["ignore", "pipe", "inherit"] });
      const childPid = await new Promise<number>((resolve, reject) => {
        let text = "";
        gate.stdout!.on("data", (chunk) => {
          text += String(chunk);
          const match = /child (\d+)/.exec(text);
          if (match) resolve(Number(match[1]));
        });
        setTimeout(() => reject(new Error(`no child pid, got '${text}'`)), 20_000);
      });
      expect(running(childPid)).toBe(true);
      process.kill(gate.pid!, "SIGKILL");
      const deadline = Date.now() + 15_000;
      while (running(childPid) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
      expect(running(childPid)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
