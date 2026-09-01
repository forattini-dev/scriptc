// crypto.timingSafeEqual over Buffers and typed arrays: equal, unequal,
// aliased, and empty inputs, plus the length-mismatch RangeError
// (ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH) caught and reported.
import { timingSafeEqual } from "node:crypto";
import * as crypto from "node:crypto";

const a = Buffer.from("correct horse battery staple");
const b = Buffer.from("correct horse battery staple");
const c = Buffer.from("correct horse battery stapld");

console.log(timingSafeEqual(a, b));
console.log(timingSafeEqual(a, c));
console.log(timingSafeEqual(a, a));
console.log(crypto.timingSafeEqual(Buffer.alloc(0), Buffer.alloc(0)));

// Byte-level differences at the first, middle, and last position.
console.log(timingSafeEqual(Buffer.from([1, 2, 3]), Buffer.from([1, 2, 3])));
console.log(timingSafeEqual(Buffer.from([1, 2, 3]), Buffer.from([9, 2, 3])));
console.log(timingSafeEqual(Buffer.from([1, 2, 3]), Buffer.from([1, 9, 3])));
console.log(timingSafeEqual(Buffer.from([1, 2, 3]), Buffer.from([1, 2, 9])));

// High bytes and NULs compare by value, not as text.
console.log(timingSafeEqual(Buffer.from([0, 255, 0]), Buffer.from([0, 255, 0])));
console.log(timingSafeEqual(Buffer.from([0, 255, 0]), Buffer.from([0, 254, 0])));

// A plain Uint8Array is an ArrayBufferView like a Buffer.
const view = new Uint8Array([7, 7, 7]);
console.log(timingSafeEqual(view, new Uint8Array([7, 7, 7])));
console.log(timingSafeEqual(view, Buffer.from([7, 7, 7])));

// Unequal byte lengths throw, catchably, with Node's code and message.
try {
  timingSafeEqual(Buffer.from("ab"), Buffer.from("abc"));
  console.log("unreachable");
} catch (error) {
  if (error instanceof RangeError) {
    console.log("threw", error.name, error.message);
  }
}

try {
  crypto.timingSafeEqual(Buffer.alloc(0), Buffer.from([1]));
  console.log("unreachable");
} catch (error) {
  console.log("threw empty-vs-one", error instanceof RangeError);
}

// The digest-comparison idiom the API exists for.
const expected = crypto.createHmac("sha256", "secret").update("payload").digest("hex");
const actual = crypto.createHmac("sha256", "secret").update("payload").digest("hex");
console.log(timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(actual, "hex")));
