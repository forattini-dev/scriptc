// fs.promises.lstat and the stable file-identity fields used to verify that
// a path still names the same entry. The output stays differential across
// filesystems by printing invariants rather than platform-specific values.
import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "scr-fsp-lstat-"));
const target = join(dir, "target");
const link = join(dir, "link");
const file = join(target, "payload.txt");
mkdirSync(target);
writeFileSync(file, "identity\n");

// symlinkSync has no lowering yet. A Windows directory junction needs no
// developer-mode symlink privilege and still exercises lstat's no-follow
// contract.
execFileSync(
  "node",
  [
    "-e",
    "require('node:fs').symlinkSync(process.argv[1],process.argv[2],process.platform==='win32'?'junction':'dir')",
    target,
    link,
  ],
  { stdio: "pipe" },
);

async function main(): Promise<void> {
  const first = await lstat(target);
  const again = await lstat(target);
  const linked = await lstat(link);
  const syncLinked = lstatSync(link);
  const fileStats = await lstat(file);
  const handle = await open(file, "r");
  const handleStats = await handle.stat();

  console.log("types:", first.isDirectory(), linked.isSymbolicLink(), linked.isDirectory());
  console.log(
    "distinct identity:",
    first.dev !== linked.dev || first.ino !== linked.ino,
  );
  console.log(
    "stable identity:",
    first.dev === again.dev,
    first.ino === again.ino,
    first.size === again.size,
    first.mtimeMs === again.mtimeMs,
    first.ctimeMs === again.ctimeMs,
  );
  console.log(
    "sync parity:",
    linked.dev === syncLinked.dev,
    linked.ino === syncLinked.ino,
    linked.size === syncLinked.size,
    linked.mtimeMs === syncLinked.mtimeMs,
    linked.ctimeMs === syncLinked.ctimeMs,
  );
  console.log(
    "field shapes:",
    Number.isSafeInteger(first.dev),
    Number.isSafeInteger(first.ino),
    first.ctimeMs > 0,
  );
  console.log(
    "handle parity:",
    handleStats.dev === fileStats.dev,
    handleStats.ino === fileStats.ino,
    handleStats.size === fileStats.size,
    handleStats.mtimeMs === fileStats.mtimeMs,
    handleStats.ctimeMs === fileStats.ctimeMs,
  );
  await handle.close();

  try {
    const missing = lstat(join(dir, "missing"));
    console.log("missing returned promise");
    try {
      await missing;
      console.log("missing did not reject");
    } catch (error) {
      if (error instanceof Error) {
        console.log(
          "missing:",
          (error as NodeJS.ErrnoException).code,
          error.message.includes("lstat"),
        );
      }
    }
  } catch {
    console.log("missing threw synchronously");
  }

  rmSync(dir, { recursive: true, force: true });
}

void main();
