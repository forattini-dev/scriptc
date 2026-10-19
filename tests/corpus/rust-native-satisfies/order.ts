// @rust-only
// @no-engine
let calls: number = 0;
function make(): { value: number } { calls = calls + 1; console.log("source", calls); return { value: calls }; }
const value = make() satisfies { value: number };
console.log("once", calls, value.value);
function fail(): { value: number } { console.log("throw source"); throw "stop"; }
try { fail() satisfies { value: number }; } catch { console.log("caught"); }
console.log("done", calls);
