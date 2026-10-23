// @ts-nocheck
// @rust-only
// @no-engine
import { appendFileSync as append, existsSync } from "node:fs";
import { resolve } from "node:path";
function report(label: string, error: unknown): void {
  const value = error as any;
  console.log("error", label, String(value.name), String(value.code), String(value.message));
}
function invalid(mode: number): void {
  try { append("invalid", "", { mode }); }
  catch (error) { report("mode", error); }
}
invalid(-1); invalid(0.5); invalid(0 / 0); invalid(1 / 0);
invalid(4294967296); invalid(1000000000000000);
console.log("invalid no file", existsSync("invalid"));
try { append("a\0b", "data", { mode: -1, encoding: "utf8" }); }
catch (error) { report("path before mode", error); }
try { append("", "data"); }
catch (error) { report("empty", error); }
try { append("absent-parent/child", "data"); }
catch (error) {
  const value = error as any;
  const path = process.platform === "win32" ? resolve("absent-parent/child") : "absent-parent/child";
  console.log("missing", String(value.name), String(value.code), String(value.message) === "ENOENT: no such file or directory, open '" + path + "'");
}
let trace = "";
function path(): string { trace = trace + "path,"; return "unwritten"; }
function data(): string { trace = trace + "data,"; return "value"; }
function fail(): number { trace = trace + "throw,"; throw new Error("extra"); }
try { append(path(), data(), { mode: -1 }, fail()); }
catch (error) { if (error instanceof Error) console.log("extra before validation", trace, error.message, existsSync("unwritten")); else throw error; }
trace = "";
try { append(path(), data(), { mode: fail() }); }
catch (error) { if (error instanceof Error) console.log("options before io", trace, error.message, existsSync("unwritten")); else throw error; }
