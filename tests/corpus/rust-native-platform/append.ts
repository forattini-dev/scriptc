// @ts-nocheck
// @rust-only
// @no-engine
// Harnesses give each run a fresh working directory.
import * as fs from "node:fs";
import { appendFileSync as append, existsSync, openSync, readSync, closeSync, statSync } from "node:fs";

function contents(path: string): string {
  const fd = openSync(path, "r");
  try {
    const data = new Uint8Array(statSync(path).size);
    readSync(fd, data, 0, data.length, 0);
    return new TextDecoder().decode(data);
  } finally { closeSync(fd); }
}
append("records", "first\n");
fs.appendFileSync("records", "ação 😀\n", { encoding: "utf8", mode: 0o600 });
append("records", "last", "utf-8");
console.log("contents", contents("records") === "first\nação 😀\nlast");
append("empty", "", { mode: 0o600 });
console.log("empty creates", existsSync("empty"), statSync("empty").size);
append("defaults", "a", null);
append("defaults", "b", undefined);
append("defaults", "c", {});
const mode = 0o600;
append("defaults", "d", { mode, flag: "a", flush: false, encoding: "utf-8" });
console.log("defaults", contents("defaults"));
append("unicode", "😀".slice(0, 1));
console.log("replacement", contents("unicode") === "�");
let trace = "";
function path(): string { trace = trace + "path,"; return "effects"; }
function data(): string { trace = trace + "data,"; return "x"; }
function permissions(label: string, value: number): number { trace = trace + label + ","; return value; }
function extra(): number { trace = trace + "extra,"; return 9; }
append(path(), data(), { mode: permissions("first", -1), mode: permissions("last", 0o600) }, extra());
console.log("order", trace, contents("effects"));
append("effects", "y", { mode: 0o400 });
console.log("keeps content", contents("effects"));
function ownAppend(path: string, data: string): void { console.log("shadow", path, data); }
const own = { appendFileSync: ownAppend };
own.appendFileSync("owned", "value");
console.log("shadow no file", existsSync("owned"));
append("read-only", "first", { mode: 0o400 });
let appended = false;
try { append("read-only", "second", { mode: 0o600 }); appended = true; }
catch (error) { const value = error as any; console.log("readonly error", String(value.name), String(value.code)); }
console.log("readonly outcome", appended);
