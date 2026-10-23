// @ts-nocheck
// @rust-only
// @no-engine
import { readFileSync as read } from "node:fs";
import { resolve } from "node:path";
function report(label: string, error: unknown): void {
  const value = error as any;
  console.log("error", label, String(value.name), String(value.code), String(value.message));
}
try { read("a\0b", "utf8"); } catch (error) { report("nul", error); }
try { read("", { encoding: "utf8" }); } catch (error) { report("empty", error); }
try { read(".", "utf8"); } catch (error) { report("directory", error); }
try { read("missing/child", { encoding: "utf-8", flag: "r" }); }
catch (error) {
  const value = error as any;
  const path = process.platform === "win32" ? resolve("missing/child") : "missing/child";
  console.log("missing", String(value.name), String(value.code), String(value.message) === "ENOENT: no such file or directory, open '" + path + "'");
}
let trace = "";
function path(): string { trace = trace + "path,"; return "a\0b"; }
function fail(): number { trace = trace + "throw,"; throw new Error("argument failure"); }
try { read(path(), "utf8", fail()); }
catch (error) { if (error instanceof Error) console.log("extra before validation", trace, error.message); else throw error; }
