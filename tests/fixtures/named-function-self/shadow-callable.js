// @ts-nocheck
"use strict";
const inner = function(n) { return 99; };
const fn = function inner(n) { return n ? inner(n - 1) : 9; };
console.log("shadow-callable", fn(2), inner(2));
