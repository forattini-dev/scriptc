// @ts-nocheck
"use strict";
const fn = function self() {
  const self = 42;
  return self;
};
console.log("inner-shadow", fn());
