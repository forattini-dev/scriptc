// @rust-only
// @no-engine
// @ts-nocheck
export {};
let trace = "";
function left(): boolean { trace += "left;"; return true; }
function right(): number { trace += "right;"; return 2; }
const result = (left() ? undefined : undefined) * right();
console.log("arithmetic", String(result), trace);
trace = "";
console.log("null-number", Math.floor(left() ? null : null), trace);
trace = "";
console.log("unit-string", String(left() ? undefined : undefined), trace);
trace = "";
try { Buffer.from(left() ? null : null); }
catch(error) { console.log("unit-buffer", error instanceof TypeError, String(error.code), trace); }
function fail(): number { trace += "throw;"; throw new Error("right"); }
trace = "";
try { (left() ? undefined : undefined) / fail(); }
catch(error) { console.log("abrupt", String(error.message), trace); }
