// @rust-only
// @no-engine
const read = JSON.parse;
const write = JSON.stringify;
const result = read('{"z":1,"2":"first","a":[true,null,1e400],"z":2,"__proto__":{"safe":true}}');
console.log("parse", result.z === 2, result["2"] === "first", result.a[0] === true, result.a[1] === null, result.a[2] === 1 / 0, result["__proto__"].safe === true);
console.log("order", write(result) === '{"2":"first","z":2,"a":[true,null,null],"__proto__":{"safe":true}}');
console.log("primitive", read("null") === null, read("true") === true, read("-0") === 0, read('"hello"') === "hello");
try { read('{"x":}'); } catch (error) { console.log("syntax", error instanceof SyntaxError); }
