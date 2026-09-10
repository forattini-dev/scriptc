import { Buffer } from "node:buffer";

function pixels(source: Uint8Array, count: number): Uint8Array {
  const out = new Uint8Array(32);
  for (let i = 0; i < count; i++) {
    if (i === 4) break;
    const byte = source[i];
    out[i * 8] = source[i];
    out[i * 8 + 1] = byte - 257;
    out[i * 8 + 2] = byte + 256;
    out[i * 8 + 3] = byte * 255 + 257;
    out[i * 8 + 4] = Number.MAX_SAFE_INTEGER;
    out[i * 8 + 5] = Number.MIN_SAFE_INTEGER;
    out[i * 8 + 6] = byte * -1;
    out[i * 8 + 7] = 1 / (byte * -1);
  }
  return out;
}
const source = new Uint8Array([0, 1, 128, 255]);
console.log("direct", pixels(source, 4).join(","));
console.log("offset", pixels(source.subarray(1, 3), 2).join(","));
console.log("fractional", pixels(source, 2.5).join(","));
console.log("empty", pixels(source, 0).join(","));
console.log("infinite", pixels(source, Infinity).join(","));
const words = new Uint32Array([0xff800100]);
console.log("backed", pixels(Buffer.from(words.buffer), 4).join(","));

function floats(input: Float64Array, count: number): Uint8Array {
  const out = new Uint8Array(8);
  for (let i = 0; i < count; i++) out[i] = input[i];
  return out;
}
console.log("floats", floats(new Float64Array([0.5, -1.5, NaN, Infinity, -Infinity, -0, 257.75, -257.75]), 8).join(","));
function wide(input: Uint32Array, count: number): Uint8Array {
  const out = new Uint8Array(4);
  for (let i = 0; i < count; i++) out[i] = input[i];
  return out;
}
console.log("wide", wide(new Uint32Array([0, 256, 257, 4294967295]), 4).join(","));
function sameOutput(count: number): Uint8Array {
  const out = new Uint8Array(8);
  for (let i = 0; i < count; i++) {
    out[i] = i * 257 + 129;
    if (i > 0) out[i] = out[i - 1];
  }
  return out;
}
console.log("same output", sameOutput(8).join(","));
let events = "";
function destination(i: number): number { events += "d" + i; return i; }
function value(i: number): number { events += "v" + i; return i; }
function ordered(input: Uint8Array): Uint8Array {
  const out = new Uint8Array(4);
  for (let i = 0; i < 4; i++) out[destination(i)] = input[value(i)];
  return out;
}
console.log("ordered", ordered(source).join(","), events);
