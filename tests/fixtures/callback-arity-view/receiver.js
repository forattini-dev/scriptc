// @ts-nocheck
"use strict";
/** @callback Handler
 * @param {number} first
 * @param {number} second
 * @returns {number}
 */
/** @type {Handler} */
function pick(first) { return first + this.value; }
/** @type {{ value: number, parse: Handler }} */
const handler = { value: 10, parse: pick };
console.log("receiver", handler.parse(4, 9));
