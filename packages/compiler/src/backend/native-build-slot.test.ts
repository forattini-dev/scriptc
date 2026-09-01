import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { withNativeBuildSlot } from "./native-build-slot.js";

const originalEnvironment = {
  lockDir: process.env["SCRIPTC_NATIVE_LOCK_DIR"],
  hostWorkers: process.env["SCRIPTC_NATIVE_HOST_WORKERS"],
  pollMs: process.env["SCRIPTC_NATIVE_LOCK_POLL_MS"],
};

afterEach(() => {
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
    new Promise<false>((resolve) => setTimeout(() => resolve(false), 50)),
  ]);

  await rm(lockDir, { recursive: true, force: true });
  await build.catch(() => undefined);
  expect(recovered).toBe(true);
  expect(ran).toBe(true);
});

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
