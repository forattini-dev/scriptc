// @ts-nocheck
"use strict";
const fn = function self(n) {
  const other = function self() { return 42; };
  return n ? self(n - 1) : other();
};
console.log("nested-shadow", fn(2));
