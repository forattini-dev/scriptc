// @ts-nocheck
"use strict";
const fn = function inner(value = inner) { return value === inner; };
console.log("default", fn(), fn(fn));
