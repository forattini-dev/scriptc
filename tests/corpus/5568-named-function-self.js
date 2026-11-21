// @ts-nocheck
"use strict";
const sum = function inner(n) { return n ? n + inner(n - 1) : 0; };
console.log("sum", sum(5));
