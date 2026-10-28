// @rust-only
// @no-engine
export {};
let calls = 0;
function value(): string { calls++; return "é😀"; }
console.log("basic", Buffer.byteLength(""), Buffer.byteLength("abc"), Buffer.byteLength(value()), calls);
console.log("unicode", Buffer.byteLength("😀"), Buffer.byteLength(String.fromCharCode(0xd800)), Buffer.byteLength(String.fromCharCode(0xdc00)), Buffer.byteLength(String.fromCharCode(0xd800, 0xdc00)));
console.log("nul", Buffer.byteLength("a\0b"));
