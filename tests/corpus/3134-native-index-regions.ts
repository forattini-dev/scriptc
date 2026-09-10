import { Buffer } from "node:buffer";

// Counted loops and derived indices keep JS number observations in both lanes.
function tiles(input: Uint8Array, rows: number, columns: number): Uint8Array {
  const out = new Uint8Array(64);
  for (let y = 0; y < rows; y++) {
    if (y >= 3) break;
    const row = y * 16;
    const prior = row - 16;
    for (let x = 0; x < columns; x++) {
      if (x >= 3) break;
      const read = y * 4 + x;
      out[row + x] = input[read]! + (y > 0 ? input[prior / 4 + x]! : 0);
      out[row + 4 + x] = x * -1; // Includes -0; conversion still follows JS.
      out[row + 8 + x] = 1 / (x * -1);
    }
  }
  return out;
}
const input = new Uint8Array(32);
for (let i = 0; i < input.length; i++) input[i] = i * 17 + 3;
for (const limit of [0, -0, 1, 2.5, 3, -1, NaN, Infinity, 67108863, 67108864, Number.MAX_SAFE_INTEGER]) {
  console.log(String(limit), tiles(input, limit, 2.5).join(','));
  console.log(String(limit), tiles(input, 2, limit).join(','));
}
console.log('slice', tiles(input.subarray(2, 18), 2, 3).join(','));
const backing = new Uint32Array([0x04030201, 0x08070605, 0x0c0b0a09, 0x100f0e0d]);
const backed = Buffer.from(backing.buffer).subarray(2, 14);
console.log('backed', tiles(backed, 2, 3).join(','));

function changed(input: Uint8Array, count: number): Uint8Array {
  const out = new Uint8Array(16);
  for (let i = 0; i < count; i++) {
    out[i] = input[i]!;
    if (i === 1) count = 2.5;
  }
  return out;
}
console.log('changed', changed(input, 8).join(','));

function captured(input: Uint8Array, count: number): Uint8Array {
  const alter = () => { count = 2; };
  const out = new Uint8Array(16);
  for (let i = 0; i < count; i++) {
    out[i] = input[i]!;
    alter();
  }
  return out;
}
console.log('captured', captured(input, 8).join(','));

function observations(count: number): Uint8Array {
  const out = new Uint8Array(16);
  for (let i = 0; i < count; i++) {
    if (i > 2) break;
    const negative = i * -1;
    console.log('numeric', i, 1 / negative, i * Number.MAX_SAFE_INTEGER, i + 0.5);
    out[i * 4 + 1] = i + 257;
  }
  return out;
}
console.log('observations', observations(3).join(','));

function iterableElements(input: Uint8Array, count: number, offsets: number[]): Uint8Array {
  const out = new Uint8Array(32);
  for (let i = 0; i < count; i++) {
    const row = i * 4;
    for (const offset of offsets) out[row + offset] = input[i]!;
  }
  return out;
}
console.log('elements', iterableElements(input, 3, [1, 2]).join(','));
