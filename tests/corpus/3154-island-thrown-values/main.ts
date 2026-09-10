// @rust-only
// C/LLVM stringify engine-thrown nonstrings and lose host lone surrogates.
// @dynamic
import { fail, roundtrip, failPrimitive, capture, counts } from "throwvalues";

for (let index = 0; index < 4; index++) {
  console.log(roundtrip(() => {
    try { fail(index); } catch (value) {
      console.log(typeof value, value === null, value === undefined, value instanceof Error, String(value));
      throw value;
    }
  }, index));
}

console.log(capture(() => { throw "\ud800"; }));

for (let index = 0; index < 7; index++) {
  try { failPrimitive(index); } catch (value) {
    console.log(typeof value, typeof value === "string" ? value.charCodeAt(0) : String(value));
    if (typeof value === "number") console.log(Object.is(value, -0), Number.isNaN(value));
  }
}

console.log("effects", counts());
