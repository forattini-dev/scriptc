"use strict";
if (process.argv.includes("--first")) {
  let offset = 1;
  /** @param {number} value */
  function transform(value) { return value + offset++; }
  module.exports = transform;
} else {
  let offset = 1;
  /** @param {number} value */
  function transform(value) { return value - offset++; }
  module.exports = transform;
}
