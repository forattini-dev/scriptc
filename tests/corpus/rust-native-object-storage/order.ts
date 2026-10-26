// @ts-nocheck
// @rust-only
// @no-engine
export {};
var state: {value: number} | undefined = {value: 0};
const alias: {value: number} | undefined = state;
let trace = "";
function receiver(): {value: number} | undefined { trace = trace + "b"; return state; }
function rhs(): number { trace = trace + "r"; state = undefined; return 9; }
receiver()!.value = rhs();
console.log("snapshot", trace, alias!.value, state === undefined);
trace = "";
try { receiver()!.value = rhs(); }
catch (error) { console.log("null-write", trace, error instanceof TypeError, String(error.message)); }
trace = "";
function fail(): number { trace = trace + "f"; throw new Error("rhs"); }
try { receiver()!.value = fail(); }
catch (error) { console.log("abrupt", trace, String(error.message)); }
trace = "";
try { receiver()!.value + rhs(); }
catch (error) { console.log("read-first", trace, String(error.message)); }
trace = "";
function dynamicValue(): any { trace = trace + "d"; return "unrepresented field value"; }
try { receiver()!.value = dynamicValue(); }
catch (error) { console.log("presence-before-field-check", trace, String(error.message)); }
