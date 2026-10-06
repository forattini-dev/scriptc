/* The gate's share of the host-wide advisory lock that serialises full
 * suite runs (tests/harness/suite-lock.mjs).
 *
 * suite-lock.mjs only engages for a vitest run with no file filter, and the
 * gate always passes files, so on its own the gate would run beside another
 * gate or beside a full `pnpm test`. Two of those oversubscribe the cores
 * and memory, which is a known flake class here (vitest worker RPC timeouts,
 * event-loop timing failures) and which the gate would then report as new
 * reds. The gate therefore takes the same lock file, with the same record
 * shape, for the whole run: a full suite and a gate queue behind each other,
 * and `SCRIPTC_NO_LOCK=1` (or --no-lock) opts out exactly as it does for a
 * suite. Unlike a suite, a gate that cannot get the lock in time refuses to
 * start instead of proceeding: a gate verdict taken on an oversubscribed
 * host is worse than no verdict. */
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pidAlive } from "./gate-rust-reporter.mjs";

/** Must equal the file name in tests/harness/suite-lock.mjs; a unit test pins that. */
export const LOCK_FILE_NAME = "scriptc-full-suite.lock";

export function lockPath(directory = tmpdir()) {
  return join(directory, LOCK_FILE_NAME);
}

function holderOf(path) {
  try {
    const record = JSON.parse(readFileSync(path, "utf8"));
    return typeof record.pid === "number" ? record : null;
  } catch {
    return null;
  }
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Take the lock, waiting up to `waitMs` for a live holder. Resolves to
 * `{ acquired: true, release }` or `{ acquired: false, holder }`. A lock
 * whose holder is dead or whose record is unreadable is stolen. */
export async function acquireLock({
  path = lockPath(),
  waitMs = 45 * 60_000,
  pollMs = 2000,
  pid = process.pid,
  alive = pidAlive,
  sleep = defaultSleep,
  now = Date.now,
  onWait = () => {},
  cwd = process.cwd(),
} = {}) {
  const started = now();
  let announced = null;
  for (;;) {
    try {
      writeFileSync(path, JSON.stringify({ pid, startedAt: new Date().toISOString(), cwd, tool: "gate-rust" }), { flag: "wx" });
      const release = () => {
        try {
          if (holderOf(path)?.pid === pid) rmSync(path, { force: true });
        } catch {
          // Best effort: a dead-pid steal cleans up otherwise.
        }
      };
      return { acquired: true, release };
    } catch (error) {
      // Anything but "the file exists" (no such directory, no permission) cannot be waited out.
      if (error?.code !== "EEXIST") throw error;
      const holder = holderOf(path);
      if (holder === null || !alive(holder.pid)) {
        try { rmSync(path, { force: true }); } catch { /* racing steal; retry */ }
        continue;
      }
      if (now() - started >= waitMs) return { acquired: false, holder };
      if (announced === null || now() - announced > 30_000) {
        onWait(holder);
        announced = now();
      }
      await sleep(pollMs);
    }
  }
}
