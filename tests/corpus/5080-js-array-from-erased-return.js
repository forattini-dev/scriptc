// @ts-nocheck
/** @returns {Iterable<string>} */
function encodeLines(input) {
  return ["a", "b"];
}

const opaque = /** @type {any} */ ({});
console.log(Array.from(encodeLines(opaque)).join(","));
