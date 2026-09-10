import { Buffer } from "node:buffer";

const owner = new Uint32Array(4);
const view = Buffer.from(owner.buffer);
view.set(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), 2);
console.log("direct-to-backed", view.join(","));
const inner = view.subarray(2, 10);
inner.set(inner.subarray(0, 6), 2);
console.log("forward-overlap", inner.join(","));
inner.set(inner.subarray(2, 8), 0);
console.log("backward-overlap", inner.join(","));
inner.set(inner, -0);
console.log("self-copy", inner.join(","));
const direct = new Uint8Array(10);
direct.set(inner.subarray(1, 5), 2.9);
console.log("backed-to-direct", direct.join(","));
const second = Buffer.from(new Uint32Array(4).buffer).subarray(3, 13);
second.set(inner.subarray(2, 6), 1);
console.log("backed-to-backed", second.join(","));
for (const offset of [-1, Infinity, -Infinity, 7, 20]) {
  try { inner.set(new Uint8Array([11, 22]), offset); }
  catch (error) { console.log("bounds", offset, error instanceof RangeError, inner.join(",")); }
}
inner.set(new Uint8Array(0), inner.length);
inner.set(new Uint8Array([99]), NaN);
inner.set(new Uint8Array([88]), -0.5);
console.log("empty-and-offset", inner.join(","), view.join(","));

const floatOwner = new Float64Array(2);
const floatBytes = Buffer.from(floatOwner.buffer);
floatBytes.set(new Uint8Array([9, 8, 7, 6, 5, 4, 3, 2]), 4);
const copied = new Uint8Array(8);
copied.set(floatBytes.subarray(4, 12));
console.log("float-storage", copied.join(","));
