"use strict";
if (process.argv.includes("--first")) {
  /** @param {number} value */
  module.exports = function transform(value) { return value + 1; };
} else {
  /** @param {number} value */
  module.exports = function transform(value) { return value - 1; };
}
