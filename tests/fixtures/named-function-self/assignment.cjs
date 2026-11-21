// @ts-nocheck
const fn = function inner() { inner = 4; return typeof inner; };
console.log("assignment", fn());
