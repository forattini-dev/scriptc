// @rust-only
// @no-engine
// @ts-nocheck
export {};
let trace = "";
function receiver(): number { trace = trace + "receiver;"; return 255; }
function radix(): number { trace = trace + "radix;"; return 16; }
function extra(): number { trace = trace + "extra;"; return 999; }
console.log("order", receiver().toString(radix(), extra()), trace);
trace = "";
console.log("undefined", receiver().toString(undefined, extra()), trace);
console.log("text", (255).toString("16"), (31).toString(" 16 "));
function fails(): number { trace = trace + "throw;"; throw new Error("extra-failed"); }
trace = "";
try { receiver().toString(1, fails()); } catch (error) { console.log("abrupt", error instanceof Error, error.message === "extra-failed", trace); }
trace = "";
try { receiver().toString(1, extra()); } catch (error) { console.log("range-order", error instanceof RangeError, trace); }
