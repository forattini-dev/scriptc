// @ts-nocheck
"use strict";
const events = [];
/** @callback Handler
 * @param {number} first
 * @param {number} second
 * @returns {number}
 */
/** @type {Handler} */
function pick(first) { events.push("call"); return first; }
/** @type {{ parse: Handler }} */
const handler = { parse: pick };
function value(n) { events.push(String(n)); return n; }
console.log("result", handler.parse(value(1), value(2)));
console.log("events", events.join(","));
