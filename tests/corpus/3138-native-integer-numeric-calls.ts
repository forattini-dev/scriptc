import { Buffer } from "node:buffer";

// The helper name deliberately differs from any application. The proof must
// follow values and branches, including tie-breaking and signed differences.
function predict(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}
function filter(input: Uint8Array, count: number): Uint8Array {
  const out = new Uint8Array(64);
  for (let i = 0; i < count; i++) {
    if (i === 64) break;
    const a = i >= 1 ? input[i - 1] : 0;
    const b = i >= 4 ? input[i - 4] : 0;
    const c = i >= 1 && i >= 5 ? input[i - 5] : 0;
    out[i] = (input[i] - predict(a, b, c)) & 255;
  }
  return out;
}
const input = new Uint8Array(64);
for (let i = 0; i < input.length; i++) input[i] = i * 97 + 255;
console.log("filter", filter(input, 64).join(","));
console.log("fractional-bound", filter(input, 5.5).join(","));
console.log("unbounded", filter(input, Infinity).join(","));
console.log("empty", filter(new Uint8Array(0), -0).join(","));
const words = new Uint32Array(16);
const backed = Buffer.from(words.buffer);
for (let i = 0; i < input.length; i++) backed[i] = input[i];
console.log("backed", filter(backed, 64).join(","));
console.log("view", filter(input.subarray(2), 12).join(","));

function combinations(samples: Uint8Array): Uint8Array {
  const out = new Uint8Array(216);
  for (let i = 0; i < 6; i++) {
    for (let j = 0; j < 6; j++) {
      for (let k = 0; k < 6; k++) {
        const a = samples[i];
        const b = samples[j];
        const c = samples[k];
        out[(i * 6 + j) * 6 + k] = predict(a, b, c);
      }
    }
  }
  return out;
}
console.log("ties-and-extremes", combinations(new Uint8Array([0, 1, 127, 128, 254, 255])).join(","));

let calls = 0;
function condition(index: number): boolean { calls++; return index > 0; }
function effect(value: number): number { calls++; return value + calls; }
function neg(value: number): number { return value * -1; }
function unsafeRange(value: number): number { const sum = value + Number.MAX_SAFE_INTEGER; return sum - Number.MAX_SAFE_INTEGER; }
function fraction(value: number): number { return value + 0.5; }
function distance(value: number): number { if (value < 100) return 100 - value; return value - 100; }
function order(a: number, b: number): number { return a * 10 + b; }
function take(input: Uint8Array): Uint8Array {
  const out = new Uint8Array(24);
  for (let i = 0; i < 4; i++) {
    const value = condition(i) ? input[i] : 0;
    const d = distance(value);
    console.log("observe", value, d, 1 / neg(value), fraction(value), unsafeRange(value));
    out[i * 6] = d;
    out[i * 6 + 1] = effect(value);
    out[i * 6 + 2] = fraction(value) * 2;
    out[i * 6 + 3] = unsafeRange(value);
    out[i * 6 + 4] = order(input[calls++ % 4], input[calls++ % 4]);
    out[i * 6 + 5] = distance(out[i * 6]);
  }
  return out;
}
console.log("order", take(new Uint8Array([0, 1, 128, 255])).join(","), calls);
console.log("ordinary-floats", predict(1.5, 2.5, -0), 1 / predict(-0, -0, -0), predict(NaN, 1, 2));
