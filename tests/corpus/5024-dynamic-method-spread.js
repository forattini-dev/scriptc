"use strict";

const target = /** @type {any} */ ({
  base: 4,
  /** @param {number} value */
  add(value) {
    return this.base + value;
  },
});
/** @type {[number]} */
const args = [5];
console.log(Number(target.add(...args)));
