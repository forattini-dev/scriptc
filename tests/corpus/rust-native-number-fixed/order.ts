// @rust-only
// @no-engine
// @ts-nocheck
export {};
let trace = "";
function receiver(): number { trace += "receiver;"; return 1.25; }
function digits(): number { trace += "digits;"; return 2; }
function extra(): number { trace += "extra;"; return 9; }
console.log("order", receiver().toFixed(digits(), extra()), trace);
trace = "";
console.log("undefined", receiver().toFixed(undefined, extra()), trace);
console.log("coerce", (1.25).toFixed("2"), (1.25).toFixed(null), (1.25).toFixed(true), (1.25).toFixed("bad"));
function fail(): number { trace += "throw;"; throw new Error("extra-failed"); }
trace = "";
try { receiver().toFixed(101, fail()); } catch (error) { console.log("abrupt", error instanceof Error, error.message === "extra-failed", trace); }
trace = "";
try { receiver().toFixed(101, extra()); } catch (error) { console.log("range-order", error instanceof RangeError, trace); }
let current = 1.25;
function change(): number { current = 9; return 2; }
console.log("snapshot", current.toFixed(change()), current);
