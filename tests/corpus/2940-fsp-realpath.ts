import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import * as fs from "node:fs";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "scr-realpath-"));
const target = join(dir, "target");
const link = join(dir, "link");
mkdirSync(target);
writeFileSync(join(target, "file.txt"), "content");
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
  try {
    console.log("cwd", (await realpath(".")) === realpathSync("."));
    console.log("link", (await realpath(join(link, "file.txt"))) === realpathSync(join(target, "file.txt")));
    console.log("namespace", (await fs.promises.realpath(link)) === realpathSync(target));
    try {
      await realpath(join(dir, "missing"));
      console.log("missing unexpectedly resolved");
    } catch (e) {
      const error = e as NodeJS.ErrnoException;
      console.log("missing", error instanceof Error, error.code, error.message.includes("realpath"), error.message.includes("missing"));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

main();
