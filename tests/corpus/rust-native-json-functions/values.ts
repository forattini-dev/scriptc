// @rust-only
// @no-engine
const write = JSON.stringify;
const object = {"10": "ten", b: true, "2": "two", a: "é\n😀"};
console.log("object", write(object) === '{"2":"two","10":"ten","b":true,"a":"é\\n😀"}');
const items: any[] = [undefined, () => 1, Symbol("value"), 0 / 0, 1 / 0, -0];
console.log("array", write(items) === "[null,null,null,null,null,0]");
console.log("omission", write({a: undefined, b: () => 1, c: Symbol("key"), d: null}) === '{"d":null}');
console.log("roots", write(undefined) === undefined, write(() => 1) === undefined, write(Symbol("root")) === undefined, write(null) === "null");
console.log("regex", write(/abc/g) === "{}");

const tuple: [number, string] = [1, "two"];
console.log("tuple", write(tuple) === '[1,"two"]');
