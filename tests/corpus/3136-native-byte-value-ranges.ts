import { Buffer } from "node:buffer";

function lookup(input: Uint8Array | null, table: Uint8Array, count: number): Uint8Array {
  const out = new Uint8Array(16);
  for (let i = 0; i < count; i++) {
    if (i === 4) break;
    const byte = input![i];
    const index = byte * 3;
    out[i * 3] = table[index];
    out[i * 3 + 1] = table[index + 1];
    out[i * 3 + 2] = table[index + 2];
  }
  return out;
}
const table = new Uint8Array(768);
for (let i = 0; i < table.length; i++) table[i] = i * 17 + 9;
const input = new Uint8Array([0, 1, 255, 128]);
console.log("lookup", lookup(input, table, 4).join(","));
console.log("empty", lookup(null, table, 0).join(","));
console.log("fractional", lookup(input, table, 2.5).join(","));
console.log("infinity", lookup(input, table, Infinity).join(","));
console.log("offset", lookup(input.subarray(1, 3), table, 2).join(","));
const words = new Uint32Array([0x80ff0100]);
const backed = Buffer.from(words.buffer);
console.log("backed", lookup(backed, table, 4).join(","));
try { lookup(null, table, 1); } catch (error) { console.log("null", error instanceof TypeError); }

let reads = 0;
function index(): number { reads++; return 0; }
function observe(source: Uint8Array): Uint8Array {
  const out = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    const byte = source[index()];
    const negative = byte * -1;
    console.log("number", byte, byte + 0.5, 1 / negative, byte * Number.MAX_SAFE_INTEGER);
    out[i] = byte + reads;
    source[0] = source[0] + 1;
  }
  return out;
}
console.log("effects", observe(new Uint8Array([0])).join(","), reads);
function mutable(source: Uint8Array): Uint8Array {
  const out = new Uint8Array(2);
  for (let i = 0; i < 2; i++) {
    let byte = source[i];
    byte = byte + 0.5;
    out[i] = byte * 2;
  }
  return out;
}
console.log("mutable", mutable(input).join(","));
function floating(source: Float64Array): Uint8Array {
  const out = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    const value = source[i];
    console.log("float", value, 1 / value);
    out[i] = value * 2;
  }
  return out;
}
console.log("floating", floating(new Float64Array([0.5, -0, NaN, Infinity])).join(","));
