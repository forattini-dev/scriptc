// @ts-nocheck
"use strict";
function tag(parts) { return parts; }
function first() { return tag`same`; }
function second() { return tag`same`; }
const a = first();
const b = first();
const c = second();
console.log("site", a === b, a === c, a.raw === b.raw, a.raw === c.raw);
