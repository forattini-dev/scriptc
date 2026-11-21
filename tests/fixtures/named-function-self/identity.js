// @ts-nocheck
"use strict";
function make(value) {
  return function inner(n) {
    if (n) return inner(n - 1);
    return [inner, value];
  };
}
const a = make(3), b = make(7);
const first = a(2), second = b(2);
console.log("identity", first[0] === a, second[0] === b, first[0] === second[0], first[1], second[1]);
