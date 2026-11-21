// @ts-nocheck
"use strict";
/** @callback Handler
 * @param {number} first
 * @param {number} second
 * @returns {number}
 */
function pick(first) { return first + this.value; }
/** @returns {Handler} */
function view(value) { return value; }
/** @type {{ value: number, parse: Handler }} */
const handler = { value: 10, parse: view(pick) };
console.log("dynamic-receiver", handler.parse(4, 9), handler.parse === pick);
