// @ts-nocheck
// @rust-only
// @no-engine
import * as fs from "node:fs";
import { readFileSync as read, appendFileSync as append } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
append("text", "ação 😀\n", { mode: 0o600 });
console.log("text", read("text", "utf8"));
console.log("alias", fs.readFileSync("text", "utf-8") === read("text", { encoding: "utf8" }));
append("text", "tail");
console.log("fresh read", read("text", { flag: "r", encoding: "utf-8" }).endsWith("tail"));
append("empty", "");
console.log("empty", read("empty", "utf8").length);
const binary = join(dirname(fileURLToPath(import.meta.url)), "read-invalid-utf8.bin");
console.log("malformed", String(JSON.stringify(read(binary, "utf8"))));
console.log("bom preserved", read(binary, "utf-8").charCodeAt(0));
function load(path: string): string { return read(path, "utf8"); }
const holder = { read(path: string): string { return read(path, { encoding: "utf8", flag: "r" }); } };
console.log("returns", load("text") === holder.read("text"));
let trace = "";
let selected = "text";
function path(): string { trace = trace + "path,"; return selected; }
function extra(): number { selected = "absent"; trace = trace + "extra,"; return 9; }
console.log("order", read(path(), "utf8", extra()).startsWith("ação"), trace);
function ownRead(path: string, encoding: string): string { return path + encoding; }
const own = { readFileSync: ownRead };
console.log("shadow", own.readFileSync("own", "value"));
