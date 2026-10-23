// @ts-nocheck
// @rust-only
// @no-engine
// Every harness runs this fixture in its own temporary working directory.
import * as fs from "node:fs";
import { mkdirSync as mkdir, existsSync as exists } from "node:fs";
import { resolve } from "node:path";

function report(label: string, error: unknown): void {
  const value = error as any;
  console.log("error", label, String(value.name), String(value.code), String(value.message));
}
function filesystemError(label: string, error: unknown, requested: string, prefix: string): void {
  const value = error as any;
  const expected = prefix + (process.platform === "win32" ? resolve(requested) : requested) + "'";
  console.log("filesystem error", label, String(value.name), String(value.code), String(value.message) === expected);
}
console.log("before", exists("plain"));
mkdir("plain");
console.log("plain", exists("plain"));
fs.mkdirSync("plain/nested/deep", { recursive: true });
fs.mkdirSync("plain/nested/deep", { recursive: true });
console.log("recursive", exists("plain/nested/deep"));
const mode = 0o700;
fs.mkdirSync("private/nested", { mode, recursive: true });
mkdir("numeric", 0o700);
mkdir("options", { recursive: false, mode: 0o700 });
console.log("modes", exists("private/nested"), exists("numeric"), exists("options"));
try { mkdir("plain"); }
catch (error) { if (error instanceof Error) filesystemError("exists", error, "plain", "EEXIST: file already exists, mkdir '"); else throw error; }
try { mkdir("missing/child"); }
catch (error) { if (error instanceof Error) filesystemError("missing", error, "missing/child", "ENOENT: no such file or directory, mkdir '"); else throw error; }
try { mkdir("a\0b"); }
catch (error) { if (error instanceof Error) report("nul", error); else throw error; }
try { mkdir("", { recursive: true }); }
catch (error) { if (error instanceof Error) report("empty", error); else throw error; }
function invalidMode(value: number): void {
  try { mkdir("invalid", { mode: value }); }
  catch (error) { if (error instanceof RangeError) report("mode", error); else throw error; }
}
invalidMode(-1); invalidMode(0.5); invalidMode(0 / 0); invalidMode(1 / 0);
try { mkdir("a\0b", { mode: -1, recursive: true }); }
catch (error) { if (error instanceof RangeError) report("mode-before-path", error); else throw error; }
let trace = "";
function path(): string { trace = trace + "path,"; return "effects"; }
function permissions(label: string): number { trace = trace + label + ","; return 0o700; }
function extra(): number { trace = trace + "extra,"; return 1; }
mkdir(path(), { mode: permissions("first"), mode: permissions("last"), recursive: true }, extra());
console.log("effects", trace, exists("effects"));
function fail(): number { trace = trace + "throw,"; throw new Error("extra argument"); }
trace = "";
try { mkdir(path(), { mode: -1 }, fail()); }
catch (error) { if (error instanceof Error) console.log("extra-before-validation", trace, error.message); else throw error; }
const io = { mkdir(dir: string): void { mkdir(dir, { recursive: true, mode: 0o700 }); } };
io.mkdir("method/child");
console.log("method", exists("method/child"), exists("invalid"));
