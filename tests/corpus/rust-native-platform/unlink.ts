// @rust-only
// @no-engine
import { appendFileSync, existsSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";

let trace = "";
function path(): string { trace += "path"; return "unlink-owned"; }
appendFileSync("unlink-owned", "content");
unlinkSync(path());
console.log("removed", existsSync("unlink-owned"), trace);
try { unlinkSync("unlink-missing"); }
catch (error) {
  const value = error as NodeJS.ErrnoException;
  const path = process.platform === "win32" ? resolve("unlink-missing") : "unlink-missing";
  console.log("missing", String(value.name), String(value.code), value.message === `ENOENT: no such file or directory, unlink '${path}'`);
}
try { unlinkSync("nul\0name"); }
catch (error) {
  const value = error as NodeJS.ErrnoException;
  console.log("nul", String(value.name), String(value.code), String(value.message));
}
