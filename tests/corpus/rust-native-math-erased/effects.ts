// @rust-only
// @no-engine
export {};
let order = "";
function first(value: any): any { order += "f"; return value; }
function second(): number { order += "s"; return 2; }
function third(): number { order += "t"; return 3; }
console.log("order", Math.max(first("4"), second(), third()), order);
order = "";
try { Math.max(first(1n), second(), third()); }
catch (error) { console.log("bigint", error instanceof TypeError, order); }
order = "";
try { Math.max(first(Symbol("x")), second()); }
catch (error) { console.log("symbol", error instanceof TypeError, order); }
function absent(): any { order += "a"; return undefined; }
order = "";
console.log("undefined", Math.max(absent(), second()), order);
function nested(value: any): number { return Math.max(1, Math.round(value / Math.max(1, value))); }
console.log("nested", nested("6"));
