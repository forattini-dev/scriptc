"use strict";
/** @param {number} value */
function transform(value) { return value + 1; }
if (process.argv.includes("--first")) {
  module.exports = transform;
} else {
  module.exports = transform;
}
