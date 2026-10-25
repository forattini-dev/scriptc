// @rust-only
// @no-engine
// @ts-nocheck
const array = JSON.parse('[1]');
console.log(delete array.length);
console.log(delete "abc"[0]);
console.log(delete "abc".length);
console.log(delete "abc"[3]);
const value = JSON.parse('{"x":1}');
console.log(delete value.x);
console.log(Object.keys(value).length);
