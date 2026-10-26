// @ts-nocheck
// @rust-only
// @no-engine
export {};
const values = [0, 1, 2, 3, 4];
console.log("copies", values.slice().join(","), values.slice(1, -1).join(","), values.slice(-2).join(","));
console.log("clamp", values.slice(-99, 99).join(","), values.slice(3, 1).length, values.slice(Number.NaN, 2.9).join(","));
console.log("defaults", values.slice(undefined, undefined).join(","), values.slice(1, Number.POSITIVE_INFINITY).join(","));
console.log("string defaults", "abc".slice(undefined, undefined), "abc".substring(undefined, undefined));
console.log("coercion", values.slice("1", "3").join(","), values.slice(null, true).join(","));
const object = {value: 1};
const objects = [object];
const copy = objects.slice();
console.log(copy !== objects, copy[0] === object);
object.value = 9;
console.log(copy[0].value, values.length);
try { values.slice(1n); } catch (error) { console.log(error instanceof TypeError, String(error.message)); }
