// @rust-only
// @no-engine
import { openSync, readSync, closeSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
const path = fileURLToPath(import.meta.url);
const fd = openSync(path, "r");
try {
    const bytes = new Uint8Array([99, 99, 99, 99]);
    console.log("fd", fd >= 0);
    console.log("positioned", readSync(fd, bytes, 1, 2, 0), bytes.join(","));
    console.log("cursor", readSync(fd, bytes, 0, 1, null), bytes[0] === 47);
    // @ts-expect-error Node accepts the omitted positional argument at runtime.
    console.log("cursor next", readSync(fd, bytes, 0, 1), bytes[0] === 47);
    // @ts-expect-error Node accepts undefined position at runtime.
    console.log("undefined position", readSync(fd, bytes, 0, 1, undefined), bytes[0] === 32);
    const view = bytes.subarray(1, 3);
    console.log("view read", readSync(fd, view, 0, 2, 0), bytes.join(","));
    const tail = new Uint8Array(1);
    console.log("tail", readSync(fd, tail, 0, 1, statSync(path).size - 1), tail[0] === 10);
    console.log("eof", readSync(fd, tail, 0, 1, statSync(path).size), tail[0] === 10);
    console.log("fraction", readSync(fd, bytes, 0, 1.9, 0), bytes[0] === 47);
    console.log("zero", readSync(fd, bytes, 99, 0, -99));
} finally { closeSync(fd); }
// @ts-expect-error Node defaults omitted flags to read.
const defaultFd = openSync(path);
try { console.log("default flags", readSync(defaultFd, new Uint8Array(1), 0, 1, -1)); }
finally { closeSync(defaultFd); }
function created(): void {
    const created = openSync("descriptor-created", "a+");
    try { console.log("created", readSync(created, new Uint8Array(1), 0, 1, 0)); }
    finally { closeSync(created); }
}
created(); created(); created();
function inspect(path: string): boolean {
    let size: number;
    try { size = statSync(path).size; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return true; throw error; }
    if (size === 0) return true;
    let descriptor: number | undefined;
    try {
        descriptor = openSync(path, "r");
        const tail = new Uint8Array(1);
        readSync(descriptor, tail, 0, 1, size - 1);
        return tail[0] === 10;
    } finally { if (descriptor !== undefined) closeSync(descriptor); }
}
console.log("inspect", inspect(path), inspect("descriptor-missing"), inspect("descriptor-created"));
