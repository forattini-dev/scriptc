import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { withNativeBuildSlot } from "./native-build-slot.js";

const transient = vi.hoisted(() => ({ reaperFailures: 0 }));
vi.mock("node:fs/promises", async () => {
  const fs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return { ...fs, link: async (...args: Parameters<typeof fs.link>) => {
    if (String(args[1]).endsWith(".reaping") && transient.reaperFailures > 0) {
      transient.reaperFailures--;
      throw Object.assign(new Error("Windows lock deletion pending"), { code: "EPERM" });
    }
    return fs.link(...args);
  } };
});

const originalEnvironment = {
  lockDir: process.env["SCRIPTC_NATIVE_LOCK_DIR"],
  hostWorkers: process.env["SCRIPTC_NATIVE_HOST_WORKERS"],
  pollMs: process.env["SCRIPTC_NATIVE_LOCK_POLL_MS"],
};

afterEach(() => {
  transient.reaperFailures = 0;
  restoreEnvironment("SCRIPTC_NATIVE_LOCK_DIR", originalEnvironment.lockDir);
  restoreEnvironment("SCRIPTC_NATIVE_HOST_WORKERS", originalEnvironment.hostWorkers);
  restoreEnvironment("SCRIPTC_NATIVE_LOCK_POLL_MS", originalEnvironment.pollMs);
});

test("serializes native builds through a shared one-seat gate", async () => {
  const lockDir = await mkdtemp(join(tmpdir(), "scriptc-native-slot-test-"));
  process.env["SCRIPTC_NATIVE_LOCK_DIR"] = lockDir;
  process.env["SCRIPTC_NATIVE_HOST_WORKERS"] = "1";
  process.env["SCRIPTC_NATIVE_LOCK_POLL_MS"] = "5";

  let releaseFirst!: () => void;
  const firstHeld = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let firstStarted!: () => void;
  const firstStart = new Promise<void>((resolve) => {
    firstStarted = resolve;
  });
  const order: string[] = [];

  const first = withNativeBuildSlot(async () => {
    order.push("first:start");
    firstStarted();
    await firstHeld;
    order.push("first:end");
  });
  await firstStart;
  const second = withNativeBuildSlot(async () => {
    order.push("second:start");
  });

  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(order).toEqual(["first:start"]);

  releaseFirst();
  await Promise.all([first, second]);
  expect(order).toEqual(["first:start", "first:end", "second:start"]);
  await rm(lockDir, { recursive: true, force: true });
});

test("recovers a native build seat left by a dead process", async () => {
  const lockDir = await mkdtemp(join(tmpdir(), "scriptc-native-slot-test-"));
  process.env["SCRIPTC_NATIVE_LOCK_DIR"] = lockDir;
  process.env["SCRIPTC_NATIVE_HOST_WORKERS"] = "1";
  process.env["SCRIPTC_NATIVE_LOCK_POLL_MS"] = "5";
  await mkdir(lockDir, { recursive: true });
  await writeFile(
    join(lockDir, "slot-0.json"),
    `${JSON.stringify({ pid: 999_999_999, token: "abandoned", startedAt: "2026-01-01T00:00:00.000Z" })}\n`,
  );

  let ran = false;
  const build = withNativeBuildSlot(async () => {
    ran = true;
  });
  const recovered = await Promise.race([
    build.then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), 1000)),
  ]);

  await rm(lockDir, { recursive: true, force: true });
  await build.catch(() => undefined);
  expect(recovered).toBe(true);
  expect(ran).toBe(true);
});

test("recovers when a dead lease reaper was also abandoned", async () => {
  const lockDir = await mkdtemp(join(tmpdir(), "scriptc-native-slot-test-"));
  process.env["SCRIPTC_NATIVE_LOCK_DIR"] = lockDir;
  process.env["SCRIPTC_NATIVE_HOST_WORKERS"] = "1";
  process.env["SCRIPTC_NATIVE_LOCK_POLL_MS"] = "5";
  await writeFile(
    join(lockDir, "slot-0.json"),
    `${JSON.stringify({ pid: 999_999_999, token: "abandoned", startedAt: "2026-01-01T00:00:00.000Z" })}\n`,
  );
  const reaper = join(lockDir, "slot-0.json.reaping");
  await mkdir(reaper);
  const old = new Date(Date.now() - 60_000);
  await utimes(reaper, old, old);

  let ran = false;
  const build = withNativeBuildSlot(async () => {
    ran = true;
  });
  const recovered = await Promise.race([
    build.then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), 1000)),
  ]);

  if (!recovered) {
    await rm(join(lockDir, "slot-0.json.reaping"), { recursive: true, force: true });
  }
  await build;
  await rm(lockDir, { recursive: true, force: true });
  expect(recovered).toBe(true);
  expect(ran).toBe(true);
});

test("recovers when a dead lease reaper file was truncated", async () => {
  const lockDir = await mkdtemp(join(tmpdir(), "scriptc-native-slot-test-"));
  process.env["SCRIPTC_NATIVE_LOCK_DIR"] = lockDir;
  process.env["SCRIPTC_NATIVE_HOST_WORKERS"] = "1";
  process.env["SCRIPTC_NATIVE_LOCK_POLL_MS"] = "5";
  await writeFile(
    join(lockDir, "slot-0.json"),
    `${JSON.stringify({ pid: 999_999_999, token: "abandoned", startedAt: "2026-01-01T00:00:00.000Z" })}\n`,
  );
  const reaper = join(lockDir, "slot-0.json.reaping");
  await writeFile(reaper, "{");

  let ran = false;
  const build = withNativeBuildSlot(async () => {
    ran = true;
  });
  const recovered = await Promise.race([
    build.then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), 1000)),
  ]);

  if (!recovered) await rm(reaper, { force: true });
  await build;
  await rm(lockDir, { recursive: true, force: true });
  expect(recovered).toBe(true);
  expect(ran).toBe(true);
});

test.skipIf(process.platform !== "win32")("retries a Windows reaper lock with deletion pending", async () => {
  const lockDir = await mkdtemp(join(tmpdir(), "scriptc-native-slot-eperm-"));
  process.env["SCRIPTC_NATIVE_LOCK_DIR"] = lockDir;
  process.env["SCRIPTC_NATIVE_HOST_WORKERS"] = "1";
  process.env["SCRIPTC_NATIVE_LOCK_POLL_MS"] = "2";
  try {
    await writeFile(join(lockDir, "slot-0.json"), JSON.stringify({ pid: 999_999_999 }));
    transient.reaperFailures = 2;
    let active = 0, peak = 0, completed = 0;
    await Promise.all(Array.from({ length: 16 }, () => withNativeBuildSlot(async () => {
      peak = Math.max(peak, ++active);
      await new Promise(resolve => setTimeout(resolve, 2));
      active--;
      completed++;
    })));
    expect(transient.reaperFailures).toBe(0);
    expect(peak).toBe(1);
    expect(completed).toBe(16);
  } finally { await rm(lockDir, { recursive: true, force: true }); }
});

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
