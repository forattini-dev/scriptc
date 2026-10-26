// @ts-nocheck
export {};
let trace = "";
function fn(value: number): number { return value + 1; }
const data: any = fn;
function receiver(): typeof fn { trace = trace + "R"; return fn; }
function key(): string { trace = trace + "K"; return "value"; }
function rhs(): number { trace = trace + "V"; return 4; }
receiver()[key()] = rhs();
console.log("write", trace, data.value === 4);
trace = "";
console.log("read", receiver()[key()] === 4, trace);
trace = "";
console.log("delete", delete receiver()[key()], trace, data.value === undefined);
function fail(): number { trace = trace + "X"; throw new Error("stop"); }
data.value = 8;
trace = "";
try { receiver()[key()] = fail(); } catch { console.log("abrupt", trace, data.value === 8); }
console.log("call", fn(3));
