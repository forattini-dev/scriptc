// @rust-only
// @no-engine
// @ts-nocheck
export {};
let trace = "";
function input(): string { trace += "input;"; return "ab"; }
function encoding(): string { trace += "encoding;"; return "utf8"; }
function extra(): number { trace += "extra;"; return 3; }
console.log("order", Buffer.from(input(), encoding(), extra()).toString(), trace);
function fail(): number { trace += "throw;"; throw new Error("extra"); }
trace = "";
try { Buffer.from(1, "bad", fail()); } catch(error) { console.log("abrupt", error instanceof Error, error.message === "extra", trace); }
trace = "";
const source = {value: "hi", valueOf() { trace += "valueOf;"; return this.value; }};
console.log("hook", Buffer.from(source, encoding(), extra()).toString(), trace);
trace = "";
const bytes = Buffer.from("ab");
function receiver(): Buffer { trace += "receiver;"; return bytes; }
console.log("method", receiver().toString(encoding()), trace);
const empty = Buffer.alloc(0);
console.log("empty", empty.toString(Symbol("ignored")), new Uint8Array([1, 2]).toString(Symbol("ignored")));
function ignored(): any { trace += "ignored;"; return {toString(){throw new Error("not converted")}}; }
trace = "";
console.log("array-encoding", Buffer.from([65], ignored()).toString(), trace);
