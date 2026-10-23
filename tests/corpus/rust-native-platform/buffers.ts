// @rust-only
// @no-engine
import { Buffer as Bytes } from "node:buffer";
import { openSync, readSync, closeSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
const buffer = Bytes.alloc(4);
console.log("zero", buffer.length, buffer.byteLength, buffer.join(","), Bytes.isBuffer(buffer));
buffer.set(new Uint8Array([10, 20, 30, 40]));
const slice = buffer.slice(1, 3);
slice.set(new Uint8Array([91, 92]));
console.log("slice", buffer.join(","), Bytes.isBuffer(slice), slice[0] === 91, slice[2] === undefined);
const sub = buffer.subarray(-2);
sub.set(new Uint8Array([71, 72]));
console.log("subarray", buffer.join(","), Bytes.isBuffer(sub));
function sliceAsTyped(value: Uint8Array): Uint8Array { return value.slice(1, 3); }
const throughTyped = sliceAsTyped(buffer);
throughTyped.set(new Uint8Array([51, 52]));
console.log("typed buffer alias", buffer.join(","), Bytes.isBuffer(throughTyped));
const typed = new Uint8Array([10, 20, 30, 40]);
const copied = sliceAsTyped(typed);
copied.set(new Uint8Array([61, 62]));
console.log("typed copy", typed.join(","), copied.join(","), Bytes.isBuffer(copied));
const fromBuffer = new Uint8Array(buffer);
fromBuffer.set(new Uint8Array([1]));
console.log("copy constructor", buffer[0] === 10, fromBuffer[0] === 1, Bytes.isBuffer(fromBuffer));
const owned: unknown = buffer;
const typedOwned: unknown = typed;
console.log("erasure brand", Bytes.isBuffer(owned), Bytes.isBuffer(typedOwned), Bytes.isBuffer({length: 4}), Bytes.isBuffer(null), Bytes.isBuffer(4));
const empty = Bytes.alloc(0);
console.log("empty", Bytes.isBuffer(empty), empty.length, empty[0] === undefined, Bytes.isBuffer(empty.slice()));
console.log("fraction", Bytes.alloc(1.9).length, Bytes.alloc(-0).length);
const unsafe = Bytes.allocUnsafe(4);
unsafe.set(new Uint8Array([1, 2, 3, 4]));
console.log("unsafe initialized", unsafe.join(","), Bytes.isBuffer(unsafe), unsafe[-1] === undefined);
const unsafeAgain = Bytes.allocUnsafe(4);
unsafeAgain.set(new Uint8Array([9, 8, 7, 6]));
console.log("owning", unsafe !== unsafeAgain, unsafe.join(","), unsafeAgain.join(","));
function inspect(path: string): boolean {
    let size: number;
    try { size = statSync(path).size; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return true; throw error; }
    if (size === 0) return true;
    let descriptor: number | undefined;
    try {
        descriptor = openSync(path, "r");
        const tail = Buffer.allocUnsafe(1);
        readSync(descriptor, tail, 0, 1, size - 1);
        return tail[0] === 10;
    } finally { if (descriptor !== undefined) closeSync(descriptor); }
}
console.log("tail", inspect(fileURLToPath(import.meta.url)), inspect("buffer-file-missing"));
let effects = "";
function size(): number { effects = effects + "s"; return 2; }
function predicate(): Uint8Array { effects = effects + "p"; return unsafe; }
console.log("once", Bytes.alloc(size()).length, Bytes.isBuffer(predicate()), effects);
// A lexical source class with this name must keep its own methods.
function shadow(): void {
    const Buffer = {allocUnsafe(size: number): number { return size + 7; }};
    console.log("shadow", Buffer.allocUnsafe(1));
}
shadow();
