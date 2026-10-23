// @rust-only
// @no-engine
import { statSync, lstatSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

function report(label: string, error: unknown): void {
  const value = error as any;
  console.log("error", label, String(value.name), String(value.code), String(value.message));
}
function missing(label: string, error: unknown, requested: string, operation: string): void {
  const value = error as any;
  const path = process.platform === "win32" && requested !== "" ? resolve(requested) : requested;
  const expected = "ENOENT: no such file or directory, " + operation + " '" + path + "'";
  console.log("missing", label, String(value.name), String(value.code), String(value.message) === expected);
}
try { statSync("stat-missing"); }
catch (error) { missing("stat", error, "stat-missing", "stat"); }
try { lstatSync("lstat-missing"); }
catch (error) { missing("lstat", error, "lstat-missing", "lstat"); }
try { statSync(""); }
catch (error) { missing("empty", error, "", "stat"); }
try { statSync("null\0path"); }
catch (error) { report("nul", error); }
try { lstatSync("null\0path"); }
catch (error) { report("lstat nul", error); }
function inspect(path: string): number {
  let size: number;
  try { size = statSync(path).size; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return -1;
    throw error;
  }
  return size;
}
console.log("deferred stat", inspect(fileURLToPath(import.meta.url)) > 0, inspect("still-missing"));
function codeOf(error: NodeJS.ErrnoException): string | undefined { return error.code; }
const data = {name: "Error", message: "data", code: "DATA"};
console.log("structural errno", String(codeOf(data)), codeOf(new Error("plain")) === undefined);
try { lstatSync("errno-alias-missing"); }
catch (error) {
  const alias = error as NodeJS.ErrnoException;
  console.log("errno alias", String(codeOf(alias)), alias.name, alias.message.includes("lstat"));
}
