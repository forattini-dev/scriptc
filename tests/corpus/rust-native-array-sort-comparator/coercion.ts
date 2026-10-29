// @ts-nocheck
const strings = [3, 1, 2];
strings.sort((a, b) => String(a - b));
console.log("string", strings.join(","));
const noResult = [3, 1, 2];
noResult.sort(() => undefined);
console.log("undefined", noResult.join(","));
const big = [2n, 1n];
try { big.sort((a, b) => a - b); }
catch (error) { console.log("bigint", error instanceof TypeError); }
