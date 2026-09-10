// @no-engine
// Native spool writes: UTF-8, creation-only permissions, exclusive creation,
// and source evaluation order must agree with Node.
import { accessSync, appendFileSync, constants, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "scriptc-append-"));
const path = join(dir, "spool");
appendFileSync(path, "ação\n", { encoding: "utf8", mode: 0o600 });
accessSync(path, constants.W_OK);
appendFileSync(path, "次\n", { mode: 0o400, encoding: "utf-8", flag: "a" });
appendFileSync(path, "", "utf-8");
console.log("bytes", readFileSync(path, "utf8"));
accessSync(path, constants.W_OK);
console.log("still writable");

const exclusive = join(dir, "exclusive");
appendFileSync(exclusive, "owner", { flag: "ax" });
try {
  appendFileSync(exclusive, "intruder", { flag: "ax", mode: 0o600 });
} catch (error) {
  if (error instanceof Error) console.log("exclusive", (error as NodeJS.ErrnoException).code);
}
console.log("owner", readFileSync(exclusive, "utf8"));

const order: string[] = [];
function file(): string { order.push("path"); return path; }
function data(): string { order.push("data"); return "tail"; }
function encoding(): "utf8" { order.push("encoding"); return "utf8"; }
function mode(): number { order.push("mode"); return 0o600; }
function flag(): "a" { order.push("flag"); return "a"; }
appendFileSync(file(), data(), { encoding: encoding(), mode: mode(), flag: flag() });
appendFileSync(file(), data(), encoding());
console.log("order", order.join(","));
console.log("appended", readFileSync(path, "utf8"));

function invalidMode(label: string, value: number): void {
  const target = join(dir, label);
  try {
    appendFileSync(target, "x", { mode: value });
    console.log("unexpected mode", label);
  } catch (error) {
    if (error instanceof Error) console.log(label, error.name, (error as NodeJS.ErrnoException).code, existsSync(target));
  }
}
invalidMode("negative", -1);
invalidMode("fractional", 1.5);
invalidMode("nan", NaN);
invalidMode("infinite", Infinity);
invalidMode("overflow", 4294967296);

try {
  appendFileSync(join(dir, "missing", "child"), "x", { mode: 0o600 });
} catch (error) {
  if (error instanceof Error) console.log("missing", (error as NodeJS.ErrnoException).code);
}
writeFileSync(path, "retained", { mode: 0o600 });
function failEncoding(): "utf8" { throw new Error("option failed"); }
try {
  appendFileSync(path, "lost", { encoding: failEncoding() });
} catch (error) {
  if (error instanceof Error) console.log("option", error.message);
}
console.log("no write after throw", readFileSync(path, "utf8"));
rmSync(dir, { recursive: true, force: true });
