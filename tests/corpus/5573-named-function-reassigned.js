// @ts-nocheck
"use strict";
let outside = function self(n) {
  if (n === 0) return self;
  return self(n - 1);
};
const original = outside;
outside = function() { return null; };
console.log("reassigned", original(2) === original, original(2) === outside);
