// @rust-only
// @no-engine
// @ts-nocheck
export {};
const data = JSON.parse('{"0":1,"true":2,"null":3,"undefined":4,"1":5,"01":6,"__proto__":7}');
let zero = -0, flag = true, big = 1n;
console.log("delete", delete data[zero], delete data[flag], delete data[null], delete data[undefined], delete data[big]);
console.log("keys", Object.keys(data).join(","), Object.hasOwn(data, "01"));
console.log(delete data.__proto__, Object.hasOwn(data, "__proto__"));
