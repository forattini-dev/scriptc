import { open, rm, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function tryAcquireExclusiveLock(path: string): Promise<FileHandle | null> {
  try {
    return await open(path, "wx");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return null;
    throw error;
  }
}

async function reach(lockPath: string): Promise<"spawned" | "joined"> {
  const lock = await tryAcquireExclusiveLock(lockPath);
  if (!lock) {
    return "joined";
  }
  try {
    return "spawned";
  } finally {
    await lock.close();
  }
}

async function main(): Promise<void> {
  const lockPath = join(tmpdir(), `scriptc-lock-${process.pid}.lock`);
  await rm(lockPath, { force: true });
  const holder = await tryAcquireExclusiveLock(lockPath);
  console.log("holder", holder !== null);
  console.log("contended", await reach(lockPath));
  await holder?.close();
  await rm(lockPath, { force: true });
  console.log("free", await reach(lockPath));
  await rm(lockPath, { force: true });
}

main();
