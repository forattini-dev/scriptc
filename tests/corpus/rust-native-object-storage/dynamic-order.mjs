// @ts-nocheck
// @rust-only
// @no-engine
var state = {};
let trace = "";
function receiver() { trace = trace + "b"; return state; }
function key() { trace = trace + "k"; return "value"; }
function rhs() { trace = trace + "r"; return 4; }
receiver()[key()] = rhs();
console.log("order", trace, state.value === 4);
state = undefined;
trace = "";
try { receiver()[key()] = rhs(); }
catch (error) { console.log("undefined", trace, error instanceof TypeError, String(error.message)); }
state = null;
trace = "";
try { receiver().value = rhs(); }
catch (error) { console.log("null", trace, error instanceof TypeError, String(error.message)); }
trace = "";
function fail() { trace = trace + "f"; throw new Error("rhs"); }
try { receiver()[key()] = fail(); }
catch (error) { console.log("abrupt", trace, String(error.message)); }
