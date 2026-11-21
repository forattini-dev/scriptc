// @ts-nocheck
"use strict";
const inner = 42;
const fn = function inner(n) { return n ? inner(n - 1) : 9; };
console.log("shadow", fn(2), inner);
