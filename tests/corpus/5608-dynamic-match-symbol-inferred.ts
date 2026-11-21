"use strict";
const pattern: any = { [Symbol.match](_value: string): string { return "custom"; } };
const result = "abc".match(pattern);
console.log("inferred", result && result[0]);
