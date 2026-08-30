import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "scr-agentic-wx-"));
const lease = join(dir, "session.lease");

await writeFile(lease, "first", { encoding: "utf8", flag: "wx", mode: 0o600 });
console.log("created", existsSync(lease), readFileSync(lease, "utf8"));

try {
  await writeFile(lease, "second", { flag: "wx" });
  console.log("overwrote");
} catch (error) {
  if (error instanceof Error) {
    console.log("refused", (error as NodeJS.ErrnoException).code, readFileSync(lease, "utf8"));
  }
}

rmSync(dir, { force: true, recursive: true });
