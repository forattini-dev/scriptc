// @ts-nocheck
"use strict";
const fn = function self(n) {
  return () => n ? self(n - 1)() : self;
};
console.log("nested", fn(3)() === fn);
