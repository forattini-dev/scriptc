// @ts-nocheck
"use strict";
/** @callback Handler
 * @param {number} first
 * @param {number} second
 * @returns {number}
 */
/** @type {Handler} */
function pick(first) { return first + 1; }
/** @type {{ parse: Handler }} */
const handler = { parse: pick };
console.log("basic", handler.parse(4, 9));
