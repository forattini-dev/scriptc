// @rust-only
// @no-engine
// @ts-nocheck
import { Buffer as NativeBuffer } from "node:buffer";
export {};
let calls = 0;
const source = {text: "before", valueOf() { calls += 1; return this.text; }};
function encoding(): string { source.text = "after"; return "utf8"; }
console.log("live-hook", NativeBuffer.from(source, encoding()).toString(), calls);
const next = {valueOf() { calls += 1; return "chain"; }};
const chain = {valueOf() { calls += 1; return next; }};
console.log("chain", NativeBuffer.from(chain).toString(), calls);
const array = {valueOf() { return [65, 66]; }};
console.log("array-hook", NativeBuffer.from(array, "bad").toString());
const numeric = {length: 1, 0: 65, valueOf() { return 7; }};
const nullish = {length: 1, 0: 66, valueOf() { return null; }};
console.log("fallback", NativeBuffer.from(numeric).toString(), NativeBuffer.from(nullish).toString());
try { NativeBuffer.from({length: 1, 0: 65, valueOf: "bad"}); }
catch(error) { console.log("not-callable", error instanceof TypeError, String(error.message)); }
const custom = {from: (value: string): string => "custom:" + value};
console.log("shadow", custom.from("source"));
const encoded = new TextEncoder().encode("AB");
console.log("encoder-brand", NativeBuffer.isBuffer(encoded), encoded.byteOffset, encoded.toString());
const encodedEmpty = new TextEncoder().encode();
console.log("encoder-empty", NativeBuffer.isBuffer(encodedEmpty), encodedEmpty.byteOffset);
console.log("factory-brand", NativeBuffer.isBuffer(NativeBuffer.from(encoded)), NativeBuffer.from(encoded).toString());
