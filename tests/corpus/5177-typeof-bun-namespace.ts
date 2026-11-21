/// <reference path="./5166-types/node_modules/bun-types/index.d.ts" />

const host = typeof Bun === "undefined" ? "native" : "native";
console.log(host);
