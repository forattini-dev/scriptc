"use strict";
const pattern: any = {
  prefix: "custom:",
  [Symbol.match](value: string): string { return this.prefix + value; },
};
const result: any = "abc".match(pattern);
console.log("symbol", result);
