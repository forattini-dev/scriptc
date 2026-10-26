// @ts-nocheck
console.log("number", "ab".replace(/a/, () => 42));
console.log("boolean", "ab".replace(/a/, () => false));
console.log("null", "ab".replace(/a/, () => null));
console.log("undefined", "ab".replace(/a/, () => undefined));
console.log("void", "aa".replace(/a/g, () => { console.log("effect"); }));
console.log("bigint", "ab".replace(/a/, () => 123n));
const regex = /a/g;
try { "aa".replace(regex, () => Symbol("bad")); }
catch (error) { console.log("symbol", error instanceof TypeError, regex.lastIndex); }
console.log("after", "a".replace(/a/, () => "ok"));
