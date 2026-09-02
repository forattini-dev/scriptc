import { link, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

interface NativeBuildLease {
  path: string;
  token: string;
}

const LEGACY_REAPER_STALE_MS = 30_000;

/** Run one native build transaction inside the machine-wide compiler gate. */
export async function withNativeBuildSlot<T>(action: () => Promise<T>): Promise<T> {
  const lease = await acquireNativeBuildSlot();
  try {
    return await action();
  } finally {
    await releaseNativeBuildSlot(lease);
  }
}

async function acquireNativeBuildSlot(): Promise<NativeBuildLease> {
  const root = process.env["SCRIPTC_NATIVE_LOCK_DIR"] ??
    join(process.env["XDG_RUNTIME_DIR"] ?? join(homedir(), ".cache"), "scriptc", "native-build-slots-v1");
  const width = positiveInteger("SCRIPTC_NATIVE_HOST_WORKERS", 2);
  const pollMs = positiveInteger("SCRIPTC_NATIVE_LOCK_POLL_MS", 50);
  const token = `${process.pid}-${randomUUID()}`;
  await mkdir(root, { recursive: true, mode: 0o700 });

  for (;;) {
    for (let index = 0; index < width; index++) {
      const path = join(root, `slot-${index}.json`);
      const temporary = join(root, `.lease-${token}-${index}.json`);
      await writeFile(
        temporary,
        `${JSON.stringify({ pid: process.pid, token, startedAt: new Date().toISOString() })}\n`,
        { mode: 0o600 },
      );
      try {
        await link(temporary, path);
        await rm(temporary, { force: true });
        return { path, token };
      } catch (error) {
        await rm(temporary, { force: true });
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        await reclaimDeadLease(path);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

async function reclaimDeadLease(path: string): Promise<void> {
  const reaper = `${path}.reaping`;
  try {
    await writeFile(
      reaper,
      `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`,
      { flag: "wx", mode: 0o600 },
    );
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST" || code === "EISDIR") {
      await reclaimAbandonedReaper(reaper);
      return;
    }
    throw error;
  }
  try {
    let pid: unknown;
    try {
      pid = (JSON.parse(await readFile(path, "utf8")) as { pid?: unknown }).pid;
    } catch {
      return;
    }
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid < 1 || processAlive(pid)) return;
    await rm(path, { force: true });
  } finally {
    await rm(reaper, { force: true });
  }
}

async function reclaimAbandonedReaper(path: string): Promise<void> {
  try {
    const record = JSON.parse(await readFile(path, "utf8")) as { pid?: unknown };
    const pid = record.pid;
    if (typeof pid === "number" && Number.isInteger(pid) && pid > 0 && processAlive(pid)) return;
    await rm(path, { force: true });
  } catch (error) {
    if (error instanceof SyntaxError) {
      await rm(path, { force: true });
      return;
    }
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return;
    if (code !== "EISDIR") throw error;
    // Before reapers carried an owning pid they were directories. Keep a
    // short grace period so a process running the old protocol can finish,
    // then let upgrades recover a directory abandoned by a crash.
    const metadata = await stat(path).catch(() => undefined);
    if (metadata === undefined || Date.now() - metadata.mtimeMs < LEGACY_REAPER_STALE_MS) return;
    await rm(path, { recursive: true, force: true });
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code !== "ESRCH" && code !== "EINVAL";
  }
}

async function releaseNativeBuildSlot(lease: NativeBuildLease): Promise<void> {
  try {
    const record = JSON.parse(await readFile(lease.path, "utf8")) as { token?: unknown };
    if (record.token === lease.token) await rm(lease.path, { force: true });
  } catch {
    // A missing or malformed lease cannot safely be removed here.
  }
}

function positiveInteger(name: string, fallback: number): number {
  const configured = process.env[name];
  if (configured === undefined || configured === "") return fallback;
  const value = Number(configured);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}
