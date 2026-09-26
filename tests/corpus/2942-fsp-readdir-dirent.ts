// fs.promises.readdir(path, { withFileTypes: true }): asynchronous Dirent
// rows carry the same names, parent paths, and type probes as the sync API.
// Directory order is unspecified, so the observable rows are sorted.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as fs from "node:fs";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "scr-fsp-dirent-"));
mkdirSync(join(dir, "sub-a"));
mkdirSync(join(dir, "sub-b"));
writeFileSync(join(dir, "file.txt"), "x");

async function main(): Promise<void> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const rows: string[] = [];
    for (const entry of entries) {
      rows.push(
        `${entry.name} dir=${entry.isDirectory()} file=${entry.isFile()} link=${entry.isSymbolicLink()} parent=${entry.parentPath === dir}`,
      );
    }
    rows.sort();
    for (const row of rows) console.log(row);

    const dirs = entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("sub-"))
      .map((entry) => entry.name);
    dirs.sort();
    console.log("dirs", dirs.join(","), entries.length);

    const namespaceEntries = await fs.promises.readdir(dir, {
      encoding: "utf8",
      withFileTypes: true,
    });
    console.log("namespace", namespaceEntries.length);

    try {
      const missing = readdir(join(dir, "missing"), { withFileTypes: true });
      console.log("missing returned promise");
      await missing;
      console.log("missing did not reject");
    } catch (error) {
      if (error instanceof Error) {
        console.log(
          "missing",
          (error as NodeJS.ErrnoException).code,
          error.message.includes("scandir"),
        );
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

void main();
