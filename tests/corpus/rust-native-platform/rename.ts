// @rust-only
// @no-engine
import { appendFileSync, existsSync, readFileSync, renameSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";

let trace = "";
function oldPath(): string { trace += "old,"; return "rename-old"; }
function newPath(): string { trace += "new,"; return "rename-new"; }
appendFileSync("rename-old", "source");
appendFileSync("rename-new", "target");
renameSync(oldPath(), newPath());
console.log("renamed", existsSync("rename-old"), readFileSync("rename-new", "utf8"), trace);
unlinkSync("rename-new");
try { renameSync("rename-missing", "rename-dest"); }
catch (error) {
  const value = error as NodeJS.ErrnoException;
  const from = process.platform === "win32" ? resolve("rename-missing") : "rename-missing";
  const to = process.platform === "win32" ? resolve("rename-dest") : "rename-dest";
  console.log("missing", String(value.name), String(value.code), value.message === `ENOENT: no such file or directory, rename '${from}' -> '${to}'`);
}
try { renameSync("old\0path", "new"); }
catch (error) { const value = error as NodeJS.ErrnoException; console.log("nul", String(value.name), String(value.code), String(value.message)); }
try { renameSync("old", "new\0path"); }
catch (error) { const value = error as NodeJS.ErrnoException; console.log("nul", String(value.name), String(value.code), String(value.message)); }
