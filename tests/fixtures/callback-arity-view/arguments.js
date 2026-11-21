// @ts-nocheck
"use strict";
/** @callback Handler
 * @param {number} first
 * @param {number} second
 * @returns {number}
 */
/** @type {Handler} */
function pick(first) { return arguments.length + first; }
/** @type {{ parse: Handler }} */
const handler = { parse: pick };
console.log("arguments", handler.parse(4, 9));
