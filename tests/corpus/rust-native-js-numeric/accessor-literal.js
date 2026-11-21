"use strict";
let reads = 0;
const target = {
  base: 4,
  get value() { reads++; return this === target ? this.base + 3 : 0; },
};
const alias = target;
console.log("values", String(target.value), String(alias.value), reads);
console.log("keys", Object.keys(target).join(","));
console.log("json", String(JSON.stringify(target)), reads);
console.log("delete", delete target.value, Object.keys(target).join(","));
