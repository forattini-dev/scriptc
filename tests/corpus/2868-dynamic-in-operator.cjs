"use strict";

// A computed key over an untyped value uses JavaScript's runtime presence
// test. Present properties still answer true when their value is undefined.
function has(value, key) {
  return key in value;
}

const object = { answer: 42, present: undefined };
for (const key of ["answer", "present", "missing"]) {
  console.log(key, has(object, key));
}

const array = ["zero", undefined];
for (const key of ["0", "1", "2", "01", "length"]) {
  console.log(key, has(array, key));
}
