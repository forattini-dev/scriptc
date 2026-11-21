// @rust-only
// @no-engine
import { existsSync, writeFileSync } from "node:fs";
import { unlink } from "node:fs/promises";

async function main(): Promise<void> {
  const path = "unlink-promise-owned";
  writeFileSync(path, "content");
  await unlink(path);
  console.log("removed", existsSync(path));

  try {
    await unlink("unlink-promise-missing");
  } catch (error) {
    const value = error as NodeJS.ErrnoException;
    console.log("missing", String(value.name), String(value.code));
  }
}

void main();
