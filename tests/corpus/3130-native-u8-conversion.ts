import { Buffer } from "node:buffer";

const values = [-0, 0, 5e-324, -5e-324, 0.75, -0.75, 1.75, -1.75, 255.75, -255.75,
  256, -256, 257, -257, 2147483647, 2147483648, 4294967295, 4294967296,
  9007199254740991, 9007199254740992, 1152921504606846848, 1152921504606846976,
  9223372036854774784, 9223372036854775808, 9223372036854777856,
  -9223372036854774784, -9223372036854775808, -9223372036854777856,
  1e100, -1e100, 1.7976931348623157e308, -1.7976931348623157e308, NaN, Infinity, -Infinity];
console.log("construct", new Uint8Array(values).join(","));
console.log("buffer", Buffer.from(values).join(","));
function store(input: number[]): Uint8Array {
  const out = new Uint8Array(input.length * 2);
  for (let i = 0; i < input.length; i++) {
    out[i * 2] = input[i];
    out[i * 2 + 1] = input[i] & 255;
  }
  return out;
}
console.log("stores", store(values).join(","));
const owner = new Uint8Array(4);
const view = owner.subarray(1, 3);
view[0] = -257.5; view[1] = 9223372036854775808;
console.log("views", owner.join(","));
