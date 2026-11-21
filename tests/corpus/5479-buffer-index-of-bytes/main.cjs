"use strict";

const input = Buffer.from("--x--x", "utf8");
const needle = Buffer.from("--x", "utf8");

console.log(input.indexOf(needle));
console.log(input.indexOf(needle, 1));
console.log(input.lastIndexOf(needle));
console.log(input.includes(needle, 4));
console.log(input.includes(Buffer.from("missing")));
