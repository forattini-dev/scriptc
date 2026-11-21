"use strict";

const { isUint8Array } = require("node:util/types");

console.log(isUint8Array(new Uint8Array(2)));
console.log(isUint8Array(Buffer.from([1])));
console.log(isUint8Array(new Uint16Array(2)));
console.log(isUint8Array({}));
