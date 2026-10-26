// @rust-only
// @no-engine
const object = { test(value: string): boolean { return value === "custom"; } };
const test = object.test;
console.log(test("custom"), test("a"));
const bound = test.bind(/a/);
console.log(bound("custom"));
const native = /a/.test;
const dynamic: any = native;
console.log(native === /b/.test, dynamic === test);
