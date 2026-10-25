// @ts-nocheck
// @rust-only
// @no-engine
let trace = "";
function number(): number { trace = trace + "n"; return 1; }
function nothing(): void { trace = trace + "v"; }
function object() { trace = trace + "o"; return { toString(): string { trace = trace + "BAD"; return "bad"; } }; }
function fail(): number { trace = trace + "x"; throw new Error("argument"); }
console.log("ignored", JSON.parse.toString(number(), nothing(), object(), null, undefined), trace);
trace = "";
try { JSON.stringify.toString(number(), fail(), object()); }
catch (error) { console.log("throws", error instanceof Error, trace); }
const alias = JSON.parse;
trace = "";
console.log("alias effects", alias.toString(nothing(), number()), trace);
