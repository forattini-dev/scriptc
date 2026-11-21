// @ts-nocheck
"use strict";
let last;
function tag(parts, value) {
  console.log("parts", parts[0], parts[1], parts.raw[0], parts.raw[1], value);
  console.log("same", last === parts);
  last = parts;
  return value;
}
function run() { return tag`a\n${7}b`; }
console.log("result", run(), run());
