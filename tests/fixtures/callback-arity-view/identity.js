// @ts-nocheck
"use strict";
/** @callback Handler
 * @param {number} first
 * @param {number} second
 * @returns {number}
 */
/** @type {Handler} */
function pick(first) { return first; }
/** @type {{ parse: Handler }} */
const handler = { parse: pick };
console.log("identity", handler.parse === pick, handler.parse(3, 5));
