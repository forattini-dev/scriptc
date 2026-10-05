"use strict";
const { version, count: initialCount, "display-name": displayName, nested, values } = require("./package.json");
const { count } = require("./package.json");
function describe() {
  return `${version}:${initialCount}:${displayName}:${count + 2}:${nested.enabled}:${values[1]}`;
}
console.log(describe());
console.error("json-binding");
