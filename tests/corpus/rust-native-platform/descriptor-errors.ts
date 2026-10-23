// @rust-only
// @no-engine
import { openSync, readSync, closeSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
function report(label: string, error: unknown): void {
    const e = error as any;
    console.log("error", label, String(e.name), String(e.code), String(e.message));
}
function check1(fd: number): void {
    try { closeSync(fd); } catch (error) { report("close", error); }
    console.log("no io", readSync(fd, new Uint8Array(2), 99, 0, -99));
    console.log("nan length", readSync(fd, new Uint8Array(2), 0, (0 / 0), -99));
    console.log("wrap length", readSync(fd, new Uint8Array(2), 0, 4294967296, -99));
    try { readSync(fd, new Uint8Array(2), 0, 1, -1); } catch (error) { report("read", error); }
}
check1(-1);
check1(0.5);
check1((0 / 0));
check1((1 / 0));
check1(2147483648);
check1(123456);

function check2(offset: number): void {
    try { readSync(123456, new Uint8Array(2), offset, 0, -99); } catch (error) { report("offset first", error); }
}
check2(-1);
check2(0.5);
check2((0 / 0));
check2((1 / 0));
check2(9007199254740992);

function check3(length: number): void {
    try { readSync(123456, new Uint8Array(2), 0, length, -1); } catch (error) { report("length", error); }
}
check3(-1);
check3(3);
check3(1.5);
check3(2147483648);
check3(4294967297);

function check4(position: number): void {
    try { readSync(123456, new Uint8Array(2), 0, 1, position); } catch (error) { report("position", error); }
}
check4(-2);
check4(0.5);
check4((0 / 0));
check4((1 / 0));
check4(9007199254740992);

try { readSync(123456, new Uint8Array(2), 3, 1, -99); } catch (error) { report("window before position", error); }
try { readSync(123456, new Uint8Array(0), 0, 1, -99); }
catch (error) { const e = error as any; console.log("empty view", String(e.name), String(e.code)); }
console.log("empty zero", readSync(123456, new Uint8Array(0), 99, 0, -99));
const fd = openSync(fileURLToPath(import.meta.url), "r");
closeSync(fd);
try { closeSync(fd); } catch (error) { report("closed twice", error); }
try { readSync(fd, new Uint8Array(1), 0, 1, 0); } catch (error) { report("closed read", error); }
function check5(path: string): void {
    try { openSync(path, "r"); }
    catch (error) {
        const e = error as any;
        const target = process.platform === "win32" && path !== "" ? resolve(path) : path;
        console.log("missing", String(e.name), String(e.code), String(e.message) === "ENOENT: no such file or directory, open '" + target + "'");
    }
}
check5("descriptor-missing");
check5("");

try { openSync("null\0path", "r"); } catch (error) { report("nul", error); }
let effects = "";
function descriptor(): number { effects = effects + "d"; return -1; }
function buffer(): Uint8Array { effects = effects + "b"; return new Uint8Array(1); }
function offset(): number { effects = effects + "o"; return -1; }
function length(): number { effects = effects + "l"; return 1; }
function position(): number { effects = effects + "p"; return -1; }
try { readSync(descriptor(), buffer(), offset(), length(), position()); }
catch (error) { report("ordered", error); }
console.log("effects", effects);
