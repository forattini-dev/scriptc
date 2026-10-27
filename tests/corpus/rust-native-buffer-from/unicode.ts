// @rust-only
// @no-engine
// @ts-nocheck
export {};
const lone: any = JSON.parse('"\\ud800"');
console.log("lone-utf8", Buffer.from(lone).toString("hex"));
const wide = Buffer.from(lone, "ucs-2");
console.log("lone-utf16", wide.toString("hex"), wide.toString("utf16le").charCodeAt(0));
console.log("invalid-utf8", Buffer.from("ff61c0af", "hex").toString("utf8"));
console.log("odd", Buffer.from("610062", "hex").toString("utf-16le"));
console.log("base64url", Buffer.from("-_8", "base64url").toString("base64"), Buffer.from("+/8=", "base64").toString("base64url"));
const sparse: any = JSON.parse('[65,66,67]');
delete sparse[1];
console.log("sparse", Buffer.from(sparse).toString("hex"));
let calls = 0;
const rows = {length: 2, 0: 65, 1: 66, valueOf() { calls += 1; return this; }};
console.log("same-hook", Buffer.from(rows).toString(), calls);
